/**
 * TLS configuration (phase LAN-3.1).
 *
 * Two properties are tested here, and they are independent on purpose:
 *
 *   · the transport switches to HTTPS only when a *complete and consistent* pair of
 *     certificate and private key is supplied — every partial, missing, malformed or
 *     mismatched combination is refused, with no fallback to HTTP;
 *   · supplying a valid pair never relaxes the loopback rule, so the service still cannot
 *     be reached from another computer.
 *
 * Certificates come from `test/fixtures/tls/` and are **test-only** (see the README in
 * that directory). Nothing here reads a production key.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { startRuntime } from '../src/startup.js';
import { tlsServerOptions } from '../src/tls.js';
import {
  TLS_FIXTURES,
  tlsEnv,
  testTlsMaterial,
  tempDataDir,
  removeDir,
  configFor,
  openMigrated,
} from './helpers.js';

function expectConfigError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ConfigError, `expected ConfigError, received ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

/** Write a file into a scratch directory and return its path. */
function scratchFile(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
}

test('the default configuration is still plain HTTP on loopback', () => {
  const dir = tempDataDir();
  try {
    const config = configFor(dir);
    assert.equal(config.transport, 'http');
    assert.equal(config.tls, null);
    assert.equal(config.host, '127.0.0.1');

    // Absent variables behave exactly as before LAN-3.1: development defaults, no TLS.
    const defaults = loadConfig({ NODE_ENV: 'development' });
    assert.equal(defaults.transport, 'http');
    assert.equal(defaults.tls, null);
    assert.equal(defaults.port, 4317);
  } finally {
    removeDir(dir);
  }
});

test('HTTPS activates only when the certificate and the key are both supplied', () => {
  const dir = tempDataDir();
  try {
    const config = configFor(dir, tlsEnv());
    assert.equal(config.transport, 'https');
    assert.ok(config.tls !== null);
    assert.equal(config.tls.certFile, path.resolve(TLS_FIXTURES.certFile));
    assert.equal(config.tls.keyFile, path.resolve(TLS_FIXTURES.keyFile));
    assert.match(config.tls.certPem, /^-----BEGIN CERTIFICATE-----/);
    assert.match(config.tls.keyPem, /PRIVATE KEY-----/);

    // Public attributes are available for the operator log; nothing else is derived.
    assert.match(config.tls.certificate.subject, /RHODES TEST ONLY/);
    assert.ok(config.tls.certificate.fingerprint256.length > 0);

    // Whether the advisory permission flag fires depends on the file's mode, which Git
    // does not preserve (a fresh clone gives 0644). The detection itself is tested
    // separately below, against a copy, so this assertion stays about the transport.
  } finally {
    removeDir(dir);
  }
});

test('only the certificate is refused, never downgraded to HTTP', () => {
  const dir = tempDataDir();
  try {
    expectConfigError(
      () => configFor(dir, { RHODES_TLS_CERT_FILE: TLS_FIXTURES.certFile }),
      'config.tls_incomplete',
    );
  } finally {
    removeDir(dir);
  }
});

test('only the private key is refused, never downgraded to HTTP', () => {
  const dir = tempDataDir();
  try {
    expectConfigError(
      () => configFor(dir, { RHODES_TLS_KEY_FILE: TLS_FIXTURES.keyFile }),
      'config.tls_incomplete',
    );
  } finally {
    removeDir(dir);
  }
});

test('a blank value counts as absent, so a blank certificate is an incomplete pair', () => {
  const dir = tempDataDir();
  try {
    expectConfigError(
      () => configFor(dir, { RHODES_TLS_CERT_FILE: '   ', RHODES_TLS_KEY_FILE: TLS_FIXTURES.keyFile }),
      'config.tls_incomplete',
    );
    // Whitespace around a real path is trimmed rather than treated as a different file.
    const config = configFor(dir, {
      RHODES_TLS_CERT_FILE: `  ${TLS_FIXTURES.certFile}  `,
      RHODES_TLS_KEY_FILE: TLS_FIXTURES.keyFile,
    });
    assert.equal(config.transport, 'https');
    assert.equal(config.tls?.certFile, path.resolve(TLS_FIXTURES.certFile));
  } finally {
    removeDir(dir);
  }
});

test('a missing certificate file is refused', () => {
  const dir = tempDataDir();
  try {
    const missing = path.join(dir, 'absent-cert.pem');
    expectConfigError(
      () => configFor(dir, { RHODES_TLS_CERT_FILE: missing, RHODES_TLS_KEY_FILE: TLS_FIXTURES.keyFile }),
      'config.tls_cert_unreadable',
    );
  } finally {
    removeDir(dir);
  }
});

test('a missing private-key file is refused', () => {
  const dir = tempDataDir();
  try {
    const missing = path.join(dir, 'absent-key.pem');
    expectConfigError(
      () => configFor(dir, { RHODES_TLS_CERT_FILE: TLS_FIXTURES.certFile, RHODES_TLS_KEY_FILE: missing }),
      'config.tls_key_unreadable',
    );
  } finally {
    removeDir(dir);
  }
});

test('an empty file is refused rather than treated as valid material', () => {
  const dir = tempDataDir();
  try {
    const cert = scratchFile(dir, 'empty-cert.pem', '\n   \n');
    expectConfigError(
      () => configFor(dir, { RHODES_TLS_CERT_FILE: cert, RHODES_TLS_KEY_FILE: TLS_FIXTURES.keyFile }),
      'config.tls_cert_unreadable',
    );

    const key = scratchFile(dir, 'empty-key.pem', '');
    expectConfigError(
      () => configFor(dir, { RHODES_TLS_CERT_FILE: TLS_FIXTURES.certFile, RHODES_TLS_KEY_FILE: key }),
      'config.tls_key_unreadable',
    );
  } finally {
    removeDir(dir);
  }
});

test('a malformed certificate is refused', () => {
  const dir = tempDataDir();
  try {
    const cert = scratchFile(dir, 'garbage-cert.pem', 'this is not a certificate\n');
    expectConfigError(
      () => configFor(dir, { RHODES_TLS_CERT_FILE: cert, RHODES_TLS_KEY_FILE: TLS_FIXTURES.keyFile }),
      'config.tls_cert_invalid',
    );
  } finally {
    removeDir(dir);
  }
});

test('a malformed private key is refused', () => {
  const dir = tempDataDir();
  try {
    const key = scratchFile(dir, 'garbage-key.pem', '-----BEGIN PRIVATE KEY-----\nnot base64\n-----END PRIVATE KEY-----\n');
    expectConfigError(
      () => configFor(dir, { RHODES_TLS_CERT_FILE: TLS_FIXTURES.certFile, RHODES_TLS_KEY_FILE: key }),
      'config.tls_key_invalid',
    );
  } finally {
    removeDir(dir);
  }
});

test('a certificate and a private key from different pairs are refused', () => {
  const dir = tempDataDir();
  try {
    // Both files are genuine PEM: only the pair is wrong, which is the case a size or
    // header check would miss.
    expectConfigError(
      () =>
        configFor(dir, {
          RHODES_TLS_CERT_FILE: TLS_FIXTURES.certFile,
          RHODES_TLS_KEY_FILE: TLS_FIXTURES.otherKeyFile,
        }),
      'config.tls_pair_mismatch',
    );
    expectConfigError(
      () =>
        configFor(dir, {
          RHODES_TLS_CERT_FILE: TLS_FIXTURES.otherCertFile,
          RHODES_TLS_KEY_FILE: TLS_FIXTURES.keyFile,
        }),
      'config.tls_pair_mismatch',
    );
  } finally {
    removeDir(dir);
  }
});

test('a TLS failure stops startup before the data directory or database exists', async () => {
  const scratch = tempDataDir();
  try {
    // A path that does not exist yet: if startup gets far enough to create it, the
    // ordering guarantee has been broken.
    const dataDir = path.join(scratch, 'not-created');
    const badCert = scratchFile(scratch, 'bad-cert.pem', 'garbage\n');

    await assert.rejects(
      () =>
        startRuntime({
          env: {
            NODE_ENV: 'test',
            RHODES_PORT: '0',
            RHODES_DATA_DIR: dataDir,
            RHODES_TLS_CERT_FILE: badCert,
            RHODES_TLS_KEY_FILE: TLS_FIXTURES.keyFile,
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.code, 'config.tls_cert_invalid');
        return true;
      },
    );

    assert.equal(existsSync(dataDir), false, 'the data directory must not be created');
  } finally {
    removeDir(scratch);
  }
});

test('a TLS failure leaves an existing database untouched and creates no WAL', async () => {
  const dir = tempDataDir();
  const scratch = tempDataDir();
  let db: ReturnType<typeof openMigrated>['db'] | undefined;
  try {
    db = openMigrated(dir).db;
    db.close();
    db = undefined;

    const databasePath = path.join(dir, 'rhodes.db');
    const before = createHash('sha256').update(readFileSync(databasePath)).digest('hex');

    await assert.rejects(
      () =>
        startRuntime({
          env: {
            NODE_ENV: 'test',
            RHODES_PORT: '0',
            RHODES_DATA_DIR: dir,
            RHODES_TLS_CERT_FILE: TLS_FIXTURES.certFile,
            RHODES_TLS_KEY_FILE: TLS_FIXTURES.otherKeyFile,
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.code, 'config.tls_pair_mismatch');
        return true;
      },
    );

    const after = createHash('sha256').update(readFileSync(databasePath)).digest('hex');
    assert.equal(after, before, 'the database file must not change');
    assert.equal(existsSync(`${databasePath}-wal`), false);
    assert.equal(existsSync(`${databasePath}-shm`), false);
  } finally {
    db?.close();
    removeDir(dir);
    removeDir(scratch);
  }
});

test('a valid certificate does not relax the loopback rule', () => {
  const dir = tempDataDir();
  try {
    // Every one of these is refused *with* a valid certificate and key configured, which
    // is the boundary this phase exists to keep closed.
    for (const host of ['0.0.0.0', '::', '192.168.1.50', '10.1.2.3', 'rhodes-server', 'example.com']) {
      expectConfigError(() => configFor(dir, { ...tlsEnv(), RHODES_HOST: host }), 'config.non_loopback_host');
    }

    // And the loopback literals still work with TLS, so the refusal above is about the
    // address and not a side effect of enabling HTTPS.
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      const config = configFor(dir, { ...tlsEnv(), RHODES_HOST: host });
      assert.equal(config.transport, 'https');
      assert.equal(config.host, host === 'localhost' ? '127.0.0.1' : host);
    }
  } finally {
    removeDir(dir);
  }
});

test('a loose private-key permission is reported, never fatal', (t) => {
  // POSIX only: Windows access control is an ACL, not a mode, and Node cannot inspect it.
  // The equivalent Windows check is manual — see ARCHITECTURE.md §3.1.
  if (process.platform === 'win32') {
    t.skip('Windows access control uses ACLs, not Unix permission bits; verify with icacls by hand');
    return;
  }

  const dir = tempDataDir();
  try {
    const loose = path.join(dir, 'loose-key.pem');
    const tight = path.join(dir, 'tight-key.pem');
    writeFileSync(loose, readFileSync(TLS_FIXTURES.keyFile));
    writeFileSync(tight, readFileSync(TLS_FIXTURES.keyFile));
    chmodSync(loose, 0o644);
    chmodSync(tight, 0o600);

    const looseConfig = configFor(dir, {
      RHODES_TLS_CERT_FILE: TLS_FIXTURES.certFile,
      RHODES_TLS_KEY_FILE: loose,
    });
    assert.equal(looseConfig.tls?.keyPermissionsLoose, true);
    // Advisory only: a world-readable key still starts, and the caller is warned.
    assert.equal(looseConfig.transport, 'https');

    const tightConfig = configFor(dir, {
      RHODES_TLS_CERT_FILE: TLS_FIXTURES.certFile,
      RHODES_TLS_KEY_FILE: tight,
    });
    assert.equal(tightConfig.tls?.keyPermissionsLoose, false);
  } finally {
    removeDir(dir);
  }
});

test('the TLS floor is stated explicitly rather than inherited', () => {
  const options = tlsServerOptions(testTlsMaterial());
  assert.equal(options.minVersion, 'TLSv1.2');
  // No cipher list, no version cap: Node's secure defaults stay in force, so TLS 1.3
  // remains available and no obsolete cipher is reintroduced.
  assert.deepEqual(Object.keys(options).sort(), ['cert', 'key', 'minVersion']);
});
