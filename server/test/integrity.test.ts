/**
 * LAN-1.1 integrity hardening (migration 0002).
 *
 * Three groups of guarantees that 0001 could not express:
 *   1. a date or time in the database is a real calendar date / real clock time;
 *   2. an agenda link never crosses meeting boundaries, in either direction;
 *   3. note revision history can be appended to and read, but never destroyed.
 *
 * Every test runs against a throwaway database directory.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { RhodesDatabase } from '../src/db/index.js';
import { insertMeeting, insertPersonnel, openMigrated, removeDir, tempDataDir } from './helpers.js';

/** Insert a row built from a plain object, returning the new id. */
function insert(db: RhodesDatabase, table: string, values: Record<string, unknown>): number {
  const columns = Object.keys(values);
  const info = db.handle
    .prepare(`insert into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((column) => values[column]));
  return Number(info.lastInsertRowid);
}

function update(db: RhodesDatabase, table: string, id: number, values: Record<string, unknown>): void {
  const columns = Object.keys(values);
  db.handle
    .prepare(`update ${table} set ${columns.map((column) => `${column} = ?`).join(', ')} where id = ?`)
    .run(...columns.map((column) => values[column]), id);
}

function insertAgendaItem(db: RhodesDatabase, meetingId: number, title = 'Item'): number {
  return insert(db, 'agenda_items', { meeting_id: meetingId, title });
}

// ── 1. calendar dates ────────────────────────────────────────────────────────

test('meeting_date accepts real dates and rejects impossible ones on insert', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      for (const date of ['2024-02-29', '2026-01-01', '2026-12-31', '2000-02-29']) {
        assert.doesNotThrow(() => insertMeeting(db, { meeting_date: date }), `${date} should be accepted`);
      }
      for (const date of ['2025-02-29', '2026-02-30', '2024-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00']) {
        assert.throws(
          () => insertMeeting(db, { meeting_date: date }),
          /real calendar date/,
          `${date} should be rejected`,
        );
      }
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('meeting_date rejects impossible values on update, and still accepts valid ones', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const id = insertMeeting(db, { meeting_date: '2026-03-11' });

      for (const date of ['2025-02-29', '2026-02-30', '2026-13-01', '2026-04-31']) {
        assert.throws(
          () => update(db, 'meetings', id, { meeting_date: date }),
          /real calendar date/,
          `updating to ${date} should be rejected`,
        );
      }

      update(db, 'meetings', id, { meeting_date: '2024-02-29' });
      const stored = db.handle.prepare('select meeting_date from meetings where id = ?').get(id) as {
        meeting_date: string;
      };
      assert.equal(stored.meeting_date, '2024-02-29');
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('next_meeting_date accepts null, empty and real dates only', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      assert.doesNotThrow(() => insertMeeting(db, { next_meeting_date: null }));
      assert.doesNotThrow(() => insertMeeting(db, { next_meeting_date: '' }));
      assert.doesNotThrow(() => insertMeeting(db, { next_meeting_date: '2024-02-29' }));
      for (const date of ['2025-02-29', '2026-02-30', '2026-13-01']) {
        assert.throws(() => insertMeeting(db, { next_meeting_date: date }), /next_meeting_date/);
      }

      const id = insertMeeting(db, { next_meeting_date: '2026-03-11' });
      assert.throws(() => update(db, 'meetings', id, { next_meeting_date: '2025-02-29' }), /next_meeting_date/);
      assert.doesNotThrow(() => update(db, 'meetings', id, { next_meeting_date: null }));
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('decision_date and due_date accept empty or real dates only', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const meetingId = insertMeeting(db);

      for (const date of ['', '2024-02-29', '2026-05-01']) {
        assert.doesNotThrow(() =>
          insert(db, 'decisions', { meeting_id: meetingId, title: 'Decision', decision_date: date }),
        );
        assert.doesNotThrow(() =>
          insert(db, 'action_items', { meeting_id: meetingId, title: 'Action', due_date: date }),
        );
      }

      for (const date of ['2025-02-29', '2026-02-30', '2026-13-01', '2026-04-31']) {
        assert.throws(
          () => insert(db, 'decisions', { meeting_id: meetingId, title: 'D', decision_date: date }),
          /decisions\.decision_date/,
        );
        assert.throws(
          () => insert(db, 'action_items', { meeting_id: meetingId, title: 'A', due_date: date }),
          /action_items\.due_date/,
        );
      }

      const decisionId = insert(db, 'decisions', { meeting_id: meetingId, title: 'D2', decision_date: '2026-05-01' });
      const actionId = insert(db, 'action_items', { meeting_id: meetingId, title: 'A2', due_date: '2026-05-01' });
      assert.throws(
        () => update(db, 'decisions', decisionId, { decision_date: '2025-02-29' }),
        /decisions\.decision_date/,
      );
      assert.throws(
        () => update(db, 'action_items', actionId, { due_date: '2025-02-29' }),
        /action_items\.due_date/,
      );
      assert.doesNotThrow(() => update(db, 'decisions', decisionId, { decision_date: '' }));
      assert.doesNotThrow(() => update(db, 'action_items', actionId, { due_date: '2024-02-29' }));
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

// ── 2. clock times ───────────────────────────────────────────────────────────

test('start_time and end_time accept only real 24-hour times', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      for (const time of ['', '00:00', '09:30', '23:59']) {
        assert.doesNotThrow(
          () => insertMeeting(db, { start_time: time, end_time: time }),
          `${time || '(empty)'} should be accepted`,
        );
      }

      const rejected = ['24:00', '12:60', '23:60', '99:99', '9:30', '09:5', 'ab:cd'];
      for (const time of rejected) {
        assert.throws(
          () => insertMeeting(db, { start_time: time }),
          /start_time/,
          `start_time ${time} should be rejected`,
        );
        assert.throws(
          () => insertMeeting(db, { end_time: time }),
          /end_time/,
          `end_time ${time} should be rejected`,
        );
      }
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('time values are validated on update', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const id = insertMeeting(db, { start_time: '09:00', end_time: '10:00' });
      assert.throws(() => update(db, 'meetings', id, { start_time: '24:00' }), /start_time/);
      assert.throws(() => update(db, 'meetings', id, { end_time: '12:60' }), /end_time/);
      assert.doesNotThrow(() => update(db, 'meetings', id, { start_time: '23:59', end_time: '00:00' }));
      assert.doesNotThrow(() => update(db, 'meetings', id, { start_time: '', end_time: '' }));
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

// ── 3. agenda links stay inside one meeting ──────────────────────────────────

test('a decision and an action item may link to an agenda item of their own meeting', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const meetingId = insertMeeting(db);
      const agendaId = insertAgendaItem(db, meetingId, 'Budget');

      assert.doesNotThrow(() =>
        insert(db, 'decisions', { meeting_id: meetingId, agenda_item_id: agendaId, title: 'Approve budget' }),
      );
      assert.doesNotThrow(() =>
        insert(db, 'action_items', { meeting_id: meetingId, agenda_item_id: agendaId, title: 'Book the room' }),
      );

      const counts = db.handle
        .prepare('select (select count(*) from decisions) as d, (select count(*) from action_items) as a')
        .get() as { d: number; a: number };
      assert.equal(counts.d, 1);
      assert.equal(counts.a, 1);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('a cross-meeting agenda reference is rejected on insert', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const march = insertMeeting(db, { title: 'March', meeting_date: '2026-03-11' });
      const april = insertMeeting(db, { title: 'April', meeting_date: '2026-04-08' });
      // The agenda item exists — it simply belongs to the other meeting.
      const aprilAgenda = insertAgendaItem(db, april, 'April item');

      assert.throws(
        () => insert(db, 'decisions', { meeting_id: march, agenda_item_id: aprilAgenda, title: 'Cross' }),
        /same meeting/,
      );
      assert.throws(
        () => insert(db, 'action_items', { meeting_id: march, agenda_item_id: aprilAgenda, title: 'Cross' }),
        /same meeting/,
      );

      const stored = db.handle
        .prepare('select (select count(*) from decisions) as d, (select count(*) from action_items) as a')
        .get() as { d: number; a: number };
      assert.deepEqual(stored, { d: 0, a: 0 });
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('updating a record so that its agenda link crosses meetings is rejected', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const march = insertMeeting(db, { title: 'March', meeting_date: '2026-03-11' });
      const april = insertMeeting(db, { title: 'April', meeting_date: '2026-04-08' });
      const marchAgenda = insertAgendaItem(db, march, 'March item');
      const aprilAgenda = insertAgendaItem(db, april, 'April item');

      const decisionId = insert(db, 'decisions', { meeting_id: march, agenda_item_id: marchAgenda, title: 'Fine' });
      const actionId = insert(db, 'action_items', { meeting_id: march, agenda_item_id: marchAgenda, title: 'Fine' });

      // Repointing the link at another meeting's agenda item.
      assert.throws(() => update(db, 'decisions', decisionId, { agenda_item_id: aprilAgenda }), /same meeting/);
      assert.throws(() => update(db, 'action_items', actionId, { agenda_item_id: aprilAgenda }), /same meeting/);

      // Moving the record itself to another meeting while keeping the old agenda item.
      assert.throws(() => update(db, 'decisions', decisionId, { meeting_id: april }), /same meeting/);
      assert.throws(() => update(db, 'action_items', actionId, { meeting_id: april }), /same meeting/);

      // Both at once is consistent, and allowed.
      assert.doesNotThrow(() =>
        update(db, 'decisions', decisionId, { meeting_id: april, agenda_item_id: aprilAgenda }),
      );
      const moved = db.handle.prepare('select meeting_id, agenda_item_id from decisions where id = ?').get(decisionId) as {
        meeting_id: number;
        agenda_item_id: number;
      };
      assert.deepEqual(moved, { meeting_id: april, agenda_item_id: aprilAgenda });
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('an agenda item cannot be moved to another meeting while it is linked', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const march = insertMeeting(db, { title: 'March', meeting_date: '2026-03-11' });
      const april = insertMeeting(db, { title: 'April', meeting_date: '2026-04-08' });

      const agendaWithDecision = insertAgendaItem(db, march, 'Has a decision');
      insert(db, 'decisions', { meeting_id: march, agenda_item_id: agendaWithDecision, title: 'Linked' });

      const agendaWithAction = insertAgendaItem(db, march, 'Has an action');
      insert(db, 'action_items', { meeting_id: march, agenda_item_id: agendaWithAction, title: 'Linked' });

      assert.throws(() => update(db, 'agenda_items', agendaWithDecision, { meeting_id: april }), /cannot change/);
      assert.throws(() => update(db, 'agenda_items', agendaWithAction, { meeting_id: april }), /cannot change/);

      const still = db.handle.prepare('select meeting_id from agenda_items where id = ?').get(agendaWithDecision) as {
        meeting_id: number;
      };
      assert.equal(still.meeting_id, march);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('agenda references are optional: null stays valid, and an unlinked item moves freely', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const march = insertMeeting(db, { title: 'March', meeting_date: '2026-03-11' });
      const april = insertMeeting(db, { title: 'April', meeting_date: '2026-04-08' });

      const decisionId = insert(db, 'decisions', { meeting_id: march, title: 'No agenda link' });
      const actionId = insert(db, 'action_items', { meeting_id: march, title: 'No agenda link' });
      assert.equal(
        (db.handle.prepare('select agenda_item_id from decisions where id = ?').get(decisionId) as { agenda_item_id: unknown })
          .agenda_item_id,
        null,
      );
      assert.equal(
        (db.handle.prepare('select agenda_item_id from action_items where id = ?').get(actionId) as { agenda_item_id: unknown })
          .agenda_item_id,
        null,
      );

      // An agenda item with no links may move between meetings.
      const freeAgenda = insertAgendaItem(db, march, 'Unlinked');
      assert.doesNotThrow(() => update(db, 'agenda_items', freeAgenda, { meeting_id: april }));

      // Detaching a link is always allowed.
      const agenda = insertAgendaItem(db, march, 'Linked then detached');
      const linked = insert(db, 'decisions', { meeting_id: march, agenda_item_id: agenda, title: 'Linked' });
      assert.doesNotThrow(() => update(db, 'decisions', linked, { agenda_item_id: null }));
      assert.doesNotThrow(() => update(db, 'agenda_items', agenda, { meeting_id: april }));
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

// ── 4. revision history cannot be destroyed ─────────────────────────────────

test('deleting a single note revision is rejected', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const meetingId = insertMeeting(db);
      insert(db, 'note_revisions', { meeting_id: meetingId, revision_no: 1, content: 'Minuted.' });

      assert.throws(
        () => db.handle.prepare('delete from note_revisions where meeting_id = ?').run(meetingId),
        /cannot be deleted/,
      );
      const remaining = db.handle.prepare('select count(*) as n from note_revisions').get() as { n: number };
      assert.equal(remaining.n, 1);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('a meeting with note revision history cannot be hard-deleted', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const meetingId = insertMeeting(db);
      insertPersonnel(db);
      insert(db, 'meeting_notes', { meeting_id: meetingId, content: 'Minutes body' });
      insert(db, 'note_revisions', { meeting_id: meetingId, revision_no: 1, content: 'Minutes body' });

      assert.throws(
        () => db.handle.prepare('delete from meetings where id = ?').run(meetingId),
        /cannot be hard-deleted/,
      );

      const meeting = db.handle.prepare('select count(*) as n from meetings where id = ?').get(meetingId) as { n: number };
      assert.equal(meeting.n, 1);
      const revisions = db.handle.prepare('select count(*) as n from note_revisions').get() as { n: number };
      assert.equal(revisions.n, 1);

      // A meeting with no revision history is still deletable — the guard is specific,
      // not a blanket block on hard deletes.
      const plain = insertMeeting(db, { title: 'No revisions', meeting_date: '2026-05-06' });
      assert.doesNotThrow(() => db.handle.prepare('delete from meetings where id = ?').run(plain));
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('soft-deleting a meeting keeps its revisions readable and appendable', () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      const meetingId = insertMeeting(db);
      insert(db, 'note_revisions', { meeting_id: meetingId, revision_no: 1, content: 'First pass' });

      // Soft delete is the normal deletion policy.
      assert.doesNotThrow(() =>
        update(db, 'meetings', meetingId, { deleted_at: '2026-03-12T00:00:00.000Z', status: 'cancelled' }),
      );

      const revisions = db.handle
        .prepare('select revision_no, content from note_revisions where meeting_id = ? order by revision_no')
        .all(meetingId) as { revision_no: number; content: string }[];
      assert.deepEqual(revisions, [{ revision_no: 1, content: 'First pass' }]);

      // New revisions can still be appended to a soft-deleted meeting.
      insert(db, 'note_revisions', { meeting_id: meetingId, revision_no: 2, content: 'Second pass' });
      const after = db.handle
        .prepare('select revision_no, content from note_revisions where meeting_id = ? order by revision_no')
        .all(meetingId) as { revision_no: number; content: string }[];
      assert.deepEqual(after, [
        { revision_no: 1, content: 'First pass' },
        { revision_no: 2, content: 'Second pass' },
      ]);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});
