/**
 * Sign-in revalidation across an asynchronous password verification (LAN-2.1a).
 *
 * Sign-in verifies the submitted password with scrypt, which is deliberately slow. The
 * account row that justified the attempt was read *before* that await. An administrator
 * can disable the account or reset its password in that window — revoking every session —
 * and a session created from the stale row would then be the one live session nobody
 * revoked.
 *
 * Every test here uses the same mechanism, and none of them sleeps: the login route's
 * password verification is injected, and the injected function performs the concurrent
 * administrative operation itself before returning the (real) verification result. The
 * interleaving is therefore exact — the operation always lands after the row was read and
 * before the transaction that issues the session.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { RhodesDatabase } from '../src/db/index.js';
import {
  findByPublicId,
  patchAccount,
  resetPasswordByAdministrator,
  type AccountRow,
  type ActorHandle,
} from '../src/auth/accounts.js';
import { verifyPassword } from '../src/auth/password.js';
import { createSession } from '../src/auth/sessions.js';
import { LoginRateLimiter } from '../src/auth/rateLimit.js';
import {
  errorCode,
  errorMessage,
  fastHash,
  getJson,
  login,
  postJson,
  seedAccount,
  TEST_PASSWORD,
  TEST_PASSWORD_2,
} from './auth-helpers.js';
import { openMigrated, removeDir, startTestServer, tempDataDir } from './helpers.js';

interface Harness {
  readonly baseUrl: string;
  readonly db: RhodesDatabase;
  /**
   * Run `interleave` inside the next password verification, once. Anything after it is a
   * normal verification, so fixture sign-ins are unaffected.
   */
  readonly arm: (interleave: () => Promise<void> | void) => void;
}

/**
 * Start the real HTTP stack with verification intercepted.
 *
 * The model is the same as the LAN-2.1 stale-authorisation suite: the seam is the async
 * boundary the bug lives on, so the test drives the boundary rather than racing it.
 */
async function withInterceptedVerification<T>(
  body: (harness: Harness) => Promise<T>,
  deps: Parameters<typeof startTestServer>[1] = {},
): Promise<T> {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  let pending: (() => Promise<void> | void) | null = null;

  try {
    const { running, baseUrl } = await startTestServer(db, {
      ...deps,
      passwordVerifier: async (password: string, encodedHash: string) => {
        const run = pending;
        pending = null; // one-shot: a later request is never disturbed by it
        if (run) await run();
        // The real verification, against the hash the route read before the interleave.
        return verifyPassword(password, encodedHash);
      },
    });
    try {
      return await body({
        baseUrl,
        db,
        arm: (interleave) => {
          pending = interleave;
        },
      });
    } finally {
      await running.close();
    }
  } finally {
    db.close();
    removeDir(dir);
  }
}

/**
 * A live session for an administrator, used as the authorising actor for a direct
 * repository call. The same object the HTTP middleware would build.
 */
function actorFor(db: RhodesDatabase, account: AccountRow): ActorHandle {
  const session = createSession(db.handle, account.id, new Date());
  return { accountId: account.id, sessionId: session.sessionId, publicId: account.public_id };
}

function sessionCount(db: RhodesDatabase, accountId: number): number {
  const row = db.handle
    .prepare('select count(*) as n from user_sessions where user_account_id = ?')
    .get(accountId) as { n: number };
  return row.n;
}

function auditCount(db: RhodesDatabase, action: string): number {
  const row = db.handle.prepare('select count(*) as n from audit_records where action = ?').get(action) as {
    n: number;
  };
  return row.n;
}

test('scenario 1: a password reset during verification refuses the pending sign-in', async () => {
  // Two strikes block the key. One wrong password alone would still be allowed, so a 429
  // after *one* wrong attempt proves the refused stale sign-in took the other strike.
  const limiter = new LoginRateLimiter({
    maxAttempts: 2,
    windowMs: 60_000,
    cooldownMs: 60_000,
    maxEntries: 100,
    now: () => Date.parse('2026-06-01T12:00:00.000Z'),
  });

  await withInterceptedVerification(
    async ({ baseUrl, db, arm }) => {
      const admin = await seedAccount(db, { username: 'amara', role: 'administrator' });
      const member = await seedAccount(db, { username: 'ravi' });
      const adminActor = actorFor(db, admin);
      const replacement = await fastHash(TEST_PASSWORD_2);

      arm(() => {
        // The administrator resets the password while the sign-in is verifying.
        resetPasswordByAdministrator(db.handle, {
          publicId: member.public_id,
          passwordHash: replacement,
          authorisingActor: adminActor,
        });
      });

      const refused = await postJson<Record<string, unknown>>(baseUrl, '/api/auth/login', {
        username: 'ravi',
        password: TEST_PASSWORD,
      });

      assert.equal(refused.status, 401, 'the reset wins over the pending sign-in');
      assert.equal(errorCode(refused.body), 'auth.invalid_credentials');
      assert.equal(refused.body.token, undefined, 'no token may be issued');
      assert.equal(sessionCount(db, member.id), 0, 'no session may be created');

      const current = findByPublicId(db.handle, member.public_id);
      assert.equal(current?.must_change_password, 1, 'the reset itself did happen');
      assert.equal(current?.row_version, member.row_version + 1);

      // The refused sign-in was counted: with only one strike left, a single wrong password
      // exhausts the allowance and the correct current password is then throttled.
      const wrong = await postJson<Record<string, unknown>>(baseUrl, '/api/auth/login', {
        username: 'ravi',
        password: 'still not the password',
      });
      assert.equal(wrong.status, 401);

      const throttled = await postJson<Record<string, unknown>>(baseUrl, '/api/auth/login', {
        username: 'ravi',
        password: TEST_PASSWORD_2,
      });
      assert.equal(throttled.status, 429, 'the refused stale sign-in counts as a failed attempt');
      assert.equal(errorCode(throttled.body), 'auth.too_many_attempts');
      assert.ok(Number(throttled.headers.get('retry-after')) > 0);

      // Best-effort audit stayed best effort, and both attempts are in the record.
      assert.equal(auditCount(db, 'auth.login_failed'), 2);
      assert.equal(auditCount(db, 'auth.login'), 0);
    },
    { rateLimiter: limiter },
  );
});

test('the refusal is indistinguishable from any other wrong credential', async () => {
  await withInterceptedVerification(async ({ baseUrl, db, arm }) => {
    const admin = await seedAccount(db, { username: 'amara', role: 'administrator' });
    const member = await seedAccount(db, { username: 'ravi' });
    const adminActor = actorFor(db, admin);
    const replacement = await fastHash(TEST_PASSWORD_2);

    const wrongPassword = await postJson<Record<string, unknown>>(baseUrl, '/api/auth/login', {
      username: 'ravi',
      password: 'not the password',
    });

    arm(() => {
      resetPasswordByAdministrator(db.handle, {
        publicId: member.public_id,
        passwordHash: replacement,
        authorisingActor: adminActor,
      });
    });

    const stale = await postJson<Record<string, unknown>>(baseUrl, '/api/auth/login', {
      username: 'ravi',
      password: TEST_PASSWORD,
    });

    assert.equal(stale.status, wrongPassword.status);
    assert.equal(errorCode(stale.body), errorCode(wrongPassword.body));
    assert.equal(errorMessage(stale.body), errorMessage(wrongPassword.body));
    assert.deepEqual(
      Object.keys(stale.body as object).sort(),
      Object.keys(wrongPassword.body as object).sort(),
      'the body shape must not hint at why the attempt failed',
    );
    assert.equal(sessionCount(db, member.id), 0);
  });
});

test('scenario 2: a disable during verification refuses the pending sign-in', async () => {
  await withInterceptedVerification(async ({ baseUrl, db, arm }) => {
    const admin = await seedAccount(db, { username: 'amara', role: 'administrator' });
    const member = await seedAccount(db, { username: 'ravi' });

    arm(() => {
      patchAccount(db.handle, {
        publicId: member.public_id,
        actorAccountId: admin.id,
        actorPublicId: admin.public_id,
        status: 'disabled',
      });
    });

    const refused = await postJson<Record<string, unknown>>(baseUrl, '/api/auth/login', {
      username: 'ravi',
      password: TEST_PASSWORD,
    });

    assert.equal(refused.status, 401);
    assert.equal(errorCode(refused.body), 'auth.invalid_credentials');
    assert.equal(refused.body.token, undefined);
    assert.equal(sessionCount(db, member.id), 0, 'a disabled account gets no session');

    const current = findByPublicId(db.handle, member.public_id);
    assert.equal(current?.status, 'disabled', 'the disable itself did happen');
    assert.equal(current?.row_version, member.row_version + 1);
  });
});

test('scenario 3: a session issued before the concurrent operation stays revoked', async () => {
  await withInterceptedVerification(async ({ baseUrl, db, arm }) => {
    const admin = await seedAccount(db, { username: 'amara', role: 'administrator' });
    const member = await seedAccount(db, { username: 'ravi' });
    const adminActor = actorFor(db, admin);
    const replacement = await fastHash(TEST_PASSWORD_2);

    const earlier = await login(baseUrl, 'ravi', TEST_PASSWORD);
    assert.equal(earlier.status, 200);
    assert.ok(earlier.token, 'the first sign-in works');

    const before = await getJson(baseUrl, '/api/auth/me', earlier.token);
    assert.equal(before.status, 200, 'the first session is live');

    arm(() => {
      resetPasswordByAdministrator(db.handle, {
        publicId: member.public_id,
        passwordHash: replacement,
        authorisingActor: adminActor,
      });
    });

    const refused = await login(baseUrl, 'ravi', TEST_PASSWORD);
    assert.equal(refused.status, 401);
    assert.equal(refused.token, undefined);

    const after = await getJson(baseUrl, '/api/auth/me', earlier.token);
    assert.equal(after.status, 401, 'the reset revoked the earlier session and it stays revoked');

    const revoked = db.handle
      .prepare('select revoked_at, revoked_reason from user_sessions where token_hash is not null and user_account_id = ?')
      .all(member.id) as { revoked_at: string | null; revoked_reason: string | null }[];
    assert.equal(revoked.length, 1, 'exactly the earlier session exists — no new one');
    assert.ok(revoked[0]?.revoked_at, 'and it is revoked');
    assert.equal(revoked[0]?.revoked_reason, 'password_reset');
  });
});

test('scenario 4: a later sign-in with the current password works normally', async () => {
  await withInterceptedVerification(async ({ baseUrl, db, arm }) => {
    const admin = await seedAccount(db, { username: 'amara', role: 'administrator' });
    const member = await seedAccount(db, { username: 'ravi' });
    const adminActor = actorFor(db, admin);
    const replacement = await fastHash(TEST_PASSWORD_2);

    arm(() => {
      resetPasswordByAdministrator(db.handle, {
        publicId: member.public_id,
        passwordHash: replacement,
        authorisingActor: adminActor,
      });
    });

    const refused = await login(baseUrl, 'ravi', TEST_PASSWORD);
    assert.equal(refused.status, 401);
    assert.equal(sessionCount(db, member.id), 0);

    const fresh = await login(baseUrl, 'ravi', TEST_PASSWORD_2);
    assert.equal(fresh.status, 200, 'the revalidation does not block a correct sign-in');
    assert.ok(fresh.token);
    assert.equal(fresh.mustChangePassword, true, 'the reset forces a change');

    const me = await getJson<{ user?: { username: string } }>(baseUrl, '/api/auth/me', fresh.token);
    assert.equal(me.status, 200, 'the new token is usable');
    assert.equal(me.body.user?.username, 'ravi');
    assert.equal(sessionCount(db, member.id), 1);
  });
});

test('scenario 5: the response describes the revalidated row, not the pre-verification snapshot', async () => {
  await withInterceptedVerification(async ({ baseUrl, db, arm }) => {
    const member = await seedAccount(db, { username: 'ravi', role: 'member', mustChangePassword: false });

    arm(() => {
      // No path in the application mutates an account without bumping `row_version`, so
      // this raw update isolates the one thing under test here: which row the *response*
      // is built from. The pending sign-in is not invalidated, and must still describe the
      // account as it is now — administrator, owing a password change — rather than the
      // member-without-a-flag snapshot taken before the derivation.
      db.handle.prepare('update user_accounts set role = ?, must_change_password = 1 where id = ?').run(
        'administrator',
        member.id,
      );
    });

    const response = await postJson<{
      mustChangePassword?: boolean;
      user?: { publicId: string; username: string; role: string };
    }>(baseUrl, '/api/auth/login', { username: 'ravi', password: TEST_PASSWORD });

    assert.equal(response.status, 200, 'no security state changed, so the sign-in stands');
    assert.equal(response.body.user?.role, 'administrator', 'the current role, not the snapshot');
    assert.equal(response.body.mustChangePassword, true, 'the current flag, not the snapshot');
    assert.equal(response.body.user?.publicId, member.public_id);
    assert.equal(response.body.user?.username, 'ravi');

    const current = findByPublicId(db.handle, member.public_id);
    assert.equal(current?.row_version, member.row_version, 'the test setup bumped nothing');

    // The token agrees with the same row.
    const token = (response.body as { token?: string }).token;
    assert.ok(token);
    const me = await getJson<{ user?: { role: string; mustChangePassword: boolean } }>(
      baseUrl,
      '/api/auth/me',
      token,
    );
    assert.equal(me.status, 200);
    assert.equal(me.body.user?.role, 'administrator');
    assert.equal(me.body.user?.mustChangePassword, true);
  });
});

test('a disable-and-re-enable during verification still refuses the sign-in', async () => {
  await withInterceptedVerification(async ({ baseUrl, db, arm }) => {
    const admin = await seedAccount(db, { username: 'amara', role: 'administrator' });
    const member = await seedAccount(db, { username: 'ravi' });

    arm(() => {
      patchAccount(db.handle, {
        publicId: member.public_id,
        actorAccountId: admin.id,
        actorPublicId: admin.public_id,
        status: 'disabled',
      });
      patchAccount(db.handle, {
        publicId: member.public_id,
        actorAccountId: admin.id,
        actorPublicId: admin.public_id,
        status: 'active',
      });
    });

    const refused = await postJson<Record<string, unknown>>(baseUrl, '/api/auth/login', {
      username: 'ravi',
      password: TEST_PASSWORD,
    });

    assert.equal(refused.status, 401, 'the account is active again, but the attempt is stale');
    assert.equal(errorCode(refused.body), 'auth.invalid_credentials');
    assert.equal(sessionCount(db, member.id), 0, 'revocation survives a re-enable');

    const current = findByPublicId(db.handle, member.public_id);
    assert.equal(current?.status, 'active');
    assert.equal(current?.row_version, member.row_version + 2, 'both transitions bumped the version');
  });
});

test('the ordinary sign-in path is unchanged: one session, one audit row, no refusals', async () => {
  await withInterceptedVerification(async ({ baseUrl, db }) => {
    const member = await seedAccount(db, { username: 'ravi' });

    const response = await postJson<{
      token?: string;
      expiresAt?: string;
      mustChangePassword?: boolean;
      user?: { publicId: string; username: string; role: string };
    }>(baseUrl, '/api/auth/login', { username: 'ravi', password: TEST_PASSWORD });

    assert.equal(response.status, 200);
    assert.ok(response.body.token);
    assert.equal(response.body.user?.username, 'ravi');
    assert.equal(response.body.user?.role, 'member');
    assert.equal(response.body.mustChangePassword, false);
    assert.equal(sessionCount(db, member.id), 1);
    assert.equal(auditCount(db, 'auth.login'), 1);
    assert.equal(auditCount(db, 'auth.login_failed'), 0);

    const me = await getJson(baseUrl, '/api/auth/me', response.body.token);
    assert.equal(me.status, 200);
  });
});
