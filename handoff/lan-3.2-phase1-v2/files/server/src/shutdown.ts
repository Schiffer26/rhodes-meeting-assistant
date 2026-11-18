/**
 * RHODES API · shutdown reporting and the exit-code contract
 *
 * The process has exactly three ways to end, and each has one code:
 *
 *   0   every required shutdown operation succeeded
 *   69  shutdown ran, but the checkpoint or the database connection did not complete
 *   1   startup failure, or a fatal application fault
 *
 * "Shutdown ran" is not the same as "shutdown succeeded" — that distinction is the whole
 * point of this module. The final line is written with a *synchronous* stdout write,
 * because a Windows service host reads it to classify the shutdown and `process.exit()`
 * can drop buffered pipe writes. Writing first and exiting afterwards is what makes the
 * classification reliable.
 */

import { writeSync } from 'node:fs';

import { describeError } from './errors.js';
import { logger } from './logger.js';
import type { Runtime, ShutdownResult } from './startup.js';

export const EXIT_OK = 0;
export const EXIT_SHUTDOWN_INCOMPLETE = 69;
export const EXIT_FATAL = 1;

export const SHUTDOWN_COMPLETE_MESSAGE = 'service.shutdown_complete';

/** Writes one already-formatted line. Injected so tests never write to real stdout. */
export type LineWriter = (line: string) => void;

/**
 * The default writer: a blocking write to fd 1.
 *
 * Synchronous on purpose. Every other log line may be buffered; this one may not, so it
 * is flushed before the process is allowed to exit. A closed or broken stdout is
 * swallowed: reporting is best-effort, exiting is not.
 */
export function writeStdoutSync(line: string): void {
  try {
    writeSync(1, line.endsWith('\n') ? line : `${line}\n`);
  } catch {
    // stdout is gone (host died, pipe closed). Nothing left to report to.
  }
}

/**
 * Combine the requested code with what shutdown actually achieved.
 *
 * A fatal or fault-triggered exit keeps its code: an uncaught exception must never be
 * reported as a clean stop just because the shutdown itself went well. A requested stop
 * (code 0) downgrades to 69 when any shutdown stage failed.
 */
export function exitCodeFor(requestedCode: number, ok: boolean): number {
  if (requestedCode !== EXIT_OK) return requestedCode;
  return ok ? EXIT_OK : EXIT_SHUTDOWN_INCOMPLETE;
}

export interface ShutdownReport {
  result: ShutdownResult;
  exitCode: number;
  message: Record<string, unknown>;
}

const FAILED_RESULT: ShutdownResult = {
  listenerClosed: false,
  checkpointed: false,
  databaseClosed: false,
  ok: false,
};

/**
 * Run the shutdown, emit the single final structured line, and return the exit code.
 *
 * The line contains all four facts plus the code, so a reader never has to infer one
 * from another: `database.closed` alone says nothing about the listener or the
 * checkpoint, and is deliberately not enough to call a shutdown clean.
 */
export async function performShutdown(options: {
  runtime: Pick<Runtime, 'shutdown'>;
  reason: string;
  requestedCode: number;
  write?: LineWriter;
}): Promise<ShutdownReport> {
  const write = options.write ?? writeStdoutSync;

  let result: ShutdownResult;
  try {
    result = await options.runtime.shutdown(options.reason);
  } catch (error) {
    logger.error('service.shutdown_failed', { reason: describeError(error).message });
    result = FAILED_RESULT;
  }

  const exitCode = exitCodeFor(options.requestedCode, result.ok);

  const message = {
    level: result.ok ? 'info' : 'error',
    time: new Date().toISOString(),
    msg: SHUTDOWN_COMPLETE_MESSAGE,
    reason: options.reason,
    listenerClosed: result.listenerClosed,
    checkpointed: result.checkpointed,
    databaseClosed: result.databaseClosed,
    ok: result.ok,
    exitCode,
  };

  write(JSON.stringify(message));
  return { result, exitCode, message };
}
