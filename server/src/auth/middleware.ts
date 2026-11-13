/**
 * RHODES API · authentication and authorisation middleware
 *
 * Two rules govern everything here:
 *
 *   1. The account is read from the database on every protected request. Roles are not
 *      carried in the token, so a disabled account or a changed role takes effect on the
 *      next request rather than at the next login.
 *   2. Nothing the client sends is trusted except the bearer token itself. There is no
 *      header, query parameter or body field that can assert a role.
 *
 * Status codes are deliberate:
 *   · 401 — we do not know who you are (missing, malformed, unknown, expired or revoked
 *     token), or the account is disabled;
 *   · 403 — we know who you are, but not for this.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { Db } from '../db/index.js';
import type { AccountStatus, Role } from './accounts.js';
import { forbidden, passwordChangeRequired, unauthenticated } from './errors.js';
import { authenticateSession } from './sessions.js';
import { sendError } from '../http/respond.js';

/** A 32-byte token in base64url is exactly 43 characters. Anything else is malformed. */
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]{43})$/;

export interface AuthContext {
  readonly accountId: number;
  readonly publicId: string;
  readonly username: string;
  readonly role: Role;
  readonly status: AccountStatus;
  readonly mustChangePassword: boolean;
  readonly sessionId: number;
  readonly sessionExpiresAt: string;
}

export interface RequestWithAuth extends Request {
  auth?: AuthContext;
}

/**
 * Strict bearer parsing.
 *
 * Exactly one space, exactly the `Bearer` scheme, exactly a well-formed token. Tokens are
 * never accepted from a query string or a body field: credentials in a URL end up in
 * logs, histories and referrers.
 */
export function parseBearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  // No trimming: surrounding whitespace means the client built the header wrongly, and
  // an auth header is exactly the wrong place to be relaxed about what is accepted.
  const match = BEARER_PATTERN.exec(header);
  return match?.[1] ?? null;
}

export interface RequireAuthDeps {
  readonly db: Db;
  /** Injectable clock so session expiry can be tested without waiting eight hours. */
  readonly now?: () => Date;
}

export function requireAuth(deps: RequireAuthDeps): RequestHandler {
  const now = deps.now ?? (() => new Date());

  return function authenticate(req: Request, res: Response, next: NextFunction): void {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendError(req, res, 401, 'auth.unauthenticated', 'Authentication is required.');
      return;
    }

    // The token is hashed before it touches the database: the lookup key is the hash, and
    // a raw token never appears in a query, a log or a plan.
    const session = authenticateSession(deps.db, token, now().toISOString());
    if (!session) {
      sendError(req, res, 401, 'auth.unauthenticated', 'Authentication is required.');
      return;
    }

    (req as RequestWithAuth).auth = {
      accountId: session.account.id,
      publicId: session.account.public_id,
      username: session.account.username,
      role: session.account.role,
      status: session.account.status,
      mustChangePassword: session.account.must_change_password === 1,
      sessionId: session.sessionId,
      sessionExpiresAt: session.expiresAt,
    };
    next();
  };
}

export function requireRole(role: Role): RequestHandler {
  return function authorise(req: Request, res: Response, next: NextFunction): void {
    const auth = (req as RequestWithAuth).auth;
    if (!auth) {
      sendError(req, res, 401, 'auth.unauthenticated', 'Authentication is required.');
      return;
    }
    if (auth.role !== role) {
      const error = forbidden();
      sendError(req, res, error.httpStatus, error.code, error.message);
      return;
    }
    next();
  };
}

/**
 * Keep temporary-password accounts out of everything except authentication itself and
 * the password-change endpoint. The check reads the flag from the database on each
 * request, so clearing it takes effect immediately.
 */
export function requirePasswordChanged(): RequestHandler {
  return function passwordChanged(req: Request, res: Response, next: NextFunction): void {
    const auth = (req as RequestWithAuth).auth;
    if (!auth) {
      sendError(req, res, 401, 'auth.unauthenticated', 'Authentication is required.');
      return;
    }
    if (auth.mustChangePassword) {
      const error = passwordChangeRequired();
      sendError(req, res, error.httpStatus, error.code, error.message);
      return;
    }
    next();
  };
}

export function currentAuth(req: Request): AuthContext {
  const auth = (req as RequestWithAuth).auth;
  if (!auth) throw unauthenticated();
  return auth;
}
