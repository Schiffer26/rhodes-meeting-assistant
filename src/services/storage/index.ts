// ─────────────────────────────────────────────────────────────
// RHODES · Storage abstraction
//
// PROTOTYPE ADAPTER: browser localStorage.
// This is intentionally isolated behind the StorageAdapter
// interface so a future Electron main-process adapter
// (React Renderer → secure IPC → Main Process → SQLite) can
// replace it without touching any React component.
//
// 1.3.11 — the loader is non-destructive. A payload that cannot be
// parsed or validated is preserved under a snapshot key and left in
// place; it is never replaced with demonstration data. The app then
// starts on empty records and shows a recovery screen (see
// components/RecoveryScreen) so the operator decides what happens next.
// ─────────────────────────────────────────────────────────────
import type { AppData } from "@/types";
import { DEFAULT_SETTINGS } from "@/types";
import { buildSeedData } from "@/data/seed";
import { SCHEMA_VERSION, importRejectionReason, validateAppData } from "@/services/validation";

export const STORAGE_KEY = "rhodes.prototype.db.v1";
/** Preserved copies live beside the live key and are never auto-deleted by a load. */
export const SNAPSHOT_PREFIX = `${STORAGE_KEY}.snapshot.`;
/** Keep a short history: enough to recover, small enough to never crowd the quota. */
export const MAX_SNAPSHOTS = 4;
export const ADAPTER_LABEL = "Browser localStorage (prototype)";

export type RecoveryKind = "corrupt" | "invalid" | "repaired" | "migrated";

export interface RecoveryInfo {
  kind: RecoveryKind;
  /** One sentence for the operator. */
  message: string;
  /** Machine-level detail (parser errors, per-record problems). */
  details: string[];
  /** Key holding the untouched bytes, when a copy could be written. */
  snapshotKey: string | null;
  /** Set when the copy could not be written — the original is still in place. */
  snapshotError?: string;
  /** Original text, kept in memory for the download action. */
  preservedRaw: string | null;
  /**
   * The adapter could not read storage at all, so the payload is unknown: it may
   * or may not exist, cannot be downloaded, and cannot be snapshotted. The store
   * treats this as "preservation unverified" and blocks every write.
   */
  unreadable?: boolean;
  counts: { kept: number; dropped: number };
}

export interface LoadOutcome {
  data: AppData;
  recovery?: RecoveryInfo;
}

export interface StorageAdapter {
  readonly label: string;
  load(): Promise<LoadOutcome | AppData>;
  /**
   * Optional synchronous read used for first-render hydration. Returning the
   * record here lets the startup screen be decided during the very first React
   * render, so no shell content can paint before the boot sequence. Adapters
   * that cannot read synchronously (e.g. a future IPC/SQLite backend) simply
   * omit it and the async `load()` path is used instead.
   */
  loadSync?(): LoadOutcome | AppData | null;
  save(data: AppData): Promise<{ bytes: number }>;
  clear(): Promise<void>;
  usageInfo(): Promise<{ bytes: number; keys: number }>;

  // ── optional snapshot support ────────────────────────────────
  // Optional so an injected adapter (IPC/SQLite, test double) keeps compiling;
  // operations that *require* a recovery snapshot refuse to run without it.
  /** Raw text currently stored, or null. */
  readRaw?(): string | null;
  /** Preserve text under a separate key. */
  snapshot?(raw: string, reason: string): { key: string } | { error: string };
  snapshots?(): { key: string; bytes: number; createdAt: string; reason: string }[];
  readSnapshot?(key: string): string | null;
}

/** Empty but schema-valid record set — the safe ground for an unrecoverable load. */
export function emptyAppData(adapter = "localStorage-prototype"): AppData {
  return {
    meetings: [],
    agendaItems: [],
    personnel: [],
    notes: [],
    decisions: [],
    actionItems: [],
    settings: { ...DEFAULT_SETTINGS },
    meta: { version: 0, firstRunAt: "", adapter, schemaVersion: SCHEMA_VERSION },
  };
}

/** Accept either a bare AppData (legacy/injected adapters) or a LoadOutcome. */
export function normaliseOutcome(value: LoadOutcome | AppData | null): LoadOutcome | null {
  if (!value) return null;
  if (typeof value === "object" && "data" in value && (value as LoadOutcome).data) {
    return value as LoadOutcome;
  }
  return { data: value as AppData };
}

function bytesOf(text: string): number {
  try {
    return new Blob([text]).size;
  } catch {
    return text.length;
  }
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly label = ADAPTER_LABEL;

  /** Write a preserved copy; returns the key or a reason it could not be written. */
  snapshot(raw: string, reason: string): { key: string } | { error: string } {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const key = `${SNAPSHOT_PREFIX}${stamp}.${reason}`;
      window.localStorage.setItem(key, raw);
      this.pruneSnapshots();
      return { key };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  snapshots(): { key: string; bytes: number; createdAt: string; reason: string }[] {
    const out: { key: string; bytes: number; createdAt: string; reason: string }[] = [];
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (!key || !key.startsWith(SNAPSHOT_PREFIX)) continue;
        const raw = window.localStorage.getItem(key) ?? "";
        const tail = key.slice(SNAPSHOT_PREFIX.length);
        const [datePart, reason = "snapshot"] = tail.split(".");
        out.push({ key, bytes: bytesOf(raw), createdAt: datePart ?? "", reason });
      }
    } catch {
      return [];
    }
    return out.sort((a, b) => b.key.localeCompare(a.key));
  }

  readSnapshot(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  readRaw(): string | null {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private pruneSnapshots(): void {
    try {
      const all = this.snapshots();
      for (const entry of all.slice(MAX_SNAPSHOTS)) window.localStorage.removeItem(entry.key);
    } catch {
      /* pruning is best-effort; never fail a save because of it */
    }
  }

  loadSync(): LoadOutcome {
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      // Storage itself is unreadable (blocked, disabled profile). Touch nothing.
      return {
        data: emptyAppData(),
        recovery: {
          kind: "invalid",
          message:
            "RHODES could not access the stored records, so it cannot prove a second copy exists. " +
            "They have been left exactly as they are and writing stays blocked until they can be read.",
          details: [error instanceof Error ? error.message : String(error)],
          snapshotKey: null,
          preservedRaw: null,
          unreadable: true,
          counts: { kept: 0, dropped: 0 },
        },
      };
    }

    // First run — there is nothing to protect, so a demonstration dataset is
    // created. A failed first write must not stop the app from opening.
    if (raw === null) {
      const seed = buildSeedData();
      void this.save(seed).catch(() => undefined);
      return { data: seed };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return this.recover(raw, "corrupt", {
        message: "The stored records are not readable JSON, so they were preserved and left untouched.",
        details: [error instanceof Error ? error.message : String(error), `payload ${bytesOf(raw)} bytes`],
        counts: { kept: 0, dropped: 0 },
      });
    }

    const result = validateAppData(parsed);

    if (!result.usable || !result.data) {
      return this.recover(raw, "invalid", {
        message: "The stored records did not pass validation, so they were preserved and left untouched.",
        details: [...result.fatal, ...result.dropped].slice(0, 6),
        counts: { kept: 0, dropped: result.fatal.length },
      });
    }

    // The payload is usable but had to be altered (records set aside and/or
    // values repaired). The exact original bytes are preserved first; nothing is
    // written over them. If the copy cannot be written the store keeps the
    // console read-only until the operator has a second copy (see
    // `preservationPending` in the store), so the original cannot be lost.
    if (result.dropped.length || result.structural.length) {
      const parts: string[] = [];
      if (result.dropped.length) {
        parts.push(
          `${result.dropped.length} stored ${result.dropped.length === 1 ? "record" : "records"} could not be read and ${result.dropped.length === 1 ? "was" : "were"} set aside.`,
        );
      }
      if (result.structural.length) {
        parts.push(
          `${result.structural.length} ${result.structural.length === 1 ? "value" : "values"} could not be read and ${result.structural.length === 1 ? "was" : "were"} repaired for display.`,
        );
      }
      const saved = this.snapshot(raw, "invalid-records");
      const recovery: RecoveryInfo = {
        kind: "repaired",
        message: `${parts.join(" ")} The rest of the registry is intact.`,
        details: [...result.dropped, ...result.structural].slice(0, 6),
        snapshotKey: "key" in saved ? saved.key : null,
        snapshotError: "error" in saved ? saved.error : undefined,
        preservedRaw: raw,
        counts: {
          kept: result.counts.total,
          dropped: result.dropped.length,
        },
      };
      return { data: result.data, recovery };
    }

    // Migration only (v1 → v2). Shapes are unchanged, so no copy is needed;
    // the upgraded generation is written by the next normal save.
    if (result.migratedFrom !== null) {
      return {
        data: result.data,
        recovery: {
          kind: "migrated",
          message: `Local records were upgraded from schema v${result.migratedFrom} to v${SCHEMA_VERSION}.`,
          details: [],
          snapshotKey: null,
          preservedRaw: null,
          counts: { kept: result.counts.total, dropped: 0 },
        },
      };
    }

    return { data: result.data };
  }

  private recover(
    raw: string,
    kind: RecoveryKind,
    info: { message: string; details: string[]; counts: { kept: number; dropped: number } },
  ): LoadOutcome {
    const saved = this.snapshot(raw, kind);
    return {
      data: emptyAppData(),
      recovery: {
        kind,
        message: info.message,
        details: info.details,
        snapshotKey: "key" in saved ? saved.key : null,
        snapshotError: "error" in saved ? saved.error : undefined,
        preservedRaw: raw,
        counts: info.counts,
      },
    };
  }

  async load(): Promise<LoadOutcome> {
    // `save` writes synchronously behind its async signature, so this resolves
    // with exactly the same record the sync path returns.
    return this.loadSync();
  }

  async save(data: AppData): Promise<{ bytes: number }> {
    const raw = JSON.stringify(data);
    window.localStorage.setItem(STORAGE_KEY, raw);
    return { bytes: bytesOf(raw) };
  }

  async clear(): Promise<void> {
    window.localStorage.removeItem(STORAGE_KEY);
  }

  async usageInfo(): Promise<{ bytes: number; keys: number }> {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY) ?? "";
      let keys = 0;
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && (key === STORAGE_KEY || key.startsWith(SNAPSHOT_PREFIX))) keys++;
      }
      return { bytes: bytesOf(raw), keys };
    } catch {
      return { bytes: 0, keys: 0 };
    }
  }
}

export const storage: StorageAdapter = new LocalStorageAdapter();

/**
 * Loose validation used by JSON backup import.
 *
 * Kept for API compatibility; import now goes through `validateAppData`
 * (strict) via the store, which refuses anything `clean === false`.
 */
export function validateImport(payload: unknown): payload is AppData {
  return validateAppData(payload).clean;
}

/** Short, human-readable rejection reason for an import payload. */
export function describeRejection(payload: unknown): string {
  const result = validateAppData(payload);
  return importRejectionReason(result) || "File does not match the RHODES data schema.";
}
