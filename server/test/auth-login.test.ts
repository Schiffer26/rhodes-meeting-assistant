/**
 * Sign-in, sign-out, the session lifecycle and throttling.
 *
 * The promises being checked:
 *   · the token is returned once, is not logged, and is not accepted from a URL or body;
 *   · a failed sign-in says exactly the same thing whether the username is unknown, the
 *     password is wrong, or the account is disabled — and takes comparable time;
 *   · sessions expire after eight hours, are revoked by logout, and die on password change;
 *   · an account on a temporary password can sign in and change its password, and nothing
 *     else;
 *   · repeated failures are throttled with 429 and a Retry-After, with memory bounded.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { LoginRateLimiter } from '../src/auth/rateLimit.js';
import { hashPassword, kdfStats } from '../src/auth/password.js';
import { SESSION_TTL_MS } from '../src/auth/sessions.js';
import {
  errorCode,
  errorMessage,
  getJson,
  login,
  loginOrThrow,
  postJson,
  seedAccount,
  TEST_PASSWORD,
  TEST_PASSWORD_2,
} from './auth-helpers.js';
import { openMigrated, removeDir, startTestServer, tempDataDir } from './helpers.js';

function withServer<T>(
  run: (context: { baseUrl: string; db: ReturnType<typeof openMigrated>['db'] }) => Promise<T>,
  deps: Parameters<typeof startTestServer>[1] = {},
): Promise<T> {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  return (async () => {
    let close: (() => Promise<void>) | undefined;
    try {
      const { running, baseUrl } = await startTestServer(db, deps);
      close = running.close;
      return await run({ baseUrl, db });
    } finally {
      if (close) await close();
      db.close();
      removeDir(dir);
    }
  })();
}

test('a successful sign-in returns a token once, with a safe summary and no secrets', async () => {
  await withServer(async ({ baseUrl, db }) => {
    const account = await seedAccount(db, { username: 'Amara', role: 'administrator' });

    const response = await postJson<Record<string, unknown>>(baseUrl, '/api/auth/login', {
      username: 'amara',
      password: TEST_PASSWORD,
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const body = response.body as {
      token: string;
      expiresAt: string;
      user: { publicId: string; username: string; role: string };
      mustChangePassword: boolean;
    };
    assert.match(body.token, /^[A-Za-z0-9_-]{43}$/, 'a 32-byte token, base64url encoded');
    assert.equal(body.user.publicId, account.public_id);
    assert.equal(body.user.username, 'Amara');
    assert.equal(body.user.role, 'administrator');
    assert.equal(body.mustChangePassword, false);

    // Eight hours, absolute, computed from the same instant.
    const lifetime = new Date(body.expiresAt).getTime() - Date.now();
    assert.ok(Math.abs(lifetime - SESSION_TTL_MS) < 60_000, `ttl was ${lifetime} ms`);

    // Nothing sensitive anywhere in the payload.
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes(TEST_PASSWORD));
    assert.ok(!serialised.includes('scrypt$'));
    assert.ok(!/password_hash|passwordHash/i.test(serialised));

    // The database holds a SHA-256 of the token, not the token.
    const rows = db.handle.prepare('select token_hash, expires_at, revoked_at from user_sessions').all() as {
      token_hash: string;
      expires_at: string;
      revoked_at: string | null;
    }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.token_hash, createHash('sha256').update(body.token, 'utf8').digest('hex'));
    assert.equal(rows[0]?.revoked_at, null);
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes(body.token), 'the raw token must never be stored');

    // /me works, and does not hand the token back.
    const me = await getJson<Record<string, unknown>>(baseUrl, '/api/auth/me', body.token);
    assert.equal(me.status, 200);
    assert.equal(me.headers.get('cache-control'), 'no-store');
    const meBody = me.body as { user: { username: string; role: string }; session: { expiresAt: string } };
    assert.notEqual(meBody.user, undefined);
    assert.equal(meBody.user.username, 'Amara');
    assert.equal(meBody.session.expiresAt, body.expiresAt);
    assert.ok(!JSON.stringify(me.body).includes(body.token), '/me must not echo the token');
  });
});

test('every credential failure is indistinguishable, and costs comparable time', async () => {
  await withServer(async ({ baseUrl, db }) => {
    // A production-parameter hash, so the wrong-password path costs what a real one does.
    const { createAccount } = await import('../src/auth/accounts.js');
    await createAccount(db.handle, {
      username: 'slow',
      passwordHash: await hashPassword(TEST_PASSWORD),
      role: 'member',
      mustChangePassword: false,
      actor: 'test',
    });
    await seedAccount(db, { username: 'disabled-user', password: TEST_PASSWORD });
    db.handle.prepare("update user_accounts set status = 'disabled' where username_normalized = 'disabled-user'").run();

    const attempt = (username: string, password: string) =>
      postJson<{ error?: { code: string; message: string } }>(baseUrl, '/api/auth/login', { username, password });

    const unknown = await attempt('nobody-here', 'some wrong passphrase');
    const wrong = await attempt('slow', 'some wrong passphrase');
    const disabled = await attempt('disabled-user', TEST_PASSWORD);

    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(disabled.status, 401, 'a disabled account answers exactly like a wrong password');

    assert.equal(errorCode(unknown.body), 'auth.invalid_credentials');
    assert.equal(errorCode(wrong.body), 'auth.invalid_credentials');
    assert.equal(errorCode(disabled.body), 'auth.invalid_credentials');
    assert.equal(errorMessage(unknown.body), errorMessage(wrong.body));
    assert.equal(errorMessage(unknown.body), errorMessage(disabled.body));
    assert.deepEqual(Object.keys(unknown.body.error ?? {}).sort(), Object.keys(wrong.body.error ?? {}).sort());
    assert.ok(!JSON.stringify(disabled.body).includes('disabled'), 'the response must not reveal the account state');

    // No session was created by any of the failures.
    const sessions = db.handle.prepare('select count(*) as n from user_sessions').get() as { n: number };
    assert.equal(sessions.n, 0);

    // Timing: warm the dummy hash first (it is computed lazily), then compare. The
    // threshold is generous — this is a "the unknown-user path is not free" check, not a
    // benchmark, and a shared CI host must not make it flaky.
    await attempt('warm-up-unknown', 'some wrong passphrase');
    const time = async (username: string, password: string) => {
      const started = process.hrtime.bigint();
      await attempt(username, password);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const unknownMs = await time('another-unknown', 'some wrong passphrase');
    const wrongMs = await time('slow', 'some wrong passphrase');
    assert.ok(unknownMs > 100, `an unknown username must still pay the key derivation (${unknownMs.toFixed(0)} ms)`);
    assert.ok(wrongMs > 100, `a wrong password pays the key derivation (${wrongMs.toFixed(0)} ms)`);
    const ratio = Math.max(unknownMs, wrongMs) / Math.min(unknownMs, wrongMs);
    assert.ok(ratio < 4, `unknown/wrong timings differ too much (${unknownMs.toFixed(0)} vs ${wrongMs.toFixed(0)} ms)`);
  });
});

test('a bearer token must be well formed, and is never read from a URL or a body', async () => {
  await withServer(async ({ baseUrl, db }) => {
    await seedAccount(db, { username: 'amara', role: 'member' });
    const token = await loginOrThrow(baseUrl, 'amara');

    const malformed = [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      'bearer ' + token, // scheme is case-sensitive
      'Basic ' + token,
      'Bearer  ' + token, // two spaces
      // (A trailing space is not listed: Node's HTTP parser strips optional whitespace
      // around a header value before the application ever sees it, so it cannot be
      // tested here — and it carries no meaning either way.)
      'Bearer ' + token.slice(0, -1), // one character short
      token, // no scheme
    ];

    for (const header of malformed) {
      const response = await fetch(`${baseUrl}/api/auth/me`, {
        headers: header === undefined ? {} : { authorization: header },
      });
      assert.equal(response.status, 401, `must reject: ${JSON.stringify(header)}`);
    }

    // A token in the query string is ignored: credentials do not belong in URLs.
    const viaQuery = await fetch(`${baseUrl}/api/auth/me?token=${token}`);
    assert.equal(viaQuery.status, 401);

    // Likewise in the body.
    const viaBody = await postJson(baseUrl, '/api/auth/logout', { token });
    assert.equal(viaBody.status, 401);

    // The well-formed header still works, so the failures above are about the header.
    assert.equal((await getJson(baseUrl, '/api/auth/me', token)).status, 200);
  });
});

test('a session expires after eight hours, and logout revokes it immediately', async () => {
  let clock = new Date('2026-05-04T09:00:00.000Z');
  await withServer(
    async ({ baseUrl, db }) => {
      await seedAccount(db, { username: 'amara', role: 'member' });

      const first = await login(baseUrl, 'amara', TEST_PASSWORD);
      assert.equal(first.status, 200);
      const token = first.token!;
      assert.equal(first.expiresAt, '2026-05-04T17:00:00.000Z', 'exactly eight hours after sign-in');

      // Still valid one minute before expiry...
      clock = new Date('2026-05-04T16:59:00.000Z');
      assert.equal((await getJson(baseUrl, '/api/auth/me', token)).status, 200);

      // ...and refused one minute after.
      clock = new Date('2026-05-04T17:01:00.000Z');
      assert.equal((await getJson(baseUrl, '/api/auth/me', token)).status, 401);

      // A fresh sign-in works again, and logout kills only that session.
      clock = new Date('2026-05-05T08:00:00.000Z');
      const second = await login(baseUrl, 'amara', TEST_PASSWORD);
      const logout = await postJson(baseUrl, '/api/auth/logout', {}, second.token);
      assert.equal(logout.status, 200);
      assert.equal((logout.body as { revoked: boolean }).revoked, true);
      assert.equal((await getJson(baseUrl, '/api/auth/me', second.token)).status, 401);

      // Logging out again with the same token is a 401, not a crash.
      assert.equal((await postJson(baseUrl, '/api/auth/logout', {}, second.token)).status, 401);

      const revoked = db.handle
        .prepare("select count(*) as n from user_sessions where revoked_reason = 'logout'")
        .get() as { n: number };
      assert.equal(revoked.n, 1);
    },
    { now: () => clock },
  );
});

test('changing a password verifies the current one and revokes every session', async () => {
  await withServer(async ({ baseUrl, db }) => {
    const account = await seedAccount(db, { username: 'amara', role: 'member' });
    const first = await loginOrThrow(baseUrl, 'amara');
    const second = await loginOrThrow(baseUrl, 'amara');

    const wrongCurrent = await postJson<{ error?: { code: string } }>(
      baseUrl,
      '/api/auth/change-password',
      { currentPassword: 'not the password at all', newPassword: TEST_PASSWORD_2 },
      first,
    );
    assert.equal(wrongCurrent.status, 400);
    assert.equal(errorCode(wrongCurrent.body), 'auth.current_password_incorrect');
    assert.equal((await getJson(baseUrl, '/api/auth/me', first)).status, 200, 'a failed attempt changes nothing');

    const tooShort = await postJson<{ error?: { code: string } }>(
      baseUrl,
      '/api/auth/change-password',
      { currentPassword: TEST_PASSWORD, newPassword: 'too short' },
      first,
    );
    assert.equal(tooShort.status, 400);
    assert.equal(errorCode(tooShort.body), 'auth.password_too_short');

    const tooLong = await postJson<{ error?: { code: string } }>(
      baseUrl,
      '/api/auth/change-password',
      { currentPassword: TEST_PASSWORD, newPassword: 'x'.repeat(129) },
      first,
    );
    assert.equal(tooLong.status, 400);
    assert.equal(errorCode(tooLong.body), 'auth.password_too_long', 'the ceiling is checked before hashing');

    const changed = await postJson<{ changed: boolean; sessionsRevoked: number }>(
      baseUrl,
      '/api/auth/change-password',
      { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD_2 },
      first,
    );
    assert.equal(changed.status, 200);
    assert.equal(changed.body.changed, true);
    assert.equal(changed.body.sessionsRevoked, 2, 'the current session is revoked too');

    // Both tokens are dead: signing in again is how the user proves the change worked.
    assert.equal((await getJson(baseUrl, '/api/auth/me', first)).status, 401);
    assert.equal((await getJson(baseUrl, '/api/auth/me', second)).status, 401);

    assert.equal((await login(baseUrl, 'amara', TEST_PASSWORD)).status, 401, 'the old password stops working');
    const reLogin = await login(baseUrl, 'amara', TEST_PASSWORD_2);
    assert.equal(reLogin.status, 200);

    const row = db.handle.prepare('select password_changed_at, must_change_password from user_accounts where id = ?').get(account.id) as {
      password_changed_at: string;
      must_change_password: number;
    };
    assert.match(row.password_changed_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(row.must_change_password, 0);
  });
});

test('a temporary password can sign in, but reaches nothing until it is changed', async () => {
  await withServer(async ({ baseUrl, db }) => {
    await seedAccount(db, { username: 'new-admin', role: 'administrator', mustChangePassword: true });

    const first = await login(baseUrl, 'new-admin', TEST_PASSWORD);
    assert.equal(first.status, 200);
    assert.equal(first.mustChangePassword, true);
    const token = first.token!;

    const blocked = await getJson<{ error?: { code: string; message: string } }>(baseUrl, '/api/admin/accounts', token);
    assert.equal(blocked.status, 403);
    assert.equal(errorCode(blocked.body), 'auth.password_change_required');
    assert.doesNotMatch(errorMessage(blocked.body) ?? '', /administrator|role|member/i);

    const me = await getJson<{ mustChangePassword?: boolean }>(baseUrl, '/api/auth/me', token);
    assert.equal(me.status, 200, 'the profile remains reachable so the user can see why');

    const changed = await postJson(baseUrl, '/api/auth/change-password', {
      currentPassword: TEST_PASSWORD,
      newPassword: TEST_PASSWORD_2,
    }, token);
    assert.equal(changed.status, 200);

    const afterChange = await login(baseUrl, 'new-admin', TEST_PASSWORD_2);
    assert.equal(afterChange.mustChangePassword, false);
    const allowed = await getJson(baseUrl, '/api/admin/accounts', afterChange.token);
    assert.equal(allowed.status, 200, 'once the password is real, the account is fully usable');
  });
});

test('repeated failures are throttled per account with 429 and Retry-After, never a lockout', async () => {
  let clock = Date.parse('2026-06-01T12:00:00.000Z');
  const limiter = new LoginRateLimiter({
    maxAttempts: 3,
    windowMs: 60_000,
    cooldownMs: 60_000,
    maxEntries: 100,
    now: () => clock,
  });

  await withServer(
    async ({ baseUrl, db }) => {
      await seedAccount(db, { username: 'amara', role: 'member' });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await postJson(baseUrl, '/api/auth/login', { username: 'amara', password: 'wrong password here' });
        assert.equal(response.status, 401, `attempt ${attempt + 1} is a plain 401`);
      }

      const blocked = await postJson<{ error?: { code: string } }>(baseUrl, '/api/auth/login', {
        username: 'amara',
        password: 'wrong password here',
      });
      assert.equal(blocked.status, 429);
      assert.equal(errorCode(blocked.body), 'auth.too_many_attempts');
      const retryAfter = Number(blocked.headers.get('retry-after'));
      assert.ok(retryAfter > 0 && retryAfter <= 60, `retry-after was ${retryAfter}`);

      // Case does not escape the throttle, because the key is the normalised username.
      const differentCase = await postJson(baseUrl, '/api/auth/login', { username: 'AMARA', password: 'wrong password here' });
      assert.equal(differentCase.status, 429);

      // Even the correct password waits: the cooldown is not a hint to keep trying.
      const correctButEarly = await postJson(baseUrl, '/api/auth/login', { username: 'amara', password: TEST_PASSWORD });
      assert.equal(correctButEarly.status, 429);

      // After the cooldown the account works again — throttled, never locked out.
      clock += 61_000;
      const recovered = await login(baseUrl, 'amara', TEST_PASSWORD);
      assert.equal(recovered.status, 200);
    },
    { rateLimiter: limiter },
  );
});

test('the throttle keeps a bounded number of keys, however many usernames are tried', () => {
  let clock = Date.parse('2026-06-01T12:00:00.000Z');
  const limiter = new LoginRateLimiter({
    maxAttempts: 5,
    windowMs: 60_000,
    cooldownMs: 60_000,
    maxEntries: 50,
    now: () => clock,
  });

  for (let index = 0; index < 5_000; index += 1) {
    limiter.recordFailure(`user-${index}`, `10.0.0.${index % 250}`);
    if (index % 500 === 0) clock += 1_000;
  }

  const stats = limiter.stats();
  assert.ok(stats.usernames <= 50, `username map grew to ${stats.usernames}`);
  assert.ok(stats.addresses <= 50, `address map grew to ${stats.addresses}`);
  assert.ok(stats.usernames > 0);

  // Pruning drops everything once the window has passed.
  clock += 10 * 60_000;
  limiter.prune();
  assert.deepEqual(limiter.stats(), { usernames: 0, addresses: 0 });
});

// ── LAN-2.1: the password ceiling applies to sign-in ─────────────────────────

test('exactly 128 code points is accepted, and 129 never reaches the key derivation', async () => {
  await withServer(async ({ baseUrl, db }) => {
    const ascii128 = 'a'.repeat(128);
    const emoji128 = '🔐'.repeat(128); // 128 code points, 256 UTF-16 units
    await seedAccount(db, { username: 'at-limit', role: 'member', password: ascii128 });
    await seedAccount(db, { username: 'at-limit-emoji', role: 'member', password: emoji128 });

    const ascii = await login(baseUrl, 'at-limit', ascii128);
    assert.equal(ascii.status, 200, 'exactly 128 code points is a legal password');
    const emoji = await login(baseUrl, 'at-limit-emoji', emoji128);
    assert.equal(emoji.status, 200);

    // One past the ceiling: refused, generically, and without spending a KDF slot.
    const before = kdfStats().invocations;
    const tooLong = await login(baseUrl, 'at-limit', `${ascii128}b`);
    assert.equal(tooLong.status, 401);
    assert.equal(errorCode(tooLong.body), 'auth.invalid_credentials');
    assert.equal(kdfStats().invocations, before, 'no scrypt may run for an oversized password');
  });
});

test('an oversized password is answered identically for a real and an unknown username', async () => {
  await withServer(async ({ baseUrl, db }) => {
    await seedAccount(db, { username: 'amara', role: 'member' });
    const oversized = 'x'.repeat(129);

    const before = kdfStats().invocations;
    const existing = await login(baseUrl, 'amara', oversized);
    const unknown = await login(baseUrl, 'nobody-at-all', oversized);
    const after = kdfStats().invocations;

    assert.equal(existing.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(errorCode(existing.body), 'auth.invalid_credentials');
    assert.equal(errorCode(unknown.body), 'auth.invalid_credentials');
    assert.equal(errorMessage(existing.body), errorMessage(unknown.body));
    assert.deepEqual(
      Object.keys(existing.body.error ?? {}).sort(),
      Object.keys(unknown.body.error ?? {}).sort(),
      'the two responses are structurally identical',
    );
    assert.equal(after, before, 'neither path may hash an oversized password');

    // The same holds far above the limit; the body parser is the only earlier gate.
    assert.equal((await login(baseUrl, 'amara', 'y'.repeat(4_000))).status, 401);
    assert.equal((await login(baseUrl, 'nobody-at-all', 'y'.repeat(4_000))).status, 401);
  });
});

test('oversized password attempts are still throttled like any other failure', async () => {
  const limiter = new LoginRateLimiter({
    maxAttempts: 3,
    windowMs: 60_000,
    cooldownMs: 60_000,
    maxEntries: 100,
    now: () => Date.parse('2026-06-01T12:00:00.000Z'),
  });

  await withServer(
    async ({ baseUrl, db }) => {
      await seedAccount(db, { username: 'amara', role: 'member' });
      const oversized = 'z'.repeat(200);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await postJson(baseUrl, '/api/auth/login', { username: 'amara', password: oversized });
        assert.equal(response.status, 401, `attempt ${attempt + 1} is a plain 401`);
      }

      const blocked = await postJson<{ error?: { code: string } }>(baseUrl, '/api/auth/login', {
        username: 'amara',
        password: oversized,
      });
      assert.equal(blocked.status, 429, 'an oversized attempt counts against the account allowance');
      assert.equal(errorCode(blocked.body), 'auth.too_many_attempts');
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    },
    { rateLimiter: limiter },
  );
});
