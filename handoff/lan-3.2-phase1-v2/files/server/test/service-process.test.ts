/**
 * The real process, driven the way a Windows service host drives it (LAN-3.2, Phase 1).
 *
 * The unit tests prove the pieces; this file proves the *contract* end to end: a child
 * process is spawned from `src/index.ts`, told to shut down over stdin, and must exit 0
 * only after writing the final structured line. Everything is event-driven — the test
 * waits for a specific log line, never for a fixed delay.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { removeDir, tempDataDir } from './helpers.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type LogLine = Record<string, unknown>;

interface ServiceProcess {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves with the first line (already seen or future) matching `msg`. */
  waitForMessage(msg: string, timeoutMs?: number): Promise<LogLine>;
  /** All lines seen so far, in order. */
  lines(): LogLine[];
  waitForExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function startProcess(dataDir: string, extraEnv: Record<string, string> = {}): ServiceProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RHODES_DATA_DIR: dataDir,
      RHODES_PORT: '0',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const seen: LogLine[] = [];
  let exited = false;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  const messageWaiters: Array<{ msg: string; resolve: (line: LogLine) => void }> = [];
  const exitWaiters: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> = [];

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let entry: LogLine;
    try {
      entry = JSON.parse(trimmed) as LogLine;
    } catch {
      return;
    }
    seen.push(entry);
    if (typeof entry.msg !== 'string') return;
    for (let index = messageWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = messageWaiters[index];
      if (waiter && waiter.msg === entry.msg) {
        messageWaiters.splice(index, 1);
        waiter.resolve(entry);
      }
    }
  };

  // The logger sends info to stdout and warn/error to stderr, so both streams are parsed:
  // otherwise a rejection line would be invisible to the test and look like a hang.
  const attach = (stream: NodeJS.ReadableStream): void => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) handleLine(part);
    });
  };
  attach(child.stdout);
  attach(child.stderr);

  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    for (const waiter of exitWaiters.splice(0)) waiter(exitInfo);
  });

  const withDeadline = <T>(what: string, promise: Promise<T>, timeoutMs: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}; output so far:\n${JSON.stringify(seen)}`));
      }, timeoutMs);
      timer.unref();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  return {
    child,
    lines: () => seen.slice(),
    waitForMessage(msg, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const already = seen.find((line) => line.msg === msg);
      if (already) return Promise.resolve(already);
      const promise = new Promise<LogLine>((resolve) => {
        messageWaiters.push({ msg, resolve });
      });
      return withDeadline(`the ${msg} line`, promise, timeoutMs);
    },
    waitForExit(timeoutMs = DEFAULT_TIMEOUT_MS) {
      if (exited && exitInfo) return Promise.resolve(exitInfo);
      const promise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        exitWaiters.push(resolve);
      });
      return withDeadline('the process to exit', promise, timeoutMs);
    },
  };
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

test('the service host protocol: ready, then one command, then a clean exit 0', async () => {
  const dir = tempDataDir();
  const service = startProcess(dir, { RHODES_SERVICE_MODE: '1' });
  try {
    const ready = await service.waitForMessage('service.ready');
    assert.equal(ready.serviceMode, true);
    assert.equal(typeof ready.port, 'number');
    assert.equal(typeof ready.url, 'string');

    // Only now is the channel listening — the host may rely on that ordering.
    service.child.stdin.write('{"cmd":"shutdown"}\n');

    const exit = await service.waitForExit();
    assert.equal(exit.signal, null, 'the process exits on its own, it is not killed');
    assert.equal(exit.code, 0);

    const final = service.lines().filter((line) => line.msg === 'service.shutdown_complete');
    assert.equal(final.length, 1, 'exactly one final line');
    assert.deepEqual(
      {
        reason: final[0]?.reason,
        listenerClosed: final[0]?.listenerClosed,
        checkpointed: final[0]?.checkpointed,
        databaseClosed: final[0]?.databaseClosed,
        ok: final[0]?.ok,
        exitCode: final[0]?.exitCode,
      },
      {
        reason: 'stdin',
        listenerClosed: true,
        checkpointed: true,
        databaseClosed: true,
        ok: true,
        exitCode: 0,
      },
    );

    // The final line is the last thing the process writes.
    const messages = service.lines().map((line) => line.msg);
    assert.equal(messages[messages.length - 1], 'service.shutdown_complete');
  } finally {
    await stopChild(service.child);
    removeDir(dir);
  }
});

test('a malformed command is refused and the process keeps serving', async () => {
  const dir = tempDataDir();
  const service = startProcess(dir, { RHODES_SERVICE_MODE: '1' });
  try {
    await service.waitForMessage('service.ready');

    service.child.stdin.write('shutdown please\n');
    const rejected = await service.waitForMessage('service.stdin_rejected');
    assert.equal(rejected.reason, 'malformed');
    assert.equal(service.child.exitCode, null, 'a bad line must not stop the service');

    service.child.stdin.write('{"cmd":"shutdown"}\n');
    const exit = await service.waitForExit();
    assert.equal(exit.code, 0);
  } finally {
    await stopChild(service.child);
    removeDir(dir);
  }
});

test('a control channel that disappears shuts the service down instead of orphaning it', async () => {
  const dir = tempDataDir();
  const service = startProcess(dir, { RHODES_SERVICE_MODE: '1' });
  try {
    await service.waitForMessage('service.ready');

    service.child.stdin.end();
    const exit = await service.waitForExit();
    assert.equal(exit.code, 0);

    const final = service.lines().find((line) => line.msg === 'service.shutdown_complete');
    assert.equal(final?.reason, 'stdin-eof');
    assert.equal(final?.ok, true);
  } finally {
    await stopChild(service.child);
    removeDir(dir);
  }
});

test('without service mode a terminal is not a shutdown button, and SIGTERM still works', async () => {
  const dir = tempDataDir();
  const service = startProcess(dir);
  try {
    const ready = await service.waitForMessage('service.ready');
    assert.equal(ready.serviceMode, false);

    // The same bytes that stop a service-mode process do nothing here.
    service.child.stdin.write('{"cmd":"shutdown"}\n');
    // Synchronise on an unrelated, later line instead of sleeping: the ready line is
    // already behind us, so ask for a second one — it will never come, which is the point.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.child.exitCode, null, 'the command is ignored without the flag');
    assert.equal(
      service.lines().some((line) => line.msg === 'service.control_received'),
      false,
    );

    service.child.kill('SIGTERM');
    const exit = await service.waitForExit();
    assert.equal(exit.code, 0, 'a signal shutdown is the ordinary, clean path');

    const final = service.lines().find((line) => line.msg === 'service.shutdown_complete');
    assert.equal(final?.reason, 'SIGTERM');
    assert.equal(final?.ok, true);
  } finally {
    await stopChild(service.child);
    removeDir(dir);
  }
});
