/**
 * RHODES API · logging
 *
 * One JSON object per line on stdout/stderr, because that is what a Windows service
 * wrapper and an operator's log file can both consume without a parser. Deliberately
 * tiny: no logging framework is justified for four levels and a stable shape.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function readLevel(): LogLevel {
  const raw = (process.env.RHODES_LOG_LEVEL ?? '').trim().toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

let threshold = readLevel();

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export type LogFields = Record<string, unknown>;

/**
 * Where a finished log line goes: the process streams in production, an in-memory buffer
 * in tests.
 *
 * A `level` and the already-serialised `line` (without the trailing newline) is the whole
 * contract, which keeps the sink free to route warn/error differently or to drop a line.
 */
export type LogSink = (level: LogLevel, line: string) => void;

/** The default destination: one JSON object per line, errors and warnings on stderr. */
function writeToStreams(level: LogLevel, line: string): void {
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

let sink: LogSink = writeToStreams;

/**
 * Redirect every log line and return a restore function.
 *
 * Tests use this instead of replacing `process.stdout.write`, which would also swallow the
 * test runner's own output (Node reads a child's TAP report from stdout, so patching it
 * makes tests vanish from the count). Restore functions are idempotent and nest, so a test
 * can wrap another capture without losing its own.
 */
export function installLogSink(next: LogSink): () => void {
  const previous = sink;
  sink = next;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    sink = previous;
  };
}

/** The sink currently installed. Exposed for tests that assert the default routing. */
export function currentLogSink(): LogSink {
  return sink;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg: message,
    ...fields,
  });
  sink(level, line);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};
