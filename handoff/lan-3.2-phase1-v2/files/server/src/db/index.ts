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
 * What `PRAGMA wal_checkpoint(TRUNCATE)` actually reported.
 *
 * `busy` is 1 when the checkpoint could not take the locks it needed; `log` is the
 * number of frames in the WAL and `checkpointed` how many of them reached the main
 * file. A checkpoint is complete only when nothing was busy and every frame was
 * copied — a truncation that silently leaves frames behind is exactly the case this
 * type exists to make visible.
 */
export interface CheckpointOutcome {
  busy: number;
  log: number;
  checkpointed: number;
}

/**
 * The outcome of closing the database.
 *
 * Closing the connection and folding the WAL back into `rhodes.db` are two separate
 * facts and are reported separately: a connection can close cleanly after an
 * incomplete checkpoint, and a checkpoint can succeed while the connection refuses to
 * close. `ok` is true only when both succeeded — never merely because `close()` ran.
 */
export interface CloseResult {
  checkpoint: CheckpointOutcome | null;
  checkpointed: boolean;
  closed: boolean;
  stage: 'not_open' | 'checkpoint' | 'close' | 'done';
  ok: boolean;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Read the row `PRAGMA wal_checkpoint` returns.
 *
 * better-sqlite3 hands back `[{ busy, log, checkpointed }]` for this pragma. Anything
 * else — a driver change, a stub, a pragma that returned nothing — is reported as
 * "no usable answer" rather than being coerced into a reassuring zero.
 */
function normaliseCheckpoint(row: unknown): CheckpointOutcome | null {
  const first = Array.isArray(row) ? row[0] : row;
  if (typeof first !== 'object' || first === null) return null;
  const record = first as Record<string, unknown>;
  const busy = Number(record.busy);
  const log = Number(record.log);
  const checkpointed = Number(record.checkpointed);
  if (!Number.isFinite(busy) || !Number.isFinite(log) || !Number.isFinite(checkpointed)) return null;
  return { busy, log, checkpointed };
}

/**
 * The most specific code available for a failure: an `AppError`'s stable code, else the
 * driver's own `code` (better-sqlite3 sets e.g. `SQLITE_BUSY`), else ours.
 */
function errorCode(error: unknown, fallback: string): string {
  if (error instanceof AppError) return error.code;
  const candidate = (error as { code?: unknown } | null)?.code;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : fallback;
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
  /** Cached so repeated calls return the same answer and log exactly once. */
  #closeResult: CloseResult | null = null;

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

  /**
   * TEST ONLY. Wrap a handle-like object so the failure paths of `close()` — a
   * checkpoint that throws, a connection that refuses to close — can be exercised.
   * Production code always goes through `open()`, which builds a real connection.
   */
  static forTesting(handle: Db, filePath = ':memory:'): RhodesDatabase {
    return new RhodesDatabase(handle, filePath);
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

  /**
   * Checkpoint the WAL and close the connection, reporting both outcomes.
   *
   * Order matters and is deliberate: the checkpoint is attempted first (so the file on
   * disk is complete for a backup), the connection is closed **regardless** of what the
   * checkpoint did (a stuck checkpoint must never keep the handle open), and the result
   * distinguishes the two facts. Never throws; safe to call any number of times, in
   * which case the first result is returned again without logging twice.
   *
   * What is *not* done here, on purpose: no `-wal` or `-shm` file is ever deleted. An
   * incomplete checkpoint leaves the WAL in place, and the next connection replays it
   * on open. Removing it would be data loss dressed up as tidiness.
   */
  close(): CloseResult {
    if (this.#closeResult !== null) return this.#closeResult;

    // Nothing was ever opened (or the handle is already gone): there is nothing to
    // checkpoint and nothing to close, and saying otherwise would be noise.
    if (!this.#db.open) {
      this.#closeResult = {
        checkpoint: null,
        checkpointed: true,
        closed: true,
        stage: 'not_open',
        ok: true,
      };
      return this.#closeResult;
    }

    this.#closed = true;

    let checkpoint: CheckpointOutcome | null = null;
    let checkpointed = false;
    let checkpointError: { code: string; message: string } | undefined;

    try {
      // Fold the WAL back into the main file so a copy of rhodes.db is complete.
      // The pragma returns a row; discarding it (as this code used to) makes a busy
      // checkpoint indistinguishable from a successful one.
      const row = this.#db.pragma('wal_checkpoint(TRUNCATE)') as unknown;
      checkpoint = normaliseCheckpoint(row);
      if (checkpoint === null) {
        throw new Error('wal_checkpoint returned an unexpected shape');
      }
      checkpointed = checkpoint.busy === 0 && checkpoint.checkpointed >= checkpoint.log;
      if (checkpointed) {
        logger.info('database.checkpointed', { ...checkpoint });
      } else {
        logger.warn('database.checkpoint_incomplete', { ...checkpoint });
      }
    } catch (error) {
      const described = describeError(error);
      checkpointError = {
        code: errorCode(error, 'db.checkpoint_failed'),
        message: described.message,
      };
      logger.warn('database.checkpoint_failed', { reason: described.message });
    }

    // The connection is closed even when the checkpoint failed: leaving it open would
    // hold the file, the WAL and the lock for no benefit.
    let closeError: { code: string; message: string } | undefined;
    try {
      this.#db.close();
    } catch (error) {
      const described = describeError(error);
      closeError = { code: errorCode(error, 'db.close_failed'), message: described.message };
    }

    // Ground truth, not intent: the driver's own view of whether the handle is open.
    const closed = !this.#db.open;

    if (closed) {
      // A successful connection close is reported even when the checkpoint was
      // incomplete — it is a real, separately useful fact. The `checkpointed` field
      // says what happened to the WAL.
      logger.info('database.closed', {
        checkpointed,
        ...(closeError === undefined ? {} : { warning: closeError.message }),
      });
    } else {
      logger.error('database.close_failed', {
        reason: closeError?.message ?? 'the connection is still open',
      });
    }

    const ok = checkpointed && closed && closeError === undefined;
    const stage: CloseResult['stage'] = !closed || closeError !== undefined
      ? 'close'
      : checkpointed
        ? 'done'
        : 'checkpoint';

    if (!ok) {
      logger.warn('database.close_incomplete', {
        stage,
        checkpointed,
        closed,
        ...(checkpoint === null ? {} : { ...checkpoint }),
      });
    }

    this.#closeResult = {
      checkpoint,
      checkpointed,
      closed,
      stage,
      ok,
      // The close failure is reported in preference to the checkpoint failure: both can
      // happen, and the one that leaves the handle open is the more consequential.
      ...(closeError ?? checkpointError ? { error: (closeError ?? checkpointError)! } : {}),
    };
    return this.#closeResult;
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
