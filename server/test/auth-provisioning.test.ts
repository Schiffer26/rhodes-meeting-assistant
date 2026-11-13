/**
 * Provisioning and recovery.
 *
 * There is no default account and no default password anywhere: the first administrator
 * is created by a local command on an empty database, and an administrator who is locked
 * out is recovered by a local command too. Both are protected by filesystem access to the
 * data directory rather than by a token.
 *
 * The CLI tests run the real command in a child process. They cannot test interactive
 * password entry — a sandbox has no terminal — so what they prove is the *refusal*: with
 * no TTY the command stops instead of falling back to a visible prompt, and it never
 * accepts a password as an argument. Interactive entry is recorded as not-run in the
 * completion report.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AppError } from '../src/errors.js';
import {
  bootstrapAdministrator,
  countAccounts,
  findByUsername,
  generateTemporaryPassword,
  recoverAdministratorPassword,
} from '../src/auth/accounts.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { validatePassword } from '../src/auth/policy.js';
import { createSession, SESSION_TTL_MS } from '../src/auth/sessions.js';
import { openMigrated, removeDir, tempDataDir } from './helpers.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/admin.ts', ...args], {
      cwd: serverRoot,
      env: { ...process.env, NODE_ENV: 'test', RHODES_PORT: '0', ...env },
      // A pipe, not a terminal: this is exactly the situation the command must refuse.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

test('bootstrap creates the first administrator on an empty database, and only then', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    assert.equal(countAccounts(db.handle), 0, 'a fresh database has no account');

    const password = 'the very first administrator passphrase';
    validatePassword(password);
    const created = bootstrapAdministrator(db.handle, {
      username: 'Founder',
      passwordHash: await hashPassword(password),
    });

    assert.equal(created.role, 'administrator');
    assert.equal(created.status, 'active');
    assert.equal(created.must_change_password, 0, 'the operator chose this password themselves');
    assert.equal(created.username, 'Founder');
    assert.equal(created.username_normalized, 'founder');
    assert.match(created.public_id, /^[0-9a-f]{32}$/);
    assert.equal(await verifyPassword(password, created.password_hash), true);

    const audit = db.handle
      .prepare("select actor, action, entity_key, detail from audit_records where action = 'account.bootstrap'")
      .get() as { actor: string; action: string; entity_key: string; detail: string };
    assert.equal(audit.actor, 'operator-cli');
    assert.equal(audit.entity_key, created.public_id);
    assert.ok(!audit.detail.includes(password), 'the audit trail never records the password');
    assert.ok(!audit.detail.includes('scrypt$'));

    // A second bootstrap is refused — there is exactly one way in, and it is now used.
    assert.throws(
      () =>
        bootstrapAdministrator(db.handle, {
          username: 'Second',
          passwordHash: created.password_hash,
        }),
      (error: unknown) => error instanceof AppError && error.code === 'admin.bootstrap_not_possible',
    );
    assert.equal(countAccounts(db.handle), 1);
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('bootstrap is refused once any account exists, member or administrator', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const { createAccount } = await import('../src/auth/accounts.js');
    createAccount(db.handle, {
      username: 'someone',
      passwordHash: 'scrypt$1$N=16384,r=8,p=1$c2FsdHNhbHQ$a2V5',
      role: 'member',
      mustChangePassword: false,
      actor: 'test',
    });

    assert.throws(
      () => bootstrapAdministrator(db.handle, { username: 'root', passwordHash: 'scrypt$1$x' }),
      (error: unknown) => error instanceof AppError && error.code === 'admin.bootstrap_not_possible',
    );
    const rows = db.handle.prepare('select username from user_accounts').all() as { username: string }[];
    assert.deepEqual(rows.map((row) => row.username), ['someone']);
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('recovery resets an administrator, revokes sessions and forces a change', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const admin = bootstrapAdministrator(db.handle, {
      username: 'founder',
      passwordHash: await hashPassword('the very first administrator passphrase'),
    });
    const { createAccount } = await import('../src/auth/accounts.js');
    createAccount(db.handle, {
      username: 'member-one',
      passwordHash: await hashPassword('a member passphrase long enough'),
      role: 'member',
      mustChangePassword: false,
      actor: 'test',
    });

    const session = createSession(db.handle, admin.id);
    assert.ok(session.token);

    const temporary = 'a recovery passphrase from the host';
    validatePassword(temporary);
    const recovered = recoverAdministratorPassword(db.handle, {
      username: 'FOUNDER',
      passwordHash: await hashPassword(temporary),
    });

    assert.equal(recovered.id, admin.id);
    assert.equal(recovered.must_change_password, 1, 'the recovered password must be replaced');
    assert.notEqual(recovered.password_hash, admin.password_hash);

    const sessions = db.handle
      .prepare("select revoked_at, revoked_reason from user_sessions where user_account_id = ?")
      .all(admin.id) as { revoked_at: string | null; revoked_reason: string | null }[];
    assert.equal(sessions.length, 1);
    assert.ok(sessions[0]?.revoked_at, 'every session of the account is revoked');
    assert.equal(sessions[0]?.revoked_reason, 'admin_recovery');

    const audit = db.handle
      .prepare("select actor, detail from audit_records where action = 'account.admin_recovery'")
      .get() as { actor: string; detail: string };
    assert.equal(audit.actor, 'operator-cli');
    assert.ok(!audit.detail.includes(temporary), 'the recovery password is never audited');

    // Members are not recoverable this way, and an unknown username is refused.
    assert.throws(
      () => recoverAdministratorPassword(db.handle, { username: 'member-one', passwordHash: 'scrypt$1$x' }),
      (error: unknown) => error instanceof AppError,
    );
    assert.throws(
      () => recoverAdministratorPassword(db.handle, { username: 'ghost', passwordHash: 'scrypt$1$x' }),
      (error: unknown) => error instanceof AppError && error.code === 'admin.account_not_found',
    );

    // The member's own password is untouched.
    const member = findByUsername(db.handle, 'member-one');
    assert.equal(await verifyPassword('a member passphrase long enough', member!.password_hash), true);
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('generated temporary passwords satisfy the policy and never repeat', () => {
  const seen = new Set<string>();
  for (let index = 0; index < 200; index += 1) {
    const temporary = generateTemporaryPassword();
    validatePassword(temporary); // throws if it is somehow below the floor
    assert.match(temporary, /^[A-Za-z0-9_-]+$/, 'url-safe characters only, so it can be read aloud or typed');
    assert.ok(temporary.length >= 15);
    assert.ok(!seen.has(temporary), 'each temporary password is unique');
    seen.add(temporary);
  }
  assert.equal(seen.size, 200);
});

test('the CLI explains itself without touching a database', async () => {
  const dir = tempDataDir();
  try {
    const result = await runCli(['--help'], { RHODES_DATA_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /server:admin:bootstrap/);
    assert.match(result.stdout, /server:admin:reset/);
    assert.match(result.stdout, /never accepted as arguments/);
    assert.equal(existsSync(path.join(dir, 'rhodes.db')), false, 'help must not create a database');
  } finally {
    removeDir(dir);
  }
});

test('the CLI refuses to collect a password without a terminal, instead of echoing it', async () => {
  const dir = tempDataDir();
  try {
    const result = await runCli(['bootstrap'], { RHODES_DATA_DIR: dir });

    assert.equal(result.code, 1, 'a non-interactive bootstrap must fail, not fall back');
    assert.match(result.stderr, /interactive terminal/i);
    assert.doesNotMatch(result.stdout, /Password \(not shown\)/, 'no password prompt is even printed');

    // The command migrated the database before giving up, and created no account.
    assert.equal(existsSync(path.join(dir, 'rhodes.db')), true);
    const { db } = openMigrated(dir);
    try {
      assert.equal(countAccounts(db.handle), 0, 'a refused bootstrap creates nothing');
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('the CLI refuses a password supplied as an argument', async () => {
  const dir = tempDataDir();
  try {
    const result = await runCli(['bootstrap', '--password=hunter2-hunter2-hunter2'], { RHODES_DATA_DIR: dir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cli.arguments_not_accepted/);
    assert.doesNotMatch(result.stdout, /hunter2/);
    assert.doesNotMatch(result.stderr, /hunter2/);
  } finally {
    removeDir(dir);
  }
});

test('the CLI refuses a second bootstrap on a database that already has an account', async () => {
  const dir = tempDataDir();
  try {
    const { db } = openMigrated(dir);
    try {
      bootstrapAdministrator(db.handle, {
        username: 'founder',
        passwordHash: await hashPassword('the very first administrator passphrase'),
      });
    } finally {
      db.close();
    }

    const result = await runCli(['bootstrap'], { RHODES_DATA_DIR: dir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /admin\.bootstrap_not_possible/);
    assert.doesNotMatch(result.stdout, /Password/, 'it refuses before prompting for anything');
  } finally {
    removeDir(dir);
  }
});

test('a session issued by the CLI-era database still has the documented lifetime', () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const account = db.handle
      .prepare(
        `insert into user_accounts (username, username_normalized, password_hash, role)
         values ('founder', 'founder', 'scrypt$1$N=16384,r=8,p=1$c2FsdHNhbHQ$a2V5', 'administrator')`,
      )
      .run();
    const now = new Date('2026-07-01T10:00:00.000Z');
    const session = createSession(db.handle, Number(account.lastInsertRowid), now);

    assert.equal(new Date(session.expiresAt).getTime() - now.getTime(), SESSION_TTL_MS);
    assert.equal(SESSION_TTL_MS, 8 * 60 * 60 * 1000);
    assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  } finally {
    db.close();
    removeDir(dir);
  }
});
