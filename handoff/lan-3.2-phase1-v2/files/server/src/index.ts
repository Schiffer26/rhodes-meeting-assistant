/**
 * RHODES API · process entry point
 *
 * The ordered startup itself lives in `startup.ts`, so it can be tested with a synthetic
 * environment; this file only wires the process to it:
 *
 *   startRuntime()   configuration (including TLS material) → database → migrations →
 *                    listener on loopback, HTTP or HTTPS
 *   wiring           signal + fault handlers, optional stdin control channel, then the
 *                    `service.ready` announcement (see `serviceMode.ts`)
 *   shutdown         one sequence, whatever the trigger; one final structured line; and
 *                    an exit code that says whether it actually succeeded
 *
 * Exit codes (see `shutdown.ts`): 0 clean, 69 shutdown ran but a stage failed, 1 startup
 * failure or fatal fault.
 *
 * A failure during startup exits non-zero with a structured code and leaves nothing
 * listening; if the listener itself could not bind, the database has already been closed
 * by `startRuntime`.
 */

import { AppError, describeError } from './errors.js';
import { logger } from './logger.js';
import { wireLifecycle, type ControlInput, type LifecycleEmitter } from './serviceMode.js';
import { performShutdown } from './shutdown.js';
import { startRuntime } from './startup.js';

/**
 * How long the process may take to drain after the final line has been written.
 * Unref'd, so it never keeps the process alive on its own — it only bounds the case where
 * something else (a stray socket, a pending handle) refuses to let the loop empty.
 */
const EXIT_GRACE_MS = 2000;

async function main(): Promise<void> {
  const runtime = await startRuntime();

  let stopping = false;

  // Assigned immediately after the handlers are registered; a stop cannot arrive before
  // that, because registration itself is synchronous.
  let detachControl: (() => void) | null = null;

  const stop = (reason: string, requestedCode: number): void => {
    // One sequence only: signals, faults and control commands all funnel here, and the
    // second caller is dropped rather than starting a parallel shutdown.
    if (stopping) return;
    stopping = true;

    // Stop reading stdin first: a resumed pipe is a live handle, and this one must not
    // outlive the shutdown it just requested.
    detachControl?.();

    void (async () => {
      const { exitCode } = await performShutdown({ runtime, reason, requestedCode });

      // The final line was written synchronously inside performShutdown, so it cannot be
      // lost to an exit. Set the code and let the event loop drain; the timer is only a
      // backstop for handles that outlive their usefulness.
      process.exitCode = exitCode;
      const timer = setTimeout(() => process.exit(exitCode), EXIT_GRACE_MS);
      timer.unref();
    })();
  };

  const lifecycle = wireLifecycle({
    runtime,
    stdin: process.stdin as unknown as ControlInput,
    emitter: process as unknown as LifecycleEmitter,
    stop,
  });
  detachControl = lifecycle.detach;
}

main().catch((error: unknown) => {
  const described = describeError(error);
  // Config and migration failures are written for an operator and are safe to print.
  // The message may name a file path; it never contains certificate or key material.
  logger.error('service.startup_failed', {
    code: described.code ?? 'startup.unknown',
    name: described.name,
    message: described.message,
    details: error instanceof AppError ? error.details : undefined,
  });
  process.exitCode = 1;
});
