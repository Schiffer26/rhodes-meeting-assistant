/**
 * RHODES API · Express application
 *
 * Deliberately minimal: one endpoint, no CORS, no static files, no body parser, no
 * session middleware. Anything added here must justify itself against the phase
 * requirement to avoid unnecessary frameworks and unauthenticated surface area.
 *
 * On CORS: no `Access-Control-Allow-*` header is ever emitted. A browser page from
 * another origin therefore cannot read this API, which is the intended behaviour. When
 * the frontend is connected in a later phase it will be served from this same origin
 * (or an explicitly allow-listed one) — not opened up with a wildcard.
 */

import express, { type Express } from 'express';

import type { RhodesDatabase } from './db/index.js';
import { createHealthHandler } from './http/health.js';
import { errorHandler, notFoundHandler, requestContext } from './http/middleware.js';

export interface AppDependencies {
  readonly db: RhodesDatabase;
  /** Injectable for deterministic tests. */
  readonly uptimeSeconds?: () => number;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  // Advertise nothing about the stack.
  app.disable('x-powered-by');
  // No ETag: health responses are never cached, and entity tags would only leak
  // information about response content across requests.
  app.set('etag', false);
  app.set('trust proxy', false);

  app.use(requestContext);

  app.get('/api/health', createHealthHandler({ db: deps.db, uptimeSeconds: deps.uptimeSeconds }));

  // No data endpoints exist in this phase. Everything else is a 404.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
