/**
 * RHODES API · authentication endpoints
 *
 *   POST /api/auth/login            sign in, receive a token once
 *   POST /api/auth/logout           revoke the current session
 *   GET  /api/auth/me               current account profile
 *   POST /api/auth/change-password  set a new password, revoke all sessions
 *
 * Everything here is `Cache-Control: no-store`, and nothing a caller sends is echoed in
 * a response or written to a log.
 */

import { Router } from 'express';

import type { RhodesDatabase } from '../db/index.js';
import { currentAuth, requireAuth } from '../auth/middleware.js';
import {
  changeOwnPassword,
  findByUsername,
  toAccountSummary,
} from '../auth/accounts.js';
import { recordAudit } from '../auth/audit.js';
import {
  currentPasswordIncorrect,
  invalidCredentials,
  invalidRequest,
  tooManyAttempts,
} from '../auth/errors.js';
import { hashPassword, verifyAgainstDummyHash, verifyPassword } from '../auth/password.js';
import { normalizeUsername, validatePassword } from '../auth/policy.js';
import { LoginRateLimiter } from '../auth/rateLimit.js';
import { createSession, purgeExpiredSessions, revokeSession } from '../auth/sessions.js';
import { noStore } from './respond.js';

export interface AuthRouteDeps {
  readonly db: RhodesDatabase;
  readonly now: () => Date;
  readonly limiter: LoginRateLimiter;
}

interface CredentialsBody {
  username?: unknown;
  password?: unknown;
}

export function createAuthRouter(deps: AuthRouteDeps): Router {
  const router = Router();
  router.use(noStore);

  const authenticate = requireAuth({ db: deps.db.handle, now: deps.now });

  router.post('/login', async (req, res) => {
    const body = (req.body ?? {}) as CredentialsBody;
    if (typeof body.username !== 'string' || typeof body.password !== 'string') {
      throw invalidRequest('A username and a password are required.');
    }

    // Normalising before limiting means `Amara` and `amara` share one allowance, so
    // changing the capitalisation does not reset the counter.
    const normalized = normalizeUsername(body.username);
    const address = req.ip ?? 'unknown';
    const db = deps.db.handle;

    const verdict = deps.limiter.check(normalized, address);
    if (!verdict.allowed) {
      res.setHeader('retry-after', String(verdict.retryAfterSeconds));
      throw tooManyAttempts(verdict.retryAfterSeconds);
    }

    deps.limiter.prune();
    const account = findByUsername(db, normalized);

    if (!account) {
      // Spend the same work as a real verification so the response time does not reveal
      // whether the username exists, then fail identically.
      await verifyAgainstDummyHash(body.password);
      deps.limiter.recordFailure(normalized, address);
      throw invalidCredentials();
    }

    const passwordMatches = await verifyPassword(body.password, account.password_hash);

    // A disabled account is checked *after* the password, and answers exactly like a
    // wrong password: no "your account is disabled" message that would confirm the
    // username exists.
    if (!passwordMatches || account.status !== 'active') {
      deps.limiter.recordFailure(normalized, address);
      recordAudit(db, {
        action: 'auth.login_failed',
        entity: 'user_account',
        entityKey: account.public_id,
        outcome: 'denied',
      });
      throw invalidCredentials();
    }

    deps.limiter.recordSuccess(normalized);
    purgeExpiredSessions(db, deps.now().toISOString());

    const session = createSession(db, account.id, deps.now());
    recordAudit(db, {
      action: 'auth.login',
      entity: 'user_account',
      entityKey: account.public_id,
      actor: account.public_id,
      detail: { expiresAt: session.expiresAt },
    });

    // The raw token leaves the process here, once. It is never logged, audited or stored.
    res.status(200).json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: {
        publicId: account.public_id,
        username: account.username,
        role: account.role,
      },
      mustChangePassword: account.must_change_password === 1,
    });
  });

  router.post('/logout', authenticate, (req, res) => {
    const auth = currentAuth(req);
    const db = deps.db.handle;
    const revoked = revokeSession(db, auth.sessionId, 'logout', deps.now().toISOString());
    recordAudit(db, {
      action: 'auth.logout',
      entity: 'user_session',
      entityKey: auth.publicId,
      actor: auth.publicId,
      detail: { revoked },
    });
    res.status(200).json({ revoked });
  });

  router.get('/me', authenticate, (req, res) => {
    const auth = currentAuth(req);
    const db = deps.db.handle;
    // Read again rather than trusting the context: the flag may have changed since the
    // token was presented.
    const account = findByUsername(db, auth.username);
    if (!account) {
      res.status(200).json({
        user: { publicId: auth.publicId, username: auth.username, role: auth.role },
        status: auth.status,
        mustChangePassword: auth.mustChangePassword,
        session: { expiresAt: auth.sessionExpiresAt },
      });
      return;
    }
    res.status(200).json({
      user: toAccountSummary(account),
      session: { expiresAt: auth.sessionExpiresAt },
    });
  });

  router.post('/change-password', authenticate, async (req, res) => {
    const auth = currentAuth(req);
    const body = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
      throw invalidRequest('The current password and a new password are required.');
    }

    const db = deps.db.handle;
    const account = findByUsername(db, auth.username);
    if (!account) throw invalidCredentials();

    if (!(await verifyPassword(body.currentPassword, account.password_hash))) {
      throw currentPasswordIncorrect();
    }

    // Full policy applies to the new password, including the length ceiling: an
    // over-long input is refused here, before scrypt is ever invoked.
    validatePassword(body.newPassword);
    const passwordHash = await hashPassword(body.newPassword);

    // Every session dies, including this one. The caller must sign in again with the new
    // password, which is what proves the change reached them.
    const sessionsRevoked = changeOwnPassword(db, {
      accountId: account.id,
      passwordHash,
      actorPublicId: auth.publicId,
      now: deps.now().toISOString(),
    });

    res.status(200).json({ changed: true, sessionsRevoked });
  });

  return router;
}
