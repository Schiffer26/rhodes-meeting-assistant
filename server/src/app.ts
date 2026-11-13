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
import { LoginRateLimiter } from './auth/rateLimit.js';
import { createAdminRouter } from './http/adminRoutes.js';
import { createAuthRouter } from './http/authRoutes.js';
import { createHealthHandler } from './http/health.js';
import { errorHandler, notFoundHandler, requestContext } from './http/middleware.js';

export interface AppDependencies {
  readonly db: RhodesDatabase;
  /** Injectable for deterministic tests. */
  readonly uptimeSeconds?: () => number;
  /** Injectable clock: session expiry and audit timestamps. */
  readonly now?: () => Date;
  /** Injectable throttling state, so tests can run with a deterministic clock. */
  readonly rateLimiter?: LoginRateLimiter;
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

  // Small, strict JSON bodies. Authentication payloads are a few hundred bytes; 16 kB is
  // generous for a username and a passphrase and small enough that a malformed or hostile
  // body cannot cost much. A larger body is refused with 413, malformed JSON with 400.
  app.use(express.json({ limit: '16kb', strict: true, type: 'application/json' }));

  // Public: liveness and database readiness only.
  app.get('/api/health', createHealthHandler({ db: deps.db, uptimeSeconds: deps.uptimeSeconds }));

  const now = deps.now ?? (() => new Date());
  const limiter = deps.rateLimiter ?? new LoginRateLimiter();

  app.use('/api/auth', createAuthRouter({ db: deps.db, now, limiter }));
  app.use('/api/admin', createAdminRouter({ db: deps.db, now }));

  // Business endpoints (meetings, personnel, notes) do not exist yet. Everything else is
  // a 404, including any unauthenticated data path.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
