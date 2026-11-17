/**
 * RHODES API · process entry point
 *
 * The ordered startup itself lives in `startup.ts`, so it can be tested with a synthetic
 * environment; this file only wires the process to it:
 *
 *   startRuntime()   configuration (including TLS material) → database → migrations →
 *                    listener on loopback, HTTP or HTTPS
 *   signals          SIGINT/SIGTERM stop listening, close the database, exit 0
 *   faults           uncaught exception or unhandled rejection shut down cleanly, exit 1
 *
 * A failure during startup exits non-zero with a structured code and leaves nothing
 * listening; if the listener itself could not bind, the database has already been closed
 * by `startRuntime`.
 */

import { AppError, describeError } from './errors.js';
import { logger } from './logger.js';
import { startRuntime } from './startup.js';

async function main(): Promise<void> {
  const runtime = await startRuntime();

  let exiting = false;
  const stop = async (reason: string, exitCode: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    try {
      await runtime.shutdown(reason);
    } finally {
      process.exit(exitCode);
    }
  };

  process.on('SIGINT', () => void stop('SIGINT', 0));
  process.on('SIGTERM', () => void stop('SIGTERM', 0));
  process.on('uncaughtException', (error) => {
    logger.error('service.uncaught_exception', { name: error.name, message: error.message });
    void stop('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('service.unhandled_rejection', { reason: describeError(reason).message });
    void stop('unhandledRejection', 1);
  });
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
