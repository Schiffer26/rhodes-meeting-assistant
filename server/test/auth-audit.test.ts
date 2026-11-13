/**
 * Required audit writes are transactional (LAN-2.1).
 *
 * A security state change that cannot be recorded is not a state change we are willing to
 * keep. Every test here breaks the audit table on purpose — a `BEFORE INSERT` trigger that
 * aborts — and then checks two things:
 *
 *   · the operation fails;
 *   · the database is exactly as it was before the attempt.
 *
 * The last test proves the other half of the distinction: events that stand on their own
 * (a sign-in, a sign-out) are best-effort, so a broken audit table does not lock people
 * out of the application. Losing an audit row is bad; refusing every login because of it
 * is worse.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { RhodesDatabase } from '../src/db/index.js';
import {
  bootstrapAdministrator,
  createAccount,
  findByPublicId,
  findByUsername,
  patchAccount,
  recoverAdministratorPassword,
} from '../src/auth/accounts.js';
import { verifyPassword } from '../src/auth/password.js';
import {
  errorCode,
  fastHash,
  getJson,
  login,
  loginOrThrow,
  patchJson,
  postJson,
  seedAccount,
  TEST_PASSWORD,
  TEST_PASSWORD_2,
} from './auth-helpers.js';
import { openMigrated, removeDir, startTestServer, tempDataDir } from './helpers.js';

/** Make every audit insert fail, as a disk error or a corrupted table would. */
function breakAuditWrites(db: RhodesDatabase): void {
  db.handle.exec(`
    create trigger test_block_audit_insert
    before insert on audit_records
    begin
      select raise(abort, 'audit storage unavailable (test)');
    end;
  `);
}

function restoreAuditWrites(db: RhodesDatabase): void {
  db.handle.exec('drop trigger test_block_audit_insert');
}

function auditCount(db: RhodesDatabase): number {
  const row = db.handle.prepare('select count(*) as n from audit_records').get() as { n: number };
  return row.n;
}

test('a failed audit write rolls back an account creation', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const { running, baseUrl } = await startTestServer(db);
    try {
      await seedAccount(db, { username: 'boss', role: 'administrator' });
      const token = await loginOrThrow(baseUrl, 'boss');
      const auditBefore = auditCount(db);

      breakAuditWrites(db);
      const refused = await postJson<{ error?: { code: string } }>(
        baseUrl,
        '/api/admin/accounts',
        { username: 'unlucky', role: 'member' },
        token,
      );

      assert.equal(refused.status, 500, 'the operation cannot succeed without its audit row');
      assert.equal(errorCode(refused.body), 'http.internal_error');
      assert.equal(findByUsername(db.handle, 'unlucky'), undefined, 'no account was created');
      assert.equal(auditCount(db), auditBefore);

      // The system recovers as soon as the audit table does.
      restoreAuditWrites(db);
      const accepted = await postJson(baseUrl, '/api/admin/accounts', { username: 'unlucky', role: 'member' }, token);
      assert.equal(accepted.status, 201);
      assert.ok(findByUsername(db.handle, 'unlucky'));
      assert.equal(auditCount(db), auditBefore + 1);
    } finally {
      await running.close();
    }
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('a failed audit write rolls back an account disable, including its session revocation', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const { running, baseUrl } = await startTestServer(db);
    try {
      await seedAccount(db, { username: 'boss', role: 'administrator' });
      const target = await seedAccount(db, { username: 'member-one', role: 'member' });
      const bossToken = await loginOrThrow(baseUrl, 'boss');
      const targetToken = await loginOrThrow(baseUrl, 'member-one');

      breakAuditWrites(db);
      const refused = await patchJson(baseUrl, `/api/admin/accounts/${target.public_id}`, { status: 'disabled' }, bossToken);
      assert.equal(refused.status, 500);

      restoreAuditWrites(db);

      // Nothing about the account moved: still active, still signed in.
      assert.equal(findByPublicId(db.handle, target.public_id)?.status, 'active');
      assert.equal(findByPublicId(db.handle, target.public_id)?.disabled_at, null);
      assert.equal((await getJson(baseUrl, '/api/auth/me', targetToken)).status, 200, 'the session was not revoked');
    } finally {
      await running.close();
    }
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('a failed audit write rolls back a role change', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const boss = await seedAccount(db, { username: 'boss', role: 'administrator' });
    const member = await seedAccount(db, { username: 'member-one', role: 'member' });
    const session = (await import('../src/auth/sessions.js')).createSession(db.handle, member.id);

    breakAuditWrites(db);
    assert.throws(() =>
      patchAccount(db.handle, {
        publicId: member.public_id,
        actorAccountId: boss.id,
        actorPublicId: boss.public_id,
        role: 'administrator',
      }),
    );
    restoreAuditWrites(db);

    assert.equal(findByPublicId(db.handle, member.public_id)?.role, 'member');
    // The role change would have revoked this session; because it rolled back, it lives.
    assert.equal(
      (await import('../src/auth/sessions.js')).isSessionLive(db.handle, session.sessionId, member.id),
      true,
      'the session revocation rolled back with the rest',
    );
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('a failed audit write rolls back a password change', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const { running, baseUrl } = await startTestServer(db);
    try {
      const account = await seedAccount(db, { username: 'member-one', role: 'member' });
      const token = await loginOrThrow(baseUrl, 'member-one');

      breakAuditWrites(db);
      const refused = await postJson(baseUrl, '/api/auth/change-password', {
        currentPassword: TEST_PASSWORD,
        newPassword: TEST_PASSWORD_2,
      }, token);
      assert.equal(refused.status, 500);
      restoreAuditWrites(db);

      const after = findByPublicId(db.handle, account.public_id);
      assert.equal(after?.password_hash, account.password_hash, 'the stored hash is unchanged');
      assert.equal(await verifyPassword(TEST_PASSWORD, after!.password_hash), true);
      assert.equal((await getJson(baseUrl, '/api/auth/me', token)).status, 200, 'and the session still works');
    } finally {
      await running.close();
    }
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('a failed audit write rolls back an administrator password reset', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const { running, baseUrl } = await startTestServer(db);
    try {
      await seedAccount(db, { username: 'boss', role: 'administrator' });
      const target = await seedAccount(db, { username: 'member-one', role: 'member' });
      const bossToken = await loginOrThrow(baseUrl, 'boss');
      const targetToken = await loginOrThrow(baseUrl, 'member-one');

      breakAuditWrites(db);
      const refused = await postJson(baseUrl, `/api/admin/accounts/${target.public_id}/reset-password`, {}, bossToken);
      assert.equal(refused.status, 500);
      restoreAuditWrites(db);

      const after = findByPublicId(db.handle, target.public_id);
      assert.equal(after?.password_hash, target.password_hash, 'the target password is untouched');
      assert.equal(after?.must_change_password, 0);
      assert.equal((await getJson(baseUrl, '/api/auth/me', targetToken)).status, 200, 'the target session survives');
    } finally {
      await running.close();
    }
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('a failed audit write rolls back bootstrap and local recovery', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const passwordHash = await fastHash(TEST_PASSWORD);

    breakAuditWrites(db);
    assert.throws(() => bootstrapAdministrator(db.handle, { username: 'founder', passwordHash }));
    restoreAuditWrites(db);
    assert.equal(findByUsername(db.handle, 'founder'), undefined, 'bootstrap rolled back');
    const empty = db.handle.prepare('select count(*) as n from user_accounts').get() as { n: number };
    assert.equal(empty.n, 0);

    // From here on the fixture exists, so recovery can be attempted on a real account.
    const admin = bootstrapAdministrator(db.handle, { username: 'founder', passwordHash });
    const before = findByPublicId(db.handle, admin.public_id)!.password_hash;

    const replacementHash = await fastHash(TEST_PASSWORD_2);

    breakAuditWrites(db);
    assert.throws(() =>
      recoverAdministratorPassword(db.handle, {
        username: 'founder',
        passwordHash: replacementHash,
      }),
    );
    restoreAuditWrites(db);

    const after = findByPublicId(db.handle, admin.public_id)!;
    assert.equal(after.password_hash, before, 'recovery rolled back');
    assert.equal(after.must_change_password, 0);
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('a failed audit write rolls back a direct repository creation', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    breakAuditWrites(db);
    assert.throws(() =>
      createAccount(db.handle, {
        username: 'direct',
        passwordHash: 'scrypt$1$N=16384,r=8,p=1$c2FsdHNhbHQ$a2V5',
        role: 'member',
        mustChangePassword: false,
        actor: 'test',
      }),
    );
    restoreAuditWrites(db);

    assert.equal(findByUsername(db.handle, 'direct'), undefined);
    assert.equal(auditCount(db), 0);
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('best-effort events are not blocked by a broken audit table', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const { running, baseUrl } = await startTestServer(db);
    try {
      await seedAccount(db, { username: 'member-one', role: 'member' });
      const token = await loginOrThrow(baseUrl, 'member-one');

      breakAuditWrites(db);

      // A sign-in and a sign-out are facts about a request, not claims about stored
      // state: they succeed, and the failure is logged instead.
      const signIn = await login(baseUrl, 'member-one', TEST_PASSWORD);
      assert.equal(signIn.status, 200, 'a broken audit table must not lock people out');
      assert.equal((await postJson(baseUrl, '/api/auth/logout', {}, signIn.token)).status, 200);
      assert.equal((await postJson(baseUrl, '/api/auth/logout', {}, token)).status, 200);

      restoreAuditWrites(db);

      // A failed *state change* is still refused, which is the distinction under test.
      const refused = await postJson(baseUrl, '/api/auth/change-password', {
        currentPassword: TEST_PASSWORD,
        newPassword: TEST_PASSWORD_2,
      }, token);
      assert.notEqual(refused.status, 200);
    } finally {
      await running.close();
    }
  } finally {
    db.close();
    removeDir(dir);
  }
});
