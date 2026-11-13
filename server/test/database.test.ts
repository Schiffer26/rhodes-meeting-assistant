/**
 * Database configuration and relational guarantees.
 *
 * Cases 6, 7 and 8 of the required test matrix (foreign keys, WAL, close/reopen), plus
 * the historical-integrity rules the schema promises: no silent cascade from personnel,
 * append-only revision history, and CHECK constraints that reject impossible records.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { DatabaseError } from '../src/errors.js';
import { openDatabase } from '../src/db/index.js';
import { insertMeeting, insertPersonnel, migratedConfig, openMigrated, removeDir, tempDataDir } from './helpers.js';

/**
 * better-sqlite3 maps SQLite result codes onto `code`, but the exact extended code
 * (for example SQLITE_CONSTRAINT_FOREIGNKEY vs SQLITE_CONSTRAINT) varies with the
 * statement. Assert on the constraint family plus the message instead of guessing an
 * extended code, so the test proves enforcement rather than a driver detail.
 */
function isSqliteConstraint(error: unknown, fragment: 'FOREIGN KEY' | 'CHECK'): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: string; message?: string };
  return (code ?? '').startsWith('SQLITE_CONSTRAINT') && (message ?? '').includes(fragment);
}

test('case 7: WAL journal mode is active on the database file', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      assert.equal(String(db.handle.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
      // FULL synchronous is what makes a committed record survive a power cut.
      assert.equal(Number(db.handle.pragma('synchronous', { simple: true })), 2);
      assert.equal(Number(db.handle.pragma('foreign_keys', { simple: true })), 1);
      assert.equal(Number(db.handle.pragma('busy_timeout', { simple: true })), 5000);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('bounded busy timeout is configurable', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir, { RHODES_BUSY_TIMEOUT_MS: '15000' });
    try {
      assert.equal(Number(db.handle.pragma('busy_timeout', { simple: true })), 15000);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('case 6: foreign keys are enforced, not merely declared', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const meetingId = insertMeeting(db);
      assert.throws(
        () =>
          db.handle
            .prepare('insert into meeting_attendees (meeting_id, person_id) values (?, ?)')
            .run(meetingId, 9999),
        (error: unknown) => isSqliteConstraint(error, 'FOREIGN KEY'),
      );

      assert.throws(
        () =>
          db.handle
            .prepare('insert into meetings (title, meeting_date, organizer_person_id) values (?, ?, ?)')
            .run('Orphan meeting', '2026-03-11', 4242),
        (error: unknown) => isSqliteConstraint(error, 'FOREIGN KEY'),
      );
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('personnel with history cannot be deleted silently', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const personId = insertPersonnel(db, { code: 'P-001', full_name: 'Amara Okonjo' });
      const meetingId = insertMeeting(db, { organizer_person_id: personId });
      db.handle
        .prepare('insert into meeting_attendees (meeting_id, person_id, attendance) values (?, ?, ?)')
        .run(meetingId, personId, 'present');
      db.handle
        .prepare('insert into action_items (meeting_id, title, assignee_person_id) values (?, ?, ?)')
        .run(meetingId, 'Draft the rota', personId);

      // ON DELETE RESTRICT: the delete fails rather than taking the history with it.
      assert.throws(
        () => db.handle.prepare('delete from personnel where id = ?').run(personId),
        (error: unknown) => isSqliteConstraint(error, 'FOREIGN KEY'),
      );

      const still = db.handle.prepare('select count(*) as n from meeting_attendees').get() as { n: number };
      assert.equal(still.n, 1);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('a meeting takes its own dependent rows with it, and nothing else', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const personId = insertPersonnel(db);
      const meetingId = insertMeeting(db);
      db.handle
        .prepare('insert into meeting_attendees (meeting_id, person_id) values (?, ?)')
        .run(meetingId, personId);
      db.handle.prepare('insert into meeting_notes (meeting_id, content) values (?, ?)').run(meetingId, 'Minuted.');
      db.handle
        .prepare('insert into note_revisions (meeting_id, revision_no, content) values (?, 1, ?)')
        .run(meetingId, 'Minuted.');

      db.handle.prepare('delete from meetings where id = ?').run(meetingId);

      const attendees = db.handle.prepare('select count(*) as n from meeting_attendees').get() as { n: number };
      assert.equal(attendees.n, 0);
      const people = db.handle.prepare('select count(*) as n from personnel').get() as { n: number };
      assert.equal(people.n, 1, 'deleting a meeting must never delete a person');
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('a written note revision cannot be rewritten', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const meetingId = insertMeeting(db);
      db.handle
        .prepare('insert into note_revisions (meeting_id, revision_no, content) values (?, 1, ?)')
        .run(meetingId, 'Original text.');

      assert.throws(
        () =>
          db.handle
            .prepare('update note_revisions set content = ? where meeting_id = ?')
            .run('Rewritten.', meetingId),
        /append-only/,
      );

      // The stored revision is unchanged, and history accumulates instead of being
      // overwritten: a second revision coexists with the first.
      db.handle
        .prepare('insert into note_revisions (meeting_id, revision_no, content) values (?, 2, ?)')
        .run(meetingId, 'Revised text.');
      const contents = db.handle
        .prepare('select content from note_revisions where meeting_id = ? order by revision_no')
        .all(meetingId) as { content: string }[];
      assert.deepEqual(
        contents.map((row) => row.content),
        ['Original text.', 'Revised text.'],
      );

      // Revision numbers are unique per meeting.
      assert.throws(
        () =>
          db.handle
            .prepare('insert into note_revisions (meeting_id, revision_no, content) values (?, 2, ?)')
            .run(meetingId, 'Duplicate number.'),
        (error: unknown) => /\bUNIQUE\b/i.test(String(error)),
      );
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('impossible records are rejected by CHECK constraints', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      // A Meet link on an in-person meeting.
      assert.throws(
        () =>
          db.handle
            .prepare('insert into meetings (title, meeting_date, meeting_type, meet_url) values (?, ?, ?, ?)')
            .run('In person', '2026-03-11', 'in-person', 'https://meet.example.com/abc'),
        (error: unknown) => isSqliteConstraint(error, 'CHECK'),
      );

      // A malformed date.
      assert.throws(
        () =>
          db.handle
            .prepare('insert into meetings (title, meeting_date) values (?, ?)')
            .run('Bad date', '11/03/2026'),
        (error: unknown) => isSqliteConstraint(error, 'CHECK'),
      );

      // An unknown attendance state.
      const meetingId = insertMeeting(db);
      const personId = insertPersonnel(db);
      assert.throws(
        () =>
          db.handle
            .prepare('insert into meeting_attendees (meeting_id, person_id, attendance) values (?, ?, ?)')
            .run(meetingId, personId, 'maybe'),
        (error: unknown) => isSqliteConstraint(error, 'CHECK'),
      );

      // An empty title.
      assert.throws(
        () => db.handle.prepare('insert into meetings (title, meeting_date) values (?, ?)').run('   ', '2026-03-11'),
        (error: unknown) => isSqliteConstraint(error, 'CHECK'),
      );
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('versions and timestamps are populated automatically', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const personId = insertPersonnel(db, { code: 'P-042', full_name: 'Ruth Mensah' });
      const row = db.handle
        .prepare('select public_id, row_version, created_at, updated_at from personnel where id = ?')
        .get(personId) as { public_id: string; row_version: number; created_at: string; updated_at: string };
      assert.equal(row.row_version, 1);
      assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(row.created_at, row.updated_at);
      assert.match(row.public_id, /^[0-9a-f]{32}$/);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('case 8: closing and reopening preserves committed records and the schema version', () => {
  const dir = tempDataDir();
  try {
    const config = migratedConfig(dir);

    const first = openDatabase(config);
    const personId = insertPersonnel(first, { code: 'P-777', full_name: 'Grace Adeyemi' });
    const meetingId = insertMeeting(first, { title: 'Budget review', organizer_person_id: personId });
    first.close();
    first.close(); // idempotent, never throws

    const second = openDatabase(config);
    try {
      assert.equal(second.schemaVersion(), 1);
      const person = second.handle.prepare('select full_name from personnel where id = ?').get(personId) as
        | { full_name: string }
        | undefined;
      assert.equal(person?.full_name, 'Grace Adeyemi');
      const meeting = second.handle.prepare('select title from meetings where id = ?').get(meetingId) as
        | { title: string }
        | undefined;
      assert.equal(meeting?.title, 'Budget review');
      assert.equal(Number(second.handle.pragma('foreign_keys', { simple: true })), 1, 'pragmas must be re-applied on every open');
      second.healthCheck();
    } finally {
      second.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('a closed connection refuses work instead of appearing healthy', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    db.close();
    assert.equal(db.isOpen, false);
    assert.throws(() => db.healthCheck(), (error: unknown) => {
      assert.ok(error instanceof DatabaseError);
      assert.equal(error.code, 'db.closed');
      return true;
    });
    assert.throws(() => db.handle, /closed/);
    assert.equal(db.schemaVersion(), 0);
  } finally {
    removeDir(dir);
  }
});

test('a corrupt database file fails startup instead of serving bad data', () => {
  const dir = tempDataDir();
  try {
    const config = migratedConfig(dir);
    // Overwrite the header of the database file, keeping the file the same size.
    const bytes = readFileSync(config.databasePath);
    bytes.fill(0, 0, 32);
    writeFileSync(config.databasePath, bytes);

    assert.throws(() => openDatabase(config), (error: unknown) => {
      assert.ok(error instanceof DatabaseError, `unexpected error: ${String(error)}`);
      assert.match(error.code, /^db\./);
      return true;
    });
  } finally {
    removeDir(dir);
  }
});
