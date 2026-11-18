/**
 * Failed startup must not leave anything behind (source-review finding 3).
 *
 * A startup that dies after the database is open used to leak the handle, and after the
 * listener is bound it could leak the socket as well — a failed start that keeps port 4317
 * or the WAL lock is worse than a failed start, because the next attempt fails for a
 * different, misleading reason. These tests break each startup step in turn and assert
 * that the cleanup runs, in the right order, before the original error is rethrown.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { StartedServer } from '../src/server.js';
import { startRuntime } from '../src/startup.js';
import {
  captureLogs,
  openMigrated,
  removeDir,
  startTestServer,
  tempDataDir,
} from './helpers.js';

function occurrences(logs: string, message: string): number {
  return logs.split('\n').filter((line) => line.includes(`"msg":"${message}"`)).length;
}

/** The last `service.startup_cleanup` line, parsed. */
function cleanupLine(logs: string): Record<string, unknown> {
  const lines = logs
    .trim()
    .split('\n')
    .filter((line) => line.includes('"msg":"service.startup_cleanup"'));
  assert.equal(lines.length, 1, 'exactly one cleanup line');
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
}

function env(dataDir: string, overrides: Record<string, string> = {}): Record<string, string> {
  return { NODE_ENV: 'test', RHODES_DATA_DIR: dataDir, RHODES_PORT: '0', ...overrides };
}

test('a failure inside createApp closes the database and rethrows the cause', async () => {
  const dir = tempDataDir();
  const cause = new Error('app exploded while wiring routes');
  try {
    const logs = await captureLogs(async () => {
      await assert.rejects(
        startRuntime({
          env: env(dir),
          createApp: () => {
            throw cause;
          },
        }),
        (error: unknown) => {
          // The original error is what the operator sees, not a cleanup artefact.
          assert.equal(error, cause);
          return true;
        },
      );
    });

    const cleanup = cleanupLine(logs);
    assert.equal(cleanup.listenerStarted, false, 'no listener existed yet');
    assert.equal(cleanup.listenerClosed, undefined, 'nothing to close, nothing claimed');
    assert.equal(cleanup.databaseClosed, true, 'the open connection was closed');
    assert.equal(cleanup.reason, cause.message);
    assert.equal(occurrences(logs, 'database.closed'), 1);

    // The file is usable afterwards: migrations had already run before the failure.
    const { db } = openMigrated(dir);
    try {
      assert.equal(db.handle.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('a failure after the listener started closes the listener and then the database', async () => {
  const dir = tempDataDir();

  let closeCalls = 0;
  // `url` throws, which makes the first statement after a successful bind fail: the exact
  // "listener is already accepting connections" case the cleanup has to survive.
  const fakeRunning = {
    port: 1,
    protocol: 'http',
    server: { listening: true },
    get url(): string {
      throw new Error('listener metadata unavailable');
    },
    close: async () => {
      closeCalls += 1;
      return { closed: true, alreadyClosed: false, forcedSockets: false };
    },
  } as unknown as StartedServer;

  try {
    const logs = await captureLogs(async () => {
      await assert.rejects(
        startRuntime({
          env: env(dir),
          startServer: async () => fakeRunning,
        }),
        /listener metadata unavailable/,
      );
    });

    assert.equal(closeCalls, 1, 'the bound listener was closed exactly once');
    const cleanup = cleanupLine(logs);
    assert.equal(cleanup.listenerStarted, true);
    assert.equal(cleanup.listenerClosed, true);
    assert.equal(cleanup.databaseClosed, true);
    assert.equal(occurrences(logs, 'database.closed'), 1);
  } finally {
    removeDir(dir);
  }
});

test('a real bind failure closes the database and keeps the bind error', async () => {
  const dir = tempDataDir();
  const competingDir = tempDataDir();
  const { db: competingDb } = openMigrated(competingDir);
  const first = await startTestServer(competingDb);

  try {
    const logs = await captureLogs(async () => {
      await assert.rejects(
        startRuntime({ env: env(dir, { RHODES_PORT: String(first.running.port) }) }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'http.bind_failed');
          return true;
        },
      );
    });

    const cleanup = cleanupLine(logs);
    assert.equal(cleanup.listenerStarted, false);
    assert.equal(cleanup.databaseClosed, true);

    // The port stayed with its owner: the failed attempt did not disturb it.
    assert.equal(first.running.server.listening, true);
    assert.equal((await fetch(`${first.baseUrl}/api/health`)).status, 200);
  } finally {
    await first.running.close();
    competingDb.close();
    removeDir(dir);
    removeDir(competingDir);
  }
});
