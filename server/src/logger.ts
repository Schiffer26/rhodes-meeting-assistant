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

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg: message,
    ...fields,
  });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};
