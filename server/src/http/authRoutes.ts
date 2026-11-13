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
 *
 * ── oversized passwords never reach the key derivation (LAN-2.1 correction) ─
 *
 * The password ceiling is enforced on the sign-in path, before any account lookup and
 * before any scrypt call. An oversized value cannot match a stored password — every
 * stored one is capped at the same length — so hashing it would only burn a KDF slot.
 * The attempt is counted against the login throttle and answered with the same generic
 * failure as any other wrong credential, whether or not the username exists, so nothing
 * about the account is revealed by the shape of the response.
 *
 * ── a session is only issued against the account as it is *now* (LAN-2.1a) ────
 *
 * `verifyPassword` is asynchronous, and an administrator can disable the account or reset
 * its password while it runs. Such an operation revokes every session the account holds —
 * so the sign-in that was already in flight must not then create a fresh one. The token is
 * therefore issued inside `completeLogin`: one transaction that re-reads the row, compares
 * it with the hash and version that were verified, and inserts the session only if they
 * still agree. A refusal is the same generic `401`, counts against the throttle, and is
 * recorded best-effort; the response never says which check failed.
 */

import { Router } from 'express';

import type { RhodesDatabase } from '../db/index.js';
import { currentAuth, requireAuth } from '../auth/middleware.js';
import {
  changeOwnPassword,
  completeLogin,
  findByUsername,
  toAccountSummary,
  type ActorHandle,
} from '../auth/accounts.js';
import { recordAudit } from '../auth/audit.js';
import {
  currentPasswordIncorrect,
  invalidCredentials,
  invalidRequest,
  tooManyAttempts,
} from '../auth/errors.js';
import { hashPassword, verifyAgainstDummyHash, verifyPassword } from '../auth/password.js';
import { normalizeUsername, passwordExceedsLimit, validatePassword } from '../auth/policy.js';
import { LoginRateLimiter } from '../auth/rateLimit.js';
import { purgeExpiredSessions, revokeSession } from '../auth/sessions.js';
import { noStore } from './respond.js';

export interface AuthRouteDeps {
  readonly db: RhodesDatabase;
  readonly now: () => Date;
  readonly limiter: LoginRateLimiter;
  /**
   * Key derivation for a new password. Injectable so a test can perform a concurrent
   * security operation at exactly the moment the route is awaiting the hash, instead of
   * guessing with sleeps.
   */
  readonly passwordHasher?: (password: string) => Promise<string>;
  /**
   * Verification of a submitted password. Injectable for the same reason: a test can
   * perform a concurrent security operation at exactly the moment the sign-in route is
   * awaiting the result, instead of guessing with sleeps.
   */
  readonly passwordVerifier?: (password: string, encodedHash: string) => Promise<boolean>;
}

interface CredentialsBody {
  username?: unknown;
  password?: unknown;
}

export function createAuthRouter(deps: AuthRouteDeps): Router {
  const router = Router();
  router.use(noStore);

  const hasher = deps.passwordHasher ?? hashPassword;
  const verifier = deps.passwordVerifier ?? verifyPassword;
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

    // The ceiling, before the account is even looked up. No account lookup means no
    // difference between a real and an unknown username, and no key derivation means an
    // oversized value (a megabyte of text, say) costs a few microseconds instead of
    // occupying a hashing slot.
    if (passwordExceedsLimit(body.password)) {
      deps.limiter.recordFailure(normalized, address);
      recordAudit(db, {
        action: 'auth.login_failed',
        entity: 'user_account',
        entityKey: null,
        outcome: 'denied',
        // The value itself is never recorded, only that it was over the limit.
        detail: { reason: 'password_over_limit' },
      });
      throw invalidCredentials();
    }

    const account = findByUsername(db, normalized);

    if (!account) {
      // Spend the same work as a real verification so the response time does not reveal
      // whether the username exists, then fail identically. If the KDF pool is saturated
      // this raises 503 here exactly as it would for a real account.
      await verifyAgainstDummyHash(body.password);
      deps.limiter.recordFailure(normalized, address);
      throw invalidCredentials();
    }

    const passwordMatches = await verifier(body.password, account.password_hash);

    if (!passwordMatches) {
      deps.limiter.recordFailure(normalized, address);
      recordAudit(db, {
        action: 'auth.login_failed',
        entity: 'user_account',
        entityKey: account.public_id,
        outcome: 'denied',
      });
      throw invalidCredentials();
    }

    // The await above is a window, and this one matters: an administrator can disable the
    // account or reset its password while the derivation runs, revoking every session the
    // account had — and a session created from the *stale* row would then be the one live
    // session nobody revoked. The repository re-reads the row and inserts the session in a
    // single transaction, so either both happen against the current state or neither
    // happens at all.
    const completion = completeLogin(db, {
      accountId: account.id,
      expectedPasswordHash: account.password_hash,
      expectedRowVersion: account.row_version,
      now: deps.now(),
    });

    if (!completion.ok) {
      // Disabled, reset, re-enabled or otherwise changed since the row was read: the same
      // generic answer, the same throttle accounting, and no hint about which it was.
      deps.limiter.recordFailure(normalized, address);
      recordAudit(db, {
        action: 'auth.login_failed',
        entity: 'user_account',
        entityKey: account.public_id,
        outcome: 'denied',
        detail: { reason: 'account_changed_during_login' },
      });
      throw invalidCredentials();
    }

    // Everything below comes from the revalidated row, never from the pre-verification
    // snapshot: the token, the role and the must-change flag all describe the account as
    // it was at the moment the session was created.
    const fresh = completion.account;
    const session = completion.session;

    deps.limiter.recordSuccess(normalized);
    purgeExpiredSessions(db, deps.now().toISOString());

    recordAudit(db, {
      action: 'auth.login',
      entity: 'user_account',
      entityKey: fresh.public_id,
      actor: fresh.public_id,
      detail: { expiresAt: session.expiresAt },
    });

    // The raw token leaves the process here, once. It is never logged, audited or stored.
    res.status(200).json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: {
        publicId: fresh.public_id,
        username: fresh.username,
        role: fresh.role,
      },
      mustChangePassword: fresh.must_change_password === 1,
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

    // Same ceiling on the value being *verified*: no stored password is this long, so
    // hashing it would be pure waste.
    if (passwordExceedsLimit(body.currentPassword)) throw currentPasswordIncorrect();

    if (!(await verifyPassword(body.currentPassword, account.password_hash))) {
      throw currentPasswordIncorrect();
    }

    // Full policy applies to the new password, including the length ceiling: an
    // over-long input is refused here, before scrypt is ever invoked.
    validatePassword(body.newPassword);
    const passwordHash = await hasher(body.newPassword);

    // The await above is a window: an administrator may have reset this password, or the
    // session may have been revoked. Both are rechecked inside the write transaction,
    // against the hash that was actually verified above.
    const sessionsRevoked = changeOwnPassword(db, {
      accountId: account.id,
      sessionId: auth.sessionId,
      expectedPasswordHash: account.password_hash,
      newPasswordHash: passwordHash,
      actorPublicId: auth.publicId,
      now: deps.now().toISOString(),
    });

    res.status(200).json({ changed: true, sessionsRevoked });
  });

  return router;
}

/** Build the revalidation handle from the authenticated request context. */
export function actorFrom(req: Parameters<typeof currentAuth>[0]): ActorHandle {
  const auth = currentAuth(req);
  return { accountId: auth.accountId, sessionId: auth.sessionId, publicId: auth.publicId };
}
