/**
 * Test helpers.
 *
 * Every test gets its own temporary data directory, its own database file, and its
 * own ephemeral port, so the suite never touches `.local-data/`, never binds 4317, and
 * leaves nothing behind on failure.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp, type AppDependencies } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { openDatabase, type RhodesDatabase } from '../src/db/index.js';
import { loadMigrationFiles, MIGRATIONS_DIR, runMigrations } from '../src/db/migrate.js';
import { startServer, type StartedServer } from '../src/server.js';

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
 * Start the real HTTP stack on an ephemeral loopback port.
 *
 * Extra dependencies (a fixed clock, a pre-seeded rate limiter) can be injected so time
 * and throttling can be exercised without sleeping for hours.
 */
export async function startTestServer(
  db: RhodesDatabase,
  deps: Partial<Omit<AppDependencies, 'db'>> = {},
): Promise<{ running: StartedServer; baseUrl: string }> {
  const app = createApp({ db, uptimeSeconds: () => 42, ...deps });
  const running = await startServer(app, { host: '127.0.0.1', port: 0 });
  return { running, baseUrl: running.url };
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
