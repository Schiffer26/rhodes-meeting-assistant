/**
 * Production TLS is mandatory (LAN-3.2, Phase 1).
 *
 * A production deploy that loses its certificate variables must not come up on plain
 * HTTP: that is a silent downgrade, and every later request would be unencrypted. The
 * configuration loader therefore fails closed, before the data directory is created and
 * before anything binds a socket, with one stable code the service host can key on.
 *
 * All certificate material here is the repository's disposable test fixture. Nothing in
 * this file touches a real certificate, a real key, or any machine configuration.
 */

import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ConfigError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';
import { TLS_FIXTURES, removeDir, tempDataDir, tlsEnv } from './helpers.js';

/** The stable code production reports for any TLS problem. */
const TLS_REQUIRED = 'config.tls_required';

function expectConfigError(fn: () => unknown, code: string): ConfigError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new assert.AssertionError({ message: `expected a ConfigError with code ${code}` });
}

test('production without TLS is refused with a stable code', () => {
  const dir = tempDataDir();
  try {
    const dataDir = path.join(dir, 'never-created');
    const error = expectConfigError(
      () => loadConfig({ NODE_ENV: 'production', RHODES_DATA_DIR: dataDir }),
      TLS_REQUIRED,
    );

    assert.match(error.message, /RHODES_TLS_CERT_FILE/);
    assert.match(error.message, /RHODES_TLS_KEY_FILE/);
    assert.equal(existsSync(dataDir), false, 'nothing is created for a refused configuration');
  } finally {
    removeDir(dir);
  }
});

test('production with only half a TLS pair is refused under the same code', () => {
  const dir = tempDataDir();
  try {
    const onlyCert = expectConfigError(
      () =>
        loadConfig({
          NODE_ENV: 'production',
          RHODES_DATA_DIR: dir,
          RHODES_TLS_CERT_FILE: TLS_FIXTURES.certFile,
        }),
      TLS_REQUIRED,
    );
    // The diagnosis survives: the message names the underlying, more specific code.
    assert.match(onlyCert.message, /config\.tls_incomplete/);
    assert.equal(onlyCert.details?.cause, 'config.tls_incomplete');

    const onlyKey = expectConfigError(
      () =>
        loadConfig({
          NODE_ENV: 'production',
          RHODES_DATA_DIR: dir,
          RHODES_TLS_KEY_FILE: TLS_FIXTURES.keyFile,
        }),
      TLS_REQUIRED,
    );
    assert.equal(onlyKey.details?.cause, 'config.tls_incomplete');
  } finally {
    removeDir(dir);
  }
});

test('production with unreadable or unusable material is refused, not downgraded', () => {
  const dir = tempDataDir();
  try {
    const missingFiles = expectConfigError(
      () =>
        loadConfig({
          NODE_ENV: 'production',
          RHODES_DATA_DIR: dir,
          RHODES_TLS_CERT_FILE: path.join(dir, 'absent-cert.pem'),
          RHODES_TLS_KEY_FILE: path.join(dir, 'absent-key.pem'),
        }),
      TLS_REQUIRED,
    );
    assert.match(missingFiles.message, /config\.tls_(cert|key)_unreadable/);

    // A certificate paired with the wrong key is not usable TLS either.
    const mismatched = expectConfigError(
      () =>
        loadConfig({
          NODE_ENV: 'production',
          RHODES_DATA_DIR: dir,
          RHODES_TLS_CERT_FILE: TLS_FIXTURES.certFile,
          RHODES_TLS_KEY_FILE: TLS_FIXTURES.otherKeyFile,
        }),
      TLS_REQUIRED,
    );
    assert.equal(mismatched.details?.cause, 'config.tls_pair_mismatch');
  } finally {
    removeDir(dir);
  }
});

test('production with valid TLS is accepted and reports https', () => {
  const dir = tempDataDir();
  try {
    const config = loadConfig({
      NODE_ENV: 'production',
      RHODES_DATA_DIR: dir,
      ...tlsEnv(),
    });

    assert.equal(config.nodeEnv, 'production');
    assert.equal(config.transport, 'https');
    assert.ok(config.tls !== null);
    assert.match(config.tls.certificate.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(config.databasePath, path.join(config.dataDir, 'rhodes.db'));
  } finally {
    removeDir(dir);
  }
});

test('development and test keep plain HTTP and their specific TLS messages', () => {
  const dir = tempDataDir();
  try {
    for (const nodeEnv of ['development', 'test'] as const) {
      const plain = loadConfig({ NODE_ENV: nodeEnv, RHODES_DATA_DIR: dir });
      assert.equal(plain.transport, 'http', `${nodeEnv} may run on loopback HTTP`);
      assert.equal(plain.tls, null);

      // A half-configured pair is still refused, but with the precise reason: in
      // development that is a typo to explain, not a policy failure.
      expectConfigError(
        () =>
          loadConfig({
            NODE_ENV: nodeEnv,
            RHODES_DATA_DIR: dir,
            RHODES_TLS_CERT_FILE: TLS_FIXTURES.certFile,
          }),
        'config.tls_incomplete',
      );
    }
  } finally {
    removeDir(dir);
  }
});

test('a bad data directory is still reported as the data directory in production', () => {
  // The TLS gate runs late on purpose: an operator who mistyped the data directory should
  // hear about that, not about the certificate they never got to configure.
  const dir = tempDataDir();
  try {
    const notADirectory = path.join(dir, 'not-a-directory');
    writeFileSync(notADirectory, 'x');
    expectConfigError(
      () => loadConfig({ NODE_ENV: 'production', RHODES_DATA_DIR: notADirectory, ...tlsEnv() }),
      'config.data_dir_not_a_directory',
    );
  } finally {
    removeDir(dir);
  }
});
