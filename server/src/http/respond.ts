/**
 * RHODES API · response helpers
 *
 * The error envelope used everywhere in this service. Authentication and authorisation
 * middleware answer directly (they run before a route can throw), so they need the same
 * shape as the terminal error handler — including the request id that ties the response
 * to the log line.
 */

import type { NextFunction, Request, Response } from 'express';

export interface RequestWithContext extends Request {
  requestId?: string;
}

export function sendError(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  const requestId = (req as RequestWithContext).requestId ?? null;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader('cache-control', 'no-store');
  res.status(status).json({ error: { code, message, requestId } });
}

/** Nothing under /api/auth or /api/admin may be cached by any layer. */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');
  next();
}
