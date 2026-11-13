/**
 * RHODES API · account repository
 *
 * Every rule that protects the account table is enforced here, inside a transaction,
 * rather than in a route handler that a second call site could forget to copy:
 *
 *   · usernames are unique case-insensitively (normalised column, UNIQUE index);
 *   · accounts are never deleted — only disabled;
 *   · the last active administrator can never be disabled or demoted;
 *   · an administrator cannot disable or demote themselves;
 *   · disabling, role changes, password resets and password changes revoke sessions.
 *
 * The transactional checks use `BEGIN IMMEDIATE`, so two administrators acting at the
 * same moment cannot both observe "there is another administrator" and then both step
 * down.
 */

import { randomBytes } from 'node:crypto';

import type { Db } from '../db/index.js';
import { AppError } from '../errors.js';

import { recordAudit } from './audit.js';
import {
  accountNotFound,
  cannotModifySelf,
  invalidRole,
  invalidStatus,
  lastAdministrator,
  usernameTaken,
} from './errors.js';
import { normalizeUsername } from './policy.js';
import { revokeAllSessions } from './sessions.js';

export type Role = 'administrator' | 'member';
export type AccountStatus = 'active' | 'disabled';

export interface AccountRow {
  id: number;
  public_id: string;
  username: string;
  username_normalized: string;
  password_hash: string;
  role: Role;
  status: AccountStatus;
  must_change_password: 0 | 1;
  personnel_id: number | null;
  row_version: number;
  password_changed_at: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the API is allowed to expose about an account. Never includes the hash. */
export interface AccountSummary {
  publicId: string;
  username: string;
  role: Role;
  status: AccountStatus;
  mustChangePassword: boolean;
  personnelPublicId: string | null;
  passwordChangedAt: string | null;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toAccountSummary(row: AccountRow, personnelPublicId: string | null = null): AccountSummary {
  return {
    publicId: row.public_id,
    username: row.username,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password === 1,
    personnelPublicId,
    passwordChangedAt: row.password_changed_at,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ACCOUNT_COLUMNS = `id, public_id, username, username_normalized, password_hash, role, status,
  must_change_password, personnel_id, row_version, password_changed_at, disabled_at, created_at, updated_at`;

export function findById(db: Db, id: number): AccountRow | undefined {
  return db.prepare(`select ${ACCOUNT_COLUMNS} from user_accounts where id = ?`).get(id) as AccountRow | undefined;
}

export function findByPublicId(db: Db, publicId: string): AccountRow | undefined {
  return db.prepare(`select ${ACCOUNT_COLUMNS} from user_accounts where public_id = ?`).get(publicId) as
    | AccountRow
    | undefined;
}

export function findByUsername(db: Db, username: string): AccountRow | undefined {
  return db
    .prepare(`select ${ACCOUNT_COLUMNS} from user_accounts where username_normalized = ?`)
    .get(normalizeUsername(username)) as AccountRow | undefined;
}

export function countAccounts(db: Db): number {
  const row = db.prepare('select count(*) as n from user_accounts').get() as { n: number };
  return row.n;
}

export function countActiveAdministrators(db: Db): number {
  const row = db
    .prepare("select count(*) as n from user_accounts where role = 'administrator' and status = 'active'")
    .get() as { n: number };
  return row.n;
}

interface AccountListRow extends AccountRow {
  personnel_public_id: string | null;
}

export function listAccounts(db: Db): AccountSummary[] {
  const rows = db
    .prepare(
      `select a.${ACCOUNT_COLUMNS.trim().split(', ').join(', a.')}, p.public_id as personnel_public_id
         from user_accounts a
         left join personnel p on p.id = a.personnel_id
        order by a.username_normalized`,
    )
    .all() as AccountListRow[];
  return rows.map((row) => toAccountSummary(row, row.personnel_public_id));
}

export interface CreateAccountInput {
  readonly username: string;
  readonly passwordHash: string;
  readonly role: Role;
  readonly personnelId?: number | null;
  readonly mustChangePassword: boolean;
  readonly actor: string | null;
  readonly now?: string;
}

export function createAccount(db: Db, input: CreateAccountInput): AccountRow {
  if (input.role !== 'administrator' && input.role !== 'member') throw invalidRole();

  const run = db.transaction((): AccountRow => {
    const normalized = normalizeUsername(input.username);
    const clash = db.prepare('select id from user_accounts where username_normalized = ?').get(normalized);
    if (clash) throw usernameTaken();

    const now = input.now ?? new Date().toISOString();
    const info = db
      .prepare(
        `insert into user_accounts
           (username, username_normalized, password_hash, role, status, must_change_password, personnel_id,
            password_changed_at, created_at, updated_at)
         values (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.username,
        normalized,
        input.passwordHash,
        input.role,
        input.mustChangePassword ? 1 : 0,
        input.personnelId ?? null,
        now,
        now,
        now,
      );

    const created = findById(db, Number(info.lastInsertRowid));
    if (!created) throw new Error('account insert did not produce a row');

    recordAudit(db, {
      action: 'account.create',
      entity: 'user_account',
      entityKey: created.public_id,
      actor: input.actor,
      detail: {
        username: created.username,
        role: created.role,
        mustChangePassword: created.must_change_password === 1,
        personnelLinked: created.personnel_id !== null,
      },
    });

    return created;
  });

  return run.immediate();
}

export interface PatchAccountInput {
  readonly publicId: string;
  readonly actorAccountId: number;
  readonly actorPublicId: string | null;
  readonly role?: Role;
  readonly status?: AccountStatus;
  readonly now?: string;
}

export interface PatchAccountResult {
  readonly account: AccountRow;
  readonly sessionsRevoked: number;
}

export function patchAccount(db: Db, input: PatchAccountInput): PatchAccountResult {
  if (input.role !== undefined && input.role !== 'administrator' && input.role !== 'member') throw invalidRole();
  if (input.status !== undefined && input.status !== 'active' && input.status !== 'disabled') throw invalidStatus();

  const run = db.transaction((): PatchAccountResult => {
    const current = findByPublicId(db, input.publicId);
    if (!current) throw accountNotFound();

    const nextRole = input.role ?? current.role;
    const nextStatus = input.status ?? current.status;

    if (current.id === input.actorAccountId) {
      if (nextStatus === 'disabled' && current.status !== 'disabled') {
        throw cannotModifySelf('You cannot disable your own account. Ask another administrator.');
      }
      if (nextRole !== 'administrator' && current.role === 'administrator') {
        throw cannotModifySelf('You cannot remove your own administrator role. Ask another administrator.');
      }
    }

    if (nextRole === current.role && nextStatus === current.status) {
      return { account: current, sessionsRevoked: 0 };
    }

    // Last-administrator guard, evaluated inside the write transaction so two concurrent
    // demotions cannot both see another administrator and both succeed.
    const losingAdministrator =
      current.role === 'administrator' && current.status === 'active' && (nextRole !== 'administrator' || nextStatus !== 'active');
    if (losingAdministrator) {
      const others = db
        .prepare("select count(*) as n from user_accounts where role = 'administrator' and status = 'active' and id <> ?")
        .get(current.id) as { n: number };
      if (others.n === 0) throw lastAdministrator();
    }

    const now = input.now ?? new Date().toISOString();
    db.prepare(
      `update user_accounts
          set role = ?, status = ?, disabled_at = ?, updated_at = ?, row_version = row_version + 1
        where id = ?`,
    ).run(nextRole, nextStatus, nextStatus === 'disabled' ? (current.disabled_at ?? now) : null, now, current.id);

    let sessionsRevoked = 0;
    if (nextStatus === 'disabled' && current.status !== 'disabled') {
      sessionsRevoked = revokeAllSessions(db, current.id, 'account_disabled', now);
      recordAudit(db, {
        action: 'account.disable',
        entity: 'user_account',
        entityKey: current.public_id,
        actor: input.actorPublicId,
        detail: { sessionsRevoked },
      });
    } else if (nextStatus === 'active' && current.status === 'disabled') {
      recordAudit(db, {
        action: 'account.enable',
        entity: 'user_account',
        entityKey: current.public_id,
        actor: input.actorPublicId,
      });
    }

    if (nextRole !== current.role) {
      // A role change applies immediately: existing sessions lose whatever they had.
      sessionsRevoked += revokeAllSessions(db, current.id, 'role_change', now);
      recordAudit(db, {
        action: 'account.role_change',
        entity: 'user_account',
        entityKey: current.public_id,
        actor: input.actorPublicId,
        detail: { from: current.role, to: nextRole, sessionsRevoked },
      });
    }

    const updated = findById(db, current.id);
    if (!updated) throw accountNotFound();
    return { account: updated, sessionsRevoked };
  });

  return run.immediate();
}

export interface ChangeOwnPasswordInput {
  readonly accountId: number;
  readonly passwordHash: string;
  readonly actorPublicId: string | null;
  readonly now?: string;
}

/** Set a new password, clear the must-change flag and revoke every session. */
export function changeOwnPassword(db: Db, input: ChangeOwnPasswordInput): number {
  const run = db.transaction((): number => {
    const account = findById(db, input.accountId);
    if (!account) throw accountNotFound();
    const now = input.now ?? new Date().toISOString();

    db.prepare(
      `update user_accounts
          set password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ?,
              row_version = row_version + 1
        where id = ?`,
    ).run(input.passwordHash, now, now, account.id);

    const revoked = revokeAllSessions(db, account.id, 'password_change', now);
    recordAudit(db, {
      action: 'account.password_change',
      entity: 'user_account',
      entityKey: account.public_id,
      actor: input.actorPublicId,
      detail: { sessionsRevoked: revoked },
    });
    return revoked;
  });

  return run.immediate();
}

export interface ResetPasswordInput {
  readonly publicId: string;
  readonly passwordHash: string;
  readonly actorAccountId: number;
  readonly actorPublicId: string | null;
  readonly now?: string;
}

/** Administrator-initiated reset. Refuses to touch the caller's own account. */
export function resetPasswordByAdministrator(db: Db, input: ResetPasswordInput): AccountRow {
  const run = db.transaction((): AccountRow => {
    const account = findByPublicId(db, input.publicId);
    if (!account) throw accountNotFound();
    if (account.id === input.actorAccountId) {
      throw cannotModifySelf(
        'Use the change-password endpoint for your own account, or the local recovery command if you are locked out.',
      );
    }

    const now = input.now ?? new Date().toISOString();
    db.prepare(
      `update user_accounts
          set password_hash = ?, must_change_password = 1, password_changed_at = ?, updated_at = ?,
              row_version = row_version + 1
        where id = ?`,
    ).run(input.passwordHash, now, now, account.id);

    const revoked = revokeAllSessions(db, account.id, 'password_reset', now);
    recordAudit(db, {
      action: 'account.password_reset',
      entity: 'user_account',
      entityKey: account.public_id,
      actor: input.actorPublicId,
      detail: { sessionsRevoked: revoked },
    });

    const updated = findById(db, account.id);
    if (!updated) throw accountNotFound();
    return updated;
  });

  return run.immediate();
}

export interface BootstrapInput {
  readonly username: string;
  readonly passwordHash: string;
  readonly now?: string;
}

/**
 * Create the very first administrator.
 *
 * Refuses unless the table is empty — there is no "default" account and no default
 * password anywhere in this system; the first one is chosen by whoever runs the local
 * command with access to the host.
 */
export function bootstrapAdministrator(db: Db, input: BootstrapInput): AccountRow {
  const run = db.transaction((): AccountRow => {
    const existing = countAccounts(db);
    if (existing > 0) {
      throw new AppError(
        'admin.bootstrap_not_possible',
        'An account already exists, so bootstrap will not run. Use the reset command for an existing administrator.',
        { httpStatus: 409, exposure: 'safe' },
      );
    }

    const normalized = normalizeUsername(input.username);
    const now = input.now ?? new Date().toISOString();
    const info = db
      .prepare(
        `insert into user_accounts
           (username, username_normalized, password_hash, role, status, must_change_password,
            password_changed_at, created_at, updated_at)
         values (?, ?, ?, 'administrator', 'active', 0, ?, ?, ?)`,
      )
      .run(input.username, normalized, input.passwordHash, now, now, now);

    const created = findById(db, Number(info.lastInsertRowid));
    if (!created) throw new Error('bootstrap did not produce a row');

    recordAudit(db, {
      action: 'account.bootstrap',
      entity: 'user_account',
      entityKey: created.public_id,
      actor: 'operator-cli',
      detail: { username: created.username, role: created.role },
    });
    return created;
  });

  return run.immediate();
}

export interface RecoveryInput {
  readonly username: string;
  readonly passwordHash: string;
  readonly now?: string;
}

/**
 * Local operator recovery for an administrator who cannot sign in.
 *
 * Requires filesystem access to the data directory, which is the real authorisation:
 * whoever can run this can already read the database. The account is left requiring a
 * password change, so the temporary password does not become permanent.
 */
export function recoverAdministratorPassword(db: Db, input: RecoveryInput): AccountRow {
  const run = db.transaction((): AccountRow => {
    const account = findByUsername(db, input.username);
    if (!account) throw accountNotFound();
    if (account.role !== 'administrator') {
      throw cannotModifySelf('Only an administrator account can be recovered with this command.');
    }

    const now = input.now ?? new Date().toISOString();
    db.prepare(
      `update user_accounts
          set password_hash = ?, must_change_password = 1, password_changed_at = ?, updated_at = ?,
              row_version = row_version + 1
        where id = ?`,
    ).run(input.passwordHash, now, now, account.id);

    const revoked = revokeAllSessions(db, account.id, 'admin_recovery', now);
    recordAudit(db, {
      action: 'account.admin_recovery',
      entity: 'user_account',
      entityKey: account.public_id,
      actor: 'operator-cli',
      detail: { sessionsRevoked: revoked },
    });

    const updated = findById(db, account.id);
    if (!updated) throw accountNotFound();
    return updated;
  });

  return run.immediate();
}

/** Cryptographically random temporary password, comfortably above the length floor. */
export function generateTemporaryPassword(): string {
  return randomBytes(18).toString('base64url');
}
