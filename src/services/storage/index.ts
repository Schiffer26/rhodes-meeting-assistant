// ─────────────────────────────────────────────────────────────
// RHODES · Storage abstraction
//
// PROTOTYPE ADAPTER: browser localStorage.
// This is intentionally isolated behind the StorageAdapter
// interface so a future Electron main-process adapter
// (React Renderer → secure IPC → Main Process → SQLite) can
// replace it without touching any React component.
// ─────────────────────────────────────────────────────────────
import type { AppData } from "@/types";
import { buildSeedData } from "@/data/seed";

export const STORAGE_KEY = "rhodes.prototype.db.v1";
export const ADAPTER_LABEL = "Browser localStorage (prototype)";

export interface StorageAdapter {
  readonly label: string;
  load(): Promise<AppData>;
  /**
   * Optional synchronous read used for first-render hydration. Returning the
   * record here lets the startup screen be decided during the very first React
   * render, so no shell content can paint before the boot sequence. Adapters
   * that cannot read synchronously (e.g. a future IPC/SQLite backend) simply
   * omit it and the async `load()` path is used instead.
   */
  loadSync?(): AppData | null;
  save(data: AppData): Promise<{ bytes: number }>;
  clear(): Promise<void>;
  usageInfo(): Promise<{ bytes: number; keys: number }>;
}

function deepValidate(data: AppData): boolean {
  return (
    !!data &&
    Array.isArray(data.meetings) &&
    Array.isArray(data.agendaItems) &&
    Array.isArray(data.personnel) &&
    Array.isArray(data.notes) &&
    Array.isArray(data.decisions) &&
    Array.isArray(data.actionItems) &&
    typeof data.settings === "object" &&
    data.settings !== null
  );
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly label = ADAPTER_LABEL;

  loadSync(): AppData {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const seed = buildSeedData();
        void this.save(seed);
        return seed;
      }
      const parsed = JSON.parse(raw) as AppData;
      if (!deepValidate(parsed)) throw new Error("Corrupt payload");
      return parsed;
    } catch {
      const seed = buildSeedData();
      void this.save(seed);
      return seed;
    }
  }

  async load(): Promise<AppData> {
    // `save` writes synchronously behind its async signature, so this resolves
    // with exactly the same record the sync path returns.
    return this.loadSync();
  }

  async save(data: AppData): Promise<{ bytes: number }> {
    const raw = JSON.stringify(data);
    window.localStorage.setItem(STORAGE_KEY, raw);
    return { bytes: raw.length };
  }

  async clear(): Promise<void> {
    window.localStorage.removeItem(STORAGE_KEY);
  }

  async usageInfo(): Promise<{ bytes: number; keys: number }> {
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? "";
    let keys = 0;
    for (let i = 0; i < window.localStorage.length; i++) keys++;
    return { bytes: raw.length, keys };
  }
}

export const storage: StorageAdapter = new LocalStorageAdapter();

// Loose validation used by JSON backup import.
export function validateImport(payload: unknown): payload is AppData {
  return deepValidate(payload as AppData);
}
