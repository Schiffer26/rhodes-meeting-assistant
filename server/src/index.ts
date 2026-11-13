/**
 * RHODES API · process entry point
 *
 * Startup is strictly ordered, and every step can fail without leaving a mess:
 *
 *   1. load + validate configuration   (no data directory is touched)
 *   2. open the database               (creates the directory, checks the file)
 *   3. run migrations                  (idempotent, transactional)
 *   4. bind the HTTP listener          (loopback only)
 *
 * If step 1, 2 or 3 fails the process exits non-zero and nothing listens. If step 4
 * fails, the database is closed on the way out.
 */

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { MIGRATIONS_DIR, runMigrations } from './db/migrate.js';
import { AppError, describeError } from './errors.js';
import { logger } from './logger.js';
import { startServer, type StartedServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  logger.info('service.starting', {
    nodeEnv: config.nodeEnv,
    host: config.host,
    port: config.port,
    databaseFile: config.databaseFile,
    busyTimeoutMs: config.busyTimeoutMs,
  });

  const db = openDatabase(config);

  try {
    const outcome = runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
    logger.info('migrations.complete', {
      applied: outcome.applied.length,
      skipped: outcome.skipped,
      currentVersion: outcome.currentVersion,
    });
  } catch (error) {
    db.close();
    throw error;
  }

  const app = createApp({ db });

  let running: StartedServer;
  try {
    running = await startServer(app, { host: config.host, port: config.port });
  } catch (error) {
    db.close();
    throw error;
  }

  logger.info('service.listening', { url: running.url, schemaVersion: db.schemaVersion() });

  let stopping = false;
  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('service.stopping', { reason });
    try {
      await running.close();
    } catch (error) {
      logger.warn('service.close_failed', { reason: describeError(error).message });
    }
    // Closing the database checkpoints the WAL, so rhodes.db on disk is complete.
    db.close();
    process.exit(exitCode);
  };

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('uncaughtException', (error) => {
    logger.error('service.uncaught_exception', { name: error.name, message: error.message });
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('service.unhandled_rejection', { reason: describeError(reason).message });
    void shutdown('unhandledRejection', 1);
  });
}

main().catch((error: unknown) => {
  const described = describeError(error);
  // Config and migration failures are written for an operator and are safe to print.
  logger.error('service.startup_failed', {
    code: described.code ?? 'startup.unknown',
    name: described.name,
    message: described.message,
    details: error instanceof AppError ? error.details : undefined,
  });
  process.exitCode = 1;
});
