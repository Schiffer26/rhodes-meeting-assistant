/**
 * Authorisation, and the account-administration surface.
 *
 * The rules under test:
 *   · 401 means "we do not know who you are"; 403 means "we do, and not for this";
 *   · the role is read from the account row on every request, never from the token or
 *     anything the client sends;
 *   · changing a role or disabling an account takes effect on the very next request;
 *   · an administrator cannot lock themselves out — no self-disable, no self-demotion,
 *     no self-reset — and the last active administrator cannot be removed at all;
 *   · temporary passwords come back exactly once, are never stored, and force a change.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '../src/errors.js';
import { countActiveAdministrators, findByPublicId, patchAccount } from '../src/auth/accounts.js';
import {
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

function withServer<T>(run: (context: { baseUrl: string; db: ReturnType<typeof openMigrated>['db'] }) => Promise<T>): Promise<T> {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  return (async () => {
    let close: (() => Promise<void>) | undefined;
    try {
      const { running, baseUrl } = await startTestServer(db);
      close = running.close;
      return await run({ baseUrl, db });
    } finally {
      if (close) await close();
      db.close();
      removeDir(dir);
    }
  })();
}

test('health stays public, and the administrator surface is closed without a session', async () => {
  await withServer(async ({ baseUrl }) => {
    assert.equal((await getJson(baseUrl, '/api/health')).status, 200);

    for (const path of ['/api/admin/accounts']) {
      const response = await getJson<{ error?: { code: string } }>(baseUrl, path);
      assert.equal(response.status, 401, `${path} must require a session`);
      assert.equal(errorCode(response.body), 'auth.unauthenticated');
    }

    const patch = await patchJson(baseUrl, '/api/admin/accounts/whatever', { role: 'member' });
    assert.equal(patch.status, 401, 'an unauthenticated request cannot reach a mutation');
  });
});

test('a member is refused with 403, and the refusal reveals nothing', async () => {
  await withServer(async ({ baseUrl, db }) => {
    await seedAccount(db, { username: 'member-one', role: 'member' });
    const token = await loginOrThrow(baseUrl, 'member-one');

    const list = await getJson<{ error?: { code: string; message: string } }>(baseUrl, '/api/admin/accounts', token);
    assert.equal(list.status, 403);
    assert.equal(errorCode(list.body), 'auth.forbidden');
    assert.doesNotMatch(list.body.error?.message ?? '', /administrator|role|member/i, 'the message must not describe the rule');

    const create = await postJson(baseUrl, '/api/admin/accounts', { username: 'sneaky', role: 'administrator' }, token);
    assert.equal(create.status, 403);

    const selfPromotion = await patchJson(baseUrl, '/api/admin/accounts/anything', { role: 'administrator' }, token);
    assert.equal(selfPromotion.status, 403, 'a member cannot promote anyone, including themselves');
  });
});

test('an administrator can create an account; the temporary password appears once', async () => {
  await withServer(async ({ baseUrl, db }) => {
    await seedAccount(db, { username: 'boss', role: 'administrator' });
    const adminToken = await loginOrThrow(baseUrl, 'boss');

    const created = await postJson<{
      account: Record<string, unknown>;
      temporaryPassword: string;
      mustChangePassword: boolean;
    }>(baseUrl, '/api/admin/accounts', { username: 'New.Person', role: 'member' }, adminToken);

    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const { account, temporaryPassword } = created.body;
    assert.equal(account.username, 'New.Person');
    assert.equal(account.role, 'member');
    assert.equal(account.status, 'active');
    assert.equal(account.mustChangePassword, true);
    assert.equal(created.body.mustChangePassword, true);
    assert.ok(temporaryPassword.length >= 15, 'a temporary password must satisfy the same length policy');
    assert.match(account.publicId as string, /^[0-9a-f]{32}$/, 'a public id is opaque, not the row id');

    // No hash, no row id, no password anywhere in the response.
    const serialised = JSON.stringify(created.body);
    assert.ok(!serialised.includes('scrypt$'));
    assert.ok(!/password_hash|passwordHash/.test(serialised));
    assert.equal(serialised.includes('"id"'), false);

    // Listing shows the account but never the hash.
    const list = await getJson<{ accounts: Record<string, unknown>[] }>(baseUrl, '/api/admin/accounts', adminToken);
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    assert.equal(list.body.accounts.length, 2);
    assert.ok(!JSON.stringify(list.body).includes('scrypt$'));
    assert.ok(list.body.accounts.every((entry) => !('passwordHash' in entry)));

    // The new account can sign in with the temporary password, and must change it.
    const signIn = await login(baseUrl, 'new.person', temporaryPassword);
    assert.equal(signIn.status, 200, 'usernames are case-insensitive at sign-in');
    assert.equal(signIn.mustChangePassword, true);
    assert.equal((await getJson(baseUrl, '/api/admin/accounts', signIn.token)).status, 403);

    const changed = await postJson(baseUrl, '/api/auth/change-password', {
      currentPassword: temporaryPassword,
      newPassword: TEST_PASSWORD_2,
    }, signIn.token);
    assert.equal(changed.status, 200);

    // The temporary password is dead the moment it has been replaced.
    assert.equal((await login(baseUrl, 'new.person', temporaryPassword)).status, 401);
    assert.equal((await login(baseUrl, 'new.person', TEST_PASSWORD_2)).status, 200);
  });
});

test('account creation validates its input and refuses duplicates by normalised name', async () => {
  await withServer(async ({ baseUrl, db }) => {
    await seedAccount(db, { username: 'boss', role: 'administrator' });
    await seedAccount(db, { username: 'Existing', role: 'member' });
    const adminToken = await loginOrThrow(baseUrl, 'boss');

    const cases: Array<{ body: unknown; status: number; code: string }> = [
      { body: { username: 'ok-name', role: 'owner' }, status: 400, code: 'auth.invalid_request' },
      { body: { username: 'ok-name' }, status: 400, code: 'auth.invalid_request' },
      { body: { username: 'a'.repeat(65), role: 'member' }, status: 400, code: 'auth.invalid_username' },
      { body: { username: 'bad name!', role: 'member' }, status: 400, code: 'auth.invalid_username' },
      { body: { username: 'existing', role: 'member' }, status: 409, code: 'admin.username_taken' },
      { body: { username: 'EXISTING', role: 'member' }, status: 409, code: 'admin.username_taken' },
      { body: { username: 'linked', role: 'member', personnelPublicId: 'no-such-person' }, status: 400, code: 'admin.invalid_personnel' },
    ];

    for (const scenario of cases) {
      const response = await postJson<{ error?: { code: string } }>(baseUrl, '/api/admin/accounts', scenario.body, adminToken);
      assert.equal(response.status, scenario.status, `body ${JSON.stringify(scenario.body)}`);
      assert.equal(errorCode(response.body), scenario.code);
    }

    // Only the two fixtures exist: every rejection above created nothing.
    const rows = db.handle.prepare('select count(*) as n from user_accounts').get() as { n: number };
    assert.equal(rows.n, 2);
  });
});

test('promotion and demotion apply immediately, and revoke the affected sessions', async () => {
  await withServer(async ({ baseUrl, db }) => {
    const admin = await seedAccount(db, { username: 'boss', role: 'administrator' });
    const member = await seedAccount(db, { username: 'worker', role: 'member' });
    const adminToken = await loginOrThrow(baseUrl, 'boss');
    const workerToken = await loginOrThrow(baseUrl, 'worker');

    assert.equal((await getJson(baseUrl, '/api/admin/accounts', workerToken)).status, 403);

    const promoted = await patchJson<{ account: { role: string }; sessionsRevoked: number }>(
      baseUrl,
      `/api/admin/accounts/${member.public_id}`,
      { role: 'administrator' },
      adminToken,
    );
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.account.role, 'administrator');
    assert.equal(promoted.body.sessionsRevoked, 1, 'the old session is revoked by the role change');

    // The old token is dead rather than merely downgraded: role changes revoke.
    assert.equal((await getJson(baseUrl, '/api/admin/accounts', workerToken)).status, 401);

    // A fresh sign-in carries the new role, which the server read from the database.
    const promotedToken = await loginOrThrow(baseUrl, 'worker');
    const asAdmin = await getJson<{ accounts: unknown[] }>(baseUrl, '/api/admin/accounts', promotedToken);
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.body.accounts.length, 2);

    // Demote again; the promoted session dies, and a new one is a member again.
    const demoted = await patchJson<{ account: { role: string } }>(
      baseUrl,
      `/api/admin/accounts/${member.public_id}`,
      { role: 'member' },
      adminToken,
    );
    assert.equal(demoted.status, 200);
    assert.equal(demoted.body.account.role, 'member');
    assert.equal((await getJson(baseUrl, '/api/admin/accounts', promotedToken)).status, 401);
    const memberAgain = await loginOrThrow(baseUrl, 'worker');
    assert.equal((await getJson(baseUrl, '/api/admin/accounts', memberAgain)).status, 403);

    // The audit trail records both transitions with no credential material.
    const audit = db.handle
      .prepare("select actor, action, detail from audit_records where action = 'account.role_change' order by id")
      .all() as { actor: string; action: string; detail: string }[];
    assert.equal(audit.length, 2);
    assert.match(audit[0]?.detail ?? '', /member/);
    assert.match(audit[0]?.detail ?? '', /administrator/);
    assert.ok(!/scrypt|password/i.test(audit[0]?.detail ?? ''));
  });
});

test('disabling an account rejects its live session and its next sign-in', async () => {
  await withServer(async ({ baseUrl, db }) => {
    await seedAccount(db, { username: 'boss', role: 'administrator' });
    const worker = await seedAccount(db, { username: 'worker', role: 'member' });
    const adminToken = await loginOrThrow(baseUrl, 'boss');
    const workerToken = await loginOrThrow(baseUrl, 'worker');

    const disabled = await patchJson<{ account: { status: string }; sessionsRevoked: number }>(
      baseUrl,
      `/api/admin/accounts/${worker.public_id}`,
      { status: 'disabled' },
      adminToken,
    );
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.account.status, 'disabled');
    assert.equal(disabled.body.sessionsRevoked, 1);

    assert.equal((await getJson(baseUrl, '/api/auth/me', workerToken)).status, 401, 'the live session ends immediately');
    const attempt = await login(baseUrl, 'worker', TEST_PASSWORD);
    assert.equal(attempt.status, 401, 'and the account cannot sign in again');
    assert.equal(errorCode(attempt.body), 'auth.invalid_credentials');

    // Re-enabling restores access; the password never changed and the row was never deleted.
    const enabled = await patchJson<{ account: { status: string } }>(
      baseUrl,
      `/api/admin/accounts/${worker.public_id}`,
      { status: 'active' },
      adminToken,
    );
    assert.equal(enabled.status, 200);
    assert.equal((await login(baseUrl, 'worker', TEST_PASSWORD)).status, 200);
    const stillThere = findByPublicId(db.handle, worker.public_id);
    assert.ok(stillThere, 'a disabled account is never deleted');
  });
});

test('an administrator cannot disable or demote their own account', async () => {
  await withServer(async ({ baseUrl, db }) => {
    const admin = await seedAccount(db, { username: 'boss', role: 'administrator' });
    await seedAccount(db, { username: 'second', role: 'administrator' });
    const token = await loginOrThrow(baseUrl, 'boss');

    const selfDisable = await patchJson<{ error?: { code: string } }>(
      baseUrl,
      `/api/admin/accounts/${admin.public_id}`,
      { status: 'disabled' },
      token,
    );
    assert.equal(selfDisable.status, 403);
    assert.equal(errorCode(selfDisable.body), 'admin.cannot_modify_self');

    const selfDemote = await patchJson<{ error?: { code: string } }>(
      baseUrl,
      `/api/admin/accounts/${admin.public_id}`,
      { role: 'member' },
      token,
    );
    assert.equal(selfDemote.status, 403);
    assert.equal(errorCode(selfDemote.body), 'admin.cannot_modify_self');

    // Nothing changed, and the session still works.
    const row = findByPublicId(db.handle, admin.public_id);
    assert.equal(row?.role, 'administrator');
    assert.equal(row?.status, 'active');
    assert.equal((await getJson(baseUrl, '/api/auth/me', token)).status, 200);

    // Another administrator disabling them is allowed — the guard is about self-harm,
    // not about protecting an account from its peers.
    await seedAccount(db, { username: 'peer', role: 'administrator' });
    const peerToken = await loginOrThrow(baseUrl, 'peer');
    const peerDisablesBoss = await patchJson(baseUrl, `/api/admin/accounts/${admin.public_id}`, { status: 'disabled' }, peerToken);
    assert.equal(peerDisablesBoss.status, 200);
    assert.equal(findByPublicId(db.handle, admin.public_id)?.status, 'disabled');
  });
});

test('the last active administrator cannot be removed, even by a route that forgets the self-check', async () => {
  await withServer(async ({ db }) => {
    const only = await seedAccount(db, { username: 'only-admin', role: 'administrator' });

    // The route layer refuses self-modification, so the final guard is exercised at the
    // repository layer — which is where it must hold for any future caller.
    assert.throws(
      () =>
        patchAccount(db.handle, {
          publicId: only.public_id,
          actorAccountId: 999_999, // a caller that is not the account itself
          actorPublicId: 'system',
          role: 'member',
        }),
      (error: unknown) => error instanceof AppError && error.code === 'admin.last_administrator',
    );
    assert.throws(
      () =>
        patchAccount(db.handle, {
          publicId: only.public_id,
          actorAccountId: 999_999,
          actorPublicId: 'system',
          status: 'disabled',
        }),
      (error: unknown) => error instanceof AppError && error.code === 'admin.last_administrator',
    );

    assert.equal(countActiveAdministrators(db.handle), 1, 'the account is untouched');
    assert.equal(findByPublicId(db.handle, only.public_id)?.status, 'active');

    // With a second active administrator, the same change is allowed.
    await seedAccount(db, { username: 'backup-admin', role: 'administrator' });
    const result = patchAccount(db.handle, {
      publicId: only.public_id,
      actorAccountId: 999_999,
      actorPublicId: 'system',
      role: 'member',
    });
    assert.equal(result.account.role, 'member');
    assert.equal(countActiveAdministrators(db.handle), 1);
  });
});

test('an administrator cannot reset their own password through the admin endpoint', async () => {
  await withServer(async ({ baseUrl, db }) => {
    const admin = await seedAccount(db, { username: 'boss', role: 'administrator' });
    const worker = await seedAccount(db, { username: 'worker', role: 'member' });
    const adminToken = await loginOrThrow(baseUrl, 'boss');
    const workerToken = await loginOrThrow(baseUrl, 'worker');

    const selfReset = await postJson<{ error?: { code: string } }>(
      baseUrl,
      `/api/admin/accounts/${admin.public_id}/reset-password`,
      {},
      adminToken,
    );
    assert.equal(selfReset.status, 403);
    assert.equal(errorCode(selfReset.body), 'admin.cannot_modify_self');
    assert.equal((await getJson(baseUrl, '/api/auth/me', adminToken)).status, 200, 'the refusal changed nothing');

    const reset = await postJson<{ temporaryPassword: string; mustChangePassword: boolean }>(
      baseUrl,
      `/api/admin/accounts/${worker.public_id}/reset-password`,
      {},
      adminToken,
    );
    assert.equal(reset.status, 200);
    assert.equal(reset.headers.get('cache-control'), 'no-store');
    assert.ok(reset.body.temporaryPassword.length >= 15);
    assert.equal(reset.body.mustChangePassword, true);
    assert.ok(!JSON.stringify(reset.body).includes('scrypt$'));

    // The member's session is revoked, and the new password must be changed before use.
    assert.equal((await getJson(baseUrl, '/api/auth/me', workerToken)).status, 401);
    const signIn = await login(baseUrl, 'worker', reset.body.temporaryPassword);
    assert.equal(signIn.status, 200);
    assert.equal(signIn.mustChangePassword, true);
    assert.equal((await login(baseUrl, 'worker', TEST_PASSWORD)).status, 401, 'the old password no longer works');

    const audit = db.handle
      .prepare("select detail from audit_records where action = 'account.password_reset'")
      .all() as { detail: string }[];
    assert.equal(audit.length, 1);
    assert.ok(!audit[0]!.detail.includes(reset.body.temporaryPassword), 'the temporary password is never audited');
  });
});

test('status and role patches validate their values and need at least one of them', async () => {
  await withServer(async ({ baseUrl, db }) => {
    await seedAccount(db, { username: 'boss', role: 'administrator' });
    const worker = await seedAccount(db, { username: 'worker', role: 'member' });
    const token = await loginOrThrow(baseUrl, 'boss');

    const empty = await patchJson<{ error?: { code: string } }>(baseUrl, `/api/admin/accounts/${worker.public_id}`, {}, token);
    assert.equal(empty.status, 400);
    assert.equal(errorCode(empty.body), 'auth.invalid_request');

    const badRole = await patchJson<{ error?: { code: string } }>(
      baseUrl,
      `/api/admin/accounts/${worker.public_id}`,
      { role: 'owner' },
      token,
    );
    assert.equal(badRole.status, 400);

    const badStatus = await patchJson<{ error?: { code: string } }>(
      baseUrl,
      `/api/admin/accounts/${worker.public_id}`,
      { status: 'suspended' },
      token,
    );
    assert.equal(badStatus.status, 400);

    const missing = await patchJson<{ error?: { code: string } }>(
      baseUrl,
      '/api/admin/accounts/0123456789abcdef0123456789abcdef',
      { role: 'member' },
      token,
    );
    assert.equal(missing.status, 404);
    assert.equal(errorCode(missing.body), 'admin.account_not_found');

    // A no-op patch is accepted and revokes nothing.
    const noop = await patchJson<{ sessionsRevoked: number }>(
      baseUrl,
      `/api/admin/accounts/${worker.public_id}`,
      { role: 'member' },
      token,
    );
    assert.equal(noop.status, 200);
    assert.equal(noop.body.sessionsRevoked, 0);
  });
});
