/**
 * Stale authorisation across an asynchronous key derivation (LAN-2.1).
 *
 * Creating an account, resetting a password and changing one's own password all await a
 * scrypt derivation. That await is a window in which the world can change: the acting
 * administrator can be demoted or disabled, a session can be revoked, or the target's
 * password can be reset by somebody else.
 *
 * Every test here uses the same mechanism, and it contains no sleeps: the route's key
 * derivation is injected, and the injected function performs the concurrent change
 * itself before returning the hash. The interleaving is therefore exact — the change
 * always happens *after* the middleware checked and *before* the transaction opens,
 * which is precisely the window under review.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { RhodesDatabase } from '../src/db/index.js';
import {
  changeOwnPassword,
  findByPublicId,
  generateTemporaryPassword,
  patchAccount,
  resetPasswordByAdministrator,
} from '../src/auth/accounts.js';
import { createSession, revokeAllSessions } from '../src/auth/sessions.js';
import { verifyPassword } from '../src/auth/password.js';
import {
  fastHash,
  errorCode,
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

interface Harness {
  readonly baseUrl: string;
  readonly db: RhodesDatabase;
}

/**
 * Run one scenario against a real HTTP stack whose password hashing is intercepted.
 *
 * `duringHash` runs inside the injected derivation, i.e. exactly between the middleware's
 * authorisation decision and the repository transaction.
 */
async function withInterceptedHash<T>(
  duringHash: (password: string, db: RhodesDatabase) => Promise<void> | void,
  body: (harness: Harness) => Promise<T>,
): Promise<T> {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const { running, baseUrl } = await startTestServer(db, {
      passwordHasher: async (password: string) => {
        await duringHash(password, db);
        // A real, valid hash for the same string the route asked about — just cheaper.
        return fastHash(password);
      },
    });
    try {
      return await body({ baseUrl, db });
    } finally {
      await running.close();
    }
  } finally {
    db.close();
    removeDir(dir);
  }
}

test('scenario 1: an administrator demoted during account creation creates nothing', async () => {
  await withInterceptedHash(
    async (_password, db) => {
      // A peer administrator demotes the caller while the route is hashing.
      const actor = db.handle.prepare("select id, public_id from user_accounts where username_normalized = 'peer'").get() as {
        id: number;
        public_id: string;
      };
      const caller = db.handle.prepare("select public_id from user_accounts where username_normalized = 'caller'").get() as {
        public_id: string;
      };
      patchAccount(db.handle, {
        publicId: caller.public_id,
        actorAccountId: actor.id,
        actorPublicId: actor.public_id,
        role: 'member',
      });
    },
    async ({ baseUrl, db }) => {
      const caller = await seedAccount(db, { username: 'caller', role: 'administrator' });
      await seedAccount(db, { username: 'peer', role: 'administrator' });

      const token = await loginOrThrow(baseUrl, 'caller');
      const response = await postJson<{ error?: { code: string } }>(
        baseUrl,
        '/api/admin/accounts',
        { username: 'should-not-exist', role: 'member' },
        token,
      );

      assert.equal(response.status, 403, 'the demotion wins: the stale role is not honoured');
      assert.equal(errorCode(response.body), 'auth.forbidden');

      const created = db.handle.prepare("select count(*) as n from user_accounts where username_normalized = 'should-not-exist'").get() as {
        n: number;
      };
      assert.equal(created.n, 0, 'no account may exist after the refusal');

      const callerRow = findByPublicId(db.handle, caller.public_id);
      assert.equal(callerRow?.role, 'member', 'the concurrent demotion itself did happen');
    },
  );
});

test('scenario 2: an administrator disabled during a password reset resets nothing', async () => {
  let callerId = 0;

  await withInterceptedHash(
    async (_password, db) => {
      const peer = db.handle.prepare("select id, public_id from user_accounts where username_normalized = 'peer'").get() as {
        id: number;
        public_id: string;
      };
      const caller = db.handle.prepare("select public_id from user_accounts where id = ?").get(callerId) as {
        public_id: string;
      };
      patchAccount(db.handle, {
        publicId: caller.public_id,
        actorAccountId: peer.id,
        actorPublicId: peer.public_id,
        status: 'disabled',
      });
    },
    async ({ baseUrl, db }) => {
      const caller = await seedAccount(db, { username: 'caller', role: 'administrator' });
      await seedAccount(db, { username: 'peer', role: 'administrator' });
      const target = await seedAccount(db, { username: 'target', role: 'member' });
      callerId = caller.id;

      const token = await loginOrThrow(baseUrl, 'caller');
      const targetToken = await loginOrThrow(baseUrl, 'target');
      const hashBefore = findByPublicId(db.handle, target.public_id)?.password_hash;

      const response = await postJson<{ error?: { code: string } }>(
        baseUrl,
        `/api/admin/accounts/${target.public_id}/reset-password`,
        {},
        token,
      );

      assert.equal(response.status, 401, 'a disabled administrator cannot complete the reset');
      assert.equal(errorCode(response.body), 'auth.unauthenticated');

      const after = findByPublicId(db.handle, target.public_id);
      assert.equal(after?.password_hash, hashBefore, 'the target password is untouched');
      // The target's session survives, which it would not if the reset had committed.
      assert.equal((await getJson(baseUrl, '/api/auth/me', targetToken)).status, 200);
    },
  );
});

test('scenario 3: a session revoked during hashing cannot finish a password change', async () => {
  await withInterceptedHash(
    async (_password, db) => {
      const account = db.handle.prepare("select id from user_accounts where username_normalized = 'amara'").get() as { id: number };
      revokeAllSessions(db.handle, account.id, 'logout');
    },
    async ({ baseUrl, db }) => {
      const account = await seedAccount(db, { username: 'amara', role: 'member' });
      const token = await loginOrThrow(baseUrl, 'amara');

      const response = await postJson<{ error?: { code: string } }>(
        baseUrl,
        '/api/auth/change-password',
        { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD_2 },
        token,
      );

      assert.equal(response.status, 401, 'the revoked session is re-checked inside the transaction');
      assert.equal(errorCode(response.body), 'auth.unauthenticated');

      const after = findByPublicId(db.handle, account.public_id);
      assert.equal(after?.password_hash, account.password_hash, 'the password was not replaced');
      assert.equal(await verifyPassword(TEST_PASSWORD, after!.password_hash), true);
      assert.equal(await verifyPassword(TEST_PASSWORD_2, after!.password_hash), false);
    },
  );
});

test('scenario 4: a pending password change cannot overwrite an administrator reset', async () => {
  let temporaryPassword = '';

  await withInterceptedHash(
    async (_password, db) => {
      // While the user's change is hashing, an administrator resets the same account.
      const admin = db.handle.prepare("select id, public_id from user_accounts where username_normalized = 'boss'").get() as {
        id: number;
        public_id: string;
      };
      const target = db.handle.prepare("select public_id from user_accounts where username_normalized = 'amara'").get() as {
        public_id: string;
      };
      const adminSession = createSession(db.handle, admin.id);
      temporaryPassword = generateTemporaryPassword();
      resetPasswordByAdministrator(db.handle, {
        publicId: target.public_id,
        passwordHash: await fastHash(temporaryPassword),
        authorisingActor: { accountId: admin.id, sessionId: adminSession.sessionId, publicId: admin.public_id },
      });
    },
    async ({ baseUrl, db }) => {
      const account = await seedAccount(db, { username: 'amara', role: 'member' });
      await seedAccount(db, { username: 'boss', role: 'administrator' });
      const token = await loginOrThrow(baseUrl, 'amara');

      const response = await postJson<{ error?: { code: string } }>(
        baseUrl,
        '/api/auth/change-password',
        { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD_2 },
        token,
      );

      assert.equal(response.status, 409, 'the concurrent reset wins');
      assert.equal(errorCode(response.body), 'auth.password_changed_concurrently');

      const after = findByPublicId(db.handle, account.public_id);
      assert.equal(await verifyPassword(temporaryPassword, after!.password_hash), true, 'the reset survives');
      assert.equal(await verifyPassword(TEST_PASSWORD_2, after!.password_hash), false, 'the pending change did not overwrite it');
      assert.equal(await verifyPassword(TEST_PASSWORD, after!.password_hash), false);
      assert.equal(after?.must_change_password, 1, 'and the account must still change it');
    },
  );
});

test('scenario 5: normal creation, reset and password change still work through the same seam', async () => {
  await withInterceptedHash(
    () => {
      // No concurrent change this time.
    },
    async ({ baseUrl, db }) => {
      await seedAccount(db, { username: 'boss', role: 'administrator' });
      const bossToken = await loginOrThrow(baseUrl, 'boss');

      const created = await postJson<{ account: { publicId: string }; temporaryPassword: string }>(
        baseUrl,
        '/api/admin/accounts',
        { username: 'newcomer', role: 'member' },
        bossToken,
      );
      assert.equal(created.status, 201);
      assert.equal((await login(baseUrl, 'newcomer', created.body.temporaryPassword)).status, 200);

      const reset = await postJson<{ temporaryPassword: string }>(
        baseUrl,
        `/api/admin/accounts/${created.body.account.publicId}/reset-password`,
        {},
        bossToken,
      );
      assert.equal(reset.status, 200);

      const newcomerToken = await loginOrThrow(baseUrl, 'newcomer', reset.body.temporaryPassword);
      const changed = await postJson<{ changed: boolean }>(
        baseUrl,
        '/api/auth/change-password',
        { currentPassword: reset.body.temporaryPassword, newPassword: TEST_PASSWORD_2 },
        newcomerToken,
      );
      assert.equal(changed.status, 200);
      assert.equal((await login(baseUrl, 'newcomer', TEST_PASSWORD_2)).status, 200);

      const audit = db.handle.prepare('select action from audit_records').all() as { action: string }[];
      const actions = audit.map((row) => row.action);
      assert.ok(actions.includes('account.create'));
      assert.ok(actions.includes('account.password_reset'));
      assert.ok(actions.includes('account.password_change'));
    },
  );
});

test('the repository refuses a stale actor even when called directly', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const admin = await seedAccount(db, { username: 'boss', role: 'administrator' });
    await seedAccount(db, { username: 'peer', role: 'administrator' });
    const session = createSession(db.handle, admin.id);
    const actor = { accountId: admin.id, sessionId: session.sessionId, publicId: admin.public_id };

    // A live administrator session can create an account...
    const created = await (async () =>
      (await import('../src/auth/accounts.js')).createAccount(db.handle, {
        username: 'first',
        passwordHash: await fastHash(TEST_PASSWORD),
        role: 'member',
        mustChangePassword: false,
        actor: admin.public_id,
        authorisingActor: actor,
      }))();
    assert.equal(created.username, 'first');

    // ...but not with a session that has been revoked.
    revokeAllSessions(db.handle, admin.id, 'logout');
    await assert.rejects(
      () =>
        import('../src/auth/accounts.js').then(({ createAccount }) =>
          createAccount(db.handle, {
            username: 'second',
            passwordHash: 'scrypt$1$N=16384,r=8,p=1$c2FsdHNhbHQ$a2V5',
            role: 'member',
            mustChangePassword: false,
            actor: admin.public_id,
            authorisingActor: actor,
          }),
        ),
      (error: unknown) => (error as { code?: string }).code === 'auth.unauthenticated',
    );

    const count = db.handle.prepare('select count(*) as n from user_accounts').get() as { n: number };
    assert.equal(count.n, 3, 'two fixtures plus the one creation that succeeded');

    // And a direct password change for an unknown session is refused too.
    const account = findByPublicId(db.handle, admin.public_id)!;
    assert.throws(
      () =>
        changeOwnPassword(db.handle, {
          accountId: account.id,
          sessionId: 999_999,
          expectedPasswordHash: account.password_hash,
          newPasswordHash: 'scrypt$1$N=16384,r=8,p=1$c2FsdHNhbHQ$a2V5',
          actorPublicId: account.public_id,
        }),
      (error: unknown) => (error as { code?: string }).code === 'auth.unauthenticated',
    );
    assert.equal(findByPublicId(db.handle, admin.public_id)?.password_hash, account.password_hash);
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('a patch through the HTTP route also revalidates its actor', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const { running, baseUrl } = await startTestServer(db);
    try {
      await seedAccount(db, { username: 'boss', role: 'administrator' });
      const target = await seedAccount(db, { username: 'member-one', role: 'member' });
      const token = await loginOrThrow(baseUrl, 'boss');

      const ok = await patchJson(baseUrl, `/api/admin/accounts/${target.public_id}`, { status: 'disabled' }, token);
      assert.equal(ok.status, 200, 'a live administrator session may patch another account');

      // After a sign-out the same token is refused by the middleware; the transactional
      // recheck in the repository is the second line of defence (proven directly above).
      await postJson(baseUrl, '/api/auth/logout', {}, token);
      const afterLogout = await patchJson(baseUrl, `/api/admin/accounts/${target.public_id}`, { status: 'active' }, token);
      assert.equal(afterLogout.status, 401);
    } finally {
      await running.close();
    }
  } finally {
    db.close();
    removeDir(dir);
  }
});
