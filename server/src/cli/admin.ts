/**
 * RHODES API · administrator provisioning and recovery
 *
 *   npm run server:admin:bootstrap   create the first administrator (empty database only)
 *   npm run server:admin:reset       reset an administrator's password from the host
 *
 * Both are local-only operations. There is no HTTP route that can create the first
 * account, no default account, and no default password: authorisation here is filesystem
 * access to the data directory, which the person running the command already has.
 *
 * Rules enforced below:
 *   · no password is ever accepted from the command line, the environment or a file;
 *   · the password prompt hides input, and refuses to run when it cannot;
 *   · nothing secret is printed, logged or audited;
 *   · each operation runs in one transaction, so a failure leaves no half-created account.
 *
 * Exit codes: 0 success, 1 failure (including a refused prompt).
 */

import { loadConfig } from '../config.js';
import { openDatabase, type Db } from '../db/index.js';
import { MIGRATIONS_DIR, runMigrations } from '../db/migrate.js';
import { AppError, describeError } from '../errors.js';
import { logger } from '../logger.js';
import {
  bootstrapAdministrator,
  countAccounts,
  findByUsername,
  recoverAdministratorPassword,
} from '../auth/accounts.js';
import { hashPassword } from '../auth/password.js';
import { normalizeUsername, validatePassword, validateUsername } from '../auth/policy.js';
import { purgeExpiredSessions } from '../auth/sessions.js';
import { askSecretConfirmed, askVisible } from './prompt.js';

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

function usage(): void {
  say('RHODES administrator commands');
  say('');
  say('  npm run server:admin:bootstrap   create the first administrator account');
  say('  npm run server:admin:reset       set a new password for an administrator');
  say('');
  say('Passwords are typed at a hidden prompt. They are never accepted as arguments.');
}

async function bootstrap(db: Db): Promise<void> {
  const existing = countAccounts(db);
  if (existing > 0) {
    throw new AppError(
      'admin.bootstrap_not_possible',
      'This database already has an account, so bootstrap will not run. Use "npm run server:admin:reset" to recover an administrator, or create further accounts from the application as an administrator.',
      { httpStatus: 1, exposure: 'safe' },
    );
  }

  say('No accounts exist yet. Creating the first administrator.');
  const username = validateUsername(await askVisible('Administrator username: '));
  const password = await askSecretConfirmed('Password (not shown): ');
  validatePassword(password);

  const passwordHash = await hashPassword(password);
  const account = bootstrapAdministrator(db, { username, passwordHash });
  purgeExpiredSessions(db);

  say('');
  say(`Administrator "${account.username}" created.`);
  say('Store the password somewhere safe; it cannot be recovered, only reset.');
}

async function reset(db: Db): Promise<void> {
  const usernameInput = await askVisible('Administrator username to reset: ');
  const normalized = normalizeUsername(usernameInput);
  const account = findByUsername(db, normalized);

  if (!account) {
    throw new AppError('admin.account_not_found', 'No account has that username.', {
      httpStatus: 1,
      exposure: 'safe',
    });
  }
  if (account.role !== 'administrator') {
    throw new AppError(
      'admin.recovery_target_not_administrator',
      'That account is not an administrator. An administrator can reset a member password from the application.',
      { httpStatus: 1, exposure: 'safe' },
    );
  }

  const password = await askSecretConfirmed('New password (not shown): ');
  validatePassword(password);

  const passwordHash = await hashPassword(password);
  const updated = recoverAdministratorPassword(db, { username: account.username, passwordHash });

  say('');
  say(`Password reset for "${updated.username}".`);
  say('Every existing session for that account has been signed out.');
  say('The account must choose a new password the next time it signs in.');
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    usage();
    return;
  }
  if (command !== 'bootstrap' && command !== 'reset') {
    throw new AppError('cli.unknown_argument', `Unknown command: ${command}`, { httpStatus: 1, exposure: 'safe' });
  }
  if (process.argv.length > 3) {
    // In particular: never read a password from argv. Refuse loudly rather than ignore.
    throw new AppError(
      'cli.arguments_not_accepted',
      'This command takes no arguments. Passwords are entered at a hidden prompt and are never accepted on the command line.',
      { httpStatus: 1, exposure: 'safe' },
    );
  }

  const config = loadConfig();
  logger.info('cli.admin.starting', { command, databaseFile: config.databaseFile });

  const db = openDatabase(config);
  try {
    // A fresh install may not have been migrated yet; bootstrap should not require a
    // separate step.
    const outcome = runMigrations(db.handle, { migrationsDir: MIGRATIONS_DIR });
    if (outcome.applied.length > 0) {
      logger.info('cli.admin.migrations_applied', { applied: outcome.applied.map((entry) => entry.version) });
    }

    if (command === 'bootstrap') await bootstrap(db.handle);
    else await reset(db.handle);

    logger.info('cli.admin.completed', { command });
  } finally {
    db.close();
  }
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  const described = describeError(error);
  // Prompt failures carry their own code; anything else falls back to `cli.failed`.
  const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'cli.failed';
  // Deliberately no `details`: this path can be reached while a password is in scope.
  logger.error('cli.failed', { code, message: described.message });
  process.exitCode = 1;
}
