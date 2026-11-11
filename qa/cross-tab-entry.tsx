// QA entry: cross-tab writer lease (RHODES 1.3.12 · P3-H1 correction).
//
// Mounts two independent stores over ONE shared storage cell and one fake lock
// manager, i.e. the smallest honest model of two browser windows on one origin.
// The fake lock manager implements only what the browser guarantees: exclusive
// requests granted in order, released when the holder's promise settles or the
// holding document is torn down.
//
// Bundled and driven by .qa-cross-tab.mjs.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DataProvider, useAppData } from "@/hooks/store";
import type { AppData } from "@/types";
import type { LoadOutcome, StorageAdapter } from "@/services/storage";

interface TabFlags {
  readOnly?: boolean;
  canWrite?: boolean;
  writeLease?: string;
  data?: string;
  saveCalls?: number;
  syncCalls?: number;
  order?: string[];
  last?: Record<string, unknown>;
  draft?: string | null;
}

interface QaFlags {
  cell: { raw: string | null };
  locks: boolean;
  manualLocks?: boolean;
  releaseLocks?: () => void;
  tabs: TabFlags[];
  unmountTab: (index: number) => void;
  actions: Record<string, (...args: unknown[]) => Promise<unknown>>[];
}

declare global {
  interface Window {
    __qa: QaFlags;
  }
}

const stamp = "2026-01-01T00:00:00.000Z";
const seed = (): AppData => ({
  meetings: [
    {
      id: "m_a", title: "Cross Tab Alpha", purpose: "Fixture", date: "2026-02-02",
      startTime: "09:00", endTime: "10:00", location: "Room A", organizerId: null,
      status: "upcoming", attendeeIds: [], attendance: {}, closingNotes: "",
      nextMeetingDate: "", minuteOverride: null, createdAt: stamp, updatedAt: stamp,
    },
  ],
  agendaItems: [], personnel: [],
  notes: [{ id: "n_1", meetingId: "m_a", content: "<p>BASELINE</p>", createdAt: stamp, updatedAt: stamp }],
  decisions: [], actionItems: [],
  settings: {
    theme: "terminal", motionPreference: "off", startupAnimation: false,
    fontSize: "medium", density: "comfortable", dateFormat: "iso", timeFormat: "24h",
  },
  meta: { version: 1, firstRunAt: stamp, adapter: "qa-cross-tab", schemaVersion: 2 },
});

// ── a minimal, honest Web Locks stand-in ───────────────────────────────────
class FakeLockManager {
  /** When true, requests are only started by `release()`, i.e. a grant that is
   *  still queued — the state a window is in before the browser answers. */
  manual = false;
  releaseAll: () => void = () => {};
  private held = new Set<string>();
  private queue: {
    name: string;
    run: () => Promise<unknown>;
    signal?: AbortSignal;
    start: (value: unknown) => void;
    fail: (error: unknown) => void;
  }[] = [];

  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry = { name, run: callback, signal: options.signal, start: resolve, fail: reject };
      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          const at = this.queue.indexOf(entry);
          if (at >= 0) {
            this.queue.splice(at, 1);
            const error = new Error("AbortError");
            error.name = "AbortError";
            reject(error);
          }
        });
      }
      this.queue.push(entry);
      // The browser never runs the granted callback synchronously with the
      // request; model that. With `manual`, nothing is granted until asked.
      if (!this.manual) queueMicrotask(() => this.pump());
    });
  }

  pump() {
    for (const entry of [...this.queue]) {
      if (this.held.has(entry.name)) continue;
      this.queue.splice(this.queue.indexOf(entry), 1);
      this.held.add(entry.name);
      entry.start(undefined);
      const next = () => { this.held.delete(entry.name); queueMicrotask(() => this.pump()); };
      try {
        void entry.run().then(next, next);
      } catch {
        next();
      }
    }
  }
}

if (window.__qa === undefined) {
  window.__qa = { cell: { raw: null }, locks: true, tabs: [], unmountTab: () => {}, actions: [] };
}
const qa = window.__qa;
if (qa.locks) {
  const manager = new FakeLockManager();
  manager.manual = qa.manualLocks === true;
  qa.releaseLocks = () => { manager.manual = false; manager.pump(); };
  Object.defineProperty(navigator, "locks", { value: manager, configurable: true, writable: true });
}

const content = (raw: string | null): string => {
  try {
    const doc = JSON.parse(raw ?? "{}");
    return (doc.notes || []).find((n: { meetingId: string }) => n.meetingId === "m_a")?.content ?? "";
  } catch {
    return "";
  }
};

function makeAdapter(index: number): StorageAdapter {
  const tab = () => (window.__qa.tabs[index] ??= {});
  return {
    label: `qa-tab-${index}`,
    loadSync: (): LoadOutcome => {
      const cell = window.__qa.cell;
      if (cell.raw === null) {
        const seeded = seed();
        cell.raw = JSON.stringify(seeded);
        return { data: seeded };
      }
      try {
        return { data: JSON.parse(cell.raw) as AppData };
      } catch {
        return { data: seed() };
      }
    },
    save: async (next) => {
      const t = tab();
      t.saveCalls = (t.saveCalls ?? 0) + 1;
      (t.order ??= []).push(`async:${content(JSON.stringify(next))}`);
      await new Promise((r) => setTimeout(r, 20));
      const raw = JSON.stringify(next);
      window.__qa.cell.raw = raw;
      return { bytes: raw.length };
    },
    saveSync: (next) => {
      const t = tab();
      t.syncCalls = (t.syncCalls ?? 0) + 1;
      (t.order ??= []).push(`sync:${content(JSON.stringify(next))}`);
      const raw = JSON.stringify(next);
      window.__qa.cell.raw = raw;
      return { bytes: raw.length };
    },
    readRaw: () => ({ ok: true, raw: window.__qa.cell.raw }) as { ok: true; raw: string | null },
    clear: async () => { window.__qa.cell.raw = null; },
    usageInfo: async () => ({ bytes: window.__qa.cell.raw?.length ?? 0, keys: 1 }),
  };
}

function Probe({ index }: { index: number }) {
  const s = useAppData();
  const tab = (window.__qa.tabs[index] ??= {});

  useEffect(() => s.registerUnloadFlush((commit) => {
    const t = window.__qa.tabs[index];
    if (t.draft == null) return true;
    if (!commit) return false;
    const accepted = s.saveNote("m_a", t.draft);
    t.last = { ...(t.last ?? {}), handover: { accepted } };
    return accepted;
  }), [s, index]);

  useEffect(() => {
    const t = window.__qa.tabs[index];
    t.readOnly = s.readOnly;
    t.canWrite = s.canWrite;
    t.writeLease = s.writeLease;
    t.data = JSON.stringify(s.data).slice(0, 120);
    (window.__qa.actions[index] ??= {}) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    window.__qa.actions[index] = {
      saveNote: (text: string) => {
        const accepted = s.saveNote("m_a", text);
        t.last = { ...(t.last ?? {}), saveNote: accepted };
        return Promise.resolve({ accepted });
      },
      addMeeting: (title: string) => {
        const created = s.createMeeting({
          title, purpose: "", date: "2026-03-03", startTime: "09:00", endTime: "10:00",
          location: "", organizerId: null, attendeeIds: [], agendaDraft: [],
        });
        return Promise.resolve({ id: created?.id ?? null, title: created?.title ?? null });
      },
      flushSync: () => Promise.resolve(s.flushSynchronously()),
      flush: () => s.flush(),
      reload: () => { s.reloadFromStorage(); return Promise.resolve({ ok: true }); },
      tab: () => Promise.resolve(t as unknown),
    };
  });

  return <div id={`tab-${index}`} data-lease={s.writeLease} data-readonly={String(s.readOnly)} />;
}

function Root() {
  const [mounted, setMounted] = useState<boolean[]>([true, true]);
  const unmount = useRef<((index: number) => void) | null>(null);
  unmount.current = (index) => setMounted((m) => m.map((v, i) => (i === index ? false : v)));
  window.__qa.unmountTab = (index) => unmount.current?.(index);
  return (
    <div>
      {mounted[0] && <DataProvider adapter={makeAdapter(0)}><Probe index={0} /></DataProvider>}
      {mounted[1] && <DataProvider adapter={makeAdapter(1)}><Probe index={1} /></DataProvider>}
    </div>
  );
}

qa.tabs = [];
createRoot(document.getElementById("root")!).render(<Root />);
