/**
 * RHODES API · password hashing
 *
 * scrypt from `node:crypto`, asynchronous, with OWASP-recommended parameters. No native
 * dependency, no second crypto library, nothing to keep in step with a compiler.
 *
 * ── why these parameters ────────────────────────────────────────────────────
 *
 *   N = 2^17 (131072)   CPU and memory cost; ~128 MiB per hash at r = 8
 *   r = 8               block size, the OWASP recommendation
 *   p = 1               parallelisation; concurrency is handled by our own limiter
 *   64-byte key         derived key length
 *
 * Measured on the development container (2 vCPU, Node 22.22.3): ~300 ms per hash warm,
 * ~830 ms for the first (cold) run. That cost is the point — it is what makes an
 * offline guessing attack expensive — and it is also why concurrent hashing is capped.
 *
 * ── stored format ───────────────────────────────────────────────────────────
 *
 *   scrypt$1$N=131072,r=8,p=1$<salt base64url>$<key base64url>
 *
 * ── the resource budget (LAN-2.1 correction) ────────────────────────────────
 *
 * A stored hash names its own parameters, so a database row is untrusted input to the
 * hashing code. LAN-2 validated those parameters against a broad *range*, and then sized
 * `maxmem` from the row itself (`max(256 MiB, 128·N·r·2)`) — which meant the row decided
 * how much memory the process would commit. That is a hostile-row memory-exhaustion path:
 * N=2^20 with r=32 asks for gigabytes, and the code would ask Node for it.
 *
 * The correction is an explicit allowlist of profiles plus a fixed budget:
 *
 *   · only profiles in `SUPPORTED_PROFILES` are accepted — the production profile and the
 *     cheaper profile our test fixtures use. Anything else is refused before scrypt runs;
 *   · every profile is checked at module load against `SCRYPT_MAX_MEMORY`, a single
 *     constant that is never derived from a stored row;
 *   · maxmem passed to Node is always that same constant;
 *   · the encoded salt and key are length- and alphabet-checked *before* they are
 *     decoded, so a megabyte-long "salt" is rejected without allocating anything.
 *
 * Hashing always uses the production profile. The cheaper profile exists so verification
 * stays cheap in tests and so a row written under an older cost can still be verified
 * (`needsRehash` then reports that it should be upgraded).
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { AppError } from '../errors.js';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const SCRYPT_ALGORITHM = 'scrypt';
export const SCRYPT_VERSION = 1;

/**
 * The single, hard memory budget for one derivation.
 *
 * 256 MiB is twice what the production profile needs (~128 MiB), and is the ceiling the
 * limiter is sized around: two concurrent hashes at the production profile fit inside
 * half a gigabyte. It is a constant on purpose — nothing read from a database can raise it.
 */
export const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;

export interface ScryptProfile {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
  readonly saltLength: number;
}

/** The profile every new password is hashed with. */
export const PRODUCTION_PROFILE: ScryptProfile = Object.freeze({
  N: 131072,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 16,
});

/**
 * The cheaper profile used by test fixtures.
 *
 * 2^14 is ~40 ms instead of ~300 ms and ~16 MiB instead of ~128 MiB. It is allowlisted so
 * fixtures and any row written under an older cost still verify — never selected for
 * hashing in this codebase. `needsRehash()` flags such a row for upgrade.
 */
export const LEGACY_PROFILE: ScryptProfile = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 16,
});

/** The complete allowlist. Anything not on it is refused before any key derivation. */
export const SUPPORTED_PROFILES: readonly ScryptProfile[] = Object.freeze([PRODUCTION_PROFILE, LEGACY_PROFILE]);

/** Backwards-compatible name for the production profile (the params stored in new rows). */
export const SCRYPT_PARAMS = PRODUCTION_PROFILE;

/** Memory a profile asks scrypt to reserve: 128 · N · r bytes. */
export function profileMemoryBytes(profile: Pick<ScryptProfile, 'N' | 'r'>): number {
  return 128 * profile.N * profile.r;
}

function profileFitsBudget(profile: ScryptProfile): boolean {
  return (
    Number.isInteger(profile.N) &&
    Number.isInteger(profile.r) &&
    Number.isInteger(profile.p) &&
    profile.N > 0 &&
    profile.r > 0 &&
    profile.p > 0 &&
    profile.keyLength > 0 &&
    profile.saltLength > 0 &&
    profileMemoryBytes(profile) <= SCRYPT_MAX_MEMORY
  );
}

// Fail fast at load: an allowlisted profile that cannot fit the budget is a programming
// error, and it must not be discovered on the first login.
for (const profile of SUPPORTED_PROFILES) {
  if (!profileFitsBudget(profile)) {
    throw new Error(
      `scrypt profile N=${profile.N},r=${profile.r},p=${profile.p} exceeds the ${SCRYPT_MAX_MEMORY}-byte budget`,
    );
  }
}

/**
 * Concurrency ceiling.
 *
 * Each hash needs ~128 MiB, so two at once is ~256 MiB — the memory a single office host
 * can spare while it also holds SQLite and the OS cache. Anything beyond the ceiling
 * waits in a bounded queue; when that queue is full the request is refused with 503
 * rather than allowing memory use to grow without limit.
 */
export const MAX_CONCURRENT_HASHES = 2;
export const MAX_QUEUED_HASHES = 64;

interface SemaphoreState {
  active: number;
  maxConcurrent: number;
  maxQueued: number;
  queue: Array<() => void>;
  /** Monotonic count of scrypt calls actually started. Diagnostics and test evidence. */
  invocations: number;
}

const semaphore: SemaphoreState = {
  active: 0,
  maxConcurrent: MAX_CONCURRENT_HASHES,
  maxQueued: MAX_QUEUED_HASHES,
  queue: [],
  invocations: 0,
};

/**
 * Acquire a hashing slot.
 *
 * The released slot is handed straight to the next waiter (increment before waking), so
 * there is no window in which a third caller could observe a free slot and start while
 * the queue is non-empty.
 */
function acquireHashSlot(): Promise<() => void> {
  const release = () => {
    semaphore.active -= 1;
    const next = semaphore.queue.shift();
    if (next) {
      semaphore.active += 1;
      next();
    }
  };

  if (semaphore.active < semaphore.maxConcurrent) {
    semaphore.active += 1;
    return Promise.resolve(release);
  }

  if (semaphore.queue.length >= semaphore.maxQueued) {
    return Promise.reject(hashOverloaded());
  }

  return new Promise<() => void>((resolve) => {
    semaphore.queue.push(() => resolve(release));
  });
}

export function hashOverloaded(): AppError {
  return new AppError('auth.hash_overloaded', 'The server is busy. Try again shortly.', {
    httpStatus: 503,
    exposure: 'safe',
  });
}

/**
 * Observe the limiter.
 *
 * `invocations` counts derivations that actually reached scrypt, which is how the tests
 * prove that a hostile parameter profile — or an oversized password — is rejected *before*
 * any work starts.
 */
export function kdfStats(): {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
  invocations: number;
} {
  return {
    active: semaphore.active,
    queued: semaphore.queue.length,
    maxConcurrent: semaphore.maxConcurrent,
    maxQueued: semaphore.maxQueued,
    invocations: semaphore.invocations,
  };
}

export interface ParsedPasswordHash {
  readonly profile: ScryptProfile;
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PARAMETER_PATTERN = /^N=(\d{1,7}),r=(\d{1,3}),p=(\d{1,3})$/;

/** Length of a byte string encoded as unpadded base64url. */
function encodedLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

function findProfile(N: number, r: number, p: number): ScryptProfile | undefined {
  return SUPPORTED_PROFILES.find((profile) => profile.N === N && profile.r === r && profile.p === p);
}

/**
 * Parse and validate a stored hash.
 *
 * Three gates, in this order, and every one of them happens before scrypt is called:
 *
 *   1. structure — five `$`-separated fields, known algorithm and version, numeric params;
 *   2. policy — the parameters must name an allowlisted profile exactly;
 *   3. size — the encoded salt and key must be exactly the length that profile specifies,
 *      in the base64url alphabet, *before* they are decoded.
 *
 * Anything that fails is "cannot verify", never an exception.
 */
export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  if (typeof stored !== 'string' || stored.length > 1024) return null;

  const parts = stored.split('$');
  if (parts.length !== 5) return null;
  const [algorithm, version, parameters, saltText, keyText] = parts;
  if (algorithm !== SCRYPT_ALGORITHM || version !== String(SCRYPT_VERSION)) return null;
  if (!parameters || !saltText || !keyText) return null;

  const match = PARAMETER_PATTERN.exec(parameters);
  if (!match) return null;

  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);

  // Gate 2: an allowlisted profile, not a range. A row claiming N=2^20, r=32 is simply not
  // a profile this build supports, so it never reaches Node.
  const profile = findProfile(N, r, p);
  if (!profile) return null;

  // Gate 3: refuse an absurd or wrong-shaped encoding before allocating a Buffer for it.
  if (saltText.length !== encodedLength(profile.saltLength) || !BASE64URL.test(saltText)) return null;
  if (keyText.length !== encodedLength(profile.keyLength) || !BASE64URL.test(keyText)) return null;

  const salt = Buffer.from(saltText, 'base64url');
  const key = Buffer.from(keyText, 'base64url');
  // A belt-and-braces check on what decoding actually produced.
  if (salt.length !== profile.saltLength || key.length !== profile.keyLength) return null;

  return { profile, N, r, p, keyLength: profile.keyLength, salt, key };
}

/**
 * Derive a key with an allowlisted profile, honouring the concurrency ceiling.
 *
 * `maxmem` is always `SCRYPT_MAX_MEMORY`. It is never computed from the profile, and the
 * profile can never come from anywhere but the allowlist.
 */
async function derive(password: string, salt: Buffer, profile: ScryptProfile): Promise<Buffer> {
  const release = await acquireHashSlot();
  try {
    semaphore.invocations += 1;
    return await scryptAsync(password, salt, profile.keyLength, {
      N: profile.N,
      r: profile.r,
      p: profile.p,
      maxmem: SCRYPT_MAX_MEMORY,
    });
  } finally {
    release();
  }
}

/** Hash a password with the current parameters. Returns the self-describing string. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new AppError('auth.invalid_password', 'A password is required.', {
      httpStatus: 400,
      exposure: 'safe',
    });
  }
  const profile = PRODUCTION_PROFILE;
  const salt = randomBytes(profile.saltLength);
  const key = await derive(password, salt, profile);
  return [
    SCRYPT_ALGORITHM,
    String(SCRYPT_VERSION),
    `N=${profile.N},r=${profile.r},p=${profile.p}`,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing for an unreadable or unsupported hash: a damaged row
 * must fail authentication, not crash the login route. Comparison is `timingSafeEqual`.
 * A resource failure (`auth.hash_overloaded`) propagates — it is not a wrong password.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed || typeof password !== 'string') return false;
  try {
    const derived = await derive(password, parsed.salt, parsed.profile);
    if (derived.length !== parsed.key.length) return false;
    return timingSafeEqual(derived, parsed.key);
  } catch (error) {
    if (error instanceof AppError) throw error;
    return false;
  }
}

/** True when a stored hash does not use the current production profile. */
export function needsRehash(stored: string): boolean {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return true;
  return (
    parsed.N !== PRODUCTION_PROFILE.N ||
    parsed.r !== PRODUCTION_PROFILE.r ||
    parsed.p !== PRODUCTION_PROFILE.p ||
    parsed.key.length !== PRODUCTION_PROFILE.keyLength
  );
}

let dummyHashPromise: Promise<string> | null = null;

/**
 * A hash of a random throwaway password, used to give unknown usernames the same work as
 * real ones. Computed lazily and cached; its plaintext is never known to anyone.
 *
 * If the computation fails — for example because the KDF queue is saturated — the cached
 * promise is cleared, so a transient failure cannot permanently disable dummy
 * verification (LAN-2.1 correction).
 */
export function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(randomBytes(32).toString('base64url')).catch((error: unknown) => {
      dummyHashPromise = null;
      throw error;
    });
  }
  return dummyHashPromise;
}

/**
 * Test seam: forget the cached dummy hash, so its lazy initialisation can be observed
 * from the start. Tests run in their own process, but ordering within a file is not
 * something a security test should have to depend on.
 */
export function resetDummyHashForTests(): void {
  dummyHashPromise = null;
}

/**
 * Spend one verification on a throwaway hash.
 *
 * Called when the username does not exist, so that "unknown user" and "wrong password"
 * take comparable time.
 *
 * Overload is propagated, not swallowed (LAN-2.1 correction). If this swallowed it, an
 * unknown username would receive a generic 401 during KDF saturation while a known
 * username received 503 — an enumeration signal in the one place we cannot afford one.
 * Both paths now surface the same `auth.hash_overloaded` error.
 */
export async function verifyAgainstDummyHash(password: string): Promise<void> {
  const stored = await getDummyHash();
  await verifyPassword(password, stored);
}

/**
 * Test seam: run `body` with a smaller limiter.
 *
 * Proving "no KDF slot is available" by launching 67 real derivations would cost seconds
 * of CPU per test; shrinking the limiter proves exactly the same code path in
 * milliseconds. It refuses to run while work is in flight, and always restores the
 * configured values.
 */
export async function withHashCapacityForTests<T>(concurrent: number, queued: number, body: () => Promise<T>): Promise<T> {
  if (semaphore.active !== 0 || semaphore.queue.length !== 0) {
    throw new Error('withHashCapacityForTests requires an idle limiter');
  }
  const previous = { concurrent: semaphore.maxConcurrent, queued: semaphore.maxQueued };
  semaphore.maxConcurrent = concurrent;
  semaphore.maxQueued = queued;
  try {
    return await body();
  } finally {
    semaphore.maxConcurrent = previous.concurrent;
    semaphore.maxQueued = previous.queued;
  }
}

/** SHA-256 in hex — used for session tokens, never for passwords. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
