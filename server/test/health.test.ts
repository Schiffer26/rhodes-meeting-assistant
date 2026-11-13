/**
 * HTTP surface.
 *
 * Cases 1, 2 and 11 of the required test matrix: the service starts, /api/health
 * reports service + database state, binds loopback only, and leaks nothing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { startServer } from '../src/server.js';
import { SERVICE_NAME, SERVICE_VERSION } from '../src/version.js';
import { openMigrated, removeDir, startTestServer, tempDataDir } from './helpers.js';

/** Recursively collect every key and string value in a JSON value. */
function collect(value: unknown, keys: string[] = [], strings: string[] = []): { keys: string[]; strings: string[] } {
  if (typeof value === 'string') {
    strings.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, keys, strings);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collect(child, keys, strings);
    }
  }
  return { keys, strings };
}

test('case 1 + 2: the service starts and /api/health reports service and database', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let close: (() => Promise<void>) | undefined;
  try {
    const { running, baseUrl } = await startTestServer(db);
    close = running.close;

    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body, {
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      apiVersion: 1,
      database: { status: 'ok', schemaVersion: 1 },
      uptimeSeconds: 42,
    });
  } finally {
    if (close) await close();
    db.close();
    removeDir(dir);
  }
});

test('case 11: the listener is bound to loopback only', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let close: (() => Promise<void>) | undefined;
  try {
    const { running } = await startTestServer(db);
    close = running.close;
    const address = running.server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
    assert.equal(running.host, '127.0.0.1');
  } finally {
    if (close) await close();
    db.close();
    removeDir(dir);
  }
});

test('the health payload exposes no paths, configuration or record data', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let close: (() => Promise<void>) | undefined;
  try {
    const { running, baseUrl } = await startTestServer(db);
    close = running.close;

    const raw = await (await fetch(`${baseUrl}/api/health`)).text();
    const { keys, strings } = collect(JSON.parse(raw));

    const allowedKeys = new Set([
      'status',
      'service',
      'version',
      'apiVersion',
      'database',
      'schemaVersion',
      'uptimeSeconds',
    ]);
    for (const key of keys) {
      assert.ok(allowedKeys.has(key), `unexpected key in health payload: ${key}`);
    }

    // Nothing path-like, database-like, or credential-like may appear in a value.
    for (const value of strings) {
      assert.ok(!value.includes(dir), 'the data directory must not appear in the payload');
      assert.ok(!/\.db\b/i.test(value), 'no database file name may appear in the payload');
      assert.ok(!/[A-Za-z]:\\|\/(home|tmp|users|var)\//i.test(value), 'no filesystem path may appear');
      assert.ok(!/password|secret|token|api[_-]?key/i.test(value));
    }

    assert.ok(!raw.toLowerCase().includes('sqlite'));
  } finally {
    if (close) await close();
    db.close();
    removeDir(dir);
  }
});

test('no CORS header is emitted, so another origin cannot read the API', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let close: (() => Promise<void>) | undefined;
  try {
    const { running, baseUrl } = await startTestServer(db);
    close = running.close;

    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: 'http://example.test' },
    });
    for (const header of [
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-allow-methods',
      'access-control-allow-headers',
    ]) {
      assert.equal(response.headers.get(header), null, `${header} must not be sent`);
    }
    // Requesting headers does not change the response.
    assert.equal(response.status, 200);
  } finally {
    if (close) await close();
    db.close();
    removeDir(dir);
  }
});

test('health reports 503 when the database is unusable, without leaking why', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let close: (() => Promise<void>) | undefined;
  try {
    const { running, baseUrl } = await startTestServer(db);
    close = running.close;
    db.close(); // simulate a lost database while the process still runs

    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 503);
    const body = (await response.json()) as {
      status: string;
      database: { status: string };
      uptimeSeconds: number;
    };
    assert.equal(body.status, 'unavailable');
    assert.equal(body.database.status, 'error');
    assert.equal(body.uptimeSeconds, 42);
  } finally {
    if (close) await close();
    db.close();
    removeDir(dir);
  }
});

test('there are no unauthenticated data endpoints', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let close: (() => Promise<void>) | undefined;
  try {
    const { running, baseUrl } = await startTestServer(db);
    close = running.close;

    for (const path of [
      '/api/personnel',
      '/api/meetings',
      '/api/notes',
      '/api/decisions',
      '/api/action-items',
      '/api/health/database',
      '/',
      '/health',
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404, `${path} must not be routable`);
      const body = (await response.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, 'http.not_found');
    }
  } finally {
    if (close) await close();
    db.close();
    removeDir(dir);
  }
});

test('a second bind on the same port fails with a structured error', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let close: (() => Promise<void>) | undefined;
  try {
    const { running, baseUrl } = await startTestServer(db);
    close = running.close;
    assert.ok(baseUrl.startsWith('http://127.0.0.1:'));

    await assert.rejects(
      () => startServer(createApp({ db }), { host: '127.0.0.1', port: running.port }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, 'http.bind_failed');
        return true;
      },
    );
  } finally {
    if (close) await close();
    db.close();
    removeDir(dir);
  }
});
