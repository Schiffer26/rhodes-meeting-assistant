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
 * Append one audit record.
 *
 * Never throws: an audit failure must not turn a successful security operation into an
 * error the caller sees, but it is logged loudly because a silent gap in the trail is a
 * problem in its own right.
 */
export function recordAudit(db: Db, entry: AuditEntry): void {
  try {
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
  } catch (error) {
    logger.error('audit.write_failed', {
      action: entry.action,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
