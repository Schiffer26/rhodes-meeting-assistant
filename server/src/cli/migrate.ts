/**
 * RHODES API · maintenance CLI
 *
 *   node dist/cli/migrate.js            apply pending migrations
 *   node dist/cli/migrate.js --status   report applied migrations, change nothing
 *
 * Prints JSON on stdout so it can be scripted or tucked into an installer later.
 * The data directory is created if missing, exactly as the service does.
 */

import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';
import { MIGRATIONS_DIR, runMigrations } from '../db/migrate.js';
import { AppError, describeError } from '../errors.js';
import { logger } from '../logger.js';

interface AppliedRow {
  version: number;
  name: string;
  applied_at: string;
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const statusOnly = args.includes('--status');

  if (args.length > 0 && !statusOnly) {
    throw new AppError('cli.unknown_argument', `Unknown argument: ${args.join(' ')}`, {
      httpStatus: 1,
      exposure: 'safe',
    });
  }

  const config = loadConfig();
  const db = openDatabase(config);

  try {
    if (statusOnly) {
      const applied = db.handle
        .prepare('select version, name, applied_at from schema_migrations order by version')
        .all() as AppliedRow[];
      print({
        ok: true,
        database: config.databasePath,
        currentVersion: db.schemaVersion(),
        applied,
      });
      return;
    }

    const outcome = runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
    print({
      ok: true,
      database: config.databasePath,
      migrationDirectory: MIGRATIONS_DIR,
      totalFiles: outcome.totalFiles,
      applied: outcome.applied,
      skipped: outcome.skipped,
      currentVersion: outcome.currentVersion,
    });
  } finally {
    db.close();
  }
}

try {
  main();
  process.exitCode = 0;
} catch (error) {
  const described = describeError(error);
  logger.error('cli.failed', {
    code: described.code ?? 'cli.failed',
    message: described.message,
    details: error instanceof AppError ? error.details : undefined,
  });
  process.exitCode = 1;
}
