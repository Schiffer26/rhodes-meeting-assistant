/**
 * Migration behaviour.
 *
 * Cases 3, 4, 5 and 9 of the required test matrix: the database file is created in the
 * configured directory, migrations run, re-running is idempotent, and a fresh database
 * contains no demonstration records.
 */

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MigrationError } from '../src/errors.js';
import { openDatabase } from '../src/db/index.js';
import {
  checksumOf,
  loadMigrationFiles,
  MIGRATIONS_DIR,
  normaliseNewlines,
  runMigrations,
} from '../src/db/migrate.js';
import { configFor, insertMeeting, openMigrated, removeDir, tableCounts, tempDataDir } from './helpers.js';

const EXPECTED_TABLES = [
  'action_items',
  'agenda_items',
  'audit_records',
  'decisions',
  'meeting_attendees',
  'meeting_notes',
  'meetings',
  'note_revisions',
  'personnel',
  'schema_migrations',
];

function tableNames(db: ReturnType<typeof openMigrated>['db']): string[] {
  const rows = db.handle
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

test('case 3: opening the database creates the file inside the configured directory', () => {
  const dir = tempDataDir();
  try {
    const config = configFor(dir);
    assert.equal(existsSync(config.databasePath), false);
    const db = openDatabase(config);
    try {
      assert.equal(existsSync(config.databasePath), true);
      assert.equal(db.filePath, config.databasePath);
      // WAL is enabled at open time, before any migration runs.
      assert.equal(existsSync(`${config.databasePath}-wal`), true);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('case 4: migrations create every table in the schema', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const names = tableNames(db);
      for (const table of EXPECTED_TABLES) {
        assert.ok(names.includes(table), `missing table: ${table}`);
      }
      assert.equal(db.schemaVersion(), 2, 'a fresh database reaches schema version 2');
      const applied = db.handle.prepare('select version, name, checksum, applied_at from schema_migrations order by version').all() as {
        version: number;
        name: string;
        checksum: string;
        applied_at: string;
      }[];
      assert.equal(applied.length, 2);
      assert.equal(applied[0]?.version, 1);
      assert.equal(applied[0]?.name, 'initial-schema');
      assert.equal(applied[1]?.version, 2);
      assert.equal(applied[1]?.name, 'integrity-hardening');
      for (const row of applied) {
        assert.match(row.checksum, /^[0-9a-f]{64}$/);
        assert.match(row.applied_at, /^\d{4}-\d{2}-\d{2}T/);
      }
      // PRAGMA user_version mirrors the highest applied migration.
      assert.equal(db.handle.pragma('user_version', { simple: true }), 2);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('case 5: re-running migrations is idempotent', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const second = runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
      assert.deepEqual(second.applied, []);
      assert.equal(second.skipped, second.totalFiles);
      assert.equal(second.currentVersion, 2);
      assert.equal(second.totalFiles, 2);

      const third = runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
      assert.deepEqual(third.applied, []);

      const count = db.handle.prepare('select count(*) as n from schema_migrations').get() as { n: number };
      assert.equal(count.n, 2, 'a migration must never be recorded twice');

      // Re-running must not duplicate the triggers created by migration 0002.
      const triggers = db.handle
        .prepare("select count(*) as n from sqlite_master where type = 'trigger'")
        .get() as { n: number };
      const triggersAfter = runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
      assert.deepEqual(triggersAfter.applied, []);
      const triggersAgain = db.handle
        .prepare("select count(*) as n from sqlite_master where type = 'trigger'")
        .get() as { n: number };
      assert.equal(triggersAgain.n, triggers.n);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('case 9: a freshly initialised database contains no records', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const counts = tableCounts(db);
      for (const [table, count] of Object.entries(counts)) {
        const expected = table === 'schema_migrations' ? 2 : 0;
        assert.equal(count, expected, `${table} should contain ${expected} row(s), found ${count}`);
      }
      const names = db.handle.prepare('select full_name from personnel').all();
      assert.deepEqual(names, [], 'no demonstration personnel may be inserted');
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('an edited migration is refused instead of silently diverging', () => {
  const dir = tempDataDir();
  const migrationsCopy = mkdtempSync(path.join(tmpdir(), 'rhodes-migrations-'));
  try {
    cpSync(MIGRATIONS_DIR, migrationsCopy, { recursive: true });
    const { db } = openMigrated(dir);
    try {
      const target = path.join(migrationsCopy, path.basename(loadMigrationFiles(migrationsCopy)[0]!.filePath));
      writeFileSync(target, readFileSync(target, 'utf8') + '\n-- edited after release\n');
      assert.throws(
        () => runMigrations(db.handle, { migrationsDir: migrationsCopy }),
        (error: unknown) => {
          assert.ok(error instanceof MigrationError);
          assert.equal(error.code, 'migration.checksum_mismatch');
          return true;
        },
      );
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
    removeDir(migrationsCopy);
  }
});

test('a recorded migration with no file is refused', () => {
  const dir = tempDataDir();
  const emptyDir = mkdtempSync(path.join(tmpdir(), 'rhodes-empty-'));
  try {
    const { db } = openMigrated(dir);
    try {
      // Empty directory: no files at all.
      assert.throws(
        () => runMigrations(db.handle, { migrationsDir: emptyDir }),
        (error: unknown) => {
          assert.ok(error instanceof MigrationError);
          assert.equal(error.code, 'migration.none_found');
          return true;
        },
      );
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
    removeDir(emptyDir);
  }
});

test('a failing migration rolls back and leaves the previous version intact', () => {
  const dir = tempDataDir();
  const migrationsCopy = mkdtempSync(path.join(tmpdir(), 'rhodes-broken-'));
  try {
    cpSync(MIGRATIONS_DIR, migrationsCopy, { recursive: true });
    writeFileSync(
      path.join(migrationsCopy, '0003-deliberately-broken.sql'),
      'create table half_applied (id integer primary key);\nthis is not valid sql;\n',
    );

    const { db } = openMigrated(dir);
    try {
      assert.throws(
        () => runMigrations(db.handle, { migrationsDir: migrationsCopy }),
        (error: unknown) => {
          assert.ok(error instanceof MigrationError);
          assert.equal(error.code, 'migration.failed');
          return true;
        },
      );
      assert.equal(db.schemaVersion(), 2, 'the failed migration must not be recorded');
      const names = tableNames(db);
      assert.ok(!names.includes('half_applied'), 'the failed migration must be rolled back');
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
    removeDir(migrationsCopy);
  }
});

test('migration files are parsed by version and duplicates are refused', () => {
  const files = loadMigrationFiles(MIGRATIONS_DIR);
  assert.equal(files.length, 2);
  assert.equal(files[0]?.version, 1);
  assert.equal(files[0]?.name, 'initial-schema');
  assert.equal(files[1]?.version, 2);
  assert.equal(files[1]?.name, 'integrity-hardening');

  const duplicate = mkdtempSync(path.join(tmpdir(), 'rhodes-dupe-'));
  try {
    writeFileSync(path.join(duplicate, '0001-one.sql'), 'select 1;');
    writeFileSync(path.join(duplicate, '0001-two.sql'), 'select 2;');
    assert.throws(() => loadMigrationFiles(duplicate), (error: unknown) => {
      assert.ok(error instanceof MigrationError);
      assert.equal(error.code, 'migration.duplicate_version');
      return true;
    });
  } finally {
    removeDir(duplicate);
  }
});

test('an existing version-1 database upgrades in place to version 2', () => {
  const dir = tempDataDir();
  const v1Dir = mkdtempSync(path.join(tmpdir(), 'rhodes-v1-'));
  try {
    // A migrations directory that only knows about 0001 — the state of a database
    // created by the LAN-1 build before this migration existed.
    const v1File = path.join(v1Dir, '0001-initial-schema.sql');
    cpSync(path.join(MIGRATIONS_DIR, '0001-initial-schema.sql'), v1File);

    const config = configFor(dir);
    const db = openDatabase(config);
    try {
      const first = runMigrations(db.handle, { migrationsDir: v1Dir });
      assert.equal(first.currentVersion, 1);
      assert.deepEqual(first.applied, [{ version: 1, name: 'initial-schema' }]);

      // Data written at version 1, including a row that the *new* rules will police.
      const meetingId = insertMeeting(db, { title: 'Legacy meeting', meeting_date: '2026-03-11' });

      const upgrade = runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
      assert.deepEqual(upgrade.applied, [{ version: 2, name: 'integrity-hardening' }]);
      assert.equal(upgrade.currentVersion, 2);
      assert.equal(db.schemaVersion(), 2);

      // 0001 was verified against its stored checksum during the upgrade: the recorded
      // hash still matches the file on disk.
      const stored = db.handle
        .prepare('select version, checksum from schema_migrations order by version')
        .all() as { version: number; checksum: string }[];
      assert.equal(stored.length, 2);
      assert.equal(
        stored[0]?.checksum,
        checksumOf(readFileSync(path.join(MIGRATIONS_DIR, '0001-initial-schema.sql'), 'utf8')),
        'the checksum recorded for 0001 must still match the unmodified file',
      );

      // Existing row survived, and is now protected by the new triggers.
      const kept = db.handle.prepare('select title from meetings where id = ?').get(meetingId) as { title: string };
      assert.equal(kept.title, 'Legacy meeting');
      assert.throws(
        () => db.handle.prepare('update meetings set meeting_date = ? where id = ?').run('2025-02-29', meetingId),
        /real calendar date/,
      );

      // And the upgrade is not repeated on the next run.
      const again = runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
      assert.deepEqual(again.applied, []);
      assert.equal(again.currentVersion, 2);
      const triggers = db.handle
        .prepare("select count(*) as n from sqlite_master where type = 'trigger'")
        .get() as { n: number };
      assert.equal(triggers.n, 20, 'migration 0002 must not duplicate its triggers');
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
    removeDir(v1Dir);
  }
});

test('LF, CRLF and CR line endings produce an identical migration checksum', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rhodes-eol-'));
  try {
    const sql = 'create table sample (id integer);\nselect 1;\n';
    writeFileSync(path.join(dir, '0001-lf.sql'), sql);
    writeFileSync(path.join(dir, '0002-crlf.sql'), sql.replace(/\n/g, '\r\n'));
    writeFileSync(path.join(dir, '0003-cr.sql'), sql.replace(/\n/g, '\r'));

    const files = loadMigrationFiles(dir);
    assert.equal(files.length, 3);
    const checksums = files.map((file) => file.checksum);
    assert.equal(checksums[0], checksums[1], 'LF and CRLF must hash identically');
    assert.equal(checksums[1], checksums[2], 'CRLF and CR must hash identically');
    assert.match(String(checksums[0]), /^[0-9a-f]{64}$/);

    // The checksum is taken over normalised text, not the raw bytes.
    assert.equal(checksumOf(sql), checksumOf(sql.replace(/\n/g, '\r\n')));
    assert.equal(normaliseNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');

    // Editing the SQL itself still changes the checksum — normalisation must not blunt
    // the protection it exists to make portable.
    assert.notEqual(checksumOf(sql), checksumOf(sql + '-- edited\n'));

    // A CRLF checkout of a real migration produces the checksum recorded for the LF one,
    // which is what stops Windows and Linux from disagreeing about the same file.
    const repoMigration = readFileSync(path.join(MIGRATIONS_DIR, '0001-initial-schema.sql'), 'utf8');
    assert.equal(checksumOf(repoMigration), checksumOf(repoMigration.replace(/\n/g, '\r\n')));
  } finally {
    removeDir(dir);
  }
});
