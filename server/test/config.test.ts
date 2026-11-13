/**
 * Configuration safety.
 *
 * Cases 10 and 11 of the required test matrix live here: an invalid configuration
 * must fail before anything is created, and a non-loopback bind must be refused.
 */

import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { removeDir, tempDataDir } from './helpers.js';

function expectConfigError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ConfigError, `expected ConfigError, received ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('defaults: loopback host, port 4317, development data directory', () => {
  const config = loadConfig({ NODE_ENV: 'development' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4317);
  assert.equal(config.databaseFile, 'rhodes.db');
  assert.equal(config.busyTimeoutMs, 5000);
  assert.ok(config.dataDir.endsWith('.local-data'), `unexpected data directory: ${config.dataDir}`);
  assert.equal(config.databasePath, path.join(config.dataDir, 'rhodes.db'));
});

test('localhost is normalised to a literal loopback address', () => {
  assert.equal(loadConfig({ RHODES_HOST: 'localhost' }).host, '127.0.0.1');
  assert.equal(loadConfig({ RHODES_HOST: '  LOCALHOST ' }).host, '127.0.0.1');
  assert.equal(loadConfig({ RHODES_HOST: '127.0.0.1' }).host, '127.0.0.1');
  assert.equal(loadConfig({ RHODES_HOST: '::1' }).host, '::1');
});

test('case 11: a non-loopback bind address is refused', () => {
  for (const host of ['0.0.0.0', '192.168.1.20', '10.0.0.5', '::', 'rhodes-server', 'host.docker.internal']) {
    expectConfigError(() => loadConfig({ RHODES_HOST: host }), 'config.non_loopback_host');
  }
});

test('port and busy timeout are validated', () => {
  expectConfigError(() => loadConfig({ RHODES_PORT: 'http' }), 'config.invalid_port');
  expectConfigError(() => loadConfig({ RHODES_PORT: '70000' }), 'config.invalid_port');
  assert.equal(loadConfig({ RHODES_PORT: '0' }).port, 0);
  expectConfigError(() => loadConfig({ RHODES_BUSY_TIMEOUT_MS: '-1' }), 'config.invalid_busy_timeout');
  expectConfigError(() => loadConfig({ RHODES_BUSY_TIMEOUT_MS: 'soon' }), 'config.invalid_busy_timeout');
});

test('the database file must be a plain .db file name', () => {
  expectConfigError(() => loadConfig({ RHODES_DB_FILE: '../escape.db' }), 'config.invalid_database_file');
  expectConfigError(() => loadConfig({ RHODES_DB_FILE: 'sub/rhodes.db' }), 'config.invalid_database_file');
  expectConfigError(() => loadConfig({ RHODES_DB_FILE: 'rhodes.sqlite' }), 'config.invalid_database_file');
  assert.equal(loadConfig({ RHODES_DB_FILE: 'rhodes-main.db' }).databaseFile, 'rhodes-main.db');
});

test('a network share is refused as a data directory', () => {
  expectConfigError(
    () => loadConfig({ RHODES_DATA_DIR: '\\\\fileserver\\shared\\rhodes' }),
    'config.data_dir_network_share',
  );
  expectConfigError(
    () => loadConfig({ RHODES_DATA_DIR: '//fileserver/shared/rhodes' }),
    'config.data_dir_network_share',
  );
});

test('a cloud-synchronised folder is refused as a data directory', () => {
  expectConfigError(
    () => loadConfig({ RHODES_DATA_DIR: '/home/office/OneDrive/RHODES/data' }),
    'config.data_dir_synced_folder',
  );
  expectConfigError(
    () => loadConfig({ RHODES_DATA_DIR: '/home/office/Dropbox/RHODES' }),
    'config.data_dir_synced_folder',
  );
  // Also detected through the client's own environment root, whatever the folder is named.
  expectConfigError(
    () => loadConfig({ RHODES_DATA_DIR: '/home/office/CloudData/RHODES', OneDrive: '/home/office/CloudData' }),
    'config.data_dir_synced_folder',
  );
});

test('case 10: invalid configuration fails safely and creates nothing', () => {
  const base = tempDataDir();
  try {
    const target = path.join(base, 'never-created');
    assert.throws(() => loadConfig({ RHODES_DATA_DIR: target, RHODES_HOST: '0.0.0.0' }), ConfigError);
    assert.equal(existsSync(target), false, 'no data directory may be created by a rejected configuration');

    // A path that exists but is a file is a misconfiguration, not something to "fix".
    const filePath = path.join(base, 'not-a-directory');
    writeFileSync(filePath, 'x');
    expectConfigError(() => loadConfig({ RHODES_DATA_DIR: filePath }), 'config.data_dir_not_a_directory');
  } finally {
    removeDir(base);
  }
});

test('production requires ProgramData unless the data directory is explicit', () => {
  expectConfigError(
    () => loadConfig({ NODE_ENV: 'production' }),
    'config.programdata_unavailable',
  );
  const config = loadConfig({ NODE_ENV: 'production', ProgramData: 'C:\\ProgramData' });
  // The data directory is always absolute and always ends with the RHODES data folders,
  // whichever platform the environment happens to describe.
  assert.ok(path.isAbsolute(config.dataDir));
  assert.ok(
    config.dataDir.replace(/\\/g, '/').endsWith('RHODES/data'),
    `unexpected data directory: ${config.dataDir}`,
  );
  assert.ok(config.dataDir.includes('ProgramData'), config.dataDir);
});
