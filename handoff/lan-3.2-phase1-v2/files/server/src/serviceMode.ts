/**
 * RHODES API · service-mode control channel and process wiring
 *
 * Two jobs, both deliberately separated from `index.ts` so they can be tested without
 * spawning a process:
 *
 *   1. `attachServiceMode` — an opt-in stdin control channel. It exists only when
 *      `RHODES_SERVICE_MODE` is explicitly enabled, so ordinary development runs are
 *      untouched (a developer typing into the terminal must never shut the server down).
 *   2. `wireLifecycle` — register the process handlers, attach the control channel, and
 *      only then announce `service.ready`.
 *
 * The order in `wireLifecycle` is the contract: `service.listening` (emitted by
 * `startup.ts`) proves the listener bound; `service.ready` proves the process is fully
 * wired — database up, migrations applied, listener bound, control channel attached and
 * every signal/fault handler registered. A Windows service host waits for the latter.
 *
 * Control protocol, one JSON object per line on stdin:
 *
 *   {"cmd":"shutdown"}      -> graceful shutdown, exit 0 (or 69 if a stage failed)
 *
 * Anything else — malformed JSON, an unknown command, a line longer than 4096 bytes —
 * is logged and ignored. Repeated commands are idempotent: the second one is recorded
 * and dropped, never a second shutdown sequence.
 */

import type { EnvSource } from './config.js';
import { describeError } from './errors.js';
import { logger } from './logger.js';
import type { Runtime } from './startup.js';

/** Enables the stdin control channel. Anything else keeps it disabled. */
export const SERVICE_MODE_ENV = 'RHODES_SERVICE_MODE';

/** Longest control line accepted, in bytes. Anything larger is discarded unread. */
export const MAX_CONTROL_LINE_BYTES = 4096;

/** The only command the channel accepts. */
export const SHUTDOWN_COMMAND = 'shutdown';

export function isServiceModeEnabled(env: EnvSource = process.env): boolean {
  const raw = (env[SERVICE_MODE_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * The slice of a readable stream this module needs. `process.stdin` satisfies it; a
 * `PassThrough` in a test satisfies it too.
 */
export interface ControlInput {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

/** Minimal emitter surface, so lifecycle wiring can be tested on a fake emitter. */
export interface LifecycleEmitter {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface ServiceModeController {
  readonly enabled: boolean;
  detach(): void;
}

const DISABLED: ServiceModeController = { enabled: false, detach: () => {} };

/**
 * Attach the stdin control channel.
 *
 * Returns a controller whose `enabled` reflects the environment, and whose `detach`
 * removes every listener it added (used by tests, and by a shutdown that wants the loop
 * to drain instead of staying alive on stdin).
 */
export function attachServiceMode(options: {
  stdin: ControlInput;
  requestShutdown: (reason: string) => void;
  env?: EnvSource;
}): ServiceModeController {
  if (!isServiceModeEnabled(options.env ?? process.env)) return DISABLED;

  const stdin = options.stdin;
  let buffer = '';
  let requested = false;

  const reject = (reason: string): void => {
    logger.warn('service.stdin_rejected', { reason });
  };

  const request = (reason: string): void => {
    if (requested) {
      logger.warn('service.stdin_ignored', { reason: 'a shutdown was already requested' });
      return;
    }
    requested = true;
    logger.info('service.control_received', { reason });
    options.requestShutdown(reason);
  };

  const handleLine = (line: string): void => {
    if (line.trim().length === 0) return;
    if (Buffer.byteLength(line, 'utf8') > MAX_CONTROL_LINE_BYTES) {
      reject('oversized');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      reject('malformed');
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      reject('malformed');
      return;
    }

    // Exactly one property, exactly the documented command: no room for a payload that
    // a future version might interpret differently.
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 1 || keys[0] !== 'cmd' || record.cmd !== SHUTDOWN_COMMAND) {
      reject('unknown_command');
      return;
    }

    request('stdin');
  };

  const onData = (chunk: unknown): void => {
    buffer += typeof chunk === 'string' ? chunk : String(chunk);

    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
      newline = buffer.indexOf('\n');
    }

    // A line that never ends must not grow without bound: drop it and say so.
    if (buffer.length > MAX_CONTROL_LINE_BYTES) {
      buffer = '';
      reject('oversized');
    }
  };

  const onEnd = (): void => {
    // The host went away without asking us to stop. It is not an error in this process,
    // but it is never silent: shut down now rather than idling as an orphan.
    logger.warn('service.stdin_eof', { reason: 'the control channel closed unexpectedly' });
    request('stdin-eof');
  };

  const onError = (error: unknown): void => {
    logger.warn('service.stdin_error', { reason: describeError(error).message });
    request('stdin-error');
  };

  stdin.setEncoding?.('utf8');
  stdin.on('data', onData);
  stdin.on('end', onEnd);
  stdin.on('error', onError);
  stdin.resume?.();

  logger.info('service.mode', {
    control: 'stdin',
    maxLineBytes: MAX_CONTROL_LINE_BYTES,
    command: SHUTDOWN_COMMAND,
  });

  return {
    enabled: true,
    detach(): void {
      const remove = stdin.off ?? stdin.removeListener;
      remove?.call(stdin, 'data', onData as (...args: any[]) => void);
      remove?.call(stdin, 'end', onEnd as (...args: any[]) => void);
      remove?.call(stdin, 'error', onError as (...args: any[]) => void);
      stdin.pause?.();
      buffer = '';
    },
  };
}

export interface WireLifecycleOptions {
  runtime: Pick<Runtime, 'config' | 'running'>;
  stdin: ControlInput;
  emitter: LifecycleEmitter;
  /** The single shutdown entry point; must itself be idempotent. */
  stop: (reason: string, requestedCode: number) => void;
  env?: EnvSource;
}

/**
 * Register every process handler, attach the control channel, then announce readiness.
 *
 * `service.ready` is emitted last and only here: everything a host needs to be able to
 * rely on already exists by the time the line is written.
 */
export function wireLifecycle(options: WireLifecycleOptions): {
  serviceMode: boolean;
  /**
   * Detach the control channel. A shutdown calls this so a resumed stdin cannot keep the
   * event loop alive after the final line has been written.
   */
  detach: () => void;
} {
  const { emitter, stop } = options;

  emitter.on('SIGINT', (() => stop('SIGINT', 0)) as (...args: any[]) => void);
  emitter.on('SIGTERM', (() => stop('SIGTERM', 0)) as (...args: any[]) => void);
  emitter.on('uncaughtException', ((error: unknown) => {
    const described = describeError(error);
    logger.error('service.uncaught_exception', { name: described.name, message: described.message });
    stop('uncaughtException', 1);
  }) as (...args: any[]) => void);
  emitter.on('unhandledRejection', ((reason: unknown) => {
    logger.error('service.unhandled_rejection', { reason: describeError(reason).message });
    stop('unhandledRejection', 1);
  }) as (...args: any[]) => void);

  const controller = attachServiceMode({
    stdin: options.stdin,
    requestShutdown: (reason) => stop(reason, 0),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  logger.info('service.ready', {
    pid: process.pid,
    serviceMode: controller.enabled,
    transport: options.runtime.config.transport,
    host: options.runtime.config.host,
    port: options.runtime.running.port,
    url: options.runtime.running.url,
    databasePath: options.runtime.config.databasePath,
  });

  return { serviceMode: controller.enabled, detach: () => controller.detach() };
}
