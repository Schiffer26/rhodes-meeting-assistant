/**
 * KDF overload and the dummy hash (LAN-2.1).
 *
 * The dummy hash exists so an unknown username costs the same as a known one. LAN-2
 * silently swallowed *every* failure in that path, which meant that while the KDF queue
 * was full an unknown username received a generic 401 while a known username received a
 * 503 — a difference an attacker can measure, and therefore an enumeration oracle in the
 * exact place it matters.
 *
 * These tests saturate the limiter deliberately (by shrinking it, not by waiting) and
 * check three things:
 *
 *   · both paths raise the same `auth.hash_overloaded` error;
 *   · a failed dummy-hash initialisation is forgotten, so the next attempt works;
 *   · a successful initialisation is cached.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getDummyHash,
  hashPassword,
  kdfStats,
  resetDummyHashForTests,
  verifyAgainstDummyHash,
  verifyPassword,
  withHashCapacityForTests,
} from '../src/auth/password.js';
import { errorCode, errorMessage, fastHash, login, postJson, seedAccount } from './auth-helpers.js';
import { openMigrated, removeDir, startTestServer, tempDataDir } from './helpers.js';

const PASSWORD = 'a sufficiently long passphrase';

function isOverload(error: unknown): boolean {
  return (error as { code?: string }).code === 'auth.hash_overloaded';
}

test('with no KDF slot available, known and unknown usernames raise the same overload error', async () => {
  const stored = await fastHash(PASSWORD);
  const before = kdfStats().invocations;

  await withHashCapacityForTests(1, 1, async () => {
    // One derivation running, one queued: the pool is now exactly full.
    const running = verifyPassword(PASSWORD, stored);
    const queued = verifyPassword(PASSWORD, stored);

    // The known-username path, and the unknown-username path, must both refuse to pretend
    // this was a wrong password.
    await assert.rejects(() => verifyPassword(PASSWORD, stored), isOverload);
    await assert.rejects(() => verifyAgainstDummyHash(PASSWORD), isOverload);

    const settled = await Promise.allSettled([running, queued]);
    assert.deepEqual(settled.map((entry) => entry.status), ['fulfilled', 'fulfilled']);
  });

  // The two refusals above never reached scrypt; only the two real derivations did.
  assert.equal(kdfStats().invocations, before + 2);
  assert.equal(kdfStats().active, 0);
  assert.equal(kdfStats().queued, 0);
});

test('a failed dummy-hash initialisation is forgotten and retried, not cached as a failure', async () => {
  resetDummyHashForTests();
  // Both fixtures are prepared before the pool is shrunk: awaiting inside the saturated
  // block would let a derivation finish and hand its slot on, and the saturation would
  // stop being deterministic.
  const firstHash = await fastHash(PASSWORD);
  const secondHash = await fastHash(PASSWORD);

  await withHashCapacityForTests(1, 1, async () => {
    const running = verifyPassword(PASSWORD, firstHash);
    const queued = verifyPassword(PASSWORD, secondHash);

    // First use of the dummy hash happens while the pool is saturated: initialisation
    // fails. Under LAN-2 that failure would have been cached forever.
    await assert.rejects(() => getDummyHash(), isOverload);

    await Promise.allSettled([running, queued]);
  });

  // With the pool idle again, the same call succeeds — the rejected promise was cleared.
  const stored = await getDummyHash();
  assert.match(stored, /^scrypt\$1\$N=131072,r=8,p=1\$/, 'the dummy hash uses the production profile');
  assert.equal(await verifyPassword('not the dummy password', stored), false, 'nobody knows its input');

  // And a successful initialisation is cached: a second call returns the same value.
  assert.equal(await getDummyHash(), stored);
  assert.equal(kdfStats().active, 0);
});

test('an unknown username pays the same one derivation as a known one, and both fail generically', async () => {
  resetDummyHashForTests();
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const { running, baseUrl } = await startTestServer(db);
    try {
      await seedAccount(db, { username: 'amara', role: 'member' });

      const before = kdfStats().invocations;
      const known = await login(baseUrl, 'amara', 'the wrong password entirely');
      const unknown = await login(baseUrl, 'nobody-here', 'the wrong password entirely');
      const spent = kdfStats().invocations - before;

      assert.equal(known.status, 401);
      assert.equal(unknown.status, 401);
      assert.equal(errorCode(known.body), 'auth.invalid_credentials');
      assert.equal(errorCode(unknown.body), 'auth.invalid_credentials');
      assert.ok(spent >= 2, `each failure must pay a derivation (spent ${spent})`);
    } finally {
      await running.close();
    }
  } finally {
    db.close();
    removeDir(dir);
  }
});

test('HTTP sign-in answers 503 for both known and unknown usernames when the pool is full', async () => {
  const dir = tempDataDir();
  const { db } = openMigrated(dir);
  try {
    const { running, baseUrl } = await startTestServer(db);
    try {
      await seedAccount(db, { username: 'amara', role: 'member' });

      // Hold the single slot with a production-cost derivation (~300 ms) and fill the
      // queue behind it. No sleeps: the window is created by work that is already running.
      await withHashCapacityForTests(1, 1, async () => {
        const occupying = hashPassword('occupy the only slot');
        const queued = hashPassword('occupy the queue as well');

        const attempt = (username: string) =>
          postJson<{ error?: { code: string; message: string } }>(baseUrl, '/api/auth/login', {
            username,
            password: 'the wrong password entirely',
          });

        const known = await attempt('amara');
        const unknown = await attempt('nobody-here');

        assert.equal(known.status, 503, 'a known username is told the server is busy');
        assert.equal(unknown.status, 503, 'and so is an unknown one — no enumeration signal');
        assert.equal(errorCode(known.body), 'auth.hash_overloaded');
        assert.equal(errorCode(unknown.body), 'auth.hash_overloaded');
        assert.equal(errorMessage(known.body), errorMessage(unknown.body));
        assert.equal(known.headers.get('cache-control'), 'no-store');

        await Promise.allSettled([occupying, queued]);
      });

      // Once the pool drains, the generic credential response returns for both paths.
      assert.equal((await login(baseUrl, 'amara', 'the wrong password entirely')).status, 401);
      const recovered = await login(baseUrl, 'nobody-here', 'the wrong password entirely');
      assert.equal(recovered.status, 401);
      assert.equal(errorCode(recovered.body), 'auth.invalid_credentials');
      assert.equal(kdfStats().active, 0);
      assert.equal(kdfStats().queued, 0);
    } finally {
      await running.close();
    }
  } finally {
    db.close();
    removeDir(dir);
  }
});
