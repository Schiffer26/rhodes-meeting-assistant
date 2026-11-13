/**
 * Migration 0003 and the schema it adds.
 *
 * What this file proves:
 *   · 0001 and 0002 were not edited — their files still hash to the values those
 *     databases recorded, so an existing installation upgrades without a checksum
 *     mismatch;
 *   · a version-2 database upgrades in place and keeps its data;
 *   · re-running is a no-op;
 *   · the new tables carry the rules the phase promises: unique case-insensitive
 *     usernames, no deletion, closed sets for role/status, hashed tokens only, and an
 *     append-only audit trail;
 *   · nothing seeds an account. A fresh database has no user at all.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { checksumOf, MIGRATIONS_DIR, runMigrations } from '../src/db/migrate.js';
import {
  configFor,
  insertPersonnel,
  LATEST_SCHEMA_VERSION,
  openMigrated,
  removeDir,
  tempDataDir,
} from './helpers.js';

/** Checksums recorded by the databases created before this phase. */
const CHECKSUM_0001 = '7e139965e463647a9b1b9c4cc133ff555255214dfa61442bb93f76ae55716bb9';
const CHECKSUM_0002 = 'b86c42929aaf4f88956c2cd6c33c94baadb48dc3b2152e7c5a4fc18560b8b14e';

function sqlFor(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
}

function isConstraint(error: unknown, fragment: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: string; message?: string };
  return (code ?? '').startsWith('SQLITE_CONSTRAINT') && (message ?? '').includes(fragment);
}

/** Build a version-2 database exactly as the previous release left it. */
function versionTwoDatabase(dataDir: string, workDir: string) {
  const migrations = path.join(workDir, 'migrations');
  cpSync(MIGRATIONS_DIR, migrations, { recursive: true });
  for (const name of ['0003-authentication.sql']) {
    removeDir(path.join(migrations, name));
  }
  const config = configFor(dataDir);
  const db = openDatabase(config);
  const outcome = runMigrations(db.handle, { migrationsDir: migrations });
  assert.equal(outcome.currentVersion, 2, 'the fixture must really be a version-2 database');
  return { db, config };
}

test('migrations 0001 and 0002 are byte-identical to the released checksums', () => {
  assert.equal(checksumOf(sqlFor('0001-initial-schema.sql')), CHECKSUM_0001);
  assert.equal(checksumOf(sqlFor('0002-integrity-hardening.sql')), CHECKSUM_0002);
  // The append-only revision guard from the first release is still present, untouched:
  // 0003 adds its own rules rather than rewriting anyone else's.
  assert.match(sqlFor('0001-initial-schema.sql'), /trg_note_revisions_no_update/);
});

test('a fresh database reaches version 3 with the authentication tables and no accounts', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      assert.equal(db.schemaVersion(), LATEST_SCHEMA_VERSION);

      const tables = db.handle
        .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
        .all() as { name: string }[];
      const names = tables.map((row) => row.name);
      assert.ok(names.includes('user_accounts'), 'user_accounts must exist');
      assert.ok(names.includes('user_sessions'), 'user_sessions must exist');

      // Nothing seeded: no default administrator, no demo user, no password.
      const accounts = db.handle.prepare('select count(*) as n from user_accounts').get() as { n: number };
      const sessions = db.handle.prepare('select count(*) as n from user_sessions').get() as { n: number };
      assert.equal(accounts.n, 0, 'a new installation has no account at all');
      assert.equal(sessions.n, 0);

      // audit_records keeps the shape migration 0001 gave it: 0003 reuses it, it does
      // not replace it with a second audit table.
      const columns = db.handle.prepare('pragma table_info(audit_records)').all() as { name: string }[];
      assert.deepEqual(
        columns.map((column) => column.name),
        ['id', 'occurred_at', 'actor', 'action', 'entity', 'entity_key', 'outcome', 'detail'],
      );
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('a version-2 database upgrades in place, keeping its records and its checksums', () => {
  const dir = tempDataDir();
  const workDir = mkdtempSync(path.join(tmpdir(), 'rhodes-v2-'));
  try {
    const { db, config } = versionTwoDatabase(dir, workDir);
    try {
      const personId = insertPersonnel(db, { code: 'P-100', full_name: 'Grace Adeyemi' });
      db.handle
        .prepare('insert into meetings (title, meeting_date, organizer_person_id) values (?, ?, ?)')
        .run('Legacy budget review', '2026-02-11', personId);

      const upgrade = runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
      assert.deepEqual(upgrade.applied, [{ version: 3, name: 'authentication' }]);
      assert.equal(upgrade.currentVersion, 3);
      assert.equal(db.schemaVersion(), 3);
      assert.equal(db.handle.pragma('user_version', { simple: true }), 3);

      // Nothing was rewritten: 0001 and 0002 still verify against their recorded hashes.
      const stored = db.handle
        .prepare('select version, checksum from schema_migrations order by version')
        .all() as { version: number; checksum: string }[];
      assert.deepEqual(
        stored.map((row) => row.checksum),
        [CHECKSUM_0001, CHECKSUM_0002, checksumOf(sqlFor('0003-authentication.sql'))],
      );

      const kept = db.handle.prepare('select title from meetings').get() as { title: string };
      assert.equal(kept.title, 'Legacy budget review');

      // Reopening the same file keeps working, and the upgrade does not repeat.
      const again = runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
      assert.deepEqual(again.applied, []);
      assert.equal(again.currentVersion, 3);
    } finally {
      db.close();
    }

    // Reopen through the normal path: pragmas and version come back as expected.
    const reopened = openDatabase(config);
    try {
      assert.equal(reopened.schemaVersion(), 3);
      const accounts = reopened.handle.prepare('select count(*) as n from user_accounts').get() as { n: number };
      assert.equal(accounts.n, 0, 'upgrading must not invent an administrator');
    } finally {
      reopened.close();
    }
  } finally {
    removeDir(dir);
    removeDir(workDir);
  }
});

test('usernames are unique case-insensitively, and accounts are never deleted', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const insert = db.handle.prepare(
        `insert into user_accounts (username, username_normalized, password_hash, role)
         values (?, ?, ?, ?)`,
      );
      insert.run('Amara', 'amara', 'scrypt$1$N=16384,r=8,p=1$c2FsdHNhbHQ$a2V5', 'member');

      assert.throws(
        () => insert.run('AMARA', 'amara', 'scrypt$1$N=16384,r=8,p=1$c2FsdHNhbHQ$a2V5', 'member'),
        (error: unknown) => isConstraint(error, 'UNIQUE constraint failed: user_accounts.username_normalized'),
        'a second row differing only in case must be refused',
      );

      const id = (db.handle.prepare('select id from user_accounts').get() as { id: number }).id;
      assert.throws(
        () => db.handle.prepare('delete from user_accounts where id = ?').run(id),
        /user accounts cannot be deleted/,
        'accounts are disabled, never removed',
      );

      // Disabling is the supported way to remove access, and it keeps the row.
      db.handle.prepare("update user_accounts set status = 'disabled', disabled_at = ? where id = ?").run('2026-01-01T00:00:00.000Z', id);
      const row = db.handle.prepare('select status, disabled_at from user_accounts where id = ?').get(id) as {
        status: string;
        disabled_at: string;
      };
      assert.equal(row.status, 'disabled');
      assert.match(row.disabled_at, /^2026-01-01/);

      assert.throws(
        () => db.handle.prepare("update user_accounts set role = 'owner'").run(),
        (error: unknown) => isConstraint(error, 'CHECK constraint failed: role'),
      );
      assert.throws(
        () => db.handle.prepare("update user_accounts set must_change_password = 2").run(),
        (error: unknown) => isConstraint(error, 'CHECK constraint failed'),
      );
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('sessions store a token hash, expire after creation, and come from one account', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const accountId = Number(
        db.handle
          .prepare(
            `insert into user_accounts (username, username_normalized, password_hash, role)
             values ('Amara', 'amara', 'scrypt$1$N=16384,r=8,p=1$c2FsdHNhbHQ$a2V5', 'administrator')`,
          )
          .run().lastInsertRowid,
      );

      const insert = db.handle.prepare(
        'insert into user_sessions (user_account_id, token_hash, created_at, expires_at) values (?, ?, ?, ?)',
      );
      insert.run(accountId, 'a'.repeat(64), '2026-01-01T00:00:00.000Z', '2026-01-01T08:00:00.000Z');

      // The column cannot hold anything but a 64-character hash, and its name says so.
      assert.throws(
        () => insert.run(accountId, 'a'.repeat(63), '2026-01-01T00:00:00.000Z', '2026-01-01T08:00:00.000Z'),
        (error: unknown) => isConstraint(error, 'CHECK constraint failed'),
      );
      // A session that expires when it starts is not a session.
      assert.throws(
        () => insert.run(accountId, 'b'.repeat(64), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        (error: unknown) => isConstraint(error, 'expires_at > created_at'),
      );
      // Revocation reasons are a closed set, so a typo cannot create a mystery state.
      assert.throws(
        () =>
          db.handle
            .prepare("update user_sessions set revoked_at = '2026-01-01T09:00:00.000Z', revoked_reason = 'nonsense'")
            .run(),
        (error: unknown) => isConstraint(error, 'CHECK constraint failed'),
      );

      // An account with sessions cannot be deleted either; the sessions would dangle.
      assert.throws(
        () => db.handle.prepare('delete from user_accounts where id = ?').run(accountId),
        /user accounts cannot be deleted/,
      );
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('the audit trail is append-only and is not part of session cleanup', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      db.handle
        .prepare("insert into audit_records (actor, action, entity, entity_key, detail) values ('operator-cli', 'account.bootstrap', 'user_account', 'abc', '{}')")
        .run();

      assert.throws(() => db.handle.prepare('delete from audit_records').run(), /audit history is append-only/);
      assert.throws(() => db.handle.prepare("update audit_records set actor = 'someone else'").run(), /audit history is append-only/);

      const rows = db.handle.prepare('select count(*) as n from audit_records').get() as { n: number };
      assert.equal(rows.n, 1, 'the record survives both attempts');
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('Personnel never creates an account, and a linked person cannot be deleted', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const personId = insertPersonnel(db, { code: 'P-200', full_name: 'Amara Okoye' });
      const accounts = db.handle.prepare('select count(*) as n from user_accounts').get() as { n: number };
      assert.equal(accounts.n, 0, 'creating a person must not create a login');

      db.handle
        .prepare(
          `insert into user_accounts (username, username_normalized, password_hash, role, personnel_id)
           values ('amara', 'amara', 'scrypt$1$N=16384,r=8,p=1$c2FsdHNhbHQ$a2V5', 'member', ?)`,
        )
        .run(personId);

      assert.throws(
        () => db.handle.prepare('delete from personnel where id = ?').run(personId),
        (error: unknown) => isConstraint(error, 'FOREIGN KEY constraint failed'),
        'history must not lose the person an account belongs to',
      );

      // One person, one account: a second link to the same person is refused.
      assert.throws(
        () =>
          db.handle
            .prepare(
              `insert into user_accounts (username, username_normalized, password_hash, role, personnel_id)
               values ('amara2', 'amara2', 'scrypt$1$N=16384,r=8,p=1$c2FsdHNhbHQ$a2V5', 'member', ?)`,
            )
            .run(personId),
        (error: unknown) => isConstraint(error, 'UNIQUE constraint failed: user_accounts.personnel_id'),
      );

      // Unlinked accounts are still allowed: several of them, since NULL is not a value.
      db.handle
        .prepare(
          `insert into user_accounts (username, username_normalized, password_hash, role)
           values ('ops', 'ops', 'scrypt$1$N=16384,r=8,p=1$c2FsdHNhbHQ$a2V5', 'administrator')`,
        )
        .run();
      db.handle
        .prepare(
          `insert into user_accounts (username, username_normalized, password_hash, role)
           values ('ops2', 'ops2', 'scrypt$1$N=16384,r=8,p=1$c2FsdHNhbHQ$a2V5', 'administrator')`,
        )
        .run();
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});
