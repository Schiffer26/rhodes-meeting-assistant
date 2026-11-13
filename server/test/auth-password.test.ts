/**
 * Password storage and the key-derivation limiter.
 *
 * The properties that matter, and nothing else:
 *   · a password is never stored, only a salted scrypt hash;
 *   · the same password hashes differently every time (fresh random salt);
 *   · the stored format describes itself, so parameters can change without breaking
 *     existing rows — and a row claiming absurd parameters is refused, not obeyed;
 *   · passwords are handled byte for byte: no trimming, no normalisation, no truncation,
 *     and the 128-character ceiling is enforced before any key derivation runs;
 *   · no more than a fixed number of hashes run at once, with a bounded queue behind them.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '../src/errors.js';
import {
  MAX_CONCURRENT_HASHES,
  MAX_QUEUED_HASHES,
  hashPassword,
  kdfStats,
  needsRehash,
  parsePasswordHash,
  SCRYPT_PARAMS,
  verifyPassword,
} from '../src/auth/password.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordLength, validatePassword } from '../src/auth/policy.js';
import { fastHash, TEST_SCRYPT } from './auth-helpers.js';

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

test('a stored hash with unsupported or dangerous parameters is refused, not executed', async () => {
  const good = await fastHash('a sufficiently long passphrase');
  const [, , , salt, key] = good.split('$');

  const cases = [
    '',
    'not-a-hash',
    `bcrypt$1$N=${TEST_SCRYPT.N},r=8,p=1$${salt}$${key}`,
    `scrypt$2$N=${TEST_SCRYPT.N},r=8,p=1$${salt}$${key}`,
    `scrypt$1$N=1024,r=8,p=1$${salt}$${key}`, // below the floor
    `scrypt$1$N=1073741824,r=8,p=1$${salt}$${key}`, // a gigabyte-scale N: must not be obeyed
    `scrypt$1$N=16384,r=64,p=1$${salt}$${key}`, // r out of range
    `scrypt$1$N=16384,r=8,p=1$${salt}`, // truncated
    `scrypt$1$N=16384,r=8,p=1$$${key}`, // no salt
    `scrypt$1$N=16384,r=8,p=1$${salt}$${salt}`, // key too short
  ];

  for (const candidate of cases) {
    assert.equal(parsePasswordHash(candidate), null, `must not parse: ${candidate.slice(0, 40)}`);
    // A damaged row fails authentication; it never throws out of the verify path.
    assert.equal(await verifyPassword('a sufficiently long passphrase', candidate), false);
  }
});

test('needsRehash reports whether a stored hash predates the current parameters', async () => {
  const weak = await fastHash('a sufficiently long passphrase');
  assert.equal(needsRehash(weak), true, 'a lower-cost fixture hash should be upgraded');
  assert.equal(needsRehash('garbage'), true, 'an unreadable hash should be replaced');

  const current = await hashPassword('a sufficiently long passphrase');
  assert.equal(needsRehash(current), false);
});

test('hashing is bounded: a fixed number run at once, the rest wait in a bounded queue', async () => {
  const stored = await fastHash('a sufficiently long passphrase');
  assert.deepEqual(kdfStats().active, 0);
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
  assert.deepEqual(kdfStats(), { active: 0, queued: 0, maxConcurrent: 2, maxQueued: 64 });
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
  assert.deepEqual(kdfStats(), { active: 0, queued: 0, maxConcurrent: 2, maxQueued: 64 });
});
