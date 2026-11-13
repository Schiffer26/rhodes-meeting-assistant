/**
 * RHODES API · HTTP middleware
 *
 * Three responsibilities, in order: give every request an id, log the outcome, and
 * turn a thrown error into a response that reveals nothing about the host.
 */

import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { AppError, describeError } from '../errors.js';
import { logger } from '../logger.js';

export interface RequestWithContext extends Request {
  requestId?: string;
}

/** Attach an id, then log one line when the response is finished. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  (req as RequestWithContext).requestId = requestId;
  res.setHeader('x-request-id', requestId);
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // `req.path` only: a query string may carry values that should not be logged.
    logger.info('http.request', {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    });
  });

  next();
}

/** Anything without a route is a 404 in the same JSON shape as every other error. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'http.not_found',
      message: 'No such endpoint.',
      requestId: (req as RequestWithContext).requestId ?? null,
    },
  });
}

/**
 * Terminal error handler.
 *
 * Express recognises this as error middleware by its four parameters — do not
 * simplify the signature. `next` is unused but required.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = (req as RequestWithContext).requestId ?? null;
  // An error response is never cacheable, on any route, including the 401/403 answers
  // produced by the authentication middleware.
  if (!res.headersSent) res.setHeader('cache-control', 'no-store');
  const described = describeError(error);

  // Body-parser failures arrive as plain errors with a `type`. They are client mistakes,
  // not server faults, and must not surface as 500.
  const bodyError = error as { type?: string } | null;
  if (bodyError?.type === 'entity.parse.failed') {
    logger.warn('http.invalid_json', { requestId });
    if (res.headersSent) return;
    res.status(400).json({
      error: { code: 'http.invalid_json', message: 'The request body is not valid JSON.', requestId },
    });
    return;
  }
  if (bodyError?.type === 'entity.too.large') {
    logger.warn('http.payload_too_large', { requestId });
    if (res.headersSent) return;
    res.status(413).json({
      error: { code: 'http.payload_too_large', message: 'The request body is too large.', requestId },
    });
    return;
  }

  if (error instanceof AppError) {
    logger.error('http.error', {
      requestId,
      code: error.code,
      message: error.message,
      status: error.httpStatus,
      details: error.details,
    });
    if (res.headersSent) return;
    res.status(error.httpStatus).json({
      error: {
        code: error.code,
        // Only an error marked safe may speak for itself.
        message: error.isSafeToExpose ? error.message : 'The request could not be completed.',
        requestId,
      },
    });
    return;
  }

  logger.error('http.unhandled_error', { requestId, name: described.name, message: described.message });
  if (res.headersSent) return;
  res.status(500).json({
    error: {
      code: 'http.internal_error',
      message: 'The request could not be completed.',
      requestId,
    },
  });
}
