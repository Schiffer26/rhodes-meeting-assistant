/**
 * RHODES API · configuration
 *
 * Single place where environment variables become a validated, immutable config.
 * Every rule that protects the host is enforced HERE, not in the route handlers, so
 * an unsafe value cannot reach a listening socket through some other code path.
 *
 * Phase LAN-1 rules (deliberate, temporary):
 *   · the service binds to a loopback address ONLY — LAN exposure is a later phase,
 *     after HTTPS, individual accounts, authorisation and sessions exist;
 *   · the database lives on host-local disk — never a UNC share, never a synced folder.
 */

import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError } from './errors.js';

const SERVER_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export type NodeEnv = 'development' | 'test' | 'production';

export interface ServerConfig {
  readonly nodeEnv: NodeEnv;
  /** Always a loopback literal (127.0.0.1 or ::1). Never 0.0.0.0, never a LAN address. */
  readonly host: string;
  readonly port: number;
  /** Absolute path of the data directory. Created at startup if absent. */
  readonly dataDir: string;
  readonly databaseFile: string;
  /** Absolute path of the SQLite file. */
  readonly databasePath: string;
  readonly busyTimeoutMs: number;
}

export type EnvSource = Record<string, string | undefined>;

/** Loopback literals we accept. `localhost` is normalised, never bound verbatim. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]']);

const DEFAULT_PORT = 4317;
const DEFAULT_DB_FILE = 'rhodes.db';
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** Path segments that mean "this directory is synchronised by a cloud client". */
const SYNCED_PATH_SEGMENTS = [
  'onedrive',
  'dropbox',
  'google drive',
  'googledrive',
  'sharepoint',
  'icloud drive',
  'box',
];

function readEnv(env: EnvSource, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** Normalise `localhost` to a literal so the bind is unambiguous. */
export function normaliseHost(raw: string | undefined, fallback = '127.0.0.1'): string {
  const value = (raw ?? fallback).trim().toLowerCase();
  if (value === 'localhost') return '127.0.0.1';
  return value;
}

function parseNodeEnv(raw: string | undefined): NodeEnv {
  if (raw === undefined) return 'development';
  if (raw === 'development' || raw === 'test' || raw === 'production') return raw;
  throw new ConfigError(
    'config.invalid_node_env',
    `NODE_ENV must be one of development, test, production. Received "${raw}".`,
  );
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(raw)) {
    throw new ConfigError('config.invalid_port', 'RHODES_PORT must be a whole number between 0 and 65535.');
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError('config.invalid_port', 'RHODES_PORT must be a whole number between 0 and 65535.');
  }
  return port;
}

function parseBusyTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BUSY_TIMEOUT_MS;
  if (!/^\d{1,6}$/.test(raw)) {
    throw new ConfigError('config.invalid_busy_timeout', 'RHODES_BUSY_TIMEOUT_MS must be a whole number of milliseconds.');
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError('config.invalid_busy_timeout', 'RHODES_BUSY_TIMEOUT_MS must be zero or greater.');
  }
  return value;
}

function parseDatabaseFile(raw: string | undefined): string {
  const value = raw ?? DEFAULT_DB_FILE;
  // A file name only: no directories, no traversal, no absolute path.
  if (!/^[A-Za-z0-9._-]+\.db$/.test(value) || value.includes('..')) {
    throw new ConfigError(
      'config.invalid_database_file',
      'RHODES_DB_FILE must be a plain file name ending in .db (no directory separators).',
    );
  }
  return value;
}

function defaultDataDir(nodeEnv: NodeEnv, env: EnvSource): string {
  if (nodeEnv !== 'production') {
    return path.resolve(SERVER_ROOT, '..', '.local-data');
  }
  const programData = readEnv(env, 'ProgramData') ?? readEnv(env, 'PROGRAMDATA');
  if (!programData) {
    throw new ConfigError(
      'config.programdata_unavailable',
      'ProgramData is not defined, so the production data directory cannot be derived. ' +
        'Set RHODES_DATA_DIR explicitly (Windows default: %ProgramData%\\RHODES\\data).',
    );
  }
  return path.join(programData, 'RHODES', 'data');
}

/**
 * Resolve a configured path to the location the operating system would actually use,
 * following symbolic links and Windows junctions.
 *
 * A path that does not exist yet is the normal case for a first run, so the nearest
 * existing ancestor is resolved and the remaining segments are appended unchanged.
 * This is what makes the check meaningful: a junction at C:\RHODES makes
 * `C:\RHODES\data` look local while the bytes really live somewhere else.
 *
 * Throws if the existing ancestor cannot be resolved (for example a symlink loop).
 */
export function resolveRealPath(target: string): string {
  const resolved = path.resolve(target);
  let probe = resolved;
  const tail: string[] = [];

  for (;;) {
    let real: string | null = null;
    try {
      real = stripWindowsLongPathPrefix(realpathSync.native(probe));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        // EACCES, EPERM, ELOOP, EIO, ENAMETOOLONG … — the real location cannot be
        // determined at all. This is the fail-closed case: never guess, never walk past
        // a component whose target is unknown.
        throw unresolvable(probe, code);
      }

      // ENOENT / ENOTDIR mean "this component is not there yet" — or, for a broken
      // symbolic link, that the entry exists but leads nowhere. `lstat` looks at the
      // entry itself and separates the two; anything it cannot read is fatal.
      let entryExists = false;
      try {
        lstatSync(probe);
        entryExists = true;
      } catch (lstatError) {
        const lstatCode = (lstatError as NodeJS.ErrnoException).code;
        if (lstatCode !== 'ENOENT' && lstatCode !== 'ENOTDIR') {
          throw unresolvable(probe, lstatCode);
        }
      }
      if (entryExists) {
        throw new ConfigError(
          'config.data_dir_unresolvable',
          'RHODES_DATA_DIR could not be resolved to a real location on this computer. ' +
            `"${path.basename(probe)}" exists but leads nowhere (a broken symbolic link), so the ` +
            'target is unknowable. Refusing to start.',
          { path: probe },
        );
      }
    }

    if (real !== null) {
      if (tail.length > 0) {
        // Segments remain below this ancestor, so the ancestor has to be a directory.
        // A regular file in that position can never become a data directory.
        let stats;
        try {
          stats = statSync(real);
        } catch (error) {
          throw unresolvable(real, (error as NodeJS.ErrnoException).code);
        }
        if (!stats.isDirectory()) {
          throw new ConfigError(
            'config.data_dir_not_a_directory',
            'RHODES_DATA_DIR cannot be created: a component on the way to it is an existing ' +
              `file, not a directory ("${path.basename(real)}"). Refusing to start.`,
            { path: real },
          );
        }
      }
      return tail.length === 0 ? real : path.join(real, ...tail);
    }

    const parent = path.dirname(probe);
    // Reached a root (or a drive) without finding anything that exists.
    if (parent === probe) return resolved;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
}

/** One shape for "the target cannot be known", with the errno kept for the operator. */
function unresolvable(target: string, code: string | undefined): ConfigError {
  return new ConfigError(
    'config.data_dir_unresolvable',
    'RHODES_DATA_DIR could not be resolved to a real location on this computer' +
      (code ? ` (${code})` : '') +
      '. A permission problem, a broken link, or a symbolic-link loop makes the target ' +
      'unknowable, so the service will not start.',
    { path: target, code: code ?? null },
  );
}

/**
 * `realpathSync.native` returns extended-length paths on Windows (`\\?\C:\...`,
 * `\\?\UNC\server\share\...`). Left alone, the UNC form would evade the network
 * share check — precisely the laundering this file exists to prevent — and the drive
 * form would confuse the synced-folder heuristics. Fold both back to the form an
 * operator recognises.
 */
export function stripWindowsLongPathPrefix(target: string): string {
  if (/^\\\\\?\\UNC\\/i.test(target)) return '\\\\' + target.slice(8);
  if (/^\\\\\?\\/i.test(target)) return target.slice(4);
  return target;
}

/** Reject UNC paths (`\\\\server\\share`, `//server/share`) outright. */
export function isNetworkSharePath(target: string): boolean {
  return /^[\\/]{2}/.test(target);
}

/**
 * Detect paths that a cloud client would synchronise.
 *
 * Two independent signals: the configured sync roots in the environment, and the
 * well-known folder names a synchronised tree lives under. A *mapped network drive*
 * (e.g. Z:\RHODES) cannot be detected reliably from Node, so the operational rule is
 * documented as well — see ARCHITECTURE.md.
 */
export function isSyncedFolderPath(target: string, env: EnvSource = process.env): boolean {
  const lower = target.toLowerCase();
  const roots = [
    readEnv(env, 'OneDrive'),
    readEnv(env, 'OneDriveCommercial'),
    readEnv(env, 'OneDriveConsumer'),
    readEnv(env, 'Dropbox'),
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());

  for (const root of roots) {
    if (root.length > 0 && (lower === root || lower.startsWith(root.endsWith(path.sep) ? root : root + path.sep))) {
      return true;
    }
  }

  const segments = lower.split(/[\\/]+/).filter(Boolean);
  return segments.some((segment) => SYNCED_PATH_SEGMENTS.includes(segment));
}

function resolveDataDir(raw: string | undefined, nodeEnv: NodeEnv, env: EnvSource): string {
  const chosen = raw ?? defaultDataDir(nodeEnv, env);

  // Check the value as typed, before resolution: on POSIX, `path.resolve` collapses a
  // leading `\\server\share` into a normal absolute path, which would let a UNC path slip
  // through on the very platform where the check is easiest to get wrong.
  if (isNetworkSharePath(chosen)) {
    throw new ConfigError(
      'config.data_dir_network_share',
      'RHODES_DATA_DIR must be on the host computer\'s local disk. ' +
        'A network share (\\\\server\\share) cannot hold the database: SQLite locking and WAL are not reliable over SMB.',
    );
  }

  const absolute = path.resolve(chosen);

  if (isNetworkSharePath(absolute)) {
    throw new ConfigError(
      'config.data_dir_network_share',
      'RHODES_DATA_DIR must be on the host computer\'s local disk. ' +
        'A network share (\\\\server\\share) cannot hold the database: SQLite locking and WAL are not reliable over SMB.',
    );
  }

  if (isSyncedFolderPath(absolute, env)) {
    throw new ConfigError(
      'config.data_dir_synced_folder',
      'RHODES_DATA_DIR must not be inside a cloud-synchronised folder (OneDrive, Dropbox, ' +
        'Google Drive, SharePoint). A sync client can copy a half-written database and corrupt it.',
    );
  }

  if (existsSync(absolute) && !statSync(absolute).isDirectory()) {
    throw new ConfigError(
      'config.data_dir_not_a_directory',
      'RHODES_DATA_DIR points at an existing file, not a directory. Refusing to start.',
    );
  }

  // Finally, check where the path really leads. The string checks above can be satisfied
  // by a directory that is actually a symbolic link or a Windows junction, so resolve
  // the nearest existing ancestor (the leaf usually does not exist on a first run) and
  // re-run the same rules against the real location. The configured path is NOT
  // rewritten — an unsafe location is refused, never silently redirected.
  let real: string;
  try {
    // resolveRealPath already reports a specific, fail-closed reason (unresolvable or
    // not-a-directory); only an unexpected throw is generalised here.
    real = resolveRealPath(absolute);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      'config.data_dir_unresolvable',
      'RHODES_DATA_DIR could not be resolved to a real location on this computer. ' +
        'A broken link, a permission problem, or a symbolic-link loop makes the target unknowable, so the service will not start.',
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }

  if (isNetworkSharePath(real)) {
    throw new ConfigError(
      'config.data_dir_network_share',
      'RHODES_DATA_DIR resolves to a network share through a link or junction. ' +
        'The database must live on the host computer\'s local disk. Refusing to start.',
      { resolved: real },
    );
  }

  if (isSyncedFolderPath(real, env)) {
    throw new ConfigError(
      'config.data_dir_synced_folder',
      'RHODES_DATA_DIR resolves into a cloud-synchronised folder (OneDrive, Dropbox, ' +
        'Google Drive, SharePoint) through a link or junction. A sync client can copy a ' +
        'half-written database and corrupt it. Refusing to start.',
      { resolved: real },
    );
  }

  return absolute;
}

/**
 * Build a validated configuration. Throws ConfigError — always before the data
 * directory is created and before anything listens — so a bad environment cannot
 * leave a half-initialised database behind.
 */
export function loadConfig(env: EnvSource = process.env): ServerConfig {
  const nodeEnv = parseNodeEnv(readEnv(env, 'NODE_ENV'));
  const host = normaliseHost(readEnv(env, 'RHODES_HOST'));

  if (!isLoopbackHost(host)) {
    throw new ConfigError(
      'config.non_loopback_host',
      `RHODES_HOST must be a loopback address (127.0.0.1 or ::1) in this phase. Received "${host}". ` +
        'LAN exposure is enabled only after HTTPS, accounts, authorisation and sessions exist.',
    );
  }

  const port = parsePort(readEnv(env, 'RHODES_PORT'));
  const busyTimeoutMs = parseBusyTimeout(readEnv(env, 'RHODES_BUSY_TIMEOUT_MS'));
  const databaseFile = parseDatabaseFile(readEnv(env, 'RHODES_DB_FILE'));
  const dataDir = resolveDataDir(readEnv(env, 'RHODES_DATA_DIR'), nodeEnv, env);

  return Object.freeze({
    nodeEnv,
    host,
    port,
    dataDir,
    databaseFile,
    databasePath: path.join(dataDir, databaseFile),
    busyTimeoutMs,
  });
}

export const paths = { serverRoot: SERVER_ROOT } as const;
