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
import { storage, validateImport } from "@/services/storage";
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
  deleteMeeting: (id: ID) => void;
  setMeetingStatus: (id: ID, status: MeetingStatus) => void;
  // agenda
  addAgendaItem: (meetingId: ID, input: { title: string; description?: string; presenterId?: ID | null; estimatedMinutes?: number }) => void;
  updateAgendaItem: (id: ID, patch: Partial<AgendaItem>) => void;
  deleteAgendaItem: (id: ID) => void;
  moveAgendaItem: (meetingId: ID, id: ID, dir: -1 | 1) => void;
  setAgendaStatus: (id: ID, status: AgendaStatus) => void;
  // personnel
  createPerson: (input: Omit<Person, "id" | "code" | "createdAt">) => Person;
  updatePerson: (id: ID, patch: Partial<Person>) => void;
  deletePerson: (id: ID) => void;
  // notes
  saveNote: (meetingId: ID, content: string) => void;
  // decisions
  createDecision: (input: { meetingId: ID; title: string; description: string; agendaItemId: ID | null; approvedBy: ID | null; decisionDate: string; status: Decision["status"] }) => void;
  updateDecision: (id: ID, patch: Partial<Decision>) => void;
  deleteDecision: (id: ID) => void;
  // action items
  createActionItem: (input: { meetingId: ID; title: string; description: string; agendaItemId: ID | null; assigneeId: ID | null; dueDate: string; priority: Priority; status: TaskStatus }) => void;
  updateActionItem: (id: ID, patch: Partial<ActionItem>) => void;
  deleteActionItem: (id: ID) => void;
  setActionStatus: (id: ID, status: TaskStatus) => void;
  // attendance
  addAttendee: (meetingId: ID, personId: ID) => void;
  removeAttendee: (meetingId: ID, personId: ID) => void;
  setAttendance: (meetingId: ID, personId: ID, status: AttendanceStatus) => void;
  // settings & maintenance
  updateSettings: (patch: Partial<AppSettings>) => void;
  flush: () => void;
  exportJSON: () => string;
  importJSON: (json: string) => { ok: boolean; error?: string };
  resetToDemo: () => void;
  restoreDefaultSettings: () => void;
}

const Ctx = createContext<Store | null>(null);

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<AppData | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const ready = data !== null;
  const persistTimer = useRef<number | null>(null);
  const opCount = useRef(0);

  useEffect(() => {
    let alive = true;
    storage.load().then((d) => alive && setData(d));
    return () => { alive = false; };
  }, []);

  const persist = useCallback((next: AppData) => {
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    setSaveState("saving");
    persistTimer.current = window.setTimeout(() => {
      const op = ++opCount.current;
      storage.save(next)
        .then(() => { if (opCount.current === op) setSaveState("saved"); })
        .catch(() => { if (opCount.current === op) setSaveState("error"); });
    }, 280);
  }, []);

  const mutate = useCallback((fn: (d: AppData) => AppData) => {
    setData((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      persist(next);
      return next;
    });
  }, [persist]);

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

  const deleteMeeting = useCallback((id: ID) => {
    mutate((d) => ({
      ...d,
      meetings: d.meetings.filter((m) => m.id !== id),
      agendaItems: d.agendaItems.filter((a) => a.meetingId !== id),
      notes: d.notes.filter((n) => n.meetingId !== id),
      decisions: d.decisions.filter((x) => x.meetingId !== id),
      actionItems: d.actionItems.filter((t) => t.meetingId !== id),
    }));
  }, [mutate]);

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

  const deleteAgendaItem = useCallback((id: ID) => {
    mutate((d) => ({ ...d, agendaItems: d.agendaItems.filter((a) => a.id !== id) }));
  }, [mutate]);

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

  const deletePerson = useCallback((id: ID) => {
    mutate((d) => ({
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
    }));
  }, [mutate]);

  // ── Notes (upsert) ──────────────────────────────────────────
  const saveNote = useCallback((meetingId: ID, content: string) => {
    mutate((d) => {
      const existing = d.notes.find((n) => n.meetingId === meetingId);
      if (existing) {
        if (existing.content === content) return d;
        return { ...d, notes: d.notes.map((n) => (n.meetingId === meetingId ? { ...n, content, updatedAt: new Date().toISOString() } : n)) };
      }
      return { ...d, notes: [...d.notes, { id: uid("n"), meetingId, content, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] };
    });
  }, [mutate]);

  // ── Decisions ───────────────────────────────────────────────
  const createDecision = useCallback<Store["createDecision"]>((input) => {
    mutate((d) => ({ ...d, decisions: [...d.decisions, { ...input, id: uid("d") }] }));
  }, [mutate]);
  const updateDecision = useCallback((id: ID, patch: Partial<Decision>) => {
    mutate((d) => ({ ...d, decisions: d.decisions.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  }, [mutate]);
  const deleteDecision = useCallback((id: ID) => {
    mutate((d) => ({ ...d, decisions: d.decisions.filter((x) => x.id !== id) }));
  }, [mutate]);

  // ── Action items ────────────────────────────────────────────
  const createActionItem = useCallback<Store["createActionItem"]>((input) => {
    const nowIso = new Date().toISOString();
    mutate((d) => ({ ...d, actionItems: [...d.actionItems, { ...input, id: uid("t"), createdAt: nowIso, updatedAt: nowIso }] }));
  }, [mutate]);
  const updateActionItem = useCallback((id: ID, patch: Partial<ActionItem>) => {
    mutate((d) => ({ ...d, actionItems: d.actionItems.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t)) }));
  }, [mutate]);
  const deleteActionItem = useCallback((id: ID) => {
    mutate((d) => ({ ...d, actionItems: d.actionItems.filter((t) => t.id !== id) }));
  }, [mutate]);
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

  const flush = useCallback(() => {
    if (!data) return;
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    setSaveState("saving");
    storage.save(data)
      .then(() => setSaveState("saved"))
      .catch(() => setSaveState("error"));
  }, [data]);

  const exportJSON = useCallback((): string => JSON.stringify(data, null, 2), [data]);

  const importJSON = useCallback((json: string): { ok: boolean; error?: string } => {
    try {
      const parsed = JSON.parse(json) as AppData;
      if (!validateImport(parsed)) return { ok: false, error: "File does not match the RHODES data schema." };
      parsed.settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
      setData(parsed);
      persist(parsed);
      return { ok: true };
    } catch {
      return { ok: false, error: "File is not valid JSON." };
    }
  }, [persist]);

  const resetToDemo = useCallback(() => {
    const seed = buildSeedData();
    // Keep operator preferences through the demo reset.
    setData((prev) => {
      const next = { ...seed, settings: prev ? prev.settings : seed.settings };
      persist(next);
      return next;
    });
  }, [persist]);

  const restoreDefaultSettings = useCallback(() => {
    updateSettings({ ...DEFAULT_SETTINGS });
  }, [updateSettings]);

  const value = useMemo<Store>(() => ({
    ready: ready, data: data!, saveState,
    createMeeting, updateMeeting, deleteMeeting, setMeetingStatus,
    addAgendaItem, updateAgendaItem, deleteAgendaItem, moveAgendaItem, setAgendaStatus,
    createPerson, updatePerson, deletePerson,
    saveNote,
    createDecision, updateDecision, deleteDecision,
    createActionItem, updateActionItem, deleteActionItem, setActionStatus,
    addAttendee, removeAttendee, setAttendance,
    updateSettings, flush, exportJSON, importJSON, resetToDemo, restoreDefaultSettings,
  }), [
    ready, data, saveState, createMeeting, updateMeeting, deleteMeeting, setMeetingStatus,
    addAgendaItem, updateAgendaItem, deleteAgendaItem, moveAgendaItem, setAgendaStatus,
    createPerson, updatePerson, deletePerson, saveNote,
    createDecision, updateDecision, deleteDecision,
    createActionItem, updateActionItem, deleteActionItem, setActionStatus,
    addAttendee, removeAttendee, setAttendance,
    updateSettings, flush, exportJSON, importJSON, resetToDemo, restoreDefaultSettings,
  ]);

  if (!value.ready) return <Ctx.Provider value={value}>{null}</Ctx.Provider>;
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
