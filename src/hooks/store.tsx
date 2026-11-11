// ─────────────────────────────────────────────────────────────
// RHODES · Application data store (React context)
// All persistence flows through the StorageAdapter so the
// Electron + SQLite swap only touches services/storage.
// ─────────────────────────────────────────────────────────────
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionItem, AgendaItem, AgendaStatus, AppData, AppSettings, AttendanceStatus,
  Decision, Meeting, MeetingStatus, Person, Priority, SaveState, TaskStatus,
} from "@/types";
import { DEFAULT_SETTINGS } from "@/types";
import { emptyAppData, normaliseOutcome, storage } from "@/services/storage";
import type { LoadOutcome, RecoveryInfo, StorageAdapter } from "@/services/storage";
import { importRejectionReason, validateAppData } from "@/services/validation";
import { buildSeedData } from "@/data/seed";
import { todayISO, uid } from "@/utils/helpers";

export interface MeetingInput {
  title: string; purpose: string; date: string; startTime: string; endTime: string;
  location: string; organizerId: ID | null; attendeeIds: ID[];
  agendaDraft: { title: string; minutes: number }[];
}
type ID = string;

export interface Store {
  ready: boolean;
  data: AppData;
  saveState: SaveState;
  // meetings
  createMeeting: (input: MeetingInput) => Meeting;
  updateMeeting: (id: ID, patch: Partial<Meeting>) => void;
  deleteMeeting: (id: ID) => Promise<DestructiveResult>;
  setMeetingStatus: (id: ID, status: MeetingStatus) => void;
  // agenda
  addAgendaItem: (meetingId: ID, input: { title: string; description?: string; presenterId?: ID | null; estimatedMinutes?: number }) => void;
  updateAgendaItem: (id: ID, patch: Partial<AgendaItem>) => void;
  deleteAgendaItem: (id: ID) => Promise<DestructiveResult>;
  moveAgendaItem: (meetingId: ID, id: ID, dir: -1 | 1) => void;
  setAgendaStatus: (id: ID, status: AgendaStatus) => void;
  // personnel
  createPerson: (input: Omit<Person, "id" | "code" | "createdAt">) => Person;
  updatePerson: (id: ID, patch: Partial<Person>) => void;
  deletePerson: (id: ID) => Promise<DestructiveResult>;
  // notes
  /**
   * Upsert the note for a meeting. Returns `true` when the store accepted the
   * content (applied now, or queued behind an exclusive operation) and `false`
   * when it refused — the editor then keeps its draft and its dirty state.
   */
  saveNote: (meetingId: ID, content: string) => boolean;
  // decisions
  /** `false` means the store refused the write (recovery lock) — say so, and keep the draft. */
  createDecision: (input: { meetingId: ID; title: string; description: string; agendaItemId: ID | null; approvedBy: ID | null; decisionDate: string; status: Decision["status"] }) => boolean;
  /**
   * `false` means nothing was written: the recovery lock refused it, the record
   * is gone, or the agenda reference is not part of the record's own meeting.
   */
  updateDecision: (id: ID, patch: Partial<Decision>) => boolean;
  deleteDecision: (id: ID) => Promise<DestructiveResult>;
  // action items
  createActionItem: (input: { meetingId: ID; title: string; description: string; agendaItemId: ID | null; assigneeId: ID | null; dueDate: string; priority: Priority; status: TaskStatus }) => boolean;
  /** `false` under the same conditions as `updateDecision`. */
  updateActionItem: (id: ID, patch: Partial<ActionItem>) => boolean;
  deleteActionItem: (id: ID) => Promise<DestructiveResult>;
  setActionStatus: (id: ID, status: TaskStatus) => void;
  // attendance
  addAttendee: (meetingId: ID, personId: ID) => void;
  removeAttendee: (meetingId: ID, personId: ID) => void;
  setAttendance: (meetingId: ID, personId: ID, status: AttendanceStatus) => void;
  // settings & maintenance
  updateSettings: (patch: Partial<AppSettings>) => void;
  /** Force a write now. Resolves with the outcome so callers cannot claim success falsely. */
  flush: () => Promise<{ ok: boolean; error?: string }>;
  /**
   * Register an editor that holds text which has not reached the store yet.
   *
   * The callback must hand its draft over *synchronously* and return `false`
   * when the draft is still unsaved (the store refused it, or it is still held
   * in the editor). `flushSynchronously` calls every registered callback before
   * it reads the document, so the page can be torn down in the knowledge that
   * the last keystrokes are either stored or reported as unsaved.
   */
  registerUnloadFlush: (flushDraft: () => boolean) => () => void;
  /**
   * Write the records that are already in memory *now*, without waiting for a
   * promise. Used by the page-lifecycle path (`pagehide`, `beforeunload`,
   * `visibilitychange`) where a queued write has no guarantee of running.
   *
   * `ok: false` means nothing was written — the recovery lock is active, an
   * exclusive operation owns the document, or the adapter cannot write
   * synchronously. `pending` says whether unsaved edits were at stake, which is
   * what decides the warning before leaving.
   */
  flushSynchronously: () => { ok: boolean; error?: string; pending: boolean };
  exportJSON: () => string;
  /** Read-only inspection of a backup file: nothing is written or replaced. */
  previewImport: (json: string) => ImportPreview;
  /**
   * Replace all records with a validated backup.
   *
   * Order is deliberate: validate → preserve the current payload → write →
   * only then commit to React state. A failure at any step leaves the live
   * records exactly as they were.
   */
  importJSON: (json: string) => Promise<ImportResult>;
  /**
   * Replace all records with the demonstration dataset.
   *
   * Preserves a recovery copy, persists first and only then commits to React
   * state, so a failed write can never be reported as a successful reset.
   */
  resetToDemo: () => Promise<DestructiveResult>;
  restoreDefaultSettings: () => void;
  // recovery surface (1.3.11)
  recovery: RecoveryInfo | null;
  /** True while the recovered payload blocks normal use (corrupt / invalid). */
  recoveryBlocking: boolean;
  /**
   * A payload has to be preserved and RHODES cannot verify a second copy yet.
   * This includes the case where the stored records could not be read at all —
   * a missing `preservedRaw` is never treated as proof that no records exist.
   */
  preservationPending: boolean;
  /** The original could not even be read, so it cannot be downloaded either. */
  preservedCopyUnreadable: boolean;
  /** A download was initiated. Does NOT mean the file was saved. */
  preservedCopyDownloadStarted: boolean;
  /**
   * True while the original payload is the only copy: every mutation and every
   * write is refused so the stored bytes cannot be overwritten.
   */
  writesBlocked: boolean;
  /** Record that a download was started. Deliberately does not unlock writing. */
  notePreservedCopyDownload: () => void;
  /** The operator confirms the file is saved. The only external unlock. */
  confirmPreservedCopySaved: () => void;
  /** Re-attempt the storage read after a read failure. Non-destructive. */
  retryRecovery: () => Promise<{ ok: boolean; error?: string }>;
  /** Acknowledge the notice and continue with the records currently in memory. */
  dismissRecovery: () => void;
  /** Explicit, confirmed choice to start from the demonstration dataset. */
  startWithDemoData: () => Promise<{ ok: boolean; error?: string }>;
}

export interface ImportPreview {
  ok: boolean;
  error?: string;
  counts?: Record<string, number>;
  current?: Record<string, number>;
  /**
   * Migration and default adjustments made while reading the file — a schema
   * migration, a settings block that was not supplied. Harmless, and the records
   * are complete; they are shown separately from `warnings` because they say
   * nothing about the file being incomplete.
   */
  adjustments?: string[];
  /**
   * Personnel references the file names but does not contain. Non-blocking: the
   * meeting, decision or task still imports, and the person shows as unassigned.
   */
  warnings?: string[];
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  snapshotKey?: string;
  counts?: Record<string, number>;
  /** Drafts captured during the import that belonged to replaced records. */
  dropped?: number;
}

/**
 * Outcome of an operation that removes records.
 *
 * `snapshotKey` is the recovery copy taken *before* the operation. It is
 * reported even when the operation was refused part-way through (for example a
 * write failure), because the copy stays in storage and is the operator's way
 * back.
 */
export interface DestructiveResult {
  ok: boolean;
  error?: string;
  snapshotKey?: string;
  /**
   * Drafts that arrived while the operation ran and were discarded because the
   * record they belonged to no longer exists. Reported so the interface can say
   * what happened instead of implying everything was kept.
   */
  dropped?: number;
  /**
   * Decisions and action items whose optional agenda link was cleared because
   * the agenda entry they pointed at was removed. The records themselves are
   * kept — only the link goes.
   */
  detached?: number;
}

const Ctx = createContext<Store | null>(null);

/**
 * Is an agenda reference usable inside `meetingId`?
 *
 * `null` means "not linked to an agenda item" and is always valid — most
 * decisions and tasks have no agenda entry. A non-null reference must resolve
 * to an agenda item of the *same* meeting: the interface only ever offers items
 * from the record being edited, so anything else is a reference the operator
 * could never have chosen and the workspace could never show.
 */
function agendaRefProblem(d: AppData, meetingId: ID, agendaItemId: ID | null): string | null {
  if (!agendaItemId) return null;
  const item = d.agendaItems.find((a) => a.id === agendaItemId);
  if (!item) return "The linked agenda item no longer exists, so nothing was saved.";
  if (item.meetingId !== meetingId) {
    return "The linked agenda item belongs to a different meeting record, so nothing was saved.";
  }
  return null;
}

/**
 * Write-lock wording. Deliberately does not promise a download is enough: the
 * operator has to confirm the file is actually saved.
 */
const BLOCKED_WRITE_MESSAGE =
  "Writes are blocked because no verified second copy of the stored records exists yet.";
const NO_COPY_MESSAGE =
  "A verified second copy of the stored records must exist first — save the preserved backup and confirm it to unlock writing.";
const BUSY_MESSAGE =
  "Another operation that removes records is still running. Nothing was changed — try again once it has finished.";

/** Short, quotable form of an unknown thrown value. */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Empty but schema-valid record exposed while `ready === false`.
 *
 * Consumers that mount during the loading phase (only the startup `Gate`) read
 * `ready`, never the records, and `Core`/`AppShell` are gated behind `ready`.
 * Using a real value instead of a null assertion keeps `Store["data"]` honest
 * and means no component can dereference `undefined` even if it mounts early.
 */
const LOADING_DATA: AppData = {
  meetings: [],
  agendaItems: [],
  personnel: [],
  notes: [],
  decisions: [],
  actionItems: [],
  settings: DEFAULT_SETTINGS,
  meta: { version: 0, firstRunAt: "", adapter: "pending" },
};

export function DataProvider({ children, adapter }: { children: React.ReactNode; adapter?: StorageAdapter }) {
  // An alternate adapter (async IPC/SQLite backend, or a test double) can be
  // injected; the browser build always uses the default localStorage adapter.
  const sourceRef = useRef<StorageAdapter>(adapter ?? storage);
  const source = sourceRef.current;

  // Hydrate during the first render when the adapter can read synchronously:
  // the startup decision (boot vs. shell) must not wait for an effect, or the
  // shell could paint for a frame before the boot sequence takes over.
  // Hydration is memoised in a ref rather than a useState initialiser so the
  // adapter is queried exactly once, even under StrictMode's double render.
  const bootRef = useRef<{ data: AppData | null; recovery: RecoveryInfo | null } | null>(null);
  if (bootRef.current === null) {
    const outcome = normaliseOutcome(source.loadSync?.() ?? null);
    bootRef.current = outcome
      ? { data: outcome.data, recovery: outcome.recovery ?? null }
      : { data: null, recovery: null };
  }
  const [data, setData] = useState<AppData | null>(bootRef.current.data);
  const [recovery, setRecovery] = useState<RecoveryInfo | null>(bootRef.current.recovery);
  // ── write protection (1.3.11 Phase 1b) ─────────────────────
  // `snapshotKey` is the only second copy RHODES can verify by itself. Any other
  // recovery state means an original payload exists — or may exist — that has
  // not been duplicated: a corrupt/invalid payload whose snapshot failed, or a
  // payload the adapter could not read at all. A missing `preservedRaw` is not
  // evidence that the records are empty, so it never lifts the lock.
  // Migration-only notices are informational: nothing was set aside or repaired.
  const [preservedCopyConfirmed, setPreservedCopyConfirmed] = useState(false);
  const [preservedCopyDownloadStarted, setPreservedCopyDownloadStarted] = useState(false);
  const preservationPending = !!recovery && recovery.kind !== "migrated" && !recovery.snapshotKey;
  const preservedCopyUnreadable =
    !!recovery && preservationPending && (recovery.unreadable === true || !recovery.preservedRaw);
  const writesBlocked = preservationPending && !preservedCopyConfirmed;
  const writesBlockedRef = useRef(writesBlocked);
  writesBlockedRef.current = writesBlocked;
  const preservationPendingRef = useRef(preservationPending);
  preservationPendingRef.current = preservationPending;
  const unreadableRef = useRef(preservedCopyUnreadable);
  unreadableRef.current = preservedCopyUnreadable;
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const ready = data !== null;
  const hydratedOnFirstRender = useRef(bootRef.current.data !== null);
  const persistTimer = useRef<number | null>(null);
  const opCount = useRef(0);
  /**
   * The committed records, readable synchronously.
   *
   * Preservation has to describe *what the operator is looking at* before it can
   * describe what it is about to remove, and that description is needed inside
   * event handlers and `await` chains where `data` from the render closure may
   * already be one render out of date. Every place that commits records updates
   * this mirror in the same statement.
   */
  const dataRef = useRef<AppData | null>(bootRef.current.data);
  /**
   * Every storage write is queued on this chain, so writes reach the adapter in
   * the order they were requested even when the adapter resolves slowly. The
   * chain is the ordering guarantee; `opCount` only decides who may report the
   * save indicator.
   */
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  /** Document waiting for its debounce to elapse (kept so it can be retried). */
  const pendingDoc = useRef<AppData | null>(null);
  /**
   * Ordering for debounced writes.
   *
   * `docSeq` counts committed documents; `persistedSeq` is the newest sequence
   * known to be on disk. A queued write that carries an older sequence is
   * skipped instead of being allowed to put stale bytes back over a newer
   * document (which is exactly what a lifecycle flush can cause: it writes the
   * current document while an older one is still waiting in the queue).
   */
  const docSeq = useRef(0);
  /** The loaded document is already in storage, so sequence 0 is persisted. */
  const persistedSeq = useRef(0);
  /** Editors that may still hold text which has not reached the store. */
  const unloadFlushers = useRef<Set<() => boolean>>(new Set());
  /**
   * Non-null while an exclusive operation (delete / reset / import / demo)
   * owns the document. Exclusive operations never overlap each other.
   */
  const exclusiveRef = useRef<string | null>(null);
  /** Edits made while an exclusive operation runs, applied in order afterwards. */
  const deferredMutations = useRef<((d: AppData) => AppData)[]>([]);

  // Safety net: if any future code path commits `data` without touching the
  // mirror, the next committed render restores it.
  useEffect(() => { dataRef.current = data; }, [data]);

  /**
   * Adopt a loader outcome. Any earlier "I saved the backup" confirmation is
   * discarded: a new outcome describes a new preservation problem, and the
   * operator must confirm again (or a snapshot must exist).
   */
  const applyOutcome = useCallback((outcome: LoadOutcome | null) => {
    if (!outcome) return;
    setPreservedCopyConfirmed(false);
    setPreservedCopyDownloadStarted(false);
    setRecovery(outcome.recovery ?? null);
    dataRef.current = outcome.data;
    setData(outcome.data);
  }, []);

  /** The adapter could not be read: records may exist and we cannot prove otherwise. */
  const readFailure = useCallback((error: unknown): LoadOutcome => ({
    data: emptyAppData(source.label),
    recovery: {
      kind: "invalid",
      message:
        "RHODES could not access the stored records, so it cannot prove a second copy exists. " +
        "Nothing has been written over them and writing stays blocked until they can be read.",
      details: [error instanceof Error ? error.message : String(error)],
      snapshotKey: null,
      preservedRaw: null,
      unreadable: true,
      counts: { kept: 0, dropped: 0 },
    },
  }), [source]);

  useEffect(() => {
    if (hydratedOnFirstRender.current) return;   // already hydrated above
    let alive = true;
    source.load()
      .then((loaded) => {
        if (!alive) return;
        applyOutcome(normaliseOutcome(loaded ?? null));
      })
      .catch((error) => {
        // A failing adapter must not leave the gate spinning forever, and must
        // not be "fixed" by inventing records.
        if (!alive) return;
        applyOutcome(readFailure(error));
      });
    return () => { alive = false; };
  }, [source, applyOutcome, readFailure]);

  /**
   * Queue a storage write behind every write already requested.
   *
   * `then(task, task)` deliberately runs the task whether the previous link
   * settled or failed: one failed save must not wedge the queue for the rest of
   * the session, but it must still be *ordered* before anything that follows.
   */
  const enqueueWrite = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = writeChain.current.then(task, task);
    writeChain.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  /** Resolve once every write requested so far has settled. Never throws. */
  const drainWrites = useCallback(() => enqueueWrite(() => Promise.resolve()), [enqueueWrite]);

  /**
   * The single place a document is handed to the adapter.
   *
   * `opCount` is bumped when the write is *queued*, so only the newest write may
   * move the save indicator: an older save that resolves late cannot report
   * "saved" over a newer one.
   */
  const writeDocument = useCallback((doc: AppData, seq?: number): Promise<{ bytes: number }> => {
    const op = ++opCount.current;
    const ordered = seq !== undefined;
    // The sequence this document carries. Unordered writes are an exclusive
    // operation's own document, so they mark the sequence current at enqueue.
    const mark = seq ?? docSeq.current;
    return enqueueWrite(async () => {
      // An ordered (debounced) write is dropped when a newer document already
      // reached storage. Writes issued by an exclusive operation carry no
      // sequence: they are the operation's own document and are never skipped.
      if (ordered && (seq as number) < persistedSeq.current) {
        return { bytes: 0 };
      }
      const result = await source.save(doc);
      // The document went stale *while* the write was in flight — a lifecycle
      // flush overtook it. A synchronous store cannot reach this point; an
      // asynchronous one has already put the older bytes down, so write the
      // newest document back over them once. Never the other way round: an
      // older queued write must not be the last writer.
      if (ordered && (seq as number) < persistedSeq.current) {
        const latest = dataRef.current;
        if (latest && latest !== doc) {
          const corrected = await source.save(latest);
          persistedSeq.current = Math.max(persistedSeq.current, docSeq.current);
          return corrected;
        }
      }
      return result;
    }).then(
      (result) => {
        persistedSeq.current = Math.max(persistedSeq.current, mark);
        if (opCount.current === op) setSaveState("saved");
        return result;
      },
      (error) => {
        if (opCount.current === op) setSaveState("error");
        throw error;
      },
    );
  }, [enqueueWrite, source]);

  /**
   * Drop the queued write, reporting whether anything was actually waiting.
   *
   * Callers must only use this once the queued document has been accounted for
   * — written down, or preserved — because the timer is the only thing that
   * would have carried those bytes to storage.
   */
  const cancelPendingWrite = useCallback((): boolean => {
    const hadPending = persistTimer.current !== null || pendingDoc.current !== null;
    if (persistTimer.current) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    pendingDoc.current = null;
    return hadPending;
  }, []);

  /**
   * Hold a document for the debounce window, then write it.
   *
   * The document is kept in `pendingDoc` until the timer fires, so a refusal can
   * put it back on the queue instead of losing it.
   */
  const scheduleWrite = useCallback((doc: AppData) => {
    if (writesBlockedRef.current) return;
    pendingDoc.current = doc;
    const seq = docSeq.current;
    setSaveState("saving");
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      // The timer has fired: stop claiming a write is pending, so callers can
      // tell "queued" from "already sent to storage" by looking at the ref.
      persistTimer.current = null;
      const queued = pendingDoc.current;
      pendingDoc.current = null;
      if (!queued) return;
      void writeDocument(queued, seq).catch(() => undefined);
    }, 280);
  }, [writeDocument]);

  const persist = useCallback((next: AppData) => {
    // Defence in depth: `mutate` already refuses while writes are blocked, and a
    // timer scheduled before the lock cannot exist (the lock is known at boot).
    if (writesBlockedRef.current) return;
    scheduleWrite(next);
  }, [scheduleWrite]);

  /**
   * Take the document for an exclusive operation, or report why it cannot.
   * Refuses under the recovery write lock and while another exclusive operation
   * (delete, reset, import, demo) is running.
   */
  const beginExclusive = useCallback((kind: string): { ok: true } | { ok: false; error: string } => {
    if (writesBlockedRef.current) {
      return { ok: false, error: BLOCKED_WRITE_MESSAGE + " Nothing was changed." };
    }
    if (exclusiveRef.current) return { ok: false, error: BUSY_MESSAGE };
    exclusiveRef.current = kind;
    return { ok: true };
  }, []);

  /**
   * Release the document and replay any edit that arrived while it was held.
   *
   * The replay is persisted through the same chain, so it can never overtake the
   * operation's own write. A child record the replay *adds* for a meeting that no
   * longer exists is discarded rather than stored as an orphan; the count is
   * returned so the caller can say so instead of implying everything was kept.
   */
  const endExclusive = useCallback((): number => {
    exclusiveRef.current = null;
    const deferred = deferredMutations.current;
    deferredMutations.current = [];
    if (!deferred.length) return 0;

    const base = dataRef.current;
    if (!base) return 0;
    let next = base;
    for (const transform of deferred) next = transform(next);

    const meetingIds = new Set(next.meetings.map((m) => m.id));
    let dropped = 0;

    // Only records the replay itself added are candidates: an existing record can
    // never gain a second meeting, and pre-existing data (including a payload
    // that arrived by import) is left exactly as it was.
    const keepChild = <T extends { id: string; meetingId: string }>(before: T[], after: T[]): T[] => {
      const known = new Set(before.map((item) => item.id));
      return after.filter((item) => {
        if (meetingIds.has(item.meetingId) || known.has(item.id)) return true;
        dropped += 1;
        return false;
      });
    };

    const agendaItems = keepChild(base.agendaItems, next.agendaItems);
    const decisions = keepChild(base.decisions, next.decisions);
    const actionItems = keepChild(base.actionItems, next.actionItems);
    // Notes are keyed by meeting rather than listed under it: a note is kept only
    // while its meeting exists, whether it was typed now or earlier — there is no
    // interface that could show a note without its record.
    const notes = next.notes.filter((note) => {
      if (meetingIds.has(note.meetingId)) return true;
      dropped += 1;
      return false;
    });

    if (dropped > 0) {
      next = { ...next, agendaItems, decisions, actionItems, notes };
    }

    // An agenda link that became invalid while the operation ran — its agenda
    // item was deleted, or now belongs to another meeting — is cleared instead
    // of being replayed as a dangling reference. The decision or task itself is
    // kept: it is a record with its own meeting, not a detail of the agenda.
    const agendaOwner = new Map(next.agendaItems.map((a) => [a.id, a.meetingId] as const));
    const linkValid = (meetingId: string, agendaItemId: string | null) =>
      !agendaItemId || agendaOwner.get(agendaItemId) === meetingId;
    if (next.decisions.some((x) => !linkValid(x.meetingId, x.agendaItemId))) {
      next = { ...next, decisions: next.decisions.map((x) => (linkValid(x.meetingId, x.agendaItemId) ? x : { ...x, agendaItemId: null })) };
    }
    if (next.actionItems.some((t) => !linkValid(t.meetingId, t.agendaItemId))) {
      next = { ...next, actionItems: next.actionItems.map((t) => (linkValid(t.meetingId, t.agendaItemId) ? t : { ...t, agendaItemId: null })) };
    }

    if (next === base) return dropped;
    dataRef.current = next;
    docSeq.current += 1;
    setData(next);
    persist(next);
    return dropped;
  }, [persist]);

  /**
   * Apply a change to the records.
   *
   * The next document is computed from the synchronous mirror *outside* any
   * state updater, so persistence stays a plain side effect of the handler that
   * asked for the change rather than something React may run twice, defer or
   * discard. A no-op transform (same object identity) writes nothing.
   *
   * While an exclusive operation owns the document the change is **queued**, not
   * dropped: it is applied to whatever document the operation leaves behind.
   * Only the recovery write lock refuses outright.
   */
  const mutate = useCallback((fn: (d: AppData) => AppData) => {
    if (writesBlockedRef.current) return { ok: false, reason: "blocked" as const };
    if (exclusiveRef.current) {
      deferredMutations.current.push(fn);
      return { ok: true, deferred: true };
    }
    const prev = dataRef.current;
    if (!prev) return { ok: false, reason: "empty" as const };
    const next = fn(prev);
    if (next === prev) return { ok: true };   // nothing changed — no write, no render
    dataRef.current = next;
    docSeq.current += 1;
    setData(next);
    persist(next);
    return { ok: true };
  }, [persist]);

  /**
   * Check that a recovery copy really reached storage.
   *
   * A returned key proves the adapter's own write call did not throw; when the
   * adapter can read a snapshot back, the contents are compared too, so a
   * "successful" snapshot that stored the wrong bytes still refuses the
   * operation.
   */
  const verifySnapshot = useCallback((key: string, payload: string): { ok: true } | { ok: false; error: string } => {
    if (source.readSnapshot) {
      let read: string | null = null;
      try { read = source.readSnapshot(key); } catch { read = null; }
      if (read === null) {
        return { ok: false, error: "The recovery snapshot could not be read back after it was written, so the operation was cancelled and nothing was changed." };
      }
      if (read !== payload) {
        return { ok: false, error: "The recovery snapshot does not match the records it was meant to preserve, so the operation was cancelled and nothing was changed." };
      }
      return { ok: true };
    }
    if (source.snapshots) {
      let list: { key: string }[] = [];
      try { list = source.snapshots(); } catch { list = []; }
      if (!list.some((entry) => entry.key === key)) {
        return { ok: false, error: "The recovery snapshot is not present in the storage history, so the operation was cancelled and nothing was changed." };
      }
      return { ok: true };
    }
    // No read-back capability: the adapter's own confirmation is all that exists.
    return { ok: true };
  }, [source]);

  /**
   * Preserve the records that are about to be destroyed.
   *
   * Order is deliberate and every step can refuse:
   *   1 · the adapter must be able to read *and* snapshot — otherwise refuse;
   *   2 · storage must be **read before** the pending autosave is touched. A
   *       failed read must not cost the operator their queued edits: the timer
   *       stays armed and will write them as soon as storage is readable again;
   *   3 · writes already in flight are awaited, so the copy describes the
   *       document storage has actually reached;
   *   4 · a debounced write still waiting in the queue is written first, so the
   *       copy includes the changes the operator can already see;
   *   5 · the copy is written under a reason label and read back before anything
   *       is removed.
   */
  const preserveBeforeDestructive = useCallback(async (
    reason: string,
    /** Label to use when the live key is absent and only memory can be preserved. */
    memoryReason?: string,
  ): Promise<{ ok: true; snapshotKey: string; raw: string } | { ok: false; error: string }> => {
    const current = dataRef.current;
    if (!current) {
      return { ok: false, error: "No records are loaded, so there is nothing to preserve and nothing was changed." };
    }
    if (!source.snapshot) {
      return {
        ok: false,
        error: "This storage adapter cannot create a recovery snapshot, so the operation was cancelled and nothing was changed.",
      };
    }
    if (!source.readRaw) {
      return {
        ok: false,
        error: "This storage adapter cannot verify the stored records, so the operation was cancelled and nothing was changed.",
      };
    }

    // 1 · Read first. Cancelling the debounce before knowing the store can be
    //     read would leave the operator's newest edits in memory only — one
    //     reload away from being lost — for an operation that is about to be
    //     refused anyway.
    const first = source.readRaw();
    if (!first.ok) {
      return {
        ok: false,
        error:
          `The stored records could not be read (${first.error}), so the operation was cancelled and no recovery copy was taken. ` +
          "Your pending changes are still queued and will be saved when storage can be read again.",
      };
    }

    // 2 · A save that is already running must land before the payload is read
    //     again, or the copy would describe a document storage has moved past.
    await drainWrites();

    const memoryRaw = JSON.stringify(current);
    const stored = source.readRaw();
    if (!stored.ok) {
      return {
        ok: false,
        error: `The stored records could not be read back (${stored.error}), so the operation was cancelled and no recovery copy was taken.`,
      };
    }

    // Is a debounce still holding a document that has not reached storage? Only
    // then is memory genuinely ahead of the stored bytes; otherwise any
    // difference is display normalisation (a migrated payload, a repaired value)
    // and the stored bytes are the record of truth that must be copied verbatim.
    const queuedDoc = pendingDoc.current;

    let payload: string;
    let label = reason;
    if (stored.raw === null && memoryReason) {
      // Nothing is stored at all, so the records in memory are the only copy of
      // what is about to be replaced. Preserve them exactly; there are no stored
      // bytes to bring up to date. Any queued write is left alone here — the
      // caller accounts for it immediately before it replaces the document.
      payload = JSON.stringify(current, null, 2);
      label = memoryReason;
    } else if (stored.raw === null || (queuedDoc !== null && stored.raw !== memoryRaw)) {
      // A queued document has not been written yet. Write it now; the copy below
      // is then exactly what the operator is looking at, so their pending edit is
      // inside the recovery copy and never only in memory.
      if (persistTimer.current) {
        window.clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
      pendingDoc.current = null;
      setSaveState("saving");
      try {
        await writeDocument(current);
      } catch (error) {
        // Put the document back on the queue: the operation is refused, but the
        // edits must still reach storage once it accepts writes again.
        scheduleWrite(current);
        return {
          ok: false,
          error:
            `The pending changes could not be written to storage (${failureText(error)}), so the operation was cancelled and nothing was changed. ` +
            "They are still queued and will be saved when storage accepts them.",
        };
      }
      const after = source.readRaw();
      payload = after.ok ? after.raw ?? memoryRaw : memoryRaw;
    } else {
      // Nothing is waiting to be written, so the copy is the stored document
      // byte for byte. Clearing a timer here loses nothing (it would write the
      // same bytes) — but the indicator must stop saying "saving".
      if (persistTimer.current) {
        window.clearTimeout(persistTimer.current);
        persistTimer.current = null;
        setSaveState("saved");
      }
      pendingDoc.current = null;
      payload = stored.raw;
    }

    const saved = source.snapshot(payload, label);
    if ("error" in saved) {
      return {
        ok: false,
        error: `Could not create a recovery snapshot (${saved.error}), so no recovery copy exists. The operation was cancelled and nothing was changed.`,
      };
    }

    const verified = verifySnapshot(saved.key, payload);
    if (!verified.ok) return { ok: false, error: verified.error };

    return { ok: true, snapshotKey: saved.key, raw: payload };
  }, [source, verifySnapshot, drainWrites, writeDocument, scheduleWrite]);

  /**
   * Run a record-removing transform: lock → preserve → write → commit → replay.
   *
   * The records only change in React state after storage has accepted the new
   * document, so a failed write leaves the operator looking at exactly what is
   * still stored. The recovery copy is never deleted on any path.
   */
  const runDestructive = useCallback(async (
    reason: string,
    fn: (d: AppData) => AppData,
  ): Promise<DestructiveResult> => {
    const start = dataRef.current;
    if (!start) {
      return { ok: false, error: "No records are loaded, so nothing was changed." };
    }

    const opened = beginExclusive(`destructive:${reason}`);
    if (!opened.ok) return { ok: false, error: opened.error };
    try {
      // Nothing to remove: do not spend a snapshot slot on an unchanged document.
      if (fn(start) === start) return { ok: true };

      const preserved = await preserveBeforeDestructive(reason);
      if (!preserved.ok) return { ok: false, error: preserved.error };

      const base = dataRef.current;
      if (!base) return { ok: false, error: "No records are loaded, so nothing was changed." };
      const next = fn(base);
      if (next === base) return { ok: true, snapshotKey: preserved.snapshotKey };

      setSaveState("saving");
      try {
        // Chained: a save started before this operation cannot land after it.
        await writeDocument(next);
      } catch (error) {
        return {
          ok: false,
          snapshotKey: preserved.snapshotKey,
          error:
            `The updated records could not be written to storage (${failureText(error)}). Nothing was removed and the existing records were left unchanged. ` +
            `A recovery copy is preserved as “${reason}”.`,
        };
      }

      docSeq.current += 1;
      dataRef.current = next;
      setData(next);
      // Replay now, so the caller can report any draft whose record was removed.
      const dropped = endExclusive();
      return { ok: true, snapshotKey: preserved.snapshotKey, dropped };
    } finally {
      // Idempotent: only the edits still held are replayed.
      endExclusive();
    }
  }, [beginExclusive, endExclusive, preserveBeforeDestructive, writeDocument]);

  const touch = (m: Meeting): Meeting => ({ ...m, updatedAt: new Date().toISOString() });

  // ── Meetings ────────────────────────────────────────────────
  const createMeeting = useCallback<Store["createMeeting"]>((input) => {
    const id = uid("m");
    const nowIso = new Date().toISOString();
    const meeting: Meeting = {
      id, title: input.title.trim(), purpose: input.purpose.trim(),
      date: input.date, startTime: input.startTime, endTime: input.endTime,
      location: input.location.trim(), organizerId: input.organizerId,
      status: "upcoming", attendeeIds: input.attendeeIds,
      attendance: Object.fromEntries(input.attendeeIds.map((a) => [a, "invited" as AttendanceStatus])),
      closingNotes: "", nextMeetingDate: "", minuteOverride: null,
      createdAt: nowIso, updatedAt: nowIso,
    };
    mutate((d) => ({
      ...d,
      meetings: [...d.meetings, meeting],
      agendaItems: [
        ...d.agendaItems,
        ...input.agendaDraft.filter((a) => a.title.trim()).map((a, i) => ({
          id: uid("a"), meetingId: id, title: a.title.trim(), description: "",
          presenterId: null, estimatedMinutes: a.minutes || 10, sortOrder: i, status: "not-started" as AgendaStatus,
        })),
      ],
    }));
    return meeting;
  }, [mutate]);

  const updateMeeting = useCallback((id: ID, patch: Partial<Meeting>) => {
    mutate((d) => ({ ...d, meetings: d.meetings.map((m) => (m.id === id ? touch({ ...m, ...patch }) : m)) }));
  }, [mutate]);

  const deleteMeeting = useCallback((id: ID) => runDestructive("pre-delete-meeting", (d) => {
    if (!d.meetings.some((m) => m.id === id)) return d;
    return {
      ...d,
      meetings: d.meetings.filter((m) => m.id !== id),
      agendaItems: d.agendaItems.filter((a) => a.meetingId !== id),
      notes: d.notes.filter((n) => n.meetingId !== id),
      decisions: d.decisions.filter((x) => x.meetingId !== id),
      actionItems: d.actionItems.filter((t) => t.meetingId !== id),
    };
  }), [runDestructive]);

  const setMeetingStatus = useCallback((id: ID, status: MeetingStatus) => {
    updateMeeting(id, { status });
  }, [updateMeeting]);

  // ── Agenda ──────────────────────────────────────────────────
  const addAgendaItem = useCallback<Store["addAgendaItem"]>((meetingId, input) => {
    mutate((d) => {
      const items = d.agendaItems.filter((a) => a.meetingId === meetingId);
      const order = items.length ? Math.max(...items.map((a) => a.sortOrder)) + 1 : 0;
      return {
        ...d,
        agendaItems: [...d.agendaItems, {
          id: uid("a"), meetingId, title: input.title.trim(), description: input.description ?? "",
          presenterId: input.presenterId ?? null, estimatedMinutes: input.estimatedMinutes ?? 10,
          sortOrder: order, status: "not-started" as AgendaStatus,
        }],
      };
    });
  }, [mutate]);

  const updateAgendaItem = useCallback((id: ID, patch: Partial<AgendaItem>) => {
    mutate((d) => ({ ...d, agendaItems: d.agendaItems.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  }, [mutate]);

  /**
   * Remove an agenda entry, keeping everything that referred to it.
   *
   * Decisions and action items are records in their own right: deleting the
   * agenda line they were filed under must never delete them. Their optional
   * `agendaItemId` is cleared instead, so nothing dangles and the meeting
   * association (the required link) is untouched.
   */
  const deleteAgendaItem = useCallback((id: ID) => {
    const current = dataRef.current;
    const exists = !!current?.agendaItems.some((a) => a.id === id);
    const linked = exists && current
      ? current.decisions.filter((x) => x.agendaItemId === id).length +
        current.actionItems.filter((t) => t.agendaItemId === id).length
      : 0;
    return runDestructive("pre-delete-agenda", (d) => {
      if (!d.agendaItems.some((a) => a.id === id)) return d;
      return {
        ...d,
        agendaItems: d.agendaItems.filter((a) => a.id !== id),
        decisions: d.decisions.map((x) => (x.agendaItemId === id ? { ...x, agendaItemId: null } : x)),
        actionItems: d.actionItems.map((t) => (t.agendaItemId === id ? { ...t, agendaItemId: null } : t)),
      };
    }).then((res) => (res.ok ? { ...res, detached: linked } : res));
  }, [runDestructive]);

  const moveAgendaItem = useCallback((meetingId: ID, id: ID, dir: -1 | 1) => {
    mutate((d) => {
      const items = d.agendaItems.filter((a) => a.meetingId === meetingId).sort((x, y) => x.sortOrder - y.sortOrder);
      const idx = items.findIndex((a) => a.id === id);
      const swap = idx + dir;
      if (idx < 0 || swap < 0 || swap >= items.length) return d;
      const a = items[idx], b = items[swap];
      const orders = new Map<string, number>([[a.id, b.sortOrder], [b.id, a.sortOrder]]);
      return { ...d, agendaItems: d.agendaItems.map((x) => (orders.has(x.id) ? { ...x, sortOrder: orders.get(x.id)! } : x)) };
    });
  }, [mutate]);

  const setAgendaStatus = useCallback((id: ID, status: AgendaStatus) => updateAgendaItem(id, { status }), [updateAgendaItem]);

  // ── Personnel ───────────────────────────────────────────────
  const createPerson = useCallback<Store["createPerson"]>((input) => {
    const person: Person = { ...input, id: uid("p"), code: "", createdAt: new Date().toISOString() };
    mutate((d) => {
      const max = d.personnel.reduce((acc, p) => {
        const n = parseInt(p.code.replace(/\D/g, ""), 10);
        return isNaN(n) ? acc : Math.max(acc, n);
      }, 0);
      const withCode = { ...person, code: `OP-${String(max + 1).padStart(4, "0")}` };
      Object.assign(person, withCode);
      return { ...d, personnel: [...d.personnel, withCode] };
    });
    return person;
  }, [mutate]);

  const updatePerson = useCallback((id: ID, patch: Partial<Person>) => {
    mutate((d) => ({ ...d, personnel: d.personnel.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  }, [mutate]);

  const deletePerson = useCallback((id: ID) => runDestructive("pre-delete-person", (d) => {
    if (!d.personnel.some((p) => p.id === id)) return d;
    return {
      ...d,
      personnel: d.personnel.filter((p) => p.id !== id),
      meetings: d.meetings.map((m) => ({
        ...m,
        attendeeIds: m.attendeeIds.filter((a) => a !== id),
        attendance: Object.fromEntries(Object.entries(m.attendance).filter(([k]) => k !== id)),
        organizerId: m.organizerId === id ? null : m.organizerId,
      })),
      agendaItems: d.agendaItems.map((a) => (a.presenterId === id ? { ...a, presenterId: null } : a)),
      actionItems: d.actionItems.map((t) => (t.assigneeId === id ? { ...t, assigneeId: null } : t)),
      decisions: d.decisions.map((x) => (x.approvedBy === id ? { ...x, approvedBy: null } : x)),
    };
  }), [runDestructive]);

  // ── Notes (upsert) ──────────────────────────────────────────
  const saveNote = useCallback((meetingId: ID, content: string): boolean => {
    const result = mutate((d) => {
      const existing = d.notes.find((n) => n.meetingId === meetingId);
      if (existing) {
        if (existing.content === content) return d;
        return { ...d, notes: d.notes.map((n) => (n.meetingId === meetingId ? { ...n, content, updatedAt: new Date().toISOString() } : n)) };
      }
      return { ...d, notes: [...d.notes, { id: uid("n"), meetingId, content, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] };
    });
    // `false` means the store refused (write lock) — the caller must keep its
    // draft and the editor must not clear its dirty state.
    return result.ok === true;
  }, [mutate]);

  // ── Decisions ───────────────────────────────────────────────
  const createDecision = useCallback<Store["createDecision"]>((input) => {
    const current = dataRef.current;
    // A reference the workspace could never show is refused, not stored.
    if (!current || agendaRefProblem(current, input.meetingId, input.agendaItemId)) return false;
    const result = mutate((d) => ({ ...d, decisions: [...d.decisions, { ...input, id: uid("d") }] }));
    return result.ok === true;
  }, [mutate]);
  const updateDecision = useCallback((id: ID, patch: Partial<Decision>): boolean => {
    const current = dataRef.current;
    const existing = current?.decisions.find((x) => x.id === id);
    if (!current || !existing) return false;
    const meetingId = patch.meetingId ?? existing.meetingId;
    const agendaItemId = patch.agendaItemId !== undefined ? patch.agendaItemId : existing.agendaItemId;
    const touchesLink = patch.agendaItemId !== undefined || patch.meetingId !== undefined;
    if (touchesLink && agendaRefProblem(current, meetingId, agendaItemId)) return false;
    // A record stored before these checks existed can carry an unusable link.
    // Editing its status or text must not fail because of it, and must not
    // preserve it either: the edit repairs the link.
    const repair: Partial<Decision> = !touchesLink && agendaItemId && agendaRefProblem(current, meetingId, agendaItemId)
      ? { agendaItemId: null }
      : {};
    const result = mutate((d) => ({ ...d, decisions: d.decisions.map((x) => (x.id === id ? { ...x, ...patch, ...repair } : x)) }));
    return result.ok === true;
  }, [mutate]);
  const deleteDecision = useCallback((id: ID) => runDestructive("pre-delete-decision", (d) => (
    d.decisions.some((x) => x.id === id)
      ? { ...d, decisions: d.decisions.filter((x) => x.id !== id) }
      : d
  )), [runDestructive]);

  // ── Action items ────────────────────────────────────────────
  const createActionItem = useCallback<Store["createActionItem"]>((input) => {
    const current = dataRef.current;
    if (!current || agendaRefProblem(current, input.meetingId, input.agendaItemId)) return false;
    const nowIso = new Date().toISOString();
    const result = mutate((d) => ({ ...d, actionItems: [...d.actionItems, { ...input, id: uid("t"), createdAt: nowIso, updatedAt: nowIso }] }));
    return result.ok === true;
  }, [mutate]);
  const updateActionItem = useCallback((id: ID, patch: Partial<ActionItem>): boolean => {
    const current = dataRef.current;
    const existing = current?.actionItems.find((t) => t.id === id);
    if (!current || !existing) return false;
    const meetingId = patch.meetingId ?? existing.meetingId;
    const agendaItemId = patch.agendaItemId !== undefined ? patch.agendaItemId : existing.agendaItemId;
    const touchesLink = patch.agendaItemId !== undefined || patch.meetingId !== undefined;
    if (touchesLink && agendaRefProblem(current, meetingId, agendaItemId)) return false;
    // Same rule as decisions: an edit of an unrelated field is allowed and
    // repairs a link that was already unusable.
    const repair: Partial<ActionItem> = !touchesLink && agendaItemId && agendaRefProblem(current, meetingId, agendaItemId)
      ? { agendaItemId: null }
      : {};
    const result = mutate((d) => ({ ...d, actionItems: d.actionItems.map((t) => (t.id === id ? { ...t, ...patch, ...repair, updatedAt: new Date().toISOString() } : t)) }));
    return result.ok === true;
  }, [mutate]);
  const deleteActionItem = useCallback((id: ID) => runDestructive("pre-delete-task", (d) => (
    d.actionItems.some((t) => t.id === id)
      ? { ...d, actionItems: d.actionItems.filter((t) => t.id !== id) }
      : d
  )), [runDestructive]);
  const setActionStatus = useCallback((id: ID, status: TaskStatus) => updateActionItem(id, { status }), [updateActionItem]);

  // ── Attendance ──────────────────────────────────────────────
  const addAttendee = useCallback((meetingId: ID, personId: ID) => {
    mutate((d) => ({
      ...d,
      meetings: d.meetings.map((m) => m.id === meetingId && !m.attendeeIds.includes(personId)
        ? touch({ ...m, attendeeIds: [...m.attendeeIds, personId], attendance: { ...m.attendance, [personId]: "invited" } })
        : m),
    }));
  }, [mutate]);
  const removeAttendee = useCallback((meetingId: ID, personId: ID) => {
    mutate((d) => ({
      ...d,
      meetings: d.meetings.map((m) => m.id === meetingId
        ? touch({
            ...m,
            attendeeIds: m.attendeeIds.filter((a) => a !== personId),
            attendance: Object.fromEntries(Object.entries(m.attendance).filter(([k]) => k !== personId)),
          })
        : m),
    }));
  }, [mutate]);
  const setAttendance = useCallback((meetingId: ID, personId: ID, status: AttendanceStatus) => {
    mutate((d) => ({
      ...d,
      meetings: d.meetings.map((m) => m.id === meetingId ? touch({ ...m, attendance: { ...m.attendance, [personId]: status } }) : m),
    }));
  }, [mutate]);

  // ── Settings / maintenance ──────────────────────────────────
  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    mutate((d) => ({ ...d, settings: { ...d.settings, ...patch } }));
  }, [mutate]);

  const flush = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const current = dataRef.current;
    const seq = docSeq.current;
    if (!current) return { ok: false, error: "No records are loaded." };
    if (writesBlockedRef.current) {
      return {
        ok: false,
        error: BLOCKED_WRITE_MESSAGE,
      };
    }
    if (exclusiveRef.current) {
      return { ok: false, error: BUSY_MESSAGE };
    }
    if (persistTimer.current) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    pendingDoc.current = null;
    setSaveState("saving");
    try {
      await writeDocument(current, seq);
      return { ok: true };
    } catch (error) {
      // Keep the document on the queue so a retry — or the next edit — cannot
      // lose it, and so the indicator settles instead of staying on "saving".
      scheduleWrite(current);
      return {
        ok: false,
        error: `Could not write to storage (${failureText(error)}). Nothing was persisted; your records are still queued for retry.`,
      };
    }
  }, [writeDocument, scheduleWrite]);

  const registerUnloadFlush = useCallback((flushDraft: () => boolean) => {
    unloadFlushers.current.add(flushDraft);
    return () => { unloadFlushers.current.delete(flushDraft); };
  }, []);

  /**
   * Write the in-memory records synchronously, for use *inside* a lifecycle
   * event (`pagehide`, `beforeunload`, `visibilitychange`).
   *
   * Everything here has to finish before the handler returns: after the
   * document is torn down, neither a timer nor a promise is guaranteed to run.
   * The same refusals as `flush()` apply — a blocked write lock or an exclusive
   * operation is respected, and the caller is told nothing was written rather
   * than being told the records are safe.
   */
  const flushSynchronously = useCallback((): { ok: boolean; error?: string; pending: boolean } => {
    // 1 · Let every editor put its unsaved text into the store first. This runs
    // on every call, whatever the lock state: a refused draft has to stay in
    // the editor (and be reported), not vanish because the page is leaving.
    let draftRefused = false;
    for (const flushDraft of Array.from(unloadFlushers.current)) {
      try {
        if (flushDraft() === false) draftRefused = true;
      } catch {
        draftRefused = true;
      }
    }

    // 2 · Write what is now in memory. Everything below is synchronous by
    // design: after `pagehide` a promise or a timer may never run again.
    const current = dataRef.current;
    if (!current) return { ok: false, error: "No records are loaded.", pending: draftRefused };
    const queued = persistTimer.current !== null || pendingDoc.current !== null;
    const unsaved = queued || docSeq.current > persistedSeq.current;
    const pending = unsaved || draftRefused;

    if (writesBlockedRef.current) {
      // The write lock is not a lifecycle exception: the operator's records are
      // unsafe on purpose until they confirm a preserved copy.
      return { ok: false, error: BLOCKED_WRITE_MESSAGE, pending };
    }
    if (exclusiveRef.current) {
      // An exclusive operation owns the document; edits made now are deferred
      // to it and would be lost with the page, so this is always at risk.
      return { ok: false, error: BUSY_MESSAGE, pending: true };
    }
    if (!unsaved && !draftRefused) return { ok: true, pending: false };   // nothing to write
    if (!source.saveSync) {
      return {
        ok: false,
        error: "This storage backend cannot write synchronously, so the last few hundred milliseconds of edits could not be written.",
        pending,
      };
    }

    // The document in memory is the newest state; the queued one is redundant.
    if (persistTimer.current) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    pendingDoc.current = null;
    const seq = docSeq.current;
    try {
      source.saveSync(current);
      persistedSeq.current = Math.max(persistedSeq.current, seq);
      opCount.current += 1;      // an older in-flight write must not report over this
      setSaveState("saved");
    } catch (error) {
      // Keep the document queued so a surviving page still retries it, and let
      // the indicator settle on "error" instead of a false "saved".
      scheduleWrite(current);
      return { ok: false, error: failureText(error), pending: true };
    }
    // A refused draft can only happen while writes are blocked, and that case
    // has already returned above — so reaching here means everything is down.
    return { ok: true, pending: false };
  }, [scheduleWrite, source]);

  /**
   * Lifecycle safety net for the debounce windows.
   *
   * The editor's own 800 ms timer and the store's 280 ms timer are what stand
   * between the operator's text and storage; neither is guaranteed to fire
   * before the page is gone. On every "this document may be leaving" event we
   * (1) hand the editors' drafts to the store synchronously, then (2) write the
   * document synchronously. If that write is refused, `beforeunload` is
   * cancelled so the browser asks the operator instead of silently dropping
   * their work.
   */
  useEffect(() => {
    if (!ready) return;
    const flushForLifecycle = (event?: BeforeUnloadEvent) => {
      // `flushSynchronously` itself runs the editors' draft hand-over first, so
      // the document it writes already contains their text.
      const result = flushSynchronously();
      // Only warn when something really is at stake and could not be written.
      if (!result.ok && result.pending && event && event.type === "beforeunload" && event.cancelable) {
        event.preventDefault();
        event.returnValue = "";
      }
      return result;
    };
    const onPageHide = () => { flushForLifecycle(); };
    const onBeforeUnload = (event: BeforeUnloadEvent) => { flushForLifecycle(event); };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushForLifecycle();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [ready, flushSynchronously]);

  const exportJSON = useCallback((): string => JSON.stringify(data, null, 2), [data]);

  const countOf = (d: AppData | null): Record<string, number> => ({
    meetings: d?.meetings.length ?? 0,
    agendaItems: d?.agendaItems.length ?? 0,
    personnel: d?.personnel.length ?? 0,
    notes: d?.notes.length ?? 0,
    decisions: d?.decisions.length ?? 0,
    actionItems: d?.actionItems.length ?? 0,
    total:
      (d?.meetings.length ?? 0) + (d?.agendaItems.length ?? 0) + (d?.personnel.length ?? 0) +
      (d?.notes.length ?? 0) + (d?.decisions.length ?? 0) + (d?.actionItems.length ?? 0),
  });

  /**
   * Inspect a backup without touching anything. Used to build the confirmation
   * step: the operator sees exactly what would be replaced before deciding.
   */
  const previewImport = useCallback((json: string): ImportPreview => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return {
        ok: false,
        error: "Import refused — the file is not valid JSON. No records were changed.",
      };
    }
    const result = validateAppData(parsed);
    if (!result.usable || !result.data || !result.clean) {
      return {
        ok: false,
        error: `Import refused — ${importRejectionReason(result)}. No records were changed.`,
      };
    }
    return {
      ok: true,
      counts: result.counts,
      current: countOf(data),
      // Two different kinds of notice, kept apart: an adjustment is something
      // the reader did to a complete file, a warning is something the file does
      // not contain. Neither blocks the import.
      adjustments: result.repaired,
      warnings: result.relationshipWarnings,
    };
  }, [data]);

  /**
   * Validate → snapshot the current payload → write → commit.
   * Nothing in React state changes until the write has succeeded.
   */
  const importJSON = useCallback(async (json: string): Promise<ImportResult> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, error: "File is not valid JSON." };
    }

    const result = validateAppData(parsed);
    if (!result.usable || !result.data || !result.clean) {
      return { ok: false, error: `Import refused — ${importRejectionReason(result)}. No records were changed.` };
    }

    // The import replaces every record, so it takes the same exclusive lock as a
    // delete: it can never run beside one, and never under the write lock.
    const opened = beginExclusive("import");
    if (!opened.ok) return { ok: false, error: opened.error + " No records were changed." };
    try {
      // 1 · Preserve through the *same* path deletes use. It reads storage first,
      //     drains writes already running, writes any queued document down, and
      //     only then copies — so the copy contains the pending edits the
      //     operator can see, and a failed read leaves the queued write armed.
      //     An absent key preserves the in-memory records under its own label.
      const preserved = await preserveBeforeDestructive("pre-import", "pre-import-memory");
      if (!preserved.ok) return { ok: false, error: preserved.error };

      // 2 · The queued write has been accounted for (it was written down before
      //     the copy, or preserved with it), so it can be dropped now: a timer
      //     firing after the replacement would put the old document back.
      const hadPending = cancelPendingWrite();

      setSaveState("saving");
      try {
        await writeDocument(result.data);
      } catch (error) {
        // Nothing was replaced. Put the queued document back on the queue so a
        // reload cannot lose the edits the operator made before importing.
        const live = dataRef.current;
        if (hadPending && live) scheduleWrite(live);
        return {
          ok: false,
          error:
            `The imported records could not be written to storage (${failureText(error)}). The existing records were left unchanged.` +
            (hadPending ? " Your pending changes are still queued and will be saved when storage accepts them." : ""),
        };
      }

      // 3 · commit
      docSeq.current += 1;
      dataRef.current = result.data;
      setData(result.data);
      // Replay now, so the caller can report any draft that has no record left.
      const dropped = endExclusive();
      return { ok: true, snapshotKey: preserved.snapshotKey, counts: result.counts, dropped };
    } finally {
      // Idempotent: only the edits still held are replayed.
      endExclusive();
    }
  }, [beginExclusive, endExclusive, preserveBeforeDestructive, cancelPendingWrite, writeDocument, scheduleWrite]);

  /**
   * A browser download is only an *initiation*: the page cannot verify that the
   * file reached the operator's disk. Record it so the explicit confirmation
   * control can appear — but do not unlock anything here.
   */
  const notePreservedCopyDownload = useCallback(() => {
    if (!preservationPendingRef.current) return;
    setPreservedCopyDownloadStarted(true);
  }, []);

  /**
   * The operator states that the preserved file is saved. This is the only
   * external unlock, and it is refused when the payload was never readable
   * (there is no file to confirm — only a successful re-read can help).
   */
  const confirmPreservedCopySaved = useCallback(() => {
    if (!preservationPendingRef.current) return;
    if (unreadableRef.current) return;
    setPreservedCopyConfirmed(true);
  }, []);

  /** Re-attempt the read. Never writes, never clears the lock on its own. */
  const retryRecovery = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const sync = source.loadSync?.();
      if (sync !== undefined && sync !== null) {
        applyOutcome(normaliseOutcome(sync));
        return { ok: true };
      }
      applyOutcome(normaliseOutcome(await source.load()));
      return { ok: true };
    } catch (error) {
      applyOutcome(readFailure(error));
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, [source, applyOutcome, readFailure]);

  /**
   * A notice may be dismissed only when it is purely informational. While the
   * original payload is the only copy, the notice stays and writes stay locked:
   * dismissing must not be a way around the protection.
   */
  const dismissRecovery = useCallback(() => {
    if (writesBlockedRef.current) return;
    setRecovery(null);
  }, []);

  const startWithDemoData = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (writesBlockedRef.current) {
      return {
        ok: false,
        error: NO_COPY_MESSAGE,
      };
    }
    // Same exclusive lock as a delete or a reset: it replaces every document, so
    // it must never overlap one.
    const opened = beginExclusive("demo");
    if (!opened.ok) return { ok: false, error: opened.error };
    try {
      const seed = buildSeedData();
      if (persistTimer.current) {
        window.clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
      pendingDoc.current = null;
      setSaveState("saving");
      try {
        await writeDocument(seed);
      } catch (error) {
        return {
          ok: false,
          error: `The demonstration dataset could not be written (${failureText(error)}). Nothing was changed.`,
        };
      }
      docSeq.current += 1;
      dataRef.current = seed;
      setData(seed);
      setRecovery(null);
      return { ok: true };
    } finally {
      endExclusive();
    }
  }, [beginExclusive, endExclusive, writeDocument]);

  const resetToDemo = useCallback(async (): Promise<DestructiveResult> => {
    const opened = beginExclusive("destructive:pre-reset");
    if (!opened.ok) return { ok: false, error: opened.error };

    try {
      // Replacing every record is as destructive as deleting one: the copy has
      // to exist, and has to be readable back, before anything is touched.
      const preserved = await preserveBeforeDestructive("pre-reset");
      if (!preserved.ok) return { ok: false, error: preserved.error };

      const base = dataRef.current;
      const seed = buildSeedData();
      // Keep operator preferences through the demo reset. Computed outside any
      // state updater: persistence is a side effect and must not run inside one.
      const next: AppData = { ...seed, settings: base ? base.settings : seed.settings };

      setSaveState("saving");
      try {
        await writeDocument(next);
      } catch (error) {
        return {
          ok: false,
          snapshotKey: preserved.snapshotKey,
          error:
            `The demonstration dataset could not be written (${failureText(error)}). The existing records were left unchanged. ` +
            `A recovery copy is preserved as “pre-reset”.`,
        };
      }

      // Only now is the reset real.
      dataRef.current = next;
      setData(next);
      // Replay now, so the caller can report any draft whose record was removed.
      const dropped = endExclusive();
      return { ok: true, snapshotKey: preserved.snapshotKey, dropped };
    } finally {
      // Idempotent: only the edits still held are replayed.
      endExclusive();
    }
  }, [beginExclusive, endExclusive, preserveBeforeDestructive, writeDocument]);

  const restoreDefaultSettings = useCallback(() => {
    updateSettings({ ...DEFAULT_SETTINGS });
  }, [updateSettings]);

  const value = useMemo<Store>(() => ({
    ready: ready, data: data ?? LOADING_DATA, saveState,
    recovery, recoveryBlocking: recovery !== null && (recovery.kind === "corrupt" || recovery.kind === "invalid"),
    preservationPending, preservedCopyUnreadable, preservedCopyDownloadStarted, writesBlocked,
    notePreservedCopyDownload, confirmPreservedCopySaved, retryRecovery,
    createMeeting, updateMeeting, deleteMeeting, setMeetingStatus,
    addAgendaItem, updateAgendaItem, deleteAgendaItem, moveAgendaItem, setAgendaStatus,
    createPerson, updatePerson, deletePerson,
    saveNote,
    createDecision, updateDecision, deleteDecision,
    createActionItem, updateActionItem, deleteActionItem, setActionStatus,
    addAttendee, removeAttendee, setAttendance,
    updateSettings, flush, flushSynchronously, registerUnloadFlush, exportJSON, previewImport, importJSON, resetToDemo, restoreDefaultSettings,
    dismissRecovery, startWithDemoData,
  }), [
    ready, data, saveState, recovery, previewImport, dismissRecovery, startWithDemoData,
    preservationPending, preservedCopyUnreadable, preservedCopyDownloadStarted, writesBlocked,
    notePreservedCopyDownload, confirmPreservedCopySaved, retryRecovery, createMeeting, updateMeeting, deleteMeeting, setMeetingStatus,
    addAgendaItem, updateAgendaItem, deleteAgendaItem, moveAgendaItem, setAgendaStatus,
    createPerson, updatePerson, deletePerson, saveNote,
    createDecision, updateDecision, deleteDecision,
    createActionItem, updateActionItem, deleteActionItem, setActionStatus,
    addAttendee, removeAttendee, setAttendance,
    updateSettings, flush, flushSynchronously, registerUnloadFlush, exportJSON, importJSON, resetToDemo, restoreDefaultSettings,
  ]);

  // Children always render: `Gate` owns the loading decision and shows the
  // local-link screen while an asynchronous adapter is still loading.
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppData must be used inside DataProvider");
  return ctx;
}

// Motion preference resolved against the OS-level reduced-motion flag.
export function useMotionScale(): { off: boolean; reduced: boolean; scale: number } {
  const { data } = useAppData();
  const pref = data?.settings.motionPreference ?? "immersive";
  const osReduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const off = pref === "off";
  const reduced = !off && (pref === "reduced" || !!osReduced);
  return { off, reduced, scale: off ? 0 : reduced ? 0.45 : 1 };
}

// Derived selectors
export function useDerived() {
  const { data } = useAppData();
  return useMemo(() => {
    const today = todayISO();
    const upcoming = data.meetings
      .filter((m) => m.status === "upcoming" || m.status === "in-progress")
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    const openTasks = data.actionItems.filter((t) => t.status !== "completed");
    const overdue = openTasks.filter((t) => t.dueDate && t.dueDate < today);
    const dueSoon = openTasks.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= addDays(today, 3));
    return { upcoming, openTasks, overdue, dueSoon };
  }, [data]);
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
