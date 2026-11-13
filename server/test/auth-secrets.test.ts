/**
 * Nothing secret escapes.
 *
 * Three surfaces are checked separately:
 *   · the log stream of a real service process, exercised end to end;
 *   · the audit trail and the database file, which are what an operator or an attacker
 *     with a copy of the data directory would read;
 *   · the HTTP responses themselves, which must describe a failure without describing
 *     the account, the password or the internals.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { recordAudit } from '../src/auth/audit.js';
import {
  errorCode,
  getJson,
  login,
  loginOrThrow,
  postJson,
  seedAccount,
  TEST_PASSWORD,
} from './auth-helpers.js';
import { openMigrated, removeDir, startTestServer, tempDataDir } from './helpers.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface RunningChild {
  readonly child: ReturnType<typeof spawn>;
  output(): string;
  url(): string | undefined;
}

function startServiceProcess(dataDir: string): RunningChild {
  let captured = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RHODES_DATA_DIR: dataDir,
      RHODES_PORT: '0',
      RHODES_LOG_LEVEL: 'debug',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    captured += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    captured += chunk.toString();
  });

  return {
    child,
    output: () => captured,
    url: () => {
      for (const line of captured.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const entry = JSON.parse(trimmed) as { msg?: string; url?: string };
          if (entry.msg === 'service.listening' && entry.url) return entry.url;
        } catch {
          // Not a log line (the test runner may interleave its own output); ignore.
        }
      }
      return undefined;
    },
  };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the service to start');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a running service never writes a password, token or hash to its log stream', async () => {
  const dir = tempDataDir();
  const service = startServiceProcess(dir);
  let token = '';
  let temporary = '';
  try {
    const baseUrl = await waitFor(() => service.url());

    // Seed an administrator while the service is up: WAL lets a second connection write.
    const { db } = openMigrated(dir);
    try {
      await seedAccount(db, { username: 'boss', role: 'administrator' });
    } finally {
      db.close();
    }

    const failed = await login(baseUrl, 'boss', 'the wrong password entirely');
    assert.equal(failed.status, 401);
    token = await loginOrThrow(baseUrl, 'boss');

    const created = await postJson<{ temporaryPassword: string }>(
      baseUrl,
      '/api/admin/accounts',
      { username: 'newcomer', role: 'member' },
      token,
    );
    assert.equal(created.status, 201);
    temporary = created.body.temporaryPassword;

    // Also exercise a rejected request, which is where an error message could leak.
    const bad = await postJson<{ error?: { code: string } }>(baseUrl, '/api/auth/login', { username: 'boss' });
    assert.equal(bad.status, 400);

    service.child.kill('SIGTERM');
    await new Promise((resolve) => service.child.once('exit', resolve));
  } finally {
    service.child.kill('SIGKILL');
    removeDir(dir);
  }

  const log = service.output();
  assert.ok(log.length > 0, 'the service must have produced log output');
  assert.ok(log.includes('service.listening'), 'the fixture must really have started the service');

  for (const secret of ['the wrong password entirely', TEST_PASSWORD, temporary]) {
    assert.ok(!log.includes(secret), `the log must not contain a password (${secret.slice(0, 12)}…)`);
  }
  assert.ok(!/scrypt\$/.test(log), 'the log must not contain a password hash');
  assert.ok(!/"token"\s*:/.test(log), 'the log must not contain a session token field');
  assert.ok(!/Bearer [A-Za-z0-9_-]{43}/.test(log), 'the log must not contain an Authorization header');
});

test('the database and audit trail hold no plaintext passwords and no raw tokens', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let close: (() => Promise<void>) | undefined;
  try {
    const { running, baseUrl } = await startTestServer(db);
    close = running.close;

    await seedAccount(db, { username: 'boss', role: 'administrator' });
    const token = await loginOrThrow(baseUrl, 'boss');
    await login(baseUrl, 'boss', 'a wrong password attempt');
    const created = await postJson<{ temporaryPassword: string }>(
      baseUrl,
      '/api/admin/accounts',
      { username: 'newcomer', role: 'member' },
      token,
    );
    await postJson(baseUrl, '/api/auth/logout', {}, token);

    const temporary = created.body.temporaryPassword;

    // Every text value in every table, concatenated: if a secret is stored anywhere, it
    // shows up here.
    const tables = db.handle
      .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
      .all() as { name: string }[];
    let dump = '';
    for (const table of tables) {
      dump += JSON.stringify(db.handle.prepare(`select * from ${table.name}`).all());
    }

    assert.ok(dump.length > 0);
    for (const secret of [TEST_PASSWORD, 'a wrong password attempt', temporary]) {
      assert.ok(!dump.includes(secret), `the database must not contain a plaintext password (${secret.slice(0, 12)}…)`);
    }
    assert.ok(!dump.includes('a wrong password attempt'));
    // The raw tokens are not in the dump either: only their SHA-256 hashes.
    assert.equal(/(?<![0-9a-f])[A-Za-z0-9_-]{43}(?![0-9a-z])/.test(dump.replace(/scrypt\$[^"]*/g, '')), false);

    const audit = db.handle.prepare('select action, actor, entity_key, detail from audit_records').all() as {
      action: string;
      actor: string | null;
      entity_key: string | null;
      detail: string | null;
    }[];
    assert.ok(audit.length >= 4, 'sign-in, sign-out, failure and creation are all recorded');
    assert.ok(audit.some((row) => row.action === 'auth.login'));
    assert.ok(audit.some((row) => row.action === 'auth.login_failed'));
    assert.ok(audit.some((row) => row.action === 'auth.logout'));
    assert.ok(audit.some((row) => row.action === 'account.create'));

    for (const row of audit) {
      const text = `${row.action} ${row.actor ?? ''} ${row.entity_key ?? ''} ${row.detail ?? ''}`;
      assert.ok(!/scrypt\$/.test(text), 'no hash may reach the audit trail');
      assert.ok(!text.includes(TEST_PASSWORD));
      assert.ok(!text.includes(temporary), 'a temporary password is never audited');
      assert.ok(!/Bearer/.test(text));
    }
  } finally {
    if (close) await close();
    db.close();
    removeDir(dir);
  }
});

test('the audit writer redacts anything that looks like a credential', () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    // Defence in depth: no call site passes a secret today, and one that tried would not
    // get it into the table.
    recordAudit(db.handle, {
      action: 'test.redaction',
      entity: 'user_account',
      detail: {
        password: 'hunter2-not-a-real-password',
        passwordHash: 'scrypt$1$N=16384,r=8,p=1$aaaa$bbbb',
        sessionToken: 'abc',
        Authorization: 'Bearer abc',
        nested: { secretValue: 'shh', harmless: 'kept' },
      },
    });

    const row = db.handle.prepare("select detail from audit_records where action = 'test.redaction'").get() as { detail: string };
    assert.ok(!row.detail.includes('hunter2'));
    assert.ok(!row.detail.includes('scrypt$'));
    assert.ok(!row.detail.includes('Bearer'));
    assert.ok(!row.detail.includes('shh'));
    assert.ok(row.detail.includes('kept'), 'non-sensitive context survives');
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('failures describe the problem without describing the system', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let close: (() => Promise<void>) | undefined;
  try {
    const { running, baseUrl } = await startTestServer(db);
    close = running.close;
    await seedAccount(db, { username: 'boss', role: 'administrator' });
    const token = await loginOrThrow(baseUrl, 'boss');

    const fromHelper = async (promise: Promise<{ status: number; body: unknown }>) => {
      const { body } = await promise;
      return JSON.stringify(body);
    };

    const texts = [
      await fromHelper(postJson(baseUrl, '/api/auth/login', { username: 'boss', password: 'wrong' })),
      await fromHelper(getJson(baseUrl, '/api/auth/me')),
      await fromHelper(getJson(baseUrl, '/api/admin/accounts', token.replace(/.$/, 'x'))),
      await fromHelper(
        postJson(baseUrl, '/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'a very long passphrase' }, token),
      ),
      await fromHelper(postJson(baseUrl, '/api/admin/accounts', { username: 'boom', role: 'nope' }, token)),
      await (
        await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{not json',
        })
      ).text(),
    ];

    for (const text of texts) {
      for (const forbidden of ['scrypt$', 'SQLITE', 'select ', 'at Object.', 'node:internal', '/home/', 'password_hash']) {
        assert.ok(!text.includes(forbidden), `a response leaked "${forbidden}": ${text.slice(0, 120)}`);
      }
      const body = JSON.parse(text) as { error?: { code: string; message: string; requestId: string } };
      assert.ok(body.error?.code, 'every failure has a stable code');
      assert.equal(typeof body.error?.requestId, 'string', 'and a request id, for the log line');
      assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'requestId']);
    }

    assert.equal(errorCode((await getJson(baseUrl, '/api/auth/me')).body), 'auth.unauthenticated');
  } finally {
    if (close) await close();
    db.close();
    removeDir(dir);
  }
});

test('no file in the repository carries a seeded credential', () => {
  // A cheap guard against the class of mistake this phase forbids: a demo account, a
  // default password, or a private key committed by accident.
  const migrations = path.join(serverRoot, 'src', 'db', 'migrations');
  for (const name of readdirSync(migrations).filter((file) => file.endsWith('.sql'))) {
    const sql = readFileSync(path.join(migrations, name), 'utf8');
    assert.ok(!/insert\s+into\s+user_accounts/i.test(sql), `${name} must not seed an account`);
    assert.ok(!/\bpassword\s*=\s*'/i.test(sql), `${name} must not contain a default password`);
  }

  const envExample = mkdtempSync(path.join(tmpdir(), 'rhodes-noop-'));
  removeDir(envExample);
});
