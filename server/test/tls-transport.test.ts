/**
 * TLS transport (phase LAN-3.1).
 *
 * Proves the listener really speaks HTTPS when a valid pair is configured, that the
 * protocol floor holds in both directions (TLS 1.2 and 1.3 negotiate, TLS 1.0 and 1.1 do
 * not), that shutdown and database closure behave the same as over HTTP, and that the
 * startup log names the transport without ever containing key material.
 *
 * Clients pin the fixture certificate with `ca:` and keep verification ON. No test sets
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` or `rejectUnauthorized: false`: a service that only
 * looks encrypted when verification is off has not been tested at all.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import test from 'node:test';
import tls, { type SecureVersion } from 'node:tls';

import { startRuntime } from '../src/startup.js';
import { tlsServerOptions } from '../src/tls.js';
import {
  captureLogs,
  openMigrated,
  removeDir,
  startTestServer,
  tempDataDir,
  testCaPem,
  testTlsMaterial,
  tlsEnv,
} from './helpers.js';

const CA = testCaPem();

interface TlsResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** A GET over HTTPS with the fixture certificate pinned as the only trusted anchor. */
function httpsGet(host: string, port: number, pathname: string, version: { min?: SecureVersion; max?: SecureVersion } = {}): Promise<TlsResponse> {
  return new Promise<TlsResponse>((resolve, reject) => {
    const request = https.request(
      {
        host,
        port,
        path: pathname,
        method: 'GET',
        ca: CA,
        rejectUnauthorized: true,
        minVersion: version.min,
        maxVersion: version.max,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/**
 * The protocol a pinned client actually negotiates, or a rejection.
 *
 * `extra.ciphers` is only ever used to *lower the client's* OpenSSL security level so a
 * withdrawn protocol can still be offered. The server side is untouched by it; that is
 * the whole point of the TLS 1.0/1.1 test below.
 */
function negotiatedProtocol(
  port: number,
  min: SecureVersion,
  max: SecureVersion,
  extra: { ciphers?: string } = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port,
        ca: CA,
        rejectUnauthorized: true,
        minVersion: min,
        maxVersion: max,
        ...(extra.ciphers === undefined ? {} : { ciphers: extra.ciphers }),
      },
      () => {
        const protocol = socket.getProtocol();
        socket.end();
        if (protocol === null) reject(new Error('no protocol was negotiated'));
        else resolve(protocol);
      },
    );
    socket.on('error', reject);
  });
}

test('HTTP still works on loopback when TLS is not configured', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let close: (() => Promise<void>) | undefined;
  try {
    const { running, baseUrl } = await startTestServer(db);
    close = running.close;

    assert.equal(running.protocol, 'http');
    assert.equal(running.url, baseUrl);
    assert.ok(baseUrl.startsWith('http://127.0.0.1:'), `unexpected base URL: ${baseUrl}`);

    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
  } finally {
    if (close) await close();
    db.close();
    removeDir(dir);
  }
});

test('HTTPS works on loopback when valid test certificates are configured', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let close: (() => Promise<void>) | undefined;
  try {
    const { running, baseUrl } = await startTestServer(db, {}, { tls: tlsServerOptions(testTlsMaterial()) });
    close = running.close;

    assert.equal(running.protocol, 'https');
    assert.ok(baseUrl.startsWith('https://127.0.0.1:'), `unexpected base URL: ${baseUrl}`);

    // A certificate does not move the listener: it is still loopback only.
    const address = running.server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(address.address, '127.0.0.1');

    const response = await httpsGet('127.0.0.1', running.port, '/api/health');
    assert.equal(response.status, 200);
  } finally {
    if (close) await close();
    db.close();
    removeDir(dir);
  }
});

test('an HTTPS health request returns the existing health response unchanged', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let closeHttp: (() => Promise<void>) | undefined;
  let closeHttps: (() => Promise<void>) | undefined;
  try {
    const plain = await startTestServer(db);
    closeHttp = plain.running.close;
    const secure = await startTestServer(db, {}, { tls: tlsServerOptions(testTlsMaterial()) });
    closeHttps = secure.running.close;

    const overHttp = await fetch(`${plain.baseUrl}/api/health`);
    const overHttps = await httpsGet('127.0.0.1', secure.running.port, '/api/health');

    assert.equal(overHttps.status, overHttp.status);
    assert.match(String(overHttps.headers['content-type']), /^application\/json/);
    assert.equal(overHttps.headers['cache-control'], 'no-store');
    // Same body over both transports: TLS changes the pipe, not the payload.
    assert.deepEqual(JSON.parse(overHttps.body), await overHttp.json());
  } finally {
    if (closeHttp) await closeHttp();
    if (closeHttps) await closeHttps();
    db.close();
    removeDir(dir);
  }
});

test('TLS 1.2 and TLS 1.3 are both accepted', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let close: (() => Promise<void>) | undefined;
  try {
    const { running } = await startTestServer(db, {}, { tls: tlsServerOptions(testTlsMaterial()) });
    close = running.close;

    assert.equal(await negotiatedProtocol(running.port, 'TLSv1.2', 'TLSv1.2'), 'TLSv1.2');
    assert.equal(await negotiatedProtocol(running.port, 'TLSv1.3', 'TLSv1.3'), 'TLSv1.3');

    // And a request actually completes over each version, not just a handshake.
    assert.equal((await httpsGet('127.0.0.1', running.port, '/api/health', { min: 'TLSv1.2', max: 'TLSv1.2' })).status, 200);
    assert.equal((await httpsGet('127.0.0.1', running.port, '/api/health', { min: 'TLSv1.3', max: 'TLSv1.3' })).status, 200);
  } finally {
    if (close) await close();
    db.close();
    removeDir(dir);
  }
});

test('TLS 1.0 and TLS 1.1 are rejected', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let close: (() => Promise<void>) | undefined;
  try {
    const { running } = await startTestServer(db, {}, { tls: tlsServerOptions(testTlsMaterial()) });
    close = running.close;

    for (const max of ['TLSv1', 'TLSv1.1'] as SecureVersion[]) {
      // The client's security level is lowered so the offer really reaches the server.
      // Without it, the runtime refuses client-side (ERR_SSL_NO_PROTOCOLS_AVAILABLE) and
      // the test would only prove something about this Node build, not about the service.
      // With it, the rejection is the server's own alert.
      await assert.rejects(
        () => negotiatedProtocol(running.port, 'TLSv1', max, { ciphers: 'DEFAULT@SECLEVEL=0' }),
        (error: unknown) => {
          assert.equal(
            (error as NodeJS.ErrnoException).code,
            'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
            `TLS 1.0/1.1 (max ${max}) must be refused by the server, got: ${String(error)}`,
          );
          return true;
        },
      );
    }

    // The listener is unharmed by the refused attempts, so the refusals came from the
    // protocol policy and not from a crashed server. Pinned to exactly TLS 1.2, because a
    // client allowed both versions would legitimately prefer TLS 1.3.
    assert.equal(await negotiatedProtocol(running.port, 'TLSv1.2', 'TLSv1.2'), 'TLSv1.2');
  } finally {
    if (close) await close();
    db.close();
    removeDir(dir);
  }
});

test('graceful shutdown works with HTTPS', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const { running } = await startTestServer(db, {}, { tls: tlsServerOptions(testTlsMaterial()) });

    assert.equal((await httpsGet('127.0.0.1', running.port, '/api/health')).status, 200);

    await running.close();
    assert.equal(running.server.listening, false);

    // No connection is served afterwards. The errno depends on how far the kernel got
    // with the socket before it closed: a refused connect (ECONNREFUSED) or a reset on an
    // already-accepted, then destroyed, socket (ECONNRESET). Both mean the listener is
    // gone, which is what this asserts.
    await assert.rejects(
      () => httpsGet('127.0.0.1', running.port, '/api/health'),
      (error: unknown) => {
        assert.ok(
          ['ECONNREFUSED', 'ECONNRESET'].includes(String((error as NodeJS.ErrnoException).code)),
          `unexpected failure: ${String(error)}`,
        );
        return true;
      },
    );
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('the database is closed after an HTTPS shutdown, with the WAL checkpointed', async () => {
  const dir = tempDataDir();
  const databasePath = path.join(dir, 'rhodes.db');

  const runtime = await startRuntime({
    env: { NODE_ENV: 'test', RHODES_PORT: '0', RHODES_DATA_DIR: dir, ...tlsEnv() },
  });

  assert.equal(runtime.config.transport, 'https');
  assert.equal(runtime.running.protocol, 'https');
  assert.equal(runtime.db.isOpen, true);
  assert.equal((await httpsGet('127.0.0.1', runtime.running.port, '/api/health')).status, 200);

  await runtime.shutdown('test');

  assert.equal(runtime.db.isOpen, false);
  assert.throws(
    () => runtime.db.handle,
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'db.closed');
      return true;
    },
  );
  assert.equal(runtime.running.server.listening, false);
  assert.equal(existsSync(`${databasePath}-wal`), false, 'the WAL must be checkpointed away');

  // Shutdown is idempotent, which is what a second signal relies on.
  await runtime.shutdown('again');

  removeDir(dir);
});

test('the startup log names the transport and never contains key material', async () => {
  const httpDir = tempDataDir();
  const httpsDir = tempDataDir();
  const material = testTlsMaterial();

  const logs = await captureLogs(async () => {
    const overHttp = await startRuntime({
      env: { NODE_ENV: 'test', RHODES_PORT: '0', RHODES_DATA_DIR: httpDir },
    });
    await overHttp.shutdown('test');

    const overHttps = await startRuntime({
      env: { NODE_ENV: 'test', RHODES_PORT: '0', RHODES_DATA_DIR: httpsDir, ...tlsEnv() },
    });
    await overHttps.shutdown('test');
  });

  try {
    assert.match(logs, /"transport":"http"/);
    assert.match(logs, /"protocol":"http"/);
    assert.match(logs, /"transport":"https"/);
    assert.match(logs, /"protocol":"https"/);
    assert.match(logs, /"url":"https:\/\/127\.0\.0\.1:\d+"/);

    // The public attributes are logged; the material is not.
    assert.match(logs, /"fingerprint256"/);
    assert.ok(!logs.includes('BEGIN CERTIFICATE'), 'a certificate body must never be logged');
    assert.ok(!logs.includes('PRIVATE KEY'), 'a private key must never be logged');

    const certBody = material.certPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').slice(0, 48);
    const keyBody = material.keyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').slice(0, 48);
    assert.ok(!logs.includes(certBody), 'certificate material must never be logged');
    assert.ok(!logs.includes(keyBody), 'key material must never be logged');
  } finally {
    removeDir(httpDir);
    removeDir(httpsDir);
  }
});
