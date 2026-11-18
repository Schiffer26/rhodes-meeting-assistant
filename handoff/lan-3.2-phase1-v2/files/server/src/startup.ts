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
import { openDatabase, type CloseResult, type RhodesDatabase } from './db/index.js';
import { MIGRATIONS_DIR, runMigrations } from './db/migrate.js';
import { describeError } from './errors.js';
import { logger } from './logger.js';
import { startServer, type StartedServer } from './server.js';
import { tlsServerOptions } from './tls.js';

/**
 * What actually happened during shutdown, stage by stage.
 *
 * `checkpointed` and `databaseClosed` are *factual* fields: they say what the checkpoint
 * achieved and whether the handle is gone, independently of each other and of `ok`. They
 * are not a success summary and must never be combined into one.
 *
 * `ok` is the verdict, and it is stricter than the two facts put together: it also
 * requires that the close itself reported `CloseResult.ok`, so a close that threw after
 * the handle closed — WAL folded, connection gone, error recorded — still fails the
 * shutdown. Nothing but `ok === true` may produce exit code 0.
 */
export interface ShutdownResult {
  listenerClosed: boolean;
  checkpointed: boolean;
  databaseClosed: boolean;
  ok: boolean;
}

export interface Runtime {
  readonly config: ServerConfig;
  readonly db: RhodesDatabase;
  readonly running: StartedServer;
  /**
   * Stop listening, then close the database — in that order, but the database is
   * closed even if the listener fails. Idempotent: repeated and concurrent calls all
   * receive the result of the one shutdown that actually ran.
   */
  shutdown(reason?: string): Promise<ShutdownResult>;
}

/**
 * Startup inputs.
 *
 * `createApp` and `startServer` default to the real implementations; they exist so tests
 * can fail a specific startup step and prove that the cleanup below runs. Production
 * never passes them.
 */
export interface StartRuntimeOptions {
  env?: EnvSource;
  createApp?: (deps: { db: RhodesDatabase }) => ReturnType<typeof createApp>;
  startServer?: typeof startServer;
}

export async function startRuntime(options: StartRuntimeOptions = {}): Promise<Runtime> {
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

  const buildApp = options.createApp ?? createApp;
  const bind = options.startServer ?? startServer;

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

  // The listener is tracked outside the boot sequence because cleanup has to know whether
  // one was ever opened: a failure after the bind must close it, a failure before it must
  // not pretend to.
  let listening: StartedServer | null = null;

  const boot = async (): Promise<StartedServer> => {
    // 3 · Migrations.
    const outcome = runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
    logger.info('migrations.complete', {
      applied: outcome.applied.length,
      skipped: outcome.skipped,
      currentVersion: outcome.currentVersion,
    });

    // 4 · Application and listener. The bind address and the TLS floor were decided
    // elsewhere; a failure here (including a failure inside createApp) unwinds below.
    const app = buildApp({ db });
    const started = await bind(app, {
      host: config.host,
      port: config.port,
      tls: config.tls === null ? null : tlsServerOptions(config.tls),
    });
    listening = started;

    // Anything that throws after this point is a *post-listening* failure: the socket is
    // already accepting connections, so the cleanup below must close it and the database.
    logger.info('service.listening', {
      url: started.url,
      protocol: started.protocol,
      schemaVersion: db.schemaVersion(),
    });

    return started;
  };

  /**
   * Undo a partial start: stop listening (if a listener exists), then close the database,
   * then rethrow the *original* error. Cleanup failures are logged, never substituted for
   * the cause — an operator needs to know why startup failed, not why the tidying failed.
   */
  const cleanupFailedStartup = async (cause: unknown): Promise<void> => {
    let listenerClosed: boolean | null = null;
    if (listening !== null) {
      try {
        listenerClosed = (await listening.close()).closed;
      } catch (error) {
        listenerClosed = false;
        logger.error('service.listener_close_failed', { reason: describeError(error).message });
      }
    }

    let databaseClosed = false;
    try {
      databaseClosed = db.close().closed;
    } catch (error) {
      logger.error('database.close_failed', { reason: describeError(error).message });
    }

    logger.warn('service.startup_cleanup', {
      reason: describeError(cause).message,
      listenerStarted: listening !== null,
      ...(listenerClosed === null ? {} : { listenerClosed }),
      databaseClosed,
    });
  };

  let running: StartedServer;
  try {
    running = await boot();
  } catch (error) {
    await cleanupFailedStartup(error);
    throw error;
  }

  // One shutdown, observed by every caller. The promise is cached rather than a boolean,
  // so a caller that arrives mid-shutdown waits for the real result instead of getting
  // an empty one.
  let shutdownPromise: Promise<ShutdownResult> | null = null;

  const runShutdown = async (reason: string): Promise<ShutdownResult> => {
    logger.info('service.stopping', { reason });

    let listenerClosed = false;
    try {
      const outcome = await running.close();
      listenerClosed = outcome.closed;
      if (outcome.closed) {
        logger.info('service.listener_closed', {
          alreadyClosed: outcome.alreadyClosed,
          forcedSockets: outcome.forcedSockets,
        });
      } else {
        logger.error('service.listener_close_failed', {
          code: outcome.error?.code,
          reason: outcome.error?.message,
        });
      }
    } catch (error) {
      // `close()` is written not to throw, so this is a last line of defence: the
      // database must still be closed.
      logger.error('service.listener_close_failed', { reason: describeError(error).message });
    }

    // Closing the database checkpoints the WAL, so rhodes.db on disk is complete. It is
    // attempted unconditionally: a failed listener is not a reason to leave the database
    // open. The CloseResult carries what really happened.
    let databaseClosed = false;
    let checkpointed = false;
    // `CloseResult.ok` is the database's own verdict. It is strictly stronger than the two
    // facts above — a close that threw after the handle closed reports
    // `checkpointed: true, closed: true, ok: false` — so it is what the shutdown uses.
    let databaseOk = false;
    let databaseStage: CloseResult['stage'] | 'threw' = 'threw';
    let databaseError: CloseResult['error'];
    try {
      const closeResult = db.close();
      checkpointed = closeResult.checkpointed;
      databaseClosed = closeResult.closed;
      databaseOk = closeResult.ok;
      databaseStage = closeResult.stage;
      databaseError = closeResult.error;
    } catch (error) {
      logger.error('database.close_failed', { reason: describeError(error).message });
    }

    const result: ShutdownResult = {
      listenerClosed,
      checkpointed,
      databaseClosed,
      // Never `listenerClosed && checkpointed && databaseClosed`: that would call a close
      // with a recorded error a clean shutdown simply because the handle ended up closed.
      ok: listenerClosed && databaseOk,
    };

    if (!result.ok) {
      logger.warn('service.shutdown_incomplete', {
        ...result,
        databaseStage,
        ...(databaseError === undefined
          ? {}
          : { databaseError: { code: databaseError.code, message: databaseError.message } }),
      });
    }

    return result;
  };

  const shutdown = (reason = 'shutdown'): Promise<ShutdownResult> => {
    shutdownPromise ??= runShutdown(reason);
    return shutdownPromise;
  };

  return { config, db, running, shutdown };
}
