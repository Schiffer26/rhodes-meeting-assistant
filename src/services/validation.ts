// ─────────────────────────────────────────────────────────────
// RHODES · Data schema validation + migration
//
// One place decides whether a payload is a RHODES record set. It is
// used by the storage loader (which must never destroy what it cannot
// read) and by the JSON importer (which must never replace records
// with anything that is not fully understood).
//
// Two levels of trouble are distinguished:
//
//   fatal   — the payload as a whole cannot be trusted (not an object,
//             a collection is not an array, another schema generation).
//             The caller keeps the original bytes and works on empty
//             records; nothing is ever written over the source.
//   dropped — a single record is unusable. On load the record is set
//             aside in a preserved copy and reported; on import the
//             whole file is refused, because an import must not
//             silently discard anything the operator believed they had.
//
// Missing optional text is repaired (coerced to ""), never treated as a
// reason to drop a record: the goal is to keep records, not to be strict
// about cosmetics.
// ─────────────────────────────────────────────────────────────
import type {
  ActionItem, AgendaItem, AgendaStatus, AppData, AppSettings, AttendanceStatus,
  Decision, DecisionStatus, Meeting, MeetingNote, MeetingStatus, Person, Priority, TaskStatus,
} from "@/types";
import { DEFAULT_SETTINGS } from "@/types";

/**
 * Current schema generation.
 *
 * 1 — original prototype records (`meta.version === 1`, no `schemaVersion`).
 * 2 — 1.3.11: identical record shapes, explicit `meta.schemaVersion`, and a
 *     validated `meta` block. Version 1 payloads migrate by stamping the
 *     generation; no record is rewritten, reordered or renamed.
 */
export const SCHEMA_VERSION = 2;

export interface ValidationResult {
  /** No fatal problem: `data` is present and safe to render. */
  usable: boolean;
  /** Usable *and* nothing had to be dropped or repaired — safe to import. */
  clean: boolean;
  fatal: string[];
  dropped: string[];
  repaired: string[];
  migratedFrom: number | null;
  counts: Record<string, number>;
  data: AppData | null;
}

type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

const ok = <T,>(value: T): Check<T> => ({ ok: true, value });
const no = <T,>(reason: string): Check<T> => ({ ok: false, reason });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const asText = (v: unknown): string => (typeof v === "string" ? v : "");
const asIdOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const asFinite = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

function asEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

const MEETING_STATUS: readonly MeetingStatus[] = ["upcoming", "in-progress", "completed", "cancelled"];
const AGENDA_STATUS: readonly AgendaStatus[] = ["not-started", "in-discussion", "discussed", "skipped", "postponed"];
const ATTENDANCE: readonly AttendanceStatus[] = ["invited", "present", "absent", "excused"];
const TASK_STATUS: readonly TaskStatus[] = ["pending", "in-progress", "completed"];
const PRIORITY: readonly Priority[] = ["low", "medium", "high", "critical"];
const DECISION_STATUS: readonly DecisionStatus[] = ["proposed", "approved", "rejected", "deferred"];

// ── Records ───────────────────────────────────────────────────
// Each check returns the record with cosmetic gaps filled, or a reason
// why the record cannot be represented at all (no id, array-shaped where
// an object belongs, …).

function checkMeeting(raw: unknown): Check<Meeting> {
  if (!isRecord(raw)) return no("not an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return no("missing id");
  if (typeof raw.attendeeIds !== "undefined" && !isStringArray(raw.attendeeIds)) return no("attendeeIds is not a list of ids");
  if (typeof raw.attendance !== "undefined" && !isRecord(raw.attendance)) return no("attendance is not a map");
  const attendance: Record<string, AttendanceStatus> = {};
  if (isRecord(raw.attendance)) {
    for (const [personId, value] of Object.entries(raw.attendance)) {
      attendance[personId] = asEnum(value, ATTENDANCE, "invited");
    }
  }
  // An attendance map is an index of attendeeIds; keep them consistent so the
  // workspace can never read a status for somebody who is not on the list.
  const attendeeIds = isStringArray(raw.attendeeIds) ? raw.attendeeIds : Object.keys(attendance);
  const attendanceClean: Record<string, AttendanceStatus> = {};
  for (const personId of attendeeIds) attendanceClean[personId] = attendance[personId] ?? "invited";
  return ok({
    id,
    title: asText(raw.title),
    purpose: asText(raw.purpose),
    date: asText(raw.date),
    startTime: asText(raw.startTime),
    endTime: asText(raw.endTime),
    location: asText(raw.location),
    organizerId: asIdOrNull(raw.organizerId),
    status: asEnum(raw.status, MEETING_STATUS, "upcoming"),
    attendeeIds,
    attendance: attendanceClean,
    closingNotes: asText(raw.closingNotes),
    nextMeetingDate: asText(raw.nextMeetingDate),
    minuteOverride: typeof raw.minuteOverride === "string" ? raw.minuteOverride : null,
    createdAt: asText(raw.createdAt),
    updatedAt: asText(raw.updatedAt),
  });
}

function checkAgendaItem(raw: unknown): Check<AgendaItem> {
  if (!isRecord(raw)) return no("not an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  const meetingId = typeof raw.meetingId === "string" ? raw.meetingId : "";
  if (!id) return no("missing id");
  if (!meetingId) return no("missing meetingId");
  return ok({
    id,
    meetingId,
    title: asText(raw.title),
    description: asText(raw.description),
    presenterId: asIdOrNull(raw.presenterId),
    estimatedMinutes: asFinite(raw.estimatedMinutes, 10),
    sortOrder: asFinite(raw.sortOrder, 0),
    status: asEnum(raw.status, AGENDA_STATUS, "not-started"),
  });
}

function checkPerson(raw: unknown): Check<Person> {
  if (!isRecord(raw)) return no("not an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return no("missing id");
  return ok({
    id,
    code: asText(raw.code),
    fullName: asText(raw.fullName),
    role: asText(raw.role),
    department: asText(raw.department),
    email: asText(raw.email),
    phone: asText(raw.phone),
    notes: asText(raw.notes),
    createdAt: asText(raw.createdAt),
  });
}

function checkNote(raw: unknown): Check<MeetingNote> {
  if (!isRecord(raw)) return no("not an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  const meetingId = typeof raw.meetingId === "string" ? raw.meetingId : "";
  if (!id) return no("missing id");
  if (!meetingId) return no("missing meetingId");
  return ok({
    id,
    meetingId,
    content: asText(raw.content),
    createdAt: asText(raw.createdAt),
    updatedAt: asText(raw.updatedAt),
  });
}

function checkDecision(raw: unknown): Check<Decision> {
  if (!isRecord(raw)) return no("not an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  const meetingId = typeof raw.meetingId === "string" ? raw.meetingId : "";
  if (!id) return no("missing id");
  if (!meetingId) return no("missing meetingId");
  return ok({
    id,
    meetingId,
    agendaItemId: asIdOrNull(raw.agendaItemId),
    title: asText(raw.title),
    description: asText(raw.description),
    approvedBy: asIdOrNull(raw.approvedBy),
    decisionDate: asText(raw.decisionDate),
    status: asEnum(raw.status, DECISION_STATUS, "proposed"),
  });
}

function checkActionItem(raw: unknown): Check<ActionItem> {
  if (!isRecord(raw)) return no("not an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  const meetingId = typeof raw.meetingId === "string" ? raw.meetingId : "";
  if (!id) return no("missing id");
  if (!meetingId) return no("missing meetingId");
  return ok({
    id,
    meetingId,
    agendaItemId: asIdOrNull(raw.agendaItemId),
    title: asText(raw.title),
    description: asText(raw.description),
    assigneeId: asIdOrNull(raw.assigneeId),
    dueDate: asText(raw.dueDate),
    priority: asEnum(raw.priority, PRIORITY, "medium"),
    status: asEnum(raw.status, TASK_STATUS, "pending"),
    createdAt: asText(raw.createdAt),
    updatedAt: asText(raw.updatedAt),
  });
}

function checkSettings(raw: unknown, repaired: string[]): AppSettings {
  const src = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) repaired.push("settings were missing; defaults applied.");
  const merged: AppSettings = {
    theme: asEnum(src.theme, ["terminal", "archive", "system"] as const, DEFAULT_SETTINGS.theme),
    motionPreference: asEnum(src.motionPreference, ["immersive", "reduced", "off"] as const, DEFAULT_SETTINGS.motionPreference),
    startupAnimation: typeof src.startupAnimation === "boolean" ? src.startupAnimation : DEFAULT_SETTINGS.startupAnimation,
    fontSize: asEnum(src.fontSize, ["small", "medium", "large"] as const, DEFAULT_SETTINGS.fontSize),
    density: asEnum(src.density, ["comfortable", "compact"] as const, DEFAULT_SETTINGS.density),
    dateFormat: asEnum(src.dateFormat, ["iso", "dmy", "mdy"] as const, DEFAULT_SETTINGS.dateFormat),
    timeFormat: asEnum(src.timeFormat, ["24h", "12h"] as const, DEFAULT_SETTINGS.timeFormat),
  };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    if (isRecord(raw) && raw[key] !== merged[key]) repaired.push(`settings.${key} was invalid; default applied.`);
  }
  return merged;
}

function countRecords(data: AppData): Record<string, number> {
  return {
    meetings: data.meetings.length,
    agendaItems: data.agendaItems.length,
    personnel: data.personnel.length,
    notes: data.notes.length,
    decisions: data.decisions.length,
    actionItems: data.actionItems.length,
    total:
      data.meetings.length + data.agendaItems.length + data.personnel.length +
      data.notes.length + data.decisions.length + data.actionItems.length,
  };
}

/**
 * Validate a payload against the RHODES schema and migrate it to the current
 * generation in memory. Never writes, never mutates the input.
 */
export function validateAppData(payload: unknown): ValidationResult {
  const fatal: string[] = [];
  const dropped: string[] = [];
  const repaired: string[] = [];
  let migratedFrom: number | null = null;

  const finish = (data: AppData | null): ValidationResult => ({
    usable: fatal.length === 0 && data !== null,
    clean: fatal.length === 0 && dropped.length === 0 && data !== null,
    fatal,
    dropped,
    repaired,
    migratedFrom,
    counts: data ? countRecords(data) : { meetings: 0, agendaItems: 0, personnel: 0, notes: 0, decisions: 0, actionItems: 0, total: 0 },
    data,
  });

  if (!isRecord(payload)) {
    fatal.push("The payload is not a RHODES data object.");
    return finish(null);
  }

  // ── meta + schema generation ───────────────────────────────
  const metaRaw = payload.meta;
  let metaVersion = 1;
  let firstRunAt = "";
  let adapter = "localStorage-prototype";
  let extras: Record<string, unknown> = {};
  if (isRecord(metaRaw)) {
    extras = { ...metaRaw };
    metaVersion = asFinite(metaRaw.version, 1);
    firstRunAt = asText(metaRaw.firstRunAt);
    adapter = asText(metaRaw.adapter) || adapter;
    const declared = typeof metaRaw.schemaVersion === "number" && Number.isFinite(metaRaw.schemaVersion)
      ? metaRaw.schemaVersion
      : 1;
    if (declared > SCHEMA_VERSION) {
      fatal.push(
        `These records were written by a newer RHODES schema (v${declared}); this build understands v${SCHEMA_VERSION}. Update the application before opening them.`,
      );
    } else if (declared < SCHEMA_VERSION) {
      migratedFrom = declared;
      repaired.push(`Records migrated from schema v${declared} to v${SCHEMA_VERSION}.`);
    }
  } else {
    repaired.push("The meta block was missing; a new one has been generated.");
  }
  if (fatal.length) return finish(null);

  const meta: AppData["meta"] = {
    ...extras,
    version: metaVersion,
    firstRunAt,
    adapter,
    schemaVersion: SCHEMA_VERSION,
  };

  // ── collections ────────────────────────────────────────────
  const list = (key: string): unknown[] | null => {
    const raw = payload[key];
    if (raw === undefined || raw === null) {
      repaired.push(`${key} was missing; treated as empty.`);
      return [];
    }
    if (!Array.isArray(raw)) {
      fatal.push(`${key} is not a list.`);
      return null;
    }
    return raw;
  };

  const pull = <T,>(key: string, check: (raw: unknown) => Check<T>): T[] | null => {
    const raw = list(key);
    if (raw === null) return null;
    const out: T[] = [];
    raw.forEach((entry, index) => {
      const result = check(entry);
      if (result.ok) out.push(result.value);
      else dropped.push(`${key}[${index}] — ${result.reason}`);
    });
    return out;
  };

  const meetings = pull("meetings", checkMeeting);
  const agendaItems = pull("agendaItems", checkAgendaItem);
  const personnel = pull("personnel", checkPerson);
  const notes = pull("notes", checkNote);
  const decisions = pull("decisions", checkDecision);
  const actionItems = pull("actionItems", checkActionItem);
  if (fatal.length || !meetings || !agendaItems || !personnel || !notes || !decisions || !actionItems) {
    return finish(null);
  }

  const settings = checkSettings(payload.settings, repaired);

  const data: AppData = {
    ...(payload as unknown as AppData),
    meetings,
    agendaItems,
    personnel,
    notes,
    decisions,
    actionItems,
    settings,
    meta,
  };

  return finish(data);
}

/** Human-readable, de-duplicated summary of a failure list. */
export function summarise(problems: string[], limit = 3): string {
  if (!problems.length) return "";
  const head = problems.slice(0, limit).join("; ");
  return problems.length > limit ? `${head}; (+${problems.length - limit} more)` : head;
}
