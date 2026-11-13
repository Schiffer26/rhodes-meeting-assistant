/**
 * RHODES API · login throttling
 *
 * Two independent keys per attempt: the normalised username and the source address.
 * Both must be inside their allowance for a sign-in to be attempted, so hammering one
 * account from one address is slowed, and spraying many usernames from one address is
 * slowed too.
 *
 * ── what this is not ────────────────────────────────────────────────────────
 *
 * The state is in memory, in one process. It resets when the service restarts, and it is
 * not shared with a second instance. That is an accepted limitation for this phase,
 * which runs a single loopback-bound backend; it is recorded in ARCHITECTURE.md.
 *
 * Because the phase is loopback-only, several real users on the same host can share one
 * visible source address. The IP allowance is therefore looser than the per-account one
 * — it exists to stop a single runaway client, not to punish a shared office router.
 *
 * ── memory bound ────────────────────────────────────────────────────────────
 *
 * Both maps are capped. Attempts arrive with attacker-chosen usernames, so an uncapped
 * map would be a memory exhaustion vector: when the cap is reached the oldest entry is
 * evicted (Map preserves insertion order), which also keeps the hot recent keys.
 */

export interface RateLimiterOptions {
  /** Failures allowed per key inside one window before a cooldown starts. */
  readonly maxAttempts: number;
  /** Rolling window in milliseconds. */
  readonly windowMs: number;
  /** How long a key stays blocked once the allowance is used up. */
  readonly cooldownMs: number;
  /** Hard cap on remembered keys, per map. */
  readonly maxEntries: number;
  /** Injectable clock, in epoch milliseconds. */
  readonly now?: () => number;
}

interface Entry {
  count: number;
  windowStartedAt: number;
  blockedUntil: number;
}

export interface RateVerdict {
  readonly allowed: boolean;
  /** Seconds the caller should wait, when blocked. */
  readonly retryAfterSeconds: number;
}

const DEFAULT_OPTIONS: RateLimiterOptions = {
  maxAttempts: 10,
  windowMs: 15 * 60 * 1000,
  cooldownMs: 15 * 60 * 1000,
  maxEntries: 5000,
};

function verdictFor(entry: Entry, nowMs: number): RateVerdict {
  if (entry.blockedUntil > nowMs) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.blockedUntil - nowMs) / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

class BoundedCounter {
  readonly #entries = new Map<string, Entry>();
  readonly #options: Required<RateLimiterOptions>;

  constructor(options: Required<RateLimiterOptions>) {
    this.#options = options;
  }

  #set(key: string, entry: Entry): void {
    if (this.#entries.size >= this.#options.maxEntries && !this.#entries.has(key)) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    // Re-insert so the key becomes the most recent for eviction purposes.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  check(key: string): RateVerdict {
    const entry = this.#entries.get(key);
    if (!entry) return { allowed: true, retryAfterSeconds: 0 };
    return verdictFor(entry, this.#options.now());
  }

  recordFailure(key: string): RateVerdict {
    const nowMs = this.#options.now();
    const existing = this.#entries.get(key);

    if (!existing || nowMs - existing.windowStartedAt >= this.#options.windowMs) {
      const fresh: Entry = { count: 1, windowStartedAt: nowMs, blockedUntil: 0 };
      this.#set(key, fresh);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    existing.count += 1;
    if (existing.count >= this.#options.maxAttempts) {
      existing.blockedUntil = nowMs + this.#options.cooldownMs;
      existing.count = 0;
      existing.windowStartedAt = nowMs;
    }
    this.#set(key, existing);
    return verdictFor(existing, nowMs);
  }

  clear(key: string): void {
    this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }

  prune(): void {
    const nowMs = this.#options.now();
    for (const [key, entry] of this.#entries) {
      const stale = nowMs - entry.windowStartedAt >= this.#options.windowMs && entry.blockedUntil <= nowMs;
      if (stale) this.#entries.delete(key);
    }
  }
}

export class LoginRateLimiter {
  readonly #usernames: BoundedCounter;
  readonly #addresses: BoundedCounter;

  constructor(options: Partial<RateLimiterOptions> = {}) {
    const resolved: Required<RateLimiterOptions> = {
      maxAttempts: options.maxAttempts ?? DEFAULT_OPTIONS.maxAttempts,
      windowMs: options.windowMs ?? DEFAULT_OPTIONS.windowMs,
      cooldownMs: options.cooldownMs ?? DEFAULT_OPTIONS.cooldownMs,
      maxEntries: options.maxEntries ?? DEFAULT_OPTIONS.maxEntries,
      // Usernames are throttled harder than addresses: a shared office address must not
      // let one person's mistakes lock out their colleagues.
      now: options.now ?? Date.now,
    };
    this.#usernames = new BoundedCounter(resolved);
    this.#addresses = new BoundedCounter({ ...resolved, maxAttempts: resolved.maxAttempts * 3 });
  }

  check(username: string, address: string): RateVerdict {
    const byUsername = this.#usernames.check(username);
    if (!byUsername.allowed) return byUsername;
    return this.#addresses.check(address);
  }

  recordFailure(username: string, address: string): RateVerdict {
    const byUsername = this.#usernames.recordFailure(username);
    const byAddress = this.#addresses.recordFailure(address);
    return byUsername.allowed ? byAddress : byUsername;
  }

  /** A successful sign-in clears that username's strikes; the address keeps its history. */
  recordSuccess(username: string): void {
    this.#usernames.clear(username);
  }

  /** Test seam. */
  stats(): { usernames: number; addresses: number } {
    return { usernames: this.#usernames.size, addresses: this.#addresses.size };
  }

  prune(): void {
    this.#usernames.prune();
    this.#addresses.prune();
  }
}
