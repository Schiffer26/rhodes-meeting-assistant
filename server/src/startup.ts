/**
 * RHODES API · ordered startup (phases LAN-1 … LAN-3.1)
 *
 * The whole process lifecycle lives here, as one exported function, so it can be driven
 * by `index.ts` in production and by a test with a synthetic environment. Startup is
 * strictly ordered and every step is allowed to fail without leaving a mess behind:
 *
 *   1. load + validate configuration, including TLS material   (nothing is created)
 *   2. open the database                                       (creates the directory)
 *   3. run migrations                                          (idempotent, transactional)
 *   4. bind the listener — HTTP or HTTPS, loopback only        (no socket until now)
 *
 * Step 1 reads both certificate and key, parses them and proves they belong together. A
 * bad transport therefore fails *before* the data directory exists, before the database
 * file is touched, before a migration can run and before any socket is opened — which is
 * the requirement of LAN-3.1 and the reason this ordering is not left implicit in
 * `index.ts`.
 *
 * If step 4 fails after the database is open, the database is closed on the way out, so a
 * failed start never leaves a lock or a half-written WAL behind. Shutdown reverses the
 * order: stop listening, finish in-flight requests, then close the database (which
 * checkpoints the WAL).
 */

import { createApp } from './app.js';
import { loadConfig, type EnvSource, type ServerConfig } from './config.js';
import { openDatabase, type RhodesDatabase } from './db/index.js';
import { MIGRATIONS_DIR, runMigrations } from './db/migrate.js';
import { describeError } from './errors.js';
import { logger } from './logger.js';
import { startServer, type StartedServer } from './server.js';
import { tlsServerOptions } from './tls.js';

export interface Runtime {
  readonly config: ServerConfig;
  readonly db: RhodesDatabase;
  readonly running: StartedServer;
  /** Stop listening, then close the database. Safe to call more than once. */
  shutdown(reason?: string): Promise<void>;
}

export async function startRuntime(options: { env?: EnvSource } = {}): Promise<Runtime> {
  // 1 · Configuration. A certificate problem is reported here, with the same weight as a
  // non-loopback host, and nothing has been created yet.
  const config = loadConfig(options.env ?? process.env);

  logger.info('service.starting', {
    nodeEnv: config.nodeEnv,
    host: config.host,
    port: config.port,
    transport: config.transport,
    // Public certificate attributes only: subject, validity window, fingerprint. The PEM
    // bodies and the private key never reach a log line.
    tls:
      config.tls === null
        ? undefined
        : {
            subject: config.tls.certificate.subject,
            validFrom: config.tls.certificate.validFrom,
            validTo: config.tls.certificate.validTo,
            fingerprint256: config.tls.certificate.fingerprint256,
          },
    databaseFile: config.databaseFile,
    busyTimeoutMs: config.busyTimeoutMs,
  });

  if (config.tls?.keyPermissionsLoose === true) {
    // Advisory, never fatal: Windows ACLs are the real control and are not visible here.
    logger.warn('tls.key_permissions_loose', {
      reason:
        'The TLS private-key file is readable by group or others. Restrict it to the service ' +
        'account (Windows: icacls <key> /inheritance:r /grant:r "<account>:R").',
    });
  }

  // 2 · Database. Only reached once the configuration, transport included, is valid.
  const db = openDatabase(config);

  // 3 · Migrations.
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

  // 4 · Listener. The bind address and the TLS floor were both decided elsewhere.
  const app = createApp({ db });

  let running: StartedServer;
  try {
    running = await startServer(app, {
      host: config.host,
      port: config.port,
      tls: config.tls === null ? null : tlsServerOptions(config.tls),
    });
  } catch (error) {
    db.close();
    throw error;
  }

  logger.info('service.listening', {
    url: running.url,
    protocol: running.protocol,
    schemaVersion: db.schemaVersion(),
  });

  let stopping = false;
  const shutdown = async (reason = 'shutdown'): Promise<void> => {
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
  };

  return { config, db, running, shutdown };
}
