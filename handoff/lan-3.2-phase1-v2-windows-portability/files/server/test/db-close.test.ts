/**
 * Database shutdown outcomes (LAN-3.2, Phase 1).
 *
 * `close()` used to return nothing: a busy checkpoint, a failed checkpoint and a clean
 * one all looked identical, and `database.closed` was written whether or not the handle
 * had actually closed. These tests pin the four facts apart — checkpoint attempted,
 * checkpoint complete, connection closed, and the conjunction — and prove that the WAL
 * is preserved rather than tidied away when the checkpoint does not finish.
 *
 * The failure paths (a checkpoint that throws, a close that throws) cannot be produced by
 * a healthy SQLite handle, so they are exercised through `RhodesDatabase.forTesting` with
 * a handle-like object. Everything else runs against a real, disposable database file in
 * a temporary directory.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openDatabase, RhodesDatabase, type Db } from '../src/db/index.js';
import {
  captureLogs,
  configFor,
  insertMeeting,
  migratedConfig,
  openMigrated,
  removeDir,
  tempDataDir,
} from './helpers.js';

// ── a handle-like object, for the paths a healthy database will not take ─────

interface FakeHandle {
  open: boolean;
  pragma: (sql: string) => unknown;
  close: () => void;
}

function fake(behaviour: {
  checkpoint?: () => unknown;
  close?: () => void;
  open?: boolean;
}): FakeHandle {
  const handle: FakeHandle = {
    open: behaviour.open ?? true,
    pragma: () => behaviour.checkpoint?.() ?? [{ busy: 0, log: 1, checkpointed: 1 }],
    close: () => {
      if (behaviour.close !== undefined) behaviour.close();
      else handle.open = false;
    },
  };
  return handle;
}

/** Count how many times a JSON log line with this message appears. */
function occurrences(logs: string, message: string): number {
  return logs.split('\n').filter((line) => line.includes(`"msg":"${message}"`)).length;
}

function wrap(handle: FakeHandle) {
  return RhodesDatabase.forTesting(handle as unknown as Db);
}

test('a clean checkpoint and close report success', async () => {
  const handle = fake({ checkpoint: () => [{ busy: 0, log: 4, checkpointed: 4 }] });
  const logs = await captureLogs(() => {
    const result = wrap(handle).close();
    assert.deepEqual(result, {
      checkpoint: { busy: 0, log: 4, checkpointed: 4 },
      checkpointed: true,
      closed: true,
      stage: 'done',
      ok: true,
    });
  });

  assert.equal(occurrences(logs, 'database.checkpointed'), 1);
  assert.equal(occurrences(logs, 'database.closed'), 1);
  assert.equal(occurrences(logs, 'database.close_incomplete'), 0);
  assert.equal(occurrences(logs, 'database.checkpoint_incomplete'), 0);
});

test('an incomplete checkpoint still closes the connection, and says both', async () => {
  const handle = fake({ checkpoint: () => [{ busy: 1, log: 4, checkpointed: 0 }] });
  const logs = await captureLogs(() => {
    const result = wrap(handle).close();
    assert.equal(result.checkpointed, false, 'a busy checkpoint is not a completed one');
    assert.equal(result.closed, true, 'the connection must still be closed');
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'checkpoint');
    assert.deepEqual(result.checkpoint, { busy: 1, log: 4, checkpointed: 0 });
    assert.equal(handle.open, false);
  });

  assert.equal(occurrences(logs, 'database.checkpoint_incomplete'), 1);
  // A real close is reported even when the checkpoint was not: they are separate facts.
  assert.equal(occurrences(logs, 'database.closed'), 1);
  assert.equal(occurrences(logs, 'database.close_incomplete'), 1);
});

test('a checkpoint backlog is incomplete even when nothing was busy', async () => {
  const handle = fake({ checkpoint: () => [{ busy: 0, log: 5, checkpointed: 3 }] });
  const logs = await captureLogs(() => {
    const result = wrap(handle).close();
    assert.equal(result.checkpointed, false);
    assert.equal(result.closed, true);
    assert.equal(result.ok, false);
  });
  assert.equal(occurrences(logs, 'database.checkpoint_incomplete'), 1);
});

test('a checkpoint that throws is reported, and the connection is still closed', async () => {
  const handle = fake({
    checkpoint: () => {
      const error = new Error('disk I/O error') as Error & { code?: string };
      error.code = 'SQLITE_IOERR';
      throw error;
    },
  });

  const logs = await captureLogs(() => {
    const result = wrap(handle).close();
    assert.equal(result.checkpoint, null, 'no row was produced, so no outcome is claimed');
    assert.equal(result.checkpointed, false);
    assert.equal(result.closed, true, 'a failed checkpoint must not keep the handle open');
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'checkpoint');
    assert.equal(result.error?.code, 'SQLITE_IOERR');
    assert.match(result.error?.message ?? '', /disk I\/O error/);
  });

  assert.equal(occurrences(logs, 'database.checkpoint_failed'), 1);
  assert.equal(occurrences(logs, 'database.closed'), 1);
});

test('a connection that refuses to close is never reported as closed', async () => {
  const handle = fake({
    checkpoint: () => [{ busy: 0, log: 2, checkpointed: 2 }],
    close: () => {
      throw Object.assign(new Error('cannot close: statements in progress'), { code: 'SQLITE_BUSY' });
    },
  });

  const logs = await captureLogs(() => {
    const result = wrap(handle).close();
    assert.equal(result.closed, false);
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'close');
    assert.equal(result.error?.code, 'SQLITE_BUSY');
  });

  assert.equal(occurrences(logs, 'database.close_failed'), 1);
  assert.equal(occurrences(logs, 'database.closed'), 0, 'a still-open handle is not "closed"');
  assert.equal(occurrences(logs, 'database.close_incomplete'), 1);
});

test('a close that throws but leaves the handle closed is still not a success', async () => {
  const handle = fake({
    checkpoint: () => [{ busy: 0, log: 2, checkpointed: 2 }],
    close: () => {
      handle.open = false;
      throw new Error('closed with a complaint');
    },
  });

  const logs = await captureLogs(() => {
    const result = wrap(handle).close();
    assert.equal(result.closed, true, 'the handle really is closed');
    assert.equal(result.ok, false, 'a throwing close is not a clean close');
    assert.equal(result.stage, 'close');
  });

  assert.equal(occurrences(logs, 'database.closed'), 1);
  assert.equal(occurrences(logs, 'database.close_incomplete'), 1);
});

test('an already-closed connection is a no-op, not a failure', async () => {
  const handle = fake({ open: false });

  const logs = await captureLogs(() => {
    const result = wrap(handle).close();
    assert.deepEqual(result, {
      checkpoint: null,
      checkpointed: true,
      closed: true,
      stage: 'not_open',
      ok: true,
    });
  });

  assert.equal(logs.trim(), '', 'nothing happened, so nothing is logged');
});

test('repeated close calls return the first result and log exactly once', async () => {
  const handle = fake({ checkpoint: () => [{ busy: 0, log: 3, checkpointed: 3 }] });
  const db = wrap(handle);

  const logs = await captureLogs(() => {
    const first = db.close();
    const second = db.close();
    const third = db.close();
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
  });

  assert.equal(occurrences(logs, 'database.closed'), 1);
  assert.equal(occurrences(logs, 'database.checkpointed'), 1);
});

// ── integration: a real database, a real WAL, a real reader ──────────────────

test('integration: a reader blocks the checkpoint; the WAL survives and the data recovers', async () => {
  const dir = tempDataDir();
  // A short busy timeout keeps the "reader holds the WAL" case fast and deterministic:
  // the truncating checkpoint gives up after 100 ms instead of the 5 s default.
  const config = migratedConfig(dir, { RHODES_BUSY_TIMEOUT_MS: '100' });
  const walPath = `${config.databasePath}-wal`;

  const db = openDatabase(config);
  insertMeeting(db, { title: 'Checkpoint under a reader' });

  // A second connection holding a read transaction: deterministic, no sleeps.
  const reader = new Database(config.databasePath, { readonly: true });
  reader.exec('begin');
  reader.prepare('select count(*) as n from meetings').get();

  try {
    assert.ok(existsSync(walPath), 'the write above must have produced a WAL');

    const logs = await captureLogs(() => {
      const result = db.close();
      assert.equal(result.closed, true, 'the handle is closed even while a reader holds the WAL');
      assert.equal(result.ok, false);
      assert.equal(result.checkpointed, false);
      assert.ok(result.checkpoint !== null, 'the pragma must return a row to inspect');
      assert.equal(result.checkpoint?.busy, 1, 'a reader makes the truncating checkpoint busy');
    });

    assert.equal(occurrences(logs, 'database.checkpoint_incomplete'), 1);
    assert.equal(occurrences(logs, 'database.closed'), 1);

    // Nothing was deleted: the frames a backup needs are still on disk.
    assert.ok(existsSync(walPath), 'an incomplete checkpoint must leave the WAL in place');
    assert.ok(statSync(walPath).size > 0, 'the retained WAL still holds the committed frames');
  } finally {
    reader.exec('commit');
    reader.close();
  }

  // A fresh connection replays the WAL and sees the committed row.
  const reopened = openDatabase(config);
  try {
    const row = reopened.handle.prepare('select title from meetings').get() as { title: string };
    assert.equal(row.title, 'Checkpoint under a reader');
    assert.equal(
      String(reopened.handle.pragma('quick_check', { simple: true })).toLowerCase(),
      'ok',
    );
  } finally {
    const result = reopened.close();
    assert.equal(result.ok, true, 'with no reader left, the close completes cleanly');
  }

  // After a complete checkpoint the WAL is truncated away or emptied — never a data loss,
  // because the frames have been folded into the main file.
  assert.ok(
    !existsSync(walPath) || statSync(walPath).size === 0,
    'a completed TRUNCATE checkpoint empties the WAL',
  );

  removeDir(dir);
});

test('integration: a clean close on a real database reports every fact', async () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    insertMeeting(db, { title: 'Clean close' });

    const logs = await captureLogs(() => {
      const result = db.close();
      assert.equal(result.ok, true);
      assert.equal(result.checkpointed, true);
      assert.equal(result.closed, true);
      assert.equal(result.stage, 'done');
      assert.ok((result.checkpoint?.log ?? -1) >= 0);
    });

    assert.equal(occurrences(logs, 'database.closed'), 1);
    assert.equal(occurrences(logs, 'database.close_incomplete'), 0);
  } finally {
    removeDir(dir);
  }
});

test('integration: the database path is the configured one, unchanged', () => {
  const dir = tempDataDir();
  try {
    const config = migratedConfig(dir);
    const db = openDatabase(config);
    try {
      assert.equal(db.filePath, path.join(dir, 'rhodes.db'));
      assert.equal(db.filePath, config.databasePath);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

/**
 * Run the crash fixture and resolve when the child has committed *and* died.
 *
 * Synchronisation is on the child's own `committed` line and its `exit` event — no
 * timers, so a slow machine only makes the test slower, never flaky.
 */
async function runCrashChild(dataDir: string): Promise<{ signal: string | null; code: number | null }> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(import.meta.dirname, 'fixtures', 'crash-child.ts'), dataDir],
    { cwd: path.join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const exited = new Promise<{ signal: string | null; code: number | null }>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let committed = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!committed && stdout.includes('committed')) committed = true;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (!committed) {
        reject(new Error(`the child died before committing (code ${code}, signal ${signal}): ${stderr}`));
        return;
      }
      resolve({ code, signal });
    });
  });

  return exited;
}

/**
 * The child must die *unclean* — no shutdown code ran — but the evidence differs by platform.
 *
 * POSIX reports the fatal signal and no exit code (`signal: 'SIGKILL'`, `code: null`).
 * Windows has no POSIX signals: `process.kill(pid, 'SIGKILL')` becomes `TerminateProcess`,
 * so Node reports an exit code and `signal` is always `null`. Asserting the signal there
 * tests the platform's signal plumbing, not our recovery path, and it fails before the WAL
 * assertions below are ever reached — which is exactly what happened in the first Windows
 * run. The recovery assertions themselves are platform-independent and run everywhere.
 */
function assertUncleanTermination(exit: { signal: string | null; code: number | null }): void {
  if (process.platform === 'win32') {
    assert.equal(exit.signal, null, 'Windows does not report POSIX signal metadata');
    assert.notEqual(exit.code, 0, 'an abruptly terminated child must not report a clean exit');
    return;
  }
  assert.equal(exit.signal, 'SIGKILL', 'the fixture must die unclean, not shut down');
  assert.equal(exit.code, null, 'a signal-terminated child reports no exit code');
}

test('integration: rows committed before an abrupt death survive the reopen', async () => {
  const dir = tempDataDir();
  try {
    // A schema at the current version, closed cleanly, so the child starts from a known state.
    migratedConfig(dir);

    const exit = await runCrashChild(dir);
    assertUncleanTermination(exit);

    // The dead process left its WAL behind; we neither deleted it nor replayed it by hand.
    assert.equal(existsSync(path.join(dir, 'rhodes.db-wal')), true, 'the WAL of the dead process is preserved');

    const db = openDatabase(configFor(dir));
    try {
      const rows = db.handle.prepare("select title from meetings where title = 'Committed before the crash'").all() as Array<{ title: string }>;
      assert.equal(rows.length, 1, 'the committed row is recovered from the WAL');

      const check = db.handle.pragma('quick_check', { simple: true }) as string;
      assert.equal(check, 'ok');

      // And the reopened database can still be closed cleanly afterwards.
      const result = db.close();
      assert.equal(result.ok, true);
      assert.equal(result.closed, true);
    } finally {
      // Idempotent: a no-op if the assertions above already closed it.
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});
