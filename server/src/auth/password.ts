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
 *   maxmem = 256 MiB    headroom above the ~128 MiB a single hash needs, because Node
 *                       refuses to run scrypt whose allocation exceeds maxmem
 *
 * Measured on the development container (2 vCPU, Node 22.22.3): ~300 ms per hash warm,
 * ~830 ms for the first (cold) run. That cost is the point — it is what makes an
 * offline guessing attack expensive — and it is also why concurrent hashing is capped.
 *
 * ── stored format ───────────────────────────────────────────────────────────
 *
 *   scrypt$1$N=131072,r=8,p=1$<salt base64url>$<key base64url>
 *
 * Self-describing and versioned: a future parameter change can be applied to new
 * passwords while old hashes still verify, and the parameters in the row are validated
 * before they are used, so a corrupted or hostile row cannot make the server allocate
 * an unbounded amount of memory.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { AppError, describeError } from '../errors.js';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const SCRYPT_ALGORITHM = 'scrypt';
export const SCRYPT_VERSION = 1;
export const SCRYPT_PARAMS = Object.freeze({
  N: 131072,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 16,
  maxmem: 256 * 1024 * 1024,
});

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
}

const semaphore: SemaphoreState = {
  active: 0,
  maxConcurrent: MAX_CONCURRENT_HASHES,
  maxQueued: MAX_QUEUED_HASHES,
  queue: [],
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
    return Promise.reject(
      new AppError('auth.hash_overloaded', 'The server is busy. Try again shortly.', {
        httpStatus: 503,
        exposure: 'safe',
      }),
    );
  }

  return new Promise<() => void>((resolve) => {
    semaphore.queue.push(() => resolve(release));
  });
}

/** Test seam: observe the limiter without changing it. */
export function kdfStats(): { active: number; queued: number; maxConcurrent: number; maxQueued: number } {
  return {
    active: semaphore.active,
    queued: semaphore.queue.length,
    maxConcurrent: semaphore.maxConcurrent,
    maxQueued: semaphore.maxQueued,
  };
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

/**
 * Parse and validate a stored hash.
 *
 * Bounds are deliberately narrow: a row claiming N = 2^30 would otherwise ask Node for
 * about a terabyte. Anything outside the window is treated as "cannot verify".
 */
export function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 5) return null;
  const [algorithm, version, parameters, saltText, keyText] = parts;
  if (algorithm !== SCRYPT_ALGORITHM || version !== String(SCRYPT_VERSION)) return null;
  if (!parameters || !saltText || !keyText) return null;

  const match = /^N=(\d{1,7}),r=(\d{1,3}),p=(\d{1,3})$/.exec(parameters);
  if (!match) return null;

  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (!isPowerOfTwo(N) || N < 2 ** 12 || N > 2 ** 20) return null;
  if (r < 1 || r > 32) return null;
  if (p < 1 || p > 16) return null;

  let salt: Buffer;
  let key: Buffer;
  try {
    salt = Buffer.from(saltText, 'base64url');
    key = Buffer.from(keyText, 'base64url');
  } catch {
    return null;
  }
  if (salt.length < 8 || salt.length > 64) return null;
  if (key.length < 32 || key.length > 128) return null;

  return { N, r, p, salt, key };
}

/** Derive a key with the given parameters, honouring the concurrency ceiling. */
async function derive(password: string, salt: Buffer, keyLength: number, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const release = await acquireHashSlot();
  try {
    // maxmem is scaled to the parameters actually used, never smaller than the
    // production ceiling, so an old row with smaller N cannot ask for less headroom
    // than the allocation needs.
    const required = 128 * params.N * params.r * 2;
    const maxmem = Math.max(SCRYPT_PARAMS.maxmem, required);
    return await scryptAsync(password, salt, keyLength, { ...params, maxmem });
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
  const salt = randomBytes(SCRYPT_PARAMS.saltLength);
  const key = await derive(password, salt, SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return [
    SCRYPT_ALGORITHM,
    String(SCRYPT_VERSION),
    `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing for an unreadable or unsupported hash: a damaged
 * row must fail authentication, not crash the login route. Comparison is
 * `timingSafeEqual`, and the derivation uses the parameters recorded in the row.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed || typeof password !== 'string') return false;
  try {
    const derived = await derive(password, parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
    });
    if (derived.length !== parsed.key.length) return false;
    return timingSafeEqual(derived, parsed.key);
  } catch (error) {
    // A resource failure must not look like a wrong password to the caller, but it also
    // must not hang the request: log and behave as "not verified".
    if (error instanceof AppError) throw error;
    return false;
  }
}

/** True when a stored hash predates the current parameters and should be upgraded. */
export function needsRehash(stored: string): boolean {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return true;
  return (
    parsed.N !== SCRYPT_PARAMS.N ||
    parsed.r !== SCRYPT_PARAMS.r ||
    parsed.p !== SCRYPT_PARAMS.p ||
    parsed.key.length !== SCRYPT_PARAMS.keyLength
  );
}

let dummyHashPromise: Promise<string> | null = null;

/**
 * A hash of a random throwaway password, used to give unknown usernames the same work
 * as real ones. Computed lazily and cached; its plaintext is never known to anyone.
 */
export function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(randomBytes(32).toString('base64url'));
  }
  return dummyHashPromise;
}

/**
 * Spend one verification on a throwaway hash.
 *
 * Called when the username does not exist, so that "unknown user" and "wrong password"
 * take comparable time. The boolean is always false and is not meant to be checked.
 */
export async function verifyAgainstDummyHash(password: string): Promise<void> {
  try {
    await verifyPassword(password, await getDummyHash());
  } catch (error) {
    // Timing parity is best-effort under load; never surface this as an auth failure.
    describeError(error);
  }
}

/** SHA-256 in hex — used for session tokens, never for passwords. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
