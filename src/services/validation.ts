// ─────────────────────────────────────────────────────────────
// RHODES · Data schema validation + migration
//
// One place decides whether a payload is a RHODES record set. It is
// used by the storage loader (which must never destroy what it cannot
// read) and by the JSON importer (which must never replace records
// with anything that is not fully understood).
//
// Three levels of trouble are distinguished:
//
//   fatal      — the payload as a whole cannot be trusted (not an object,
//                a collection that is not an array, another schema
//                generation). Nothing is ever written over the source.
//   structural — the payload is renderable but incomplete or wrong:
//                a required collection is missing, required metadata is
//                absent/invalid, or a field holds an invalid value (bad
//                enum, wrong type). Loading may repair these *after* the
//                original has been preserved; an import must refuse the
//                file, because a backup that is missing a collection
//                would silently wipe that collection.
//   dropped    — a single record cannot be represented at all.
//
// Harmless cosmetic gaps (an absent optional string, an absent numeric
// default, an absent meta.firstRunAt) are "repaired" and never block an
// import: they cannot lose records.
//
// Import gate = no fatal, no structural, no dropped.
// Load gate   = no fatal (everything else is preserved + reported).
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

/** The six collections a complete RHODES record set must contain. */
export const REQUIRED_COLLECTIONS = [
  "meetings", "agendaItems", "personnel", "notes", "decisions", "actionItems",
] as const;

export interface ValidationResult {
  /** No fatal problem: `data` is present and safe to render. */
  usable: boolean;
  /** Nothing dropped, nothing structural, no broken relationship: safe to import. */
  clean: boolean;
  fatal: string[];
  structural: string[];
  dropped: string[];
  repaired: string[];
  /**
   * Broken cross-record relationships (duplicate ids, a record pointing at a
   * meeting or agenda item that is not in the payload, an agenda item from
   * another meeting). Fatal to an *import*; the loader still opens the records,
   * because stored data that is already in that state must never be locked away
   * from its owner.
   */
  relationships: string[];
  /** Personnel references that cannot be resolved. Reported, never blocking. */
  relationshipWarnings: string[];
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

const MEETING_STATUS: readonly MeetingStatus[] = ["upcoming", "in-progress", "completed", "cancelled"];
const AGENDA_STATUS: readonly AgendaStatus[] = ["not-started", "in-discussion", "discussed", "skipped", "postponed"];
const ATTENDANCE: readonly AttendanceStatus[] = ["invited", "present", "absent", "excused"];
const TASK_STATUS: readonly TaskStatus[] = ["pending", "in-progress", "completed"];
const PRIORITY: readonly Priority[] = ["low", "medium", "high", "critical"];
const DECISION_STATUS: readonly DecisionStatus[] = ["proposed", "approved", "rejected", "deferred"];
const THEME: readonly AppSettings["theme"][] = ["terminal", "archive", "system"];
const MOTION: readonly AppSettings["motionPreference"][] = ["immersive", "reduced", "off"];
const FONT: readonly AppSettings["fontSize"][] = ["small", "medium", "large"];
const DENSITY: readonly AppSettings["density"][] = ["comfortable", "compact"];
const DATE_FORMAT: readonly AppSettings["dateFormat"][] = ["iso", "dmy", "mdy"];
const TIME_FORMAT: readonly AppSettings["timeFormat"][] = ["24h", "12h"];

/** Collector handed to every field check. */
interface Report {
  structural: string[];
}

const flag = (report: Report, message: string): void => {
  if (!report.structural.includes(message)) report.structural.push(message);
};

// ── field readers ─────────────────────────────────────────────
// Absent (`undefined`) means "not supplied" and resolves to the default
// without complaint. Anything else that is the wrong shape or an invalid
// value is *structural*: an import carrying it is refused.

function textOf(raw: Record<string, unknown>, key: string, path: string, report: Report): string {
  const v = raw[key];
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  flag(report, `${path}.${key} is not text (${JSON.stringify(v)})`);
  return "";
}

function idOf(raw: Record<string, unknown>, key: string, path: string, report: Report): string | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  flag(report, `${path}.${key} is not an id (${JSON.stringify(v)})`);
  return null;
}

function numOf(raw: Record<string, unknown>, key: string, fallback: number, path: string, report: Report): number {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  flag(report, `${path}.${key} is not a number (${JSON.stringify(v)})`);
  return fallback;
}

function enumOf<T extends string>(
  raw: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T, path: string, report: Report,
): T {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  flag(report, `${path}.${key} = ${JSON.stringify(v)} is not a valid value (expected ${allowed.join(" | ")})`);
  return fallback;
}

// ── records ───────────────────────────────────────────────────

function checkMeeting(raw: unknown, path: string, report: Report): Check<Meeting> {
  if (!isRecord(raw)) return no("not an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return no("missing id");
  if (raw.attendeeIds !== undefined && !Array.isArray(raw.attendeeIds)) return no("attendeeIds is not a list");
  if (raw.attendance !== undefined && !isRecord(raw.attendance)) return no("attendance is not a map");

  const attendance: Record<string, AttendanceStatus> = {};
  if (isRecord(raw.attendance)) {
    for (const [personId, value] of Object.entries(raw.attendance)) {
      attendance[personId] = enumOf(raw.attendance, personId, ATTENDANCE, "invited", `${path}.attendance`, report);
    }
  }
  let attendeeIds: string[] = [];
  if (Array.isArray(raw.attendeeIds)) {
    attendeeIds = raw.attendeeIds.filter((entry): entry is string => {
      if (typeof entry === "string") return true;
      flag(report, `${path}.attendeeIds contains a non-id entry (${JSON.stringify(entry)})`);
      return false;
    });
  } else {
    // no list supplied — the attendance map (if any) defines the attendees
    attendeeIds = Object.keys(attendance);
  }
  const attendanceClean: Record<string, AttendanceStatus> = {};
  for (const personId of attendeeIds) attendanceClean[personId] = attendance[personId] ?? "invited";

  let minuteOverride: string | null = null;
  if (raw.minuteOverride === null || raw.minuteOverride === undefined) minuteOverride = null;
  else if (typeof raw.minuteOverride === "string") minuteOverride = raw.minuteOverride;
  else flag(report, `${path}.minuteOverride is not text (${JSON.stringify(raw.minuteOverride)})`);

  return ok({
    id,
    title: textOf(raw, "title", path, report),
    purpose: textOf(raw, "purpose", path, report),
    date: textOf(raw, "date", path, report),
    startTime: textOf(raw, "startTime", path, report),
    endTime: textOf(raw, "endTime", path, report),
    location: textOf(raw, "location", path, report),
    organizerId: idOf(raw, "organizerId", path, report),
    status: enumOf(raw, "status", MEETING_STATUS, "upcoming", path, report),
    attendeeIds,
    attendance: attendanceClean,
    closingNotes: textOf(raw, "closingNotes", path, report),
    nextMeetingDate: textOf(raw, "nextMeetingDate", path, report),
    minuteOverride,
    createdAt: textOf(raw, "createdAt", path, report),
    updatedAt: textOf(raw, "updatedAt", path, report),
  });
}

function checkAgendaItem(raw: unknown, path: string, report: Report): Check<AgendaItem> {
  if (!isRecord(raw)) return no("not an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  const meetingId = typeof raw.meetingId === "string" ? raw.meetingId : "";
  if (!id) return no("missing id");
  if (!meetingId) return no("missing meetingId");
  return ok({
    id,
    meetingId,
    title: textOf(raw, "title", path, report),
    description: textOf(raw, "description", path, report),
    presenterId: idOf(raw, "presenterId", path, report),
    estimatedMinutes: numOf(raw, "estimatedMinutes", 10, path, report),
    sortOrder: numOf(raw, "sortOrder", 0, path, report),
    status: enumOf(raw, "status", AGENDA_STATUS, "not-started", path, report),
  });
}

function checkPerson(raw: unknown, path: string, report: Report): Check<Person> {
  if (!isRecord(raw)) return no("not an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return no("missing id");
  return ok({
    id,
    code: textOf(raw, "code", path, report),
    fullName: textOf(raw, "fullName", path, report),
    role: textOf(raw, "role", path, report),
    department: textOf(raw, "department", path, report),
    email: textOf(raw, "email", path, report),
    phone: textOf(raw, "phone", path, report),
    notes: textOf(raw, "notes", path, report),
    createdAt: textOf(raw, "createdAt", path, report),
  });
}

function checkNote(raw: unknown, path: string, report: Report): Check<MeetingNote> {
  if (!isRecord(raw)) return no("not an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  const meetingId = typeof raw.meetingId === "string" ? raw.meetingId : "";
  if (!id) return no("missing id");
  if (!meetingId) return no("missing meetingId");
  return ok({
    id,
    meetingId,
    content: textOf(raw, "content", path, report),
    createdAt: textOf(raw, "createdAt", path, report),
    updatedAt: textOf(raw, "updatedAt", path, report),
  });
}

function checkDecision(raw: unknown, path: string, report: Report): Check<Decision> {
  if (!isRecord(raw)) return no("not an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  const meetingId = typeof raw.meetingId === "string" ? raw.meetingId : "";
  if (!id) return no("missing id");
  if (!meetingId) return no("missing meetingId");
  return ok({
    id,
    meetingId,
    agendaItemId: idOf(raw, "agendaItemId", path, report),
    title: textOf(raw, "title", path, report),
    description: textOf(raw, "description", path, report),
    approvedBy: idOf(raw, "approvedBy", path, report),
    decisionDate: textOf(raw, "decisionDate", path, report),
    status: enumOf(raw, "status", DECISION_STATUS, "proposed", path, report),
  });
}

function checkActionItem(raw: unknown, path: string, report: Report): Check<ActionItem> {
  if (!isRecord(raw)) return no("not an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  const meetingId = typeof raw.meetingId === "string" ? raw.meetingId : "";
  if (!id) return no("missing id");
  if (!meetingId) return no("missing meetingId");
  return ok({
    id,
    meetingId,
    agendaItemId: idOf(raw, "agendaItemId", path, report),
    title: textOf(raw, "title", path, report),
    description: textOf(raw, "description", path, report),
    assigneeId: idOf(raw, "assigneeId", path, report),
    dueDate: textOf(raw, "dueDate", path, report),
    priority: enumOf(raw, "priority", PRIORITY, "medium", path, report),
    status: enumOf(raw, "status", TASK_STATUS, "pending", path, report),
    createdAt: textOf(raw, "createdAt", path, report),
    updatedAt: textOf(raw, "updatedAt", path, report),
  });
}

function checkSettings(raw: unknown, report: Report, repaired: string[]): AppSettings {
  if (!isRecord(raw)) {
    // Absent defaults are harmless; a present-but-wrong settings block is not.
    if (raw !== undefined) flag(report, "settings is not an object");
    else repaired.push("settings were not supplied; defaults applied.");
    return { ...DEFAULT_SETTINGS };
  }
  const startupAnimation = (() => {
    if (raw.startupAnimation === undefined) return DEFAULT_SETTINGS.startupAnimation;
    if (typeof raw.startupAnimation === "boolean") return raw.startupAnimation;
    flag(report, `settings.startupAnimation is not a boolean (${JSON.stringify(raw.startupAnimation)})`);
    return DEFAULT_SETTINGS.startupAnimation;
  })();
  return {
    theme: enumOf(raw, "theme", THEME, DEFAULT_SETTINGS.theme, "settings", report),
    motionPreference: enumOf(raw, "motionPreference", MOTION, DEFAULT_SETTINGS.motionPreference, "settings", report),
    startupAnimation,
    fontSize: enumOf(raw, "fontSize", FONT, DEFAULT_SETTINGS.fontSize, "settings", report),
    density: enumOf(raw, "density", DENSITY, DEFAULT_SETTINGS.density, "settings", report),
    dateFormat: enumOf(raw, "dateFormat", DATE_FORMAT, DEFAULT_SETTINGS.dateFormat, "settings", report),
    timeFormat: enumOf(raw, "timeFormat", TIME_FORMAT, DEFAULT_SETTINGS.timeFormat, "settings", report),
  };
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
 * Cross-record relationship check.
 *
 * The data model keeps its relationships as ids and nothing in the type system
 * says a reference resolves. This function is the one place that decides
 * whether a record set is *coherent*: every id unique, every child pointing at
 * a parent that exists, and every agenda reference inside the same meeting
 * (the interface only ever offers agenda items from the record being edited).
 *
 * Errors block an import. Personnel references are warnings: a person can be
 * absent from a backup while the meeting, decision or task that mentions them
 * is still perfectly usable — the interface renders such a reference as
 * "unassigned". `deletePerson()` already clears them, so they only appear in
 * files assembled outside RHODES.
 */
export interface RelationshipReport {
  errors: string[];
  warnings: string[];
}

export function checkRelationships(data: AppData): RelationshipReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  /** Index one collection, reporting every repeat of an id. */
  const indexIds = (collection: string, records: { id: string }[]): Map<string, number> => {
    const first = new Map<string, number>();
    records.forEach((record, i) => {
      const seen = first.get(record.id);
      if (seen === undefined) first.set(record.id, i);
      else errors.push(`${collection}[${i}] repeats the id "${record.id}" already used by ${collection}[${seen}]`);
    });
    return first;
  };

  const meetingAt = indexIds("meetings", data.meetings);
  const agendaAt = indexIds("agendaItems", data.agendaItems);
  indexIds("personnel", data.personnel);
  indexIds("notes", data.notes);
  indexIds("decisions", data.decisions);
  indexIds("actionItems", data.actionItems);

  const personIds = new Set(data.personnel.map((p) => p.id));
  const agendaMeeting = new Map(data.agendaItems.map((a) => [a.id, a.meetingId] as const));

  const meetingRef = (collection: string, i: number, id: string, meetingId: string): boolean => {
    if (meetingAt.has(meetingId)) return true;
    errors.push(`${collection}[${i}] "${id}" belongs to meeting "${meetingId}", which is not in this file`);
    return false;
  };

  const agendaRef = (collection: string, i: number, id: string, meetingId: string, agendaItemId: string | null): void => {
    if (!agendaItemId) return;
    if (!agendaAt.has(agendaItemId)) {
      errors.push(`${collection}[${i}] "${id}".agendaItemId points at agenda item "${agendaItemId}", which is not in this file`);
      return;
    }
    const owner = agendaMeeting.get(agendaItemId);
    if (owner !== meetingId) {
      errors.push(
        `${collection}[${i}] "${id}".agendaItemId points at agenda item "${agendaItemId}", which belongs to meeting "${owner}", not to its own meeting "${meetingId}"`,
      );
    }
  };

  const personRef = (collection: string, i: number, id: string, field: string, personId: string | null): void => {
    if (!personId || personIds.has(personId)) return;
    warnings.push(`${collection}[${i}] "${id}".${field} refers to personnel "${personId}", who is not in this file`);
  };

  data.meetings.forEach((m, i) => {
    personRef("meetings", i, m.id, "organizerId", m.organizerId);
    m.attendeeIds.forEach((personId) => personRef("meetings", i, m.id, "attendeeIds", personId));
    Object.keys(m.attendance).forEach((personId) => personRef("meetings", i, m.id, "attendance", personId));
  });

  data.agendaItems.forEach((a, i) => {
    meetingRef("agendaItems", i, a.id, a.meetingId);
    personRef("agendaItems", i, a.id, "presenterId", a.presenterId);
  });

  // The discussion log holds one note per meeting: a second one could never be
  // shown or edited, so an import carrying two would add an unreachable record.
  const noteAt = new Map<string, number>();
  data.notes.forEach((n, i) => {
    const seen = noteAt.get(n.meetingId);
    if (seen === undefined) noteAt.set(n.meetingId, i);
    else errors.push(`notes[${i}] "${n.id}" repeats the discussion note for meeting "${n.meetingId}" already held by notes[${seen}]`);
    meetingRef("notes", i, n.id, n.meetingId);
  });

  data.decisions.forEach((d, i) => {
    const meetingOk = meetingRef("decisions", i, d.id, d.meetingId);
    personRef("decisions", i, d.id, "approvedBy", d.approvedBy);
    if (meetingOk) agendaRef("decisions", i, d.id, d.meetingId, d.agendaItemId);
  });

  data.actionItems.forEach((t, i) => {
    const meetingOk = meetingRef("actionItems", i, t.id, t.meetingId);
    personRef("actionItems", i, t.id, "assigneeId", t.assigneeId);
    if (meetingOk) agendaRef("actionItems", i, t.id, t.meetingId, t.agendaItemId);
  });

  return { errors, warnings };
}

/**
 * Validate a payload against the RHODES schema and migrate it to the current
 * generation in memory. Never writes, never mutates the input.
 */
export function validateAppData(payload: unknown): ValidationResult {
  const fatal: string[] = [];
  const structural: string[] = [];
  const dropped: string[] = [];
  const repaired: string[] = [];
  const report: Report = { structural };
  let migratedFrom: number | null = null;

  const finish = (data: AppData | null): ValidationResult => {
    const rel = data ? checkRelationships(data) : { errors: [], warnings: [] };
    return {
      usable: fatal.length === 0 && data !== null,
      clean:
        fatal.length === 0 && structural.length === 0 && dropped.length === 0 &&
        rel.errors.length === 0 && data !== null,
      fatal,
      structural,
      dropped,
      repaired,
      relationships: rel.errors,
      relationshipWarnings: rel.warnings,
      migratedFrom,
      counts: data ? countRecords(data) : { meetings: 0, agendaItems: 0, personnel: 0, notes: 0, decisions: 0, actionItems: 0, total: 0 },
      data,
    };
  };

  if (!isRecord(payload)) {
    fatal.push("The payload is not a RHODES data object.");
    return finish(null);
  }

  // ── meta + schema generation ───────────────────────────────
  // Compatibility rule: the meta block is required (an absent block is a
  // structural omission), `version` defaults to 1 when absent, and an absent
  // `schemaVersion` means the original v1 records — the legacy path. Values
  // that are present but of the wrong type are invalid metadata.
  const metaRaw = payload.meta;
  let metaVersion = 1;
  let firstRunAt = "";
  let adapter = "localStorage-prototype";
  let extras: Record<string, unknown> = {};
  if (isRecord(metaRaw)) {
    extras = { ...metaRaw };
    if (metaRaw.version !== undefined) {
      if (typeof metaRaw.version === "number" && Number.isFinite(metaRaw.version)) metaVersion = metaRaw.version;
      else flag(report, `meta.version is not a number (${JSON.stringify(metaRaw.version)})`);
    }
    if (metaRaw.firstRunAt !== undefined && typeof metaRaw.firstRunAt !== "string") {
      flag(report, `meta.firstRunAt is not text (${JSON.stringify(metaRaw.firstRunAt)})`);
    } else {
      firstRunAt = typeof metaRaw.firstRunAt === "string" ? metaRaw.firstRunAt : "";
      if (metaRaw.firstRunAt === undefined) repaired.push("meta.firstRunAt was not supplied; left empty.");
    }
    if (metaRaw.adapter !== undefined && typeof metaRaw.adapter !== "string") {
      flag(report, `meta.adapter is not text (${JSON.stringify(metaRaw.adapter)})`);
    } else if (typeof metaRaw.adapter === "string" && metaRaw.adapter) {
      adapter = metaRaw.adapter;
    }
    const declared = (() => {
      if (metaRaw.schemaVersion === undefined) return 1;
      if (typeof metaRaw.schemaVersion === "number" && Number.isFinite(metaRaw.schemaVersion)) {
        return metaRaw.schemaVersion;
      }
      flag(report, `meta.schemaVersion is not a number (${JSON.stringify(metaRaw.schemaVersion)})`);
      return 1;
    })();
    if (declared > SCHEMA_VERSION) {
      fatal.push(
        `These records were written by a newer RHODES schema (v${declared}); this build understands v${SCHEMA_VERSION}. Update the application before opening them.`,
      );
    } else if (declared < SCHEMA_VERSION) {
      migratedFrom = declared;
      repaired.push(`Records migrated from schema v${declared} to v${SCHEMA_VERSION}.`);
    }
  } else if (metaRaw === undefined) {
    flag(report, "meta is missing");
  } else {
    flag(report, `meta is not an object (${JSON.stringify(metaRaw)})`);
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
  // A missing collection is a structural omission (never an empty list): an
  // import that simply forgot `decisions` must not wipe the decision log.
  const list = (key: string): unknown[] | null => {
    const raw = payload[key];
    if (raw === undefined) {
      flag(report, `${key} is missing`);
      return [];
    }
    if (raw === null) {
      flag(report, `${key} is null`);
      return [];
    }
    if (!Array.isArray(raw)) {
      fatal.push(`${key} is not a list.`);
      return null;
    }
    return raw;
  };

  const pull = <T,>(key: string, check: (raw: unknown, path: string, report: Report) => Check<T>): T[] | null => {
    const raw = list(key);
    if (raw === null) return null;
    const out: T[] = [];
    raw.forEach((entry, index) => {
      const path = `${key}[${index}]`;
      const result = check(entry, path, report);
      if (result.ok) out.push(result.value);
      else dropped.push(`${path} — ${result.reason}`);
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

  const settings = checkSettings(payload.settings, report, repaired);

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

/** Why an import cannot be applied — empty when the file is acceptable. */
export function importRejectionReason(result: ValidationResult): string {
  if (result.usable && result.clean) return "";
  const problems = [...result.fatal, ...result.structural, ...result.dropped, ...result.relationships];
  if (!problems.length) return "File does not match the RHODES data schema.";
  return problems.slice(0, 4).join(" · ");
}
