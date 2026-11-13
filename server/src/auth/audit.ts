/**
 * RHODES API · audit trail
 *
 * Writes to the `audit_records` table introduced by migration 0001. Migration 0003 made
 * that table append-only (no UPDATE, no DELETE), so an incident cannot be reviewed from
 * a trail someone edited afterwards.
 *
 * `redact` is defensive rather than decorative: nothing in this codebase passes a secret
 * here, and the redaction means a future call site cannot accidentally start doing so.
 * Even so, the rule is stated where the table is defined: the audit trail records what
 * happened, never the credentials involved.
 */

import type { Db } from '../db/index.js';
import { logger } from '../logger.js';

export type AuditOutcome = 'ok' | 'denied' | 'conflict' | 'error';

export interface AuditEntry {
  /** Dotted verb, e.g. `account.create`, `auth.login`, `account.admin_recovery`. */
  readonly action: string;
  /** Table or concept the action applies to, e.g. `user_account`. */
  readonly entity: string;
  /** Public identifier of the affected row, when there is one. */
  readonly entityKey?: string | null;
  /** Account public id, `operator-cli` for local commands, or null for the system. */
  readonly actor?: string | null;
  readonly outcome?: AuditOutcome;
  /** Structured context. Must never contain a password, hash, token or header. */
  readonly detail?: Record<string, unknown> | null;
}

const SENSITIVE_KEY = /pass|secret|token|hash|authori[sz]ation|cookie/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(child);
    }
    return out;
  }
  return value;
}

/**
 * Perform the insert itself. This is the only place an audit row is written, and it
 * deliberately does not catch anything: whether a failure is tolerated is the caller's
 * decision, and that decision is the whole point of having two functions below.
 */
function insertAuditRow(db: Db, entry: AuditEntry): void {
  db.prepare(
    `insert into audit_records (occurred_at, actor, action, entity, entity_key, outcome, detail)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    entry.actor ?? null,
    entry.action,
    entry.entity,
    entry.entityKey ?? null,
    entry.outcome ?? 'ok',
    entry.detail ? JSON.stringify(redact(entry.detail)) : null,
  );
}

/**
 * Best-effort audit write, for events that stand on their own.
 *
 * A sign-in, a failed sign-in, a sign-out: each is a fact about a request, not a claim
 * that some other row changed. If the insert fails, the request has still done what it
 * said it did, so the failure is logged loudly and the response stands.
 *
 * Never use this for a security *state change*. Use `recordRequiredAudit`.
 */
export function recordAudit(db: Db, entry: AuditEntry): void {
  try {
    insertAuditRow(db, entry);
  } catch (error) {
    logger.error('audit.write_failed', {
      action: entry.action,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Required audit write, for successful security state changes (LAN-2.1 correction).
 *
 * An account that was created, disabled, re-enabled, re-roled, or given a new password
 * must have a matching audit row. If the row cannot be written, the change did not
 * happen: this throws, and because it runs inside the same transaction as the mutation,
 * the throw rolls the whole transaction back. A security change without a trail is not
 * an acceptable outcome, and "we changed it but could not record who did" is exactly the
 * situation an audit trail exists to prevent.
 *
 * Call this only from inside the transaction that performs the change.
 */
export function recordRequiredAudit(db: Db, entry: AuditEntry): void {
  insertAuditRow(db, entry);
}
