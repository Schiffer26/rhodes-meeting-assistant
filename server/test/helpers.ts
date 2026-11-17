/**
 * Test helpers.
 *
 * Every test gets its own temporary data directory, its own database file, and its
 * own ephemeral port, so the suite never touches `.local-data/`, never binds 4317, and
 * leaves nothing behind on failure.
 *
 * TLS fixtures under `test/fixtures/tls/` are **test-only** self-signed certificates for
 * `localhost`, `127.0.0.1` and `::1`. They are public by construction (the private keys
 * are in this repository on purpose, so the suite can prove the HTTPS path without
 * generating anything at run time) and must never be used for a real deployment.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp, type AppDependencies } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { openDatabase, type RhodesDatabase } from '../src/db/index.js';
import { loadMigrationFiles, MIGRATIONS_DIR, runMigrations } from '../src/db/migrate.js';
import { startServer, type StartedServer } from '../src/server.js';
import { loadTlsMaterial, type TlsMaterial, type TlsServerOptions } from '../src/tls.js';

const TLS_FIXTURE_DIR = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));

/**
 * TEST ONLY. Two independent self-signed pairs, both for the loopback names only.
 * `otherCert/otherKey` exist so a mismatched pair can be built from real PEM material.
 */
export const TLS_FIXTURES = {
  certFile: path.join(TLS_FIXTURE_DIR, 'rhodes-test-cert.pem'),
  keyFile: path.join(TLS_FIXTURE_DIR, 'rhodes-test-key.pem'),
  otherCertFile: path.join(TLS_FIXTURE_DIR, 'rhodes-test-other-cert.pem'),
  otherKeyFile: path.join(TLS_FIXTURE_DIR, 'rhodes-test-other-key.pem'),
} as const;

/** The fixture certificate itself, used as the trusted CA by test HTTPS clients. */
export function testCaPem(): string {
  return testTlsMaterial().certPem;
}

/** Validated material for the matched fixture pair. */
export function testTlsMaterial(): TlsMaterial {
  const material = loadTlsMaterial({ certFile: TLS_FIXTURES.certFile, keyFile: TLS_FIXTURES.keyFile });
  if (material === null) throw new Error('the TLS test fixtures are missing');
  return material;
}

/** The two environment values that switch the service to HTTPS. */
export function tlsEnv(): Record<string, string> {
  return { RHODES_TLS_CERT_FILE: TLS_FIXTURES.certFile, RHODES_TLS_KEY_FILE: TLS_FIXTURES.keyFile };
}

/**
 * The migrations this checkout ships. Version assertions derive from these files instead
 * of a literal, so adding a migration does not quietly leave a stale expectation behind
 * (and a *missing* migration still fails the "reaches the latest version" tests).
 */
export const MIGRATION_FILES = loadMigrationFiles(MIGRATIONS_DIR);
export const LATEST_SCHEMA_VERSION = MIGRATION_FILES.reduce((max, file) => Math.max(max, file.version), 0);

export function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'rhodes-test-'));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Real config code, with a synthetic environment. */
export function configFor(dataDir: string, overrides: Record<string, string> = {}): ServerConfig {
  return loadConfig({
    NODE_ENV: 'test',
    RHODES_DATA_DIR: dataDir,
    RHODES_PORT: '0',
    ...overrides,
  });
}

/** Open a database and bring it to the current schema version. */
export function openMigrated(
  dataDir: string,
  overrides: Record<string, string> = {},
): { config: ServerConfig; db: RhodesDatabase } {
  const config = configFor(dataDir, overrides);
  const db = openDatabase(config);
  runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
  return { config, db };
}

/**
 * Bring a fresh data directory to the current schema, then close the connection.
 * Used by tests that reopen the same file themselves.
 */
export function migratedConfig(dataDir: string, overrides: Record<string, string> = {}): ServerConfig {
  const config = configFor(dataDir, overrides);
  const db = openDatabase(config);
  try {
    runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
  } finally {
    db.close();
  }
  return config;
}

/**
 * Start the real HTTP(S) stack on an ephemeral loopback port.
 *
 * Extra dependencies (a fixed clock, a pre-seeded rate limiter) can be injected so time
 * and throttling can be exercised without sleeping for hours. Passing `tls` starts an
 * HTTPS listener using exactly the options `startup.ts` would use.
 */
export async function startTestServer(
  db: RhodesDatabase,
  deps: Partial<Omit<AppDependencies, 'db'>> = {},
  options: { tls?: TlsServerOptions | null; host?: string } = {},
): Promise<{ running: StartedServer; baseUrl: string }> {
  const app = createApp({ db, uptimeSeconds: () => 42, ...deps });
  const running = await startServer(app, {
    host: options.host ?? '127.0.0.1',
    port: 0,
    tls: options.tls ?? null,
  });
  return { running, baseUrl: running.url };
}

/**
 * Capture everything the logger writes while `fn` runs.
 *
 * The logger writes JSON lines straight to the process streams, so intercepting those
 * writes is the only way to assert what a real startup run emitted — including the
 * negative assertion that no certificate or private-key material reached a log line.
 * Tests inside one file run sequentially, so no other test can interleave.
 */
export async function captureLogs(fn: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const out = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const err = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  const savedOut = out.write;
  const savedErr = err.write;
  const sink = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };

  out.write = sink;
  err.write = sink;
  try {
    await fn();
  } finally {
    out.write = savedOut;
    err.write = savedErr;
  }
  return chunks.join('');
}

/** Count rows in every application table, for the "no demo records" assertions. */
export function tableCounts(db: RhodesDatabase): Record<string, number> {
  const tables = [
    'personnel',
    'meetings',
    'meeting_attendees',
    'agenda_items',
    'meeting_notes',
    'note_revisions',
    'decisions',
    'action_items',
    'audit_records',
    'user_accounts',
    'user_sessions',
    'schema_migrations',
  ];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const row = db.handle.prepare(`select count(*) as n from ${table}`).get() as { n: number };
    out[table] = row.n;
  }
  return out;
}

/** Minimal valid meeting row, for foreign-key and constraint tests. */
export function insertMeeting(db: RhodesDatabase, overrides: Record<string, unknown> = {}): number {
  const row: Record<string, unknown> = {
    title: 'Midweek service review',
    meeting_date: '2026-03-11',
    ...overrides,
  };
  const columns = Object.keys(row);
  const info = db.handle
    .prepare(
      `insert into meetings (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    )
    .run(...columns.map((column) => row[column]));
  return Number(info.lastInsertRowid);
}

export function insertPersonnel(db: RhodesDatabase, overrides: Record<string, unknown> = {}): number {
  const row: Record<string, unknown> = {
    code: `P-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    full_name: 'Test Person',
    ...overrides,
  };
  const columns = Object.keys(row);
  const info = db.handle
    .prepare(
      `insert into personnel (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    )
    .run(...columns.map((column) => row[column]));
  return Number(info.lastInsertRowid);
}
