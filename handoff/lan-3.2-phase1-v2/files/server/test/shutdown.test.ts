/**
 * Shutdown composition and the exit-code contract (LAN-3.2, Phase 1).
 *
 * `Runtime.shutdown` used to return nothing and to swallow both failures: a listener that
 * refused to close and a database whose checkpoint was incomplete were indistinguishable
 * from a clean stop. These tests drive the real startup path (temporary data directory,
 * ephemeral port) and then break one stage at a time, asserting that the other stage still
 * runs and that the reported result — and the exit code derived from it — is honest.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { CloseResult } from '../src/db/index.js';
import type { ListenerCloseOutcome } from '../src/server.js';
import {
  EXIT_FATAL,
  EXIT_OK,
  EXIT_SHUTDOWN_INCOMPLETE,
  SHUTDOWN_COMPLETE_MESSAGE,
  exitCodeFor,
  performShutdown,
} from '../src/shutdown.js';
import { startRuntime, type Runtime, type ShutdownResult } from '../src/startup.js';
import { captureLogs, removeDir, tempDataDir } from './helpers.js';

function occurrences(logs: string, message: string): number {
  return logs.split('\n').filter((line) => line.includes(`"msg":"${message}"`)).length;
}

async function withRuntime(fn: (runtime: Runtime) => Promise<void>): Promise<void> {
  const dir = tempDataDir();
  const runtime = await startRuntime({
    env: { NODE_ENV: 'test', RHODES_DATA_DIR: dir, RHODES_PORT: '0' },
  });
  try {
    await fn(runtime);
  } finally {
    // Whatever the test did, leave nothing open and nothing on disk. Both closes are
    // idempotent, so this also covers the tests that swapped one of them out.
    try {
      await runtime.running.close();
    } catch {
      // already closed, or never opened — nothing to do
    }
    try {
      runtime.db.close();
    } catch {
      // already closed
    }
    removeDir(dir);
  }
}

function breakListener(runtime: Runtime, outcome: ListenerCloseOutcome): () => void {
  const target = runtime.running as unknown as { close: () => Promise<ListenerCloseOutcome> };
  const original = target.close;
  target.close = async () => outcome;
  return () => {
    target.close = original;
  };
}

function breakDatabase(runtime: Runtime, outcome: CloseResult): () => void {
  const target = runtime.db as unknown as { close: () => CloseResult };
  const original = target.close;
  target.close = () => outcome;
  return () => {
    target.close = original;
  };
}

test('a healthy shutdown reports every stage and succeeds', async () => {
  await withRuntime(async (runtime) => {
    const logs = await captureLogs(async () => {
      const result = await runtime.shutdown('signal');
      assert.deepEqual(result, {
        listenerClosed: true,
        checkpointed: true,
        databaseClosed: true,
        ok: true,
      });
    });

    assert.equal(occurrences(logs, 'service.stopping'), 1);
    assert.equal(occurrences(logs, 'service.listener_closed'), 1);
    assert.equal(occurrences(logs, 'database.closed'), 1);
    assert.equal(occurrences(logs, 'service.shutdown_incomplete'), 0);
  });
});

test('a listener that fails to close does not stop the database from closing', async () => {
  await withRuntime(async (runtime) => {
    const restore = breakListener(runtime, {
      closed: false,
      alreadyClosed: false,
      forcedSockets: false,
      error: { code: 'EIO', message: 'listener wedged' },
    });

    try {
      const logs = await captureLogs(async () => {
        const result = await runtime.shutdown('signal');
        assert.equal(result.listenerClosed, false);
        assert.equal(result.databaseClosed, true, 'the database is still closed');
        assert.equal(result.checkpointed, true);
        assert.equal(result.ok, false);
      });

      assert.equal(occurrences(logs, 'service.listener_close_failed'), 1);
      assert.equal(occurrences(logs, 'database.closed'), 1);
      assert.equal(occurrences(logs, 'service.shutdown_incomplete'), 1);
    } finally {
      restore();
    }
  });
});

test('a database that fails to close is reported even though the listener closed', async () => {
  await withRuntime(async (runtime) => {
    const restore = breakDatabase(runtime, {
      checkpoint: { busy: 1, log: 7, checkpointed: 0 },
      checkpointed: false,
      closed: false,
      stage: 'close',
      ok: false,
      error: { code: 'SQLITE_BUSY', message: 'still open' },
    });

    try {
      const logs = await captureLogs(async () => {
        const result = await runtime.shutdown('signal');
        assert.equal(result.listenerClosed, true);
        assert.equal(result.checkpointed, false);
        assert.equal(result.databaseClosed, false);
        assert.equal(result.ok, false);
      });

      assert.equal(occurrences(logs, 'service.shutdown_incomplete'), 1);
    } finally {
      restore();
    }
  });
});

test('both stages failing is still one shutdown, reported as such', async () => {
  await withRuntime(async (runtime) => {
    const restoreListener = breakListener(runtime, {
      closed: false,
      alreadyClosed: false,
      forcedSockets: true,
      error: { code: 'EIO', message: 'listener wedged' },
    });
    const restoreDb = breakDatabase(runtime, {
      checkpoint: null,
      checkpointed: false,
      closed: false,
      stage: 'close',
      ok: false,
      error: { code: 'SQLITE_BUSY', message: 'still open' },
    });

    try {
      const result = await runtime.shutdown('signal');
      assert.deepEqual(result, {
        listenerClosed: false,
        checkpointed: false,
        databaseClosed: false,
        ok: false,
      });
    } finally {
      restoreListener();
      restoreDb();
    }
  });
});

test('a close error after a successful close is not a clean shutdown', async () => {
  await withRuntime(async (runtime) => {
    // The exact shape the source review flagged: the WAL was folded and the handle is
    // gone, but the close itself reported an error, so `CloseResult.ok` is false.
    const restore = breakDatabase(runtime, {
      checkpoint: { busy: 0, log: 4, checkpointed: 4 },
      checkpointed: true,
      closed: true,
      stage: 'close',
      ok: false,
      error: { code: 'db.close_failed', message: 'the close threw after the handle closed' },
    });

    try {
      const logs = await captureLogs(async () => {
        const result = await runtime.shutdown('SIGTERM');

        // The facts are reported as they are — neither is downgraded.
        assert.equal(result.checkpointed, true);
        assert.equal(result.databaseClosed, true);
        assert.equal(result.listenerClosed, true);

        // …and the verdict is still negative.
        assert.equal(
          result.ok,
          false,
          'CloseResult.ok=false must fail the shutdown even when checkpointed and closed are true',
        );

        // A requested clean stop therefore exits 69, not 0.
        const report = await performShutdown({
          runtime: { shutdown: async () => result },
          reason: 'SIGTERM',
          requestedCode: EXIT_OK,
          write: () => {},
        });
        assert.equal(report.exitCode, EXIT_SHUTDOWN_INCOMPLETE);
        assert.equal(report.exitCode, 69);
        assert.equal(report.message.ok, false);
        assert.equal(report.message.exitCode, 69);
      });

      assert.equal(occurrences(logs, 'service.shutdown_incomplete'), 1);
      assert.match(logs, /"databaseStage":"close"/);
      assert.match(logs, /"databaseError":\{"code":"db\.close_failed"/);
    } finally {
      restore();
    }
  });
});

test('concurrent and repeated shutdown calls share one result and log once', async () => {
  await withRuntime(async (runtime) => {
    const logs = await captureLogs(async () => {
      const [first, second, third] = await Promise.all([
        runtime.shutdown('first'),
        runtime.shutdown('second'),
        runtime.shutdown('third'),
      ]);
      const fourth = await runtime.shutdown('fourth');

      assert.deepEqual(second, first);
      assert.deepEqual(third, first);
      assert.deepEqual(fourth, first);
      assert.equal(first.ok, true);
    });

    assert.equal(occurrences(logs, 'service.stopping'), 1, 'only the first reason is recorded');
    assert.equal(occurrences(logs, 'database.closed'), 1, 'the database is closed once');
  });
});

// ── the exit-code contract and the final structured line ─────────────────────

const OK_RESULT: ShutdownResult = {
  listenerClosed: true,
  checkpointed: true,
  databaseClosed: true,
  ok: true,
};

test('a clean shutdown exits 0 and reports all four facts', async () => {
  const lines: string[] = [];
  const report = await performShutdown({
    runtime: { shutdown: async () => OK_RESULT },
    reason: 'stdin',
    requestedCode: EXIT_OK,
    write: (line) => lines.push(line),
  });

  assert.equal(report.exitCode, EXIT_OK);
  assert.equal(lines.length, 1);

  const message = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(message.msg, SHUTDOWN_COMPLETE_MESSAGE);
  assert.equal(message.reason, 'stdin');
  assert.equal(message.listenerClosed, true);
  assert.equal(message.checkpointed, true);
  assert.equal(message.databaseClosed, true);
  assert.equal(message.ok, true);
  assert.equal(message.exitCode, EXIT_OK);
});

test('an incomplete shutdown exits 69, never 0', async () => {
  const incomplete: ShutdownResult = {
    listenerClosed: true,
    checkpointed: false,
    databaseClosed: true,
    ok: false,
  };

  const lines: string[] = [];
  const report = await performShutdown({
    runtime: { shutdown: async () => incomplete },
    reason: 'SIGTERM',
    requestedCode: EXIT_OK,
    write: (line) => lines.push(line),
  });

  assert.equal(report.exitCode, EXIT_SHUTDOWN_INCOMPLETE);
  const message = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(message.ok, false);
  assert.equal(message.exitCode, EXIT_SHUTDOWN_INCOMPLETE);
});

test('a fatal exit keeps its own code even when shutdown itself was clean', async () => {
  const lines: string[] = [];
  const report = await performShutdown({
    runtime: { shutdown: async () => OK_RESULT },
    reason: 'uncaughtException',
    requestedCode: EXIT_FATAL,
    write: (line) => lines.push(line),
  });

  assert.equal(report.exitCode, EXIT_FATAL);
  assert.equal((JSON.parse(lines[0] as string) as Record<string, unknown>).exitCode, EXIT_FATAL);
});

test('a shutdown that throws is reported as incomplete, not as success', async () => {
  const lines: string[] = [];
  const logs = await captureLogs(async () => {
    const report = await performShutdown({
      runtime: {
        shutdown: async () => {
          throw new Error('shutdown exploded');
        },
      },
      reason: 'SIGTERM',
      requestedCode: EXIT_OK,
      write: (line) => lines.push(line),
    });

    assert.equal(report.exitCode, EXIT_SHUTDOWN_INCOMPLETE);
    assert.equal(report.result.ok, false);
  });

  assert.equal(occurrences(logs, 'service.shutdown_failed'), 1);
  const message = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(message.listenerClosed, false);
  assert.equal(message.databaseClosed, false);
  assert.equal(message.exitCode, EXIT_SHUTDOWN_INCOMPLETE);
});

test('exitCodeFor follows the contract in both directions', () => {
  assert.equal(exitCodeFor(EXIT_OK, true), EXIT_OK);
  assert.equal(exitCodeFor(EXIT_OK, false), EXIT_SHUTDOWN_INCOMPLETE);
  assert.equal(exitCodeFor(EXIT_FATAL, true), EXIT_FATAL, 'a fault is never a clean exit');
  assert.equal(exitCodeFor(EXIT_FATAL, false), EXIT_FATAL);
});
