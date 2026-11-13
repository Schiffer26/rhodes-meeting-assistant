/**
 * RHODES API · sessions
 *
 * A session is a random 32-byte token (256 bits from `crypto.randomBytes`) that the
 * client holds and the server stores only as a SHA-256 hash. Presenting the token
 * proves possession; the hash in SQLite proves nothing to whoever reads the file.
 *
 * Lifecycle:
 *   · created on a successful login, absolute expiry eight hours later (no sliding
 *     renewal — a session cannot be kept alive indefinitely by using it);
 *   · revoked on logout, on password change, on password reset, on administrator
 *     recovery, on role change, and when the account is disabled;
 *   · expired or revoked rows are deleted as operational state. Security history lives
 *     in `audit_records`, which is append-only and never touched by cleanup.
 */

import { randomBytes } from 'node:crypto';

import type { Db } from '../db/index.js';
import { sha256Hex } from './password.js';
import type { AccountRow } from './accounts.js';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_TOKEN_BYTES = 32;

export type RevocationReason =
  | 'logout'
  | 'password_change'
  | 'password_reset'
  | 'admin_recovery'
  | 'role_change'
  | 'account_disabled'
  | 'expired_cleanup';

export interface IssuedSession {
  /** The raw token. Returned to the client once and never stored. */
  readonly token: string;
  readonly publicId: string;
  readonly sessionId: number;
  readonly expiresAt: string;
}

export interface AuthenticatedSession {
  readonly sessionId: number;
  readonly expiresAt: string;
  readonly account: AccountRow;
}

export function issueSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export function createSession(db: Db, accountId: number, now: Date = new Date()): IssuedSession {
  const token = issueSessionToken();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  const info = db
    .prepare('insert into user_sessions (user_account_id, token_hash, created_at, expires_at) values (?, ?, ?, ?)')
    .run(accountId, sha256Hex(token), createdAt, expiresAt);

  const row = db
    .prepare('select public_id from user_sessions where id = ?')
    .get(Number(info.lastInsertRowid)) as { public_id: string } | undefined;

  return {
    token,
    publicId: row?.public_id ?? '',
    sessionId: Number(info.lastInsertRowid),
    expiresAt,
  };
}

interface SessionJoinRow extends AccountRow {
  session_id: number;
  session_expires_at: string;
  session_revoked_at: string | null;
}

/**
 * Resolve a presented token to a live session.
 *
 * Returns null for every failure — unknown token, expired, revoked, disabled account —
 * so the caller cannot accidentally tell them apart in a response. The account row is
 * read fresh on every call: a role or status change takes effect on the next request,
 * not on the next login.
 */
export function authenticateSession(db: Db, token: string, now: string = new Date().toISOString()): AuthenticatedSession | null {
  const row = db
    .prepare(
      `select s.id as session_id, s.expires_at as session_expires_at, s.revoked_at as session_revoked_at,
              a.id, a.public_id, a.username, a.username_normalized, a.password_hash, a.role, a.status,
              a.must_change_password, a.personnel_id, a.row_version, a.password_changed_at, a.disabled_at,
              a.created_at, a.updated_at
         from user_sessions s
         join user_accounts a on a.id = s.user_account_id
        where s.token_hash = ?`,
    )
    .get(sha256Hex(token)) as SessionJoinRow | undefined;

  if (!row) return null;
  if (row.session_revoked_at !== null) return null;
  if (row.session_expires_at <= now) return null;
  if (row.status !== 'active') return null;

  const { session_id, session_expires_at, ...account } = row;
  return {
    sessionId: session_id,
    expiresAt: session_expires_at,
    account: account as AccountRow,
  };
}

export function revokeSession(db: Db, sessionId: number, reason: RevocationReason, now: string = new Date().toISOString()): boolean {
  const info = db
    .prepare('update user_sessions set revoked_at = ?, revoked_reason = ? where id = ? and revoked_at is null')
    .run(now, reason, sessionId);
  return info.changes > 0;
}

/** Revoke every live session of an account. Returns how many were open. */
export function revokeAllSessions(db: Db, accountId: number, reason: RevocationReason, now: string = new Date().toISOString()): number {
  const info = db
    .prepare('update user_sessions set revoked_at = ?, revoked_reason = ? where user_account_id = ? and revoked_at is null')
    .run(now, reason, accountId);
  return info.changes;
}

/**
 * Delete expired and revoked session rows.
 *
 * Operational hygiene, not history: an expired token is already unusable, and the audit
 * trail records why a session ended. Called opportunistically on login and by the CLI.
 */
export function purgeExpiredSessions(db: Db, now: string = new Date().toISOString()): number {
  const info = db.prepare('delete from user_sessions where expires_at <= ? or revoked_at is not null').run(now);
  return info.changes;
}
