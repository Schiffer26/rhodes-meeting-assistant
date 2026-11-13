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

import { existsSync, statSync } from 'node:fs';
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
