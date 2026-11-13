/**
 * RHODES · structured errors
 *
 * Every failure the backend produces carries a stable machine-readable `code`.
 * Error codes are part of the operational contract: they appear in logs, in tests,
 * and (only when safe) in HTTP responses. They are never built from user input.
 *
 * `expose` decides whether the message may leave the process. Anything that could
 * leak a filesystem path, a SQL string, or configuration stays server-side; the
 * client sees a generic message plus the code.
 */

export type ErrorExposure = 'safe' | 'internal';

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly exposure: ErrorExposure;
  /** Extra server-side context for the log line. Never sent to a client. */
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    options: {
      httpStatus?: number;
      exposure?: ErrorExposure;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = options.httpStatus ?? 500;
    this.exposure = options.exposure ?? 'internal';
    this.details = options.details;
  }

  /** True when the message may be returned to a caller verbatim. */
  get isSafeToExpose(): boolean {
    return this.exposure === 'safe';
  }
}

/**
 * Configuration problems. Always safe to print: they are produced at startup,
 * before any request exists, and are written to the operator's stderr.
 */
export class ConfigError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, { httpStatus: 500, exposure: 'safe', details });
  }
}

/** Database-layer problems: internal by default (paths and SQL stay in the log). */
export class DatabaseError extends AppError {
  constructor(
    code: string,
    message: string,
    options: { exposure?: ErrorExposure; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(code, message, { httpStatus: 503, ...options });
  }
}

/** Migration problems are operator-facing: they are safe to expose at startup. */
export class MigrationError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, { httpStatus: 500, exposure: 'safe', details });
  }
}

/** Narrow an unknown thrown value to something loggable. */
export function describeError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof AppError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'UnknownThrownValue', message: String(error) };
}
