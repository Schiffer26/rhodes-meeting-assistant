/**
 * Configuration safety.
 *
 * Cases 10 and 11 of the required test matrix live here: an invalid configuration
 * must fail before anything is created, and a non-loopback bind must be refused.
 */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { isSyncedFolderPath, loadConfig, resolveRealPath } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { removeDir, tempDataDir, tlsEnv } from './helpers.js';

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

test('a sync root is resolved with the same rules as the data directory before comparison', () => {
  // The Windows report (LAN-2.1a): the target is compared after `path.resolve`, so a root
  // left unresolved could never match it. Both sides now go through the same key.
  expectConfigError(
    () => loadConfig({ RHODES_DATA_DIR: '/home/office/CloudData/RHODES', OneDrive: '/home/office/CloudData' }),
    'config.data_dir_synced_folder',
  );

  // Native Windows-style values, written the way a real OneDrive client sets them.
  for (const envKey of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    expectConfigError(
      () =>
        loadConfig({
          RHODES_DATA_DIR: 'C:\\Users\\Ana\\OneDrive - Contoso\\RHODES\\data',
          [envKey]: 'C:\\Users\\Ana\\OneDrive - Contoso',
        }),
      'config.data_dir_synced_folder',
    );
  }

  // Dropbox through its own root, for a folder whose name gives nothing away.
  expectConfigError(
    () => loadConfig({ RHODES_DATA_DIR: '/home/office/SyncArea/RHODES', Dropbox: '/home/office/SyncArea' }),
    'config.data_dir_synced_folder',
  );

  // The target may be the root itself, or any depth below it.
  expectConfigError(
    () => loadConfig({ RHODES_DATA_DIR: '/home/office/CloudData', OneDrive: '/home/office/CloudData' }),
    'config.data_dir_synced_folder',
  );
  expectConfigError(
    () => loadConfig({ RHODES_DATA_DIR: '/home/office/CloudData/a/b/RHODES', OneDrive: '/home/office/CloudData' }),
    'config.data_dir_synced_folder',
  );

  // Trailing separators, mixed separators and a different case all compare equal.
  expectConfigError(
    () => loadConfig({ RHODES_DATA_DIR: '/home/office/CloudData/RHODES', OneDrive: '/home/office/CloudData/' }),
    'config.data_dir_synced_folder',
  );
  expectConfigError(
    () => loadConfig({ RHODES_DATA_DIR: 'C:\\Users\\Ana/OneDrive/RHODES', OneDrive: 'C:/Users/Ana\\OneDrive' }),
    'config.data_dir_synced_folder',
  );
  expectConfigError(
    () => loadConfig({ RHODES_DATA_DIR: '/home/office/clouddata/RHODES', OneDrive: '/home/office/CloudData' }),
    'config.data_dir_synced_folder',
  );
});

test('sync-root containment is boundary-aware, not a text-prefix match', () => {
  const withRoot = (root: string) => ({ OneDrive: root });

  assert.equal(isSyncedFolderPath('/home/office/CloudData', withRoot('/home/office/CloudData')), true, 'equal');
  assert.equal(
    isSyncedFolderPath('/home/office/CloudData/RHODES', withRoot('/home/office/CloudData')),
    true,
    'nested',
  );
  assert.equal(
    isSyncedFolderPath('/home/office/CloudData/RHODES/data', withRoot('/home/office/CloudData/')),
    true,
    'nested, root with a trailing separator',
  );
  assert.equal(
    isSyncedFolderPath('/home/office/CloudData\\RHODES', withRoot('/home/office/CloudData')),
    true,
    'target with the other separator',
  );
  assert.equal(
    isSyncedFolderPath('/home/office/CLOUDDATA/RHODES', withRoot('/home/office/clouddata')),
    true,
    'case-insensitive',
  );

  assert.equal(
    isSyncedFolderPath('/home/office/CloudDataBackup/RHODES', withRoot('/home/office/CloudData')),
    false,
    'a sibling sharing only the text prefix is not inside the root',
  );
  assert.equal(
    isSyncedFolderPath('/home/office/RHODES', withRoot('/home/office/CloudData')),
    false,
    'an unrelated directory is not inside the root',
  );
  assert.equal(isSyncedFolderPath('/home/office/RHODES', {}), false, 'no root, no name: accepted');
});

test('extended-length Windows paths compare equal to their ordinary form', () => {
  // `\\?\` is a literal prefix recognised by its double separator, so it has to be
  // stripped before separators are normalised — otherwise `\\?\C:\...` becomes a path on
  // the current drive and matches nothing.
  const extendedRoot = '\\\\?\\C:\\Users\\Owner\\OneDrive';
  const ordinaryRoot = 'C:\\Users\\Owner\\OneDrive';

  // The environment root in extended form, the data directory in ordinary form. This is
  // the realistic direction: `RHODES_DATA_DIR` may not use the extended form at all (an
  // extended-length data directory is refused earlier, as a UNC-looking path), but a
  // client can advertise `%OneDrive%` either way.
  expectConfigError(
    () => loadConfig({ RHODES_DATA_DIR: 'C:\\Users\\Owner\\OneDrive\\RHODES', OneDrive: extendedRoot }),
    'config.data_dir_synced_folder',
  );

  // Equality, in both directions, through the containment helper.
  assert.equal(isSyncedFolderPath('C:\\Users\\Owner\\OneDrive\\RHODES', { OneDrive: extendedRoot }), true);
  assert.equal(isSyncedFolderPath(`${extendedRoot}\\RHODES`, { OneDrive: ordinaryRoot }), true);
  assert.equal(isSyncedFolderPath(extendedRoot, { OneDrive: extendedRoot.replace(/\\/g, '/') }), true);

  // Mixed separators and a trailing separator inside the extended form.
  assert.equal(isSyncedFolderPath('C:\\Users\\Owner\\OneDrive\\RHODES', { OneDrive: '\\\\?\\C:/Users\\Owner\\OneDrive\\' }), true);

  // Case-insensitivity is unchanged by the extra step.
  assert.equal(isSyncedFolderPath('C:\\users\\OWNER\\onedrive\\RHODES', { OneDrive: extendedRoot }), true);

  // A sibling of the extended root is still a sibling, not a child.
  assert.equal(isSyncedFolderPath('C:\\Users\\Owner\\OneDriveBackup\\RHODES', { OneDrive: extendedRoot }), false);
});

test('an extended-length UNC root keeps its share identity', () => {
  const extendedUncRoot = '\\\\?\\UNC\\fileserver\\share\\Sync';

  // The same share written as an extended UNC root and as a plain UNC target.
  assert.equal(
    isSyncedFolderPath('\\\\fileserver\\share\\Sync\\RHODES', { OneDrive: extendedUncRoot }),
    true,
    'plain UNC target under an extended UNC root',
  );
  assert.equal(
    isSyncedFolderPath('\\\\?\\UNC\\fileserver\\share\\Sync\\RHODES', { OneDrive: '\\\\fileserver\\share\\Sync' }),
    true,
    'extended UNC target under a plain UNC root',
  );

  // A local path must never be mistaken for a path inside a share. `C:\fileserver\share`
  // reads almost the same but is a directory on the local disk.
  assert.equal(
    isSyncedFolderPath('C:\\fileserver\\share\\Sync\\RHODES', { OneDrive: extendedUncRoot }),
    false,
    'a local path is not inside a share',
  );
  assert.equal(
    isSyncedFolderPath('\\\\fileserver\\share\\SyncBackup\\RHODES', { OneDrive: extendedUncRoot }),
    false,
    'a sibling share folder is not inside it',
  );
});

test('a directory beside a sync root that only shares its prefix is accepted and not rewritten', () => {
  const base = tempDataDir();
  try {
    const target = path.join(base, 'CloudDataBackup', 'RHODES');
    const config = loadConfig({ RHODES_DATA_DIR: target, OneDrive: path.join(base, 'CloudData') });

    // Accepted, and still exactly where the operator asked for it.
    assert.equal(config.dataDir, path.resolve(target));
    assert.equal(config.databasePath, path.join(path.resolve(target), 'rhodes.db'));
  } finally {
    removeDir(base);
  }
});

test('well-known sync folder names are refused without any environment root', () => {
  for (const name of ['OneDrive', 'Dropbox', 'Google Drive', 'GoogleDrive', 'SharePoint', 'iCloud Drive', 'Box']) {
    expectConfigError(
      () => loadConfig({ RHODES_DATA_DIR: path.join(path.sep + 'home', 'office', name, 'RHODES') }),
      'config.data_dir_synced_folder',
    );
  }
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
  // Production additionally requires TLS (LAN-3.2): without it the transport would
  // silently fall back to plain HTTP, which is refused before anything is created.
  const config = loadConfig({
    NODE_ENV: 'production',
    ProgramData: 'C:\\ProgramData',
    ...tlsEnv(),
  });
  // The data directory is always absolute and always ends with the RHODES data folders,
  // whichever platform the environment happens to describe.
  assert.ok(path.isAbsolute(config.dataDir));
  assert.ok(
    config.dataDir.replace(/\\/g, '/').endsWith('RHODES/data'),
    `unexpected data directory: ${config.dataDir}`,
  );
  assert.ok(config.dataDir.includes('ProgramData'), config.dataDir);
});

// ── reparse points: symbolic links (and, on Windows, junctions) ─────────────
//
// A configured path can look perfectly local and still lead somewhere unsafe: a
// directory symlink or a Windows junction. These tests prove the *resolved* target is
// what gets checked. Junctions are Windows-only and are NOT covered here — see the
// Windows checklist in ARCHITECTURE.md.

function makeSymlink(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

test('a data directory reached through a link into a synced folder is refused', (t) => {
  const base = tempDataDir();
  try {
    const synced = path.join(base, 'OneDrive', 'RHODES');
    mkdirSync(synced, { recursive: true });
    const link = path.join(base, 'local-looking-data');
    if (!makeSymlink(synced, link)) {
      t.skip('symbolic links are not supported in this environment');
      return;
    }

    // The link itself exists and is a directory…
    expectConfigError(() => loadConfig({ RHODES_DATA_DIR: link }), 'config.data_dir_synced_folder');
    // …and a directory that would be created underneath it does not exist yet.
    expectConfigError(
      () => loadConfig({ RHODES_DATA_DIR: path.join(link, 'data') }),
      'config.data_dir_synced_folder',
    );

    // Nothing may be created while refusing.
    assert.equal(existsSync(path.join(synced, 'data')), false);
  } finally {
    removeDir(base);
  }
});

test('a link chain into a synced folder is refused at the end of the chain', (t) => {
  const base = tempDataDir();
  try {
    const synced = path.join(base, 'Dropbox', 'RHODES');
    mkdirSync(synced, { recursive: true });
    const hop = path.join(base, 'hop');
    const link = path.join(base, 'final');
    if (!makeSymlink(synced, hop) || !makeSymlink(hop, link)) {
      t.skip('symbolic links are not supported in this environment');
      return;
    }
    expectConfigError(() => loadConfig({ RHODES_DATA_DIR: link }), 'config.data_dir_synced_folder');
  } finally {
    removeDir(base);
  }
});

test('a link to an ordinary local directory is accepted and is not rewritten', (t) => {
  const base = tempDataDir();
  try {
    const real = path.join(base, 'plain', 'nested');
    mkdirSync(real, { recursive: true });
    const link = path.join(base, 'alias');
    if (!makeSymlink(real, link)) {
      t.skip('symbolic links are not supported in this environment');
      return;
    }

    const configured = path.join(link, 'data');
    const config = loadConfig({ RHODES_DATA_DIR: configured });
    // The configured path is kept; an accepted path is never silently redirected.
    assert.equal(config.dataDir, path.resolve(configured));
  } finally {
    removeDir(base);
  }
});

test('a link loop is refused as unresolvable rather than guessed at', (t) => {
  const base = tempDataDir();
  try {
    const a = path.join(base, 'loop-a');
    const b = path.join(base, 'loop-b');
    if (!makeSymlink(b, a) || !makeSymlink(a, b)) {
      t.skip('symbolic links are not supported in this environment');
      return;
    }
    expectConfigError(
      () => loadConfig({ RHODES_DATA_DIR: path.join(a, 'data') }),
      'config.data_dir_unresolvable',
    );
  } finally {
    removeDir(base);
  }
});

test('resolveRealPath resolves the nearest existing ancestor and keeps the tail', () => {
  const base = tempDataDir();
  try {
    const target = path.join(base, 'not', 'created', 'yet');
    const resolved = resolveRealPath(target);
    assert.ok(resolved.endsWith(path.join('not', 'created', 'yet')), resolved);
    assert.ok(path.isAbsolute(resolved));
    // An existing directory resolves to itself.
    assert.equal(resolveRealPath(base), resolveRealPath(base));
  } finally {
    removeDir(base);
  }
});

/** Run the loader and return the ConfigError it threw, for details assertions. */
function caughtConfigError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError, but the call succeeded');
}

test('an inaccessible ancestor is refused, not treated as a missing component', (t) => {
  // Unix-only by construction. This test denies access with chmod, and Node does not
  // implement Unix permission bits on Windows — there, access is decided by ACLs that
  // chmod cannot express. Running it there would pass or fail for reasons unrelated to
  // the code under test, so it is skipped explicitly instead of pretending to cover the
  // Windows case. The Windows ACL denial remains a manual deployment check; see
  // ARCHITECTURE.md §12.
  if (process.platform === 'win32') {
    t.skip(
      'chmod cannot simulate a Windows ACL denial — Windows access control is not stored in Unix permission bits. ' +
        'Verify the EACCES/EPERM path manually with a folder ACL that denies the service account (ARCHITECTURE.md §12).',
    );
    return;
  }
  if (process.getuid?.() === 0) {
    t.skip('running as root: directory permissions are not enforced');
    return;
  }

  // The skip checks sit above the setup on purpose: chmod on a directory that was never
  // created would throw from the cleanup block and turn a skip into a failure.
  const base = tempDataDir();
  const locked = path.join(base, 'locked');
  try {
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);

    const error = caughtConfigError(() => loadConfig({ RHODES_DATA_DIR: path.join(locked, 'data') }));
    assert.equal(error.code, 'config.data_dir_unresolvable');
    assert.ok(
      (error.details?.code === 'EACCES' || error.details?.code === 'EPERM'),
      `expected a permission errno, received ${String(error.details?.code)}`,
    );
    // Fail-closed: nothing was created behind the unreadable directory.
    assert.equal(existsSync(path.join(locked, 'data')), false);
  } finally {
    chmodSync(locked, 0o700);
    removeDir(base);
  }
});

test('an existing file cannot act as an ancestor of the data directory', () => {
  const base = tempDataDir();
  try {
    const file = path.join(base, 'blocker.txt');
    writeFileSync(file, 'not a directory');

    // A directory "underneath" a file can never be created.
    expectConfigError(() => loadConfig({ RHODES_DATA_DIR: path.join(file, 'data') }), 'config.data_dir_not_a_directory');
    // The plain case (the configured path is itself a file) still reports the same code.
    expectConfigError(() => loadConfig({ RHODES_DATA_DIR: file }), 'config.data_dir_not_a_directory');
  } finally {
    removeDir(base);
  }
});

test('a broken symbolic link is refused as unresolvable', (t) => {
  const base = tempDataDir();
  try {
    const missingTarget = path.join(base, 'vanished-target');
    const link = path.join(base, 'broken-link');
    if (!makeSymlink(missingTarget, link)) {
      t.skip('symbolic links are not supported in this environment');
      return;
    }

    expectConfigError(() => loadConfig({ RHODES_DATA_DIR: link }), 'config.data_dir_unresolvable');
    expectConfigError(() => loadConfig({ RHODES_DATA_DIR: path.join(link, 'data') }), 'config.data_dir_unresolvable');
    // A dangling link is not "a directory that has not been created yet".
    assert.equal(existsSync(path.join(base, 'data')), false);
  } finally {
    removeDir(base);
  }
});
