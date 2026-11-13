/**
 * RHODES API · migration runner
 *
 * Rules that make migrations safe enough to run unattended at service start:
 *
 *   1. A migration file is immutable once applied. The runner stores a SHA-256 of the
 *      file; if the file changes later, startup REFUSES rather than pretending the
 *      schema matches the source (the classic silent-drift failure).
 *   2. Every applied migration must still exist. A missing file means the binary and
 *      the database disagree about history — also a refusal, not a guess.
 *   3. Each pending migration runs inside its own transaction, so a failing migration
 *      leaves the previous version intact and nothing half-applied.
 *   4. Re-running is a no-op: applied versions are skipped, never re-executed.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db } from './index.js';
import { MigrationError } from '../errors.js';
import { logger } from '../logger.js';

/** `0001-initial-schema.sql` → version 1, name `initial-schema`. */
const MIGRATION_PATTERN = /^(\d{4,})[-_](.+)\.sql$/;

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly filePath: string;
  /** Canonical checksum: SHA-256 of the LF-normalised text. */
  readonly checksum: string;
  /**
   * Checksums that count as "this same migration, already applied": the canonical one
   * plus any pre-LAN-1.1 line-ending variant. Used only for verification.
   */
  readonly acceptedChecksums: readonly string[];
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
}

export interface MigrationOutcome {
  /** Files discovered in the migrations directory. */
  readonly totalFiles: number;
  /** Migrations executed by this call. */
  readonly applied: readonly AppliedMigration[];
  /** Migrations already present and verified. */
  readonly skipped: number;
  /** Highest version applied after this call. */
  readonly currentVersion: number;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

/**
 * Normalise line endings before hashing or executing SQL.
 *
 * Git checks out text with CRLF on Windows when `.gitattributes` is absent or a
 * repository predates it, and appends a different byte stream for the same statement.
 * Hashing raw bytes would then make an identical migration look "edited" on one
 * platform and pristine on the other, refusing startup for no reason. LF is the single
 * canonical form (enforced for `*.sql` by `.gitattributes`); normalising here means a
 * checksum written on Windows verifies on Linux and vice versa.
 */
export function normaliseNewlines(sql: string): string {
  return sql.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Checksum of a migration's *content*, independent of checkout line endings.
 * SHA-256 over the normalised UTF-8 text.
 */
export function checksumOf(text: string): string {
  return sha256(normaliseNewlines(text));
}

/**
 * Checksums a pre-LAN-1.1 runner could have recorded for this same migration.
 *
 * Before line-ending normalisation existed, the runner hashed the file exactly as it
 * was read from disk. A database created on a CRLF checkout therefore holds
 * `sha256(<sql with CRLF>)`, which the normalising runner will never compute again.
 * Without this, such a database would be refused at startup with a checksum mismatch
 * that is not a real mismatch — the SQL is identical.
 *
 * The rule is deliberately narrow: the accepted values are SHA-256 hashes of *this*
 * migration's text with Windows line endings and of the raw bytes as read today. Any
 * change to the SQL itself — one character, one comment — changes all of them, so a
 * genuinely edited migration still fails verification. Nothing is rewritten: the
 * recorded checksum stays exactly as it was found.
 */
export function legacyChecksums(text: string): string[] {
  const canonical = checksumOf(text);
  const normalised = normaliseNewlines(text);
  const candidates = new Set<string>([sha256(text), sha256(normalised.replace(/\n/g, '\r\n'))]);
  candidates.delete(canonical);
  return [...candidates];
}

export function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(migrationsDir);
  } catch (error) {
    throw new MigrationError('migration.directory_unreadable', 'The migrations directory could not be read.', {
      directory: migrationsDir,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const files: MigrationFile[] = [];
  const seen = new Map<number, string>();

  for (const entry of entries.sort()) {
    const match = MIGRATION_PATTERN.exec(entry);
    if (!match) continue;
    const version = Number(match[1]);
    const name = match[2] ?? entry;
    const previous = seen.get(version);
    if (previous !== undefined) {
      throw new MigrationError('migration.duplicate_version', `Two migration files claim version ${version}.`, {
        first: previous,
        second: entry,
      });
    }
    seen.set(version, entry);
    const filePath = path.join(migrationsDir, entry);
    const raw = readFileSync(filePath, 'utf8');
    // The canonical checksum comes from normalised text; the legacy variants are derived
    // from the same read so verification and execution can never disagree.
    const checksum = checksumOf(raw);
    files.push({
      version,
      name,
      filePath,
      checksum,
      acceptedChecksums: [checksum, ...legacyChecksums(raw)],
    });
  }

  if (files.length === 0) {
    throw new MigrationError('migration.none_found', 'No migration files were found; the schema cannot be created.', {
      directory: migrationsDir,
    });
  }

  return files.sort((a, b) => a.version - b.version);
}

export function runMigrations(
  db: Db,
  options: { migrationsDir: string; now?: () => string },
): MigrationOutcome {
  const now = options.now ?? (() => new Date().toISOString());
  const files = loadMigrationFiles(options.migrationsDir);

  db.exec(`
    create table if not exists schema_migrations (
      version    integer primary key,
      name       text    not null,
      checksum   text    not null,
      applied_at text    not null
    );
  `);

  const appliedRows = db
    .prepare('select version, name, checksum, applied_at from schema_migrations order by version')
    .all() as AppliedRow[];
  const appliedVersions = new Set(appliedRows.map((row) => row.version));
  const filesByVersion = new Map(files.map((file) => [file.version, file] as const));

  // ── history must agree with the source tree, in both directions ──────────────
  for (const row of appliedRows) {
    const file = filesByVersion.get(row.version);
    if (!file) {
      throw new MigrationError(
        'migration.missing_file',
        `Migration ${row.version} is recorded in the database but no file provides it. ` +
          'The service and the database disagree about schema history; refusing to start.',
        { version: row.version, name: row.name },
      );
    }
    if (!file.acceptedChecksums.includes(row.checksum)) {
      throw new MigrationError(
        'migration.checksum_mismatch',
        `Migration ${row.version} (${file.name}) has changed since it was applied. ` +
          'Applied migrations are immutable; add a new migration instead of editing this one.',
        { version: row.version, expected: row.checksum, actual: file.checksum },
      );
    }
    if (row.checksum !== file.checksum) {
      // Verified through a pre-LAN-1.1 line-ending variant. The recorded value is left
      // untouched on purpose: silently rewriting history would hide the fact that this
      // database was created by an older runner.
      logger.warn('migration.legacy_checksum_accepted', {
        version: row.version,
        name: row.name,
        recorded: row.checksum,
        canonical: file.checksum,
      });
    }
  }

  const insert = db.prepare(
    'insert into schema_migrations (version, name, checksum, applied_at) values (?, ?, ?, ?)',
  );

  const applied: AppliedMigration[] = [];
  for (const file of files) {
    if (appliedVersions.has(file.version)) continue;

    const sql = normaliseNewlines(readFileSync(file.filePath, 'utf8'));
    // One transaction per migration: short, and atomic with its bookkeeping row.
    const apply = db.transaction(() => {
      db.exec(sql);
      insert.run(file.version, file.name, file.checksum, now());
      db.pragma(`user_version = ${file.version}`);
    });

    try {
      apply();
    } catch (error) {
      throw new MigrationError(
        'migration.failed',
        `Migration ${file.version} (${file.name}) failed and was rolled back.`,
        { version: file.version, name: file.name, reason: error instanceof Error ? error.message : String(error) },
      );
    }

    applied.push({ version: file.version, name: file.name });
    logger.info('migration.applied', { version: file.version, name: file.name });
  }

  const currentVersion = Math.max(0, ...appliedRows.map((row) => row.version), ...applied.map((row) => row.version));
  return {
    totalFiles: files.length,
    applied,
    skipped: files.length - applied.length,
    currentVersion,
  };
}

/**
 * Default location: `<this module>/migrations`.
 *
 * `fileURLToPath` rather than `new URL(...).pathname`, because the latter yields
 * `/C:/...` and percent-encoded spaces on Windows — which would silently point the
 * runner at a directory that does not exist.
 */
export function defaultMigrationsDir(moduleUrl: string): string {
  return path.join(path.dirname(fileURLToPath(moduleUrl)), 'migrations');
}

/**
 * The migrations shipped with this build: `<db module dir>/migrations`.
 * Correct in source (`src/db/migrations`) and after `npm run build`
 * (`dist/db/migrations`, populated by `scripts/copy-migrations.mjs`).
 */
export const MIGRATIONS_DIR = defaultMigrationsDir(import.meta.url);
