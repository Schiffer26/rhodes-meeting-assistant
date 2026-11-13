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
import { loadMigrationFiles, MIGRATIONS_DIR, runMigrations } from '../src/db/migrate.js';
import { configFor, openMigrated, removeDir, tableCounts, tempDataDir } from './helpers.js';

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
      assert.equal(db.schemaVersion(), 1);
      const applied = db.handle.prepare('select version, name, checksum, applied_at from schema_migrations').all() as {
        version: number;
        name: string;
        checksum: string;
        applied_at: string;
      }[];
      assert.equal(applied.length, 1);
      assert.equal(applied[0]?.version, 1);
      assert.equal(applied[0]?.name, 'initial-schema');
      assert.match(applied[0]?.checksum ?? '', /^[0-9a-f]{64}$/);
      assert.match(applied[0]?.applied_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
      // PRAGMA user_version mirrors the highest applied migration.
      assert.equal(db.handle.pragma('user_version', { simple: true }), 1);
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
      assert.equal(second.currentVersion, 1);

      const third = runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
      assert.deepEqual(third.applied, []);

      const count = db.handle.prepare('select count(*) as n from schema_migrations').get() as { n: number };
      assert.equal(count.n, 1, 'a migration must never be recorded twice');
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
        const expected = table === 'schema_migrations' ? 1 : 0;
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
      path.join(migrationsCopy, '0002-deliberately-broken.sql'),
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
      assert.equal(db.schemaVersion(), 1, 'the failed migration must not be recorded');
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
  assert.equal(files.length, 1);
  assert.equal(files[0]?.version, 1);
  assert.equal(files[0]?.name, 'initial-schema');

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
