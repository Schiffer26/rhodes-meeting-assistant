/**
 * Password storage, the resource budget and the key-derivation limiter.
 *
 * The properties that matter, and nothing else:
 *   · a password is never stored, only a salted scrypt hash;
 *   · the same password hashes differently every time (fresh random salt);
 *   · the stored format describes itself, but only allowlisted profiles are obeyed — a
 *     row cannot choose how much memory this process commits (LAN-2.1);
 *   · encoded salts and keys are size-checked before they are decoded;
 *   · passwords are handled byte for byte: no trimming, no normalisation, no truncation,
 *     and the 128-character ceiling is enforced before any key derivation runs;
 *   · no more than a fixed number of hashes run at once, with a bounded queue behind them.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '../src/errors.js';
import {
  hashPassword,
  kdfStats,
  LEGACY_PROFILE,
  MAX_CONCURRENT_HASHES,
  MAX_QUEUED_HASHES,
  needsRehash,
  parsePasswordHash,
  PRODUCTION_PROFILE,
  profileMemoryBytes,
  SCRYPT_MAX_MEMORY,
  SCRYPT_PARAMS,
  SUPPORTED_PROFILES,
  verifyPassword,
} from '../src/auth/password.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordLength, validatePassword } from '../src/auth/policy.js';
import { fastHash, TEST_SCRYPT } from './auth-helpers.js';

/** How many derivations have actually reached scrypt. */
function invocations(): number {
  return kdfStats().invocations;
}

test('a password is never stored: the hash is self-describing and contains no plaintext', async () => {
  const password = 'a sufficiently long passphrase';
  const stored = await hashPassword(password);

  assert.notEqual(stored, password);
  assert.ok(!stored.includes(password), 'the stored value must not contain the password');
  assert.equal(
    stored,
    `scrypt$1$N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}` +
      `$${stored.split('$')[3]}` +
      `$${stored.split('$')[4]}`,
    'the format is algorithm$version$params$salt$key',
  );

  const parsed = parsePasswordHash(stored);
  assert.ok(parsed);
  assert.equal(parsed.N, 131072);
  assert.equal(parsed.r, 8);
  assert.equal(parsed.p, 1);
  assert.equal(parsed.salt.length, 16);
  assert.equal(parsed.key.length, 64);
  assert.equal(parsed.profile, PRODUCTION_PROFILE);
});

test('the same password hashes differently every time, because the salt is random', async () => {
  const password = 'a sufficiently long passphrase';
  const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);

  assert.notEqual(first, second, 'two hashes of the same password must differ');
  assert.notEqual(parsePasswordHash(first)?.salt.toString('hex'), parsePasswordHash(second)?.salt.toString('hex'));
  assert.notEqual(parsePasswordHash(first)?.key.toString('hex'), parsePasswordHash(second)?.key.toString('hex'));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password, second), true);
});

test('verification accepts the exact password and rejects a wrong one', async () => {
  const stored = await fastHash('the exact passphrase');
  assert.equal(await verifyPassword('the exact passphrase', stored), true);
  assert.equal(await verifyPassword('the exact passphras', stored), false);
  assert.equal(await verifyPassword('The exact passphrase', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('passwords are not trimmed, normalised or truncated', async () => {
  // Leading/trailing spaces are part of the secret: a paste that kept one must still work.
  const spaced = '   padded passphrase   ';
  const spacedHash = await fastHash(spaced);
  assert.equal(await verifyPassword(spaced, spacedHash), true);
  assert.equal(await verifyPassword(spaced.trim(), spacedHash), false);

  // Canonically equivalent Unicode is still different bytes: NFC and NFD do not verify
  // against one another, because nothing normalises the password.
  const nfc = 'passe\u0301phrase-of-length'; // decomposed
  const nfd = nfc.normalize('NFC');
  assert.notEqual(nfc, nfd, 'the fixture must actually differ');
  const nfdHash = await fastHash(nfd);
  assert.equal(await verifyPassword(nfd, nfdHash), true);
  assert.equal(await verifyPassword(nfc, nfdHash), false);
});

test('Unicode passwords round-trip, and length is counted in code points', async () => {
  const password = '🔐会议密码-пароль-ok';
  assert.equal(passwordLength(password) >= PASSWORD_MIN_LENGTH, true);
  validatePassword(password);

  const stored = await fastHash(password);
  assert.equal(await verifyPassword(password, stored), true);

  // Fifteen emoji are fifteen characters, not thirty UTF-16 units.
  const fifteenEmoji = '🔐'.repeat(15);
  assert.equal(passwordLength(fifteenEmoji), 15);
  validatePassword(fifteenEmoji);
});

test('the policy floor and ceiling are enforced, and nothing else is', () => {
  assert.throws(
    () => validatePassword('x'.repeat(PASSWORD_MIN_LENGTH - 1)),
    (error: unknown) => error instanceof AppError && error.code === 'auth.password_too_short',
  );
  assert.equal(validatePassword('x'.repeat(PASSWORD_MIN_LENGTH)), 'x'.repeat(PASSWORD_MIN_LENGTH));
  assert.equal(validatePassword('x'.repeat(PASSWORD_MAX_LENGTH)), 'x'.repeat(PASSWORD_MAX_LENGTH));
  assert.throws(
    () => validatePassword('x'.repeat(PASSWORD_MAX_LENGTH + 1)),
    (error: unknown) => error instanceof AppError && error.code === 'auth.password_too_long',
  );
  // No composition rules: an all-lowercase passphrase is perfectly acceptable.
  validatePassword('a long but boring lowercase passphrase');
});

// ── LAN-2.1: the resource budget ──────────────────────────────────────────────

test('the allowlist is exactly two profiles, and every one of them fits the memory budget', () => {
  assert.deepEqual(SUPPORTED_PROFILES, [PRODUCTION_PROFILE, LEGACY_PROFILE]);
  assert.equal(PRODUCTION_PROFILE.N, 131072);
  assert.equal(PRODUCTION_PROFILE.r, 8);
  assert.equal(PRODUCTION_PROFILE.p, 1);
  assert.equal(SCRYPT_MAX_MEMORY, 256 * 1024 * 1024);

  for (const profile of SUPPORTED_PROFILES) {
    assert.ok(
      profileMemoryBytes(profile) <= SCRYPT_MAX_MEMORY,
      `N=${profile.N},r=${profile.r} needs ${profileMemoryBytes(profile)} bytes`,
    );
  }
  // The production profile is the expensive one, and it still fits: 128 MiB of the 256 MiB.
  assert.equal(profileMemoryBytes(PRODUCTION_PROFILE), 128 * 1024 * 1024);
  assert.equal(profileMemoryBytes(LEGACY_PROFILE), 16 * 1024 * 1024);
});

test('the production profile verifies, and the cheaper historical profile still verifies', async () => {
  const production = await hashPassword('a production cost passphrase');
  assert.equal(parsePasswordHash(production)?.profile, PRODUCTION_PROFILE);
  assert.equal(await verifyPassword('a production cost passphrase', production), true);
  assert.equal(needsRehash(production), false);

  const legacy = await fastHash('a legacy cost passphrase');
  assert.equal(parsePasswordHash(legacy)?.profile, LEGACY_PROFILE);
  assert.equal(await verifyPassword('a legacy cost passphrase', legacy), true);
  assert.equal(needsRehash(legacy), true, 'a cheaper row is flagged for upgrade, and still works');
});

test('an unsupported profile is rejected before scrypt is ever called', async () => {
  const salt = 'a'.repeat(22);
  const key = 'b'.repeat(86);
  const before = invocations();

  // The exact profile the review named: N=2^20, r=32, p=16 — a few gigabytes if obeyed.
  const hostile = `scrypt$1$N=1048576,r=32,p=16$${salt}$${key}`;
  assert.equal(parsePasswordHash(hostile), null);
  assert.equal(await verifyPassword('anything at all here', hostile), false);

  // Other profiles that are numerically plausible but not on the allowlist.
  for (const parameters of [
    'N=1048576,r=8,p=1', // bigger N, same r
    'N=262144,r=8,p=1', // bigger N, one step
    'N=131072,r=16,p=1', // production N, doubled r
    'N=131072,r=8,p=2', // production N, doubled p
    'N=16384,r=4,p=1', // legacy N, halved r
    'N=4096,r=8,p=1', // below the old floor
    'N=131072,r=8', // missing a parameter
  ]) {
    const candidate = `scrypt$1$${parameters}$${salt}$${key}`;
    assert.equal(parsePasswordHash(candidate), null, `must not accept ${parameters}`);
    assert.equal(await verifyPassword('anything at all here', candidate), false);
  }

  assert.equal(invocations(), before, 'no key derivation may run for a rejected profile');
});

test('encoded salts and keys are length-checked before they are decoded', async () => {
  const before = invocations();
  const good = await fastHash('a sufficiently long passphrase');
  const [, , parameters, salt, key] = good.split('$') as [string, string, string, string, string];

  const oversized = [
    `scrypt$1$${parameters}$${'A'.repeat(5_000)}$${key}`,
    `scrypt$1$${parameters}$${'A'.repeat(1_000_000)}$${key}`,
    `scrypt$1$${parameters}$${salt}$${'B'.repeat(5_000)}`,
    `scrypt$1$${parameters}$${salt}$${'B'.repeat(1_000_000)}`,
    `scrypt$1$${parameters}$${salt}$${'B'.repeat(1_000_000)}${'C'.repeat(1_000_000)}`,
    // Right length, wrong alphabet: refused before decoding.
    `scrypt$1$${parameters}$${salt.slice(0, -1)}!$${key}`,
    `scrypt$1$${parameters}$${salt}$${key.slice(0, -1)}+`,
    // Right alphabet, wrong length.
    `scrypt$1$${parameters}$${salt}A$${key}`,
    `scrypt$1$${parameters}$${salt}$${key}A}`,
    // Padding is not part of this format.
    `scrypt$1$${parameters}$${salt}==$${key}`,
  ];

  for (const candidate of oversized) {
    const started = process.hrtime.bigint();
    assert.equal(parsePasswordHash(candidate), null);
    assert.equal(await verifyPassword('a sufficiently long passphrase', candidate), false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 50, `rejection took ${elapsedMs.toFixed(1)} ms — it should be immediate`);
  }

  assert.equal(invocations(), before, 'no key derivation may run for a malformed encoding');
});

test('a whole stored hash is bounded in size before it is parsed', async () => {
  const before = invocations();
  const enormous = `scrypt$1$N=131072,r=8,p=1$${'a'.repeat(2_000_000)}$${'b'.repeat(2_000_000)}`;
  assert.equal(parsePasswordHash(enormous), null);
  assert.equal(await verifyPassword('irrelevant password', enormous), false);
  assert.equal(invocations(), before);
});

test('a stored hash with unreadable content fails authentication instead of throwing', async () => {
  for (const candidate of ['', 'not-a-hash', 'scrypt', 'scrypt$1$N=131072,r=8,p=1', 'bcrypt$1$N=131072,r=8,p=1$aa$bb']) {
    assert.equal(parsePasswordHash(candidate), null);
    assert.equal(await verifyPassword('a sufficiently long passphrase', candidate), false);
  }
});

test('needsRehash reports whether a stored hash uses anything but the production profile', async () => {
  const weak = await fastHash('a sufficiently long passphrase');
  assert.equal(needsRehash(weak), true);
  assert.equal(needsRehash('garbage'), true);

  const current = await hashPassword('a sufficiently long passphrase');
  assert.equal(needsRehash(current), false);
});

test('hashing is bounded: a fixed number run at once, the rest wait in a bounded queue', async () => {
  const stored = await fastHash('a sufficiently long passphrase');
  const idle = kdfStats();
  assert.equal(idle.active, 0);
  assert.equal(MAX_CONCURRENT_HASHES, 2);
  assert.equal(MAX_QUEUED_HASHES, 64);

  let peak = 0;
  const sampling = setInterval(() => {
    peak = Math.max(peak, kdfStats().active);
  }, 2);

  const attempts = Array.from({ length: MAX_CONCURRENT_HASHES + 6 }, () =>
    verifyPassword('a sufficiently long passphrase', stored),
  );
  const results = await Promise.all(attempts);
  clearInterval(sampling);

  assert.ok(results.every(Boolean), 'every queued verification should still succeed');
  assert.ok(peak <= MAX_CONCURRENT_HASHES, `concurrency peaked at ${peak}, above the ceiling`);
  const after = kdfStats();
  assert.equal(after.active, 0);
  assert.equal(after.queued, 0);
  assert.equal(after.maxConcurrent, MAX_CONCURRENT_HASHES);
  assert.equal(after.maxQueued, MAX_QUEUED_HASHES);
  assert.equal(after.invocations, idle.invocations + attempts.length);
});

test('a full queue is refused with 503 instead of growing without limit', async () => {
  const stored = await fastHash('a sufficiently long passphrase');
  const total = MAX_CONCURRENT_HASHES + MAX_QUEUED_HASHES + 1;

  const attempts = Array.from({ length: total }, () => verifyPassword('a sufficiently long passphrase', stored));
  const settled = await Promise.allSettled(attempts);

  const rejected = settled.filter((entry) => entry.status === 'rejected');
  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
  assert.equal(rejected.length, 1, 'exactly one caller is turned away when the queue is full');
  assert.equal(fulfilled.length, total - 1);

  const failure = rejected[0] as PromiseRejectedResult;
  assert.ok(failure.reason instanceof AppError);
  assert.equal(failure.reason.code, 'auth.hash_overloaded');
  assert.equal(failure.reason.httpStatus, 503);

  // The limiter returns to a clean idle state: no leaked slots.
  const after = kdfStats();
  assert.equal(after.active, 0);
  assert.equal(after.queued, 0);
});

test('the test capacity seam shrinks the limiter, rejects overflow, and always restores it', async () => {
  const stored = await fastHash('a sufficiently long passphrase');
  const { withHashCapacityForTests } = await import('../src/auth/password.js');

  await withHashCapacityForTests(1, 1, async () => {
    assert.deepEqual({ c: kdfStats().maxConcurrent, q: kdfStats().maxQueued }, { c: 1, q: 1 });

    const first = verifyPassword('a sufficiently long passphrase', stored); // runs
    const second = verifyPassword('a sufficiently long passphrase', stored); // queued
    const third = verifyPassword('a sufficiently long passphrase', stored); // refused

    const settled = await Promise.allSettled([first, second, third]);
    assert.deepEqual(settled.map((entry) => entry.status), ['fulfilled', 'fulfilled', 'rejected']);
    const failure = settled[2] as PromiseRejectedResult;
    assert.equal((failure.reason as AppError).code, 'auth.hash_overloaded');
  });

  assert.equal(kdfStats().maxConcurrent, MAX_CONCURRENT_HASHES, 'capacity is restored');
  assert.equal(kdfStats().maxQueued, MAX_QUEUED_HASHES);
});

test('the fixture profile is the cheaper one, and the production profile is not used by fixtures', async () => {
  assert.equal(TEST_SCRYPT.N, LEGACY_PROFILE.N);
  const fixture = await fastHash('a fixture passphrase');
  assert.match(fixture, /^scrypt\$1\$N=16384,r=8,p=1\$/);
  assert.notEqual(parsePasswordHash(fixture)?.profile, PRODUCTION_PROFILE);
});
