/**
 * RHODES API · database connection module
 *
 * This module is the ONLY place in the system that opens the SQLite file. Everything
 * else receives an already-open handle (server-side) or talks to the HTTP API (clients).
 * No client ever gets a path, a handle, or a driver.
 *
 * Durability choices, and why:
 *   journal_mode = WAL      readers never block the writer; required for a service that
 *                           answers several clients while writing.
 *   synchronous  = FULL     a committed meeting record survives a power cut. The cost is
 *                           one fsync per commit, which at this workload is invisible.
 *   foreign_keys = ON       SQLite defaults this OFF, which would silently permit orphans.
 *   busy_timeout = N        a writer waits instead of failing instantly when another
 *                           connection (a backup job, a migration) holds the lock.
 *   recursive_triggers = ON REPLACE conflict resolution deletes the conflicting row,
 *                           and that deletion only fires the BEFORE DELETE trigger when
 *                           recursive triggers are enabled. Without it, `INSERT OR
 *                           REPLACE` walks straight past the note-revision history
 *                           guard (see #applyPragmas).
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';

import Database from 'better-sqlite3';

import type { ServerConfig } from '../config.js';
import { AppError, ConfigError, DatabaseError, describeError } from '../errors.js';
import { logger } from '../logger.js';

export type Db = Database.Database;

export interface OpenDatabaseOptions {
  readonly dataDir: string;
  /** Absolute path of the SQLite file inside `dataDir`. */
  readonly databasePath: string;
  readonly busyTimeoutMs: number;
}

/**
 * Create the data directory if it is missing.
 *
 * Refuses to continue if the path exists as a file: that is a misconfiguration, and
 * opening a database "inside" a file would fail confusingly later.
 */
export function ensureDataDirectory(dataDir: string): void {
  if (existsSync(dataDir)) {
    if (!statSync(dataDir).isDirectory()) {
      throw new ConfigError(
        'config.data_dir_not_a_directory',
        'The data directory path exists but is not a directory. Refusing to start.',
      );
    }
    return;
  }
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ConfigError('config.data_dir_uncreatable', `The data directory could not be created: ${describeError(error).message}`);
  }
}

export class RhodesDatabase {
  readonly #db: Db;
  readonly #path: string;
  #closed = false;

  private constructor(db: Db, filePath: string) {
    this.#db = db;
    this.#path = filePath;
  }

  /** Open (or create) the database and prove the connection is usable. */
  static open(options: OpenDatabaseOptions): RhodesDatabase {
    ensureDataDirectory(options.dataDir);
    const filePath = options.databasePath;

    let db: Db;
    try {
      db = new Database(filePath);
    } catch (error) {
      throw new DatabaseError('db.open_failed', 'The database file could not be opened.', {
        details: { reason: describeError(error).message },
        cause: error,
      });
    }

    const instance = new RhodesDatabase(db, filePath);
    try {
      instance.#applyPragmas(options.busyTimeoutMs);
      instance.#verifyConnection();
    } catch (error) {
      // Never leave a half-configured handle behind.
      instance.close();
      if (error instanceof AppError) throw error;
      // A corrupt file, a permissions problem or a replaced file all surface here:
      // report one stable code rather than a driver-specific message.
      throw new DatabaseError('db.open_failed', 'The database file could not be opened or verified.', {
        details: { reason: describeError(error).message },
        cause: error,
      });
    }

    logger.info('database.opened', { schemaVersion: instance.schemaVersion() });
    return instance;
  }

  get handle(): Db {
    this.#assertOpen();
    return this.#db;
  }

  get filePath(): string {
    return this.#path;
  }

  get isOpen(): boolean {
    return !this.#closed && this.#db.open;
  }

  #assertOpen(): void {
    if (!this.isOpen) {
      throw new DatabaseError('db.closed', 'The database connection is closed.', { exposure: 'safe' });
    }
  }

  #applyPragmas(busyTimeoutMs: number): void {
    // WAL is a persistent property of the file: assert the value SQLite actually took.
    const journalMode = this.#db.pragma('journal_mode = WAL', { simple: true });
    if (String(journalMode).toLowerCase() !== 'wal') {
      throw new DatabaseError('db.wal_unavailable', 'WAL journal mode could not be enabled on this database file.', {
        details: { journalMode: String(journalMode) },
      });
    }

    this.#db.pragma('foreign_keys = ON');
    const foreignKeys = this.#db.pragma('foreign_keys', { simple: true });
    if (Number(foreignKeys) !== 1) {
      throw new DatabaseError('db.foreign_keys_unavailable', 'Foreign-key enforcement could not be enabled.');
    }

    // SQLite's REPLACE conflict resolution satisfies a uniqueness conflict by DELETING
    // the row that is in the way. With recursive triggers off — the default — that
    // deletion does not fire BEFORE DELETE triggers, so
    //     INSERT OR REPLACE INTO note_revisions (meeting_id, revision_no, content) …
    // would silently replace a stored revision and destroy minute history, even though
    // the table has a trigger that forbids deleting one. There is no statement-level
    // "forbid REPLACE" switch, so the delete trigger must be made to fire. Verified at
    // open: if the setting cannot be applied, the service refuses to run rather than
    // accept writes its own schema is meant to reject.
    this.#db.pragma('recursive_triggers = ON');
    const recursiveTriggers = Number(this.#db.pragma('recursive_triggers', { simple: true }));
    if (recursiveTriggers !== 1) {
      throw new DatabaseError(
        'db.recursive_triggers_unavailable',
        'Recursive triggers could not be enabled. With them disabled, REPLACE conflict ' +
          'resolution can overwrite note revision history without firing the delete guard, ' +
          'so the database would not be able to honour its own history rules. Refusing to start.',
        { details: { recursiveTriggers } },
      );
    }

    this.#db.pragma('synchronous = FULL');
    const synchronous = Number(this.#db.pragma('synchronous', { simple: true }));
    if (synchronous !== 2) {
      throw new DatabaseError('db.durability_unavailable', 'FULL synchronous durability could not be enabled.', {
        details: { synchronous },
      });
    }

    this.#db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
  }

  /** Startup validation: the file is readable, consistent, and queryable. */
  #verifyConnection(): void {
    const check = String(this.#db.pragma('quick_check', { simple: true }));
    if (check.toLowerCase() !== 'ok') {
      throw new DatabaseError('db.integrity_check_failed', 'The database failed its startup integrity check.', {
        details: { result: check.slice(0, 500) },
      });
    }
    const row = this.#db.prepare('select 1 as ok').get() as { ok: number } | undefined;
    if (!row || row.ok !== 1) {
      throw new DatabaseError('db.query_failed', 'The database answered a probe query incorrectly.');
    }
  }

  /** Highest applied migration, or 0 when the schema has not been created yet. */
  schemaVersion(): number {
    if (!this.isOpen) return 0;
    try {
      const row = this.#db
        .prepare('select coalesce(max(version), 0) as version from schema_migrations')
        .get() as { version: number } | undefined;
      return row?.version ?? 0;
    } catch {
      // schema_migrations does not exist yet — an un-migrated database.
      return 0;
    }
  }

  /** Cheap liveness probe used by /api/health. Never returns internals. */
  healthCheck(): void {
    this.#assertOpen();
    try {
      const row = this.#db.prepare('select 1 as ok').get() as { ok: number } | undefined;
      if (!row || row.ok !== 1) throw new Error('unexpected probe result');
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw new DatabaseError('db.unhealthy', 'The database did not answer a probe query.', {
        exposure: 'safe',
        cause: error,
      });
    }
  }

  /** Checkpoint and close. Safe to call twice; never throws on shutdown. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (this.#db.open) {
        // Fold the WAL back into the main file so a copy of rhodes.db is complete.
        this.#db.pragma('wal_checkpoint(TRUNCATE)');
      }
    } catch (error) {
      logger.warn('database.checkpoint_failed', { reason: describeError(error).message });
    }
    try {
      if (this.#db.open) this.#db.close();
      logger.info('database.closed');
    } catch (error) {
      logger.error('database.close_failed', { reason: describeError(error).message });
    }
  }
}

/** Convenience wrapper for callers holding a ServerConfig. */
export function openDatabase(
  config: Pick<ServerConfig, 'dataDir' | 'databasePath' | 'busyTimeoutMs'>,
): RhodesDatabase {
  return RhodesDatabase.open({
    dataDir: config.dataDir,
    databasePath: config.databasePath,
    busyTimeoutMs: config.busyTimeoutMs,
  });
}
