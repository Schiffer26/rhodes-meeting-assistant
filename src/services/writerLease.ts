// ─────────────────────────────────────────────────────────────
// RHODES · Single-writer lease (1.3.12 Phase 3 follow-up)
//
// The lifecycle flush writes the document the *window* holds. Two windows on the
// same origin therefore used to be able to put their own (different) document on
// top of each other: whichever was hidden last won, and the other window's
// records were lost. That is a real data-loss path, not a theoretical race —
// see the Phase 3 follow-up report.
//
// The fix is to let exactly one window write. The Web Locks API provides that
// lease *in the browser's lock manager*, shared by every window of the origin
// and released automatically when the owning document goes away — including a
// crash, which no `setTimeout` heartbeat could survive. It is a real mutual
// exclusion primitive: the second window's request is queued by the browser, not
// polled by us.
//
// A read-then-write comparison on `localStorage` (which the store still does as
// a second line of defence) can NOT do this: `getItem` + `setItem` is not an
// atomic compare-and-swap, so two windows can interleave between the two calls.
// It only narrows the window; the lease closes it.
// ─────────────────────────────────────────────────────────────
export const WRITER_LOCK = "rhodes.prototype.writer.v1";

/** Who may write from this window, and why. */
export type WriterLeaseState =
  /** Lease not decided yet (first render). */
  | "pending"
  /** This window holds the lease and may write. */
  | "owner"
  /** Another window holds the lease: records are visible but read-only here. */
  | "waiting"
  /** The browser has no Web Locks API: mutual exclusion cannot be guaranteed. */
  | "unsupported";

type LockManagerLike = {
  request(
    name: string,
    options: { mode: "exclusive"; signal?: AbortSignal },
    callback: () => Promise<unknown>,
  ): Promise<unknown>;
};

function lockManager(): LockManagerLike | null {
  const locks = typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { locks?: Partial<LockManagerLike> }).locks;
  return locks && typeof locks.request === "function" ? (locks as LockManagerLike) : null;
}

/** Whether this browser can provide a cross-window mutual exclusion primitive. */
export function supportsWriterLease(): boolean {
  return lockManager() !== null;
}

export interface WriterLeaseHandle {
  /** Give the lease up (the queued window is granted it next). Idempotent. */
  release: () => void;
}

/**
 * Request the exclusive writer lease and hold it for the life of the document.
 *
 * `onGranted` runs when this window becomes the writer — immediately if it is
 * the only window, or later when the current owner goes away. Nothing here polls
 * or re-tries: the browser's lock queue does the waiting, and the lock is
 * released by the browser when the document is destroyed even if `release()` is
 * never called.
 *
 * Returns `null` when the browser has no Web Locks API.
 */
export function acquireWriterLease(
  onGranted: () => void,
  onError?: (error: unknown) => void,
  name: string = WRITER_LOCK,
): WriterLeaseHandle | null {
  const locks = lockManager();
  if (!locks) return null;

  let settle: (() => void) | null = null;
  let released = false;
  const controller = new AbortController();

  void locks
    .request(name, { mode: "exclusive", signal: controller.signal }, () => {
      if (released) return Promise.resolve();      // given up while queued
      return new Promise<void>((resolve) => {
        settle = resolve;
        try {
          onGranted();
        } catch (error) {
          // A throwing callback must not keep the lease held forever.
          onError?.(error);
          released = true;
          resolve();
        }
      });
    })
    .catch((error: unknown) => { onError?.(error); });

  return {
    release() {
      if (released) return;
      released = true;
      if (settle) settle();          // we held it: resolving releases it
      else controller.abort();       // still queued: withdraw the request
    },
  };
}
