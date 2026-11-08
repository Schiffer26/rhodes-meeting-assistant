// RHODES · shared utilities (dates, ids, exports, minutes)
import type {
  ActionItem, AgendaItem, AppSettings, Decision, Meeting, MeetingNote, MeetingTemplate, Person,
} from "@/types";

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── Dates ────────────────────────────────────────────────────
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatDate(iso: string, fmt: AppSettings["dateFormat"] = "iso"): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  if (fmt === "dmy") return `${d}/${m}/${y}`;
  if (fmt === "mdy") return `${m}/${d}/${y}`;
  return `${y}-${m}-${d}`;
}

export function formatDateLong(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

export function formatTime(hhmm: string, fmt: AppSettings["timeFormat"] = "24h"): string {
  if (!hhmm) return "—";
  const [hStr, m] = hhmm.split(":");
  let h = parseInt(hStr, 10);
  if (isNaN(h)) return hhmm;
  if (fmt === "24h") return `${String(h).padStart(2, "0")}:${m}`;
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

export function daysUntil(iso: string): number {
  const a = new Date(todayISO() + "T00:00:00").getTime();
  const b = new Date(iso + "T00:00:00").getTime();
  return Math.round((b - a) / 86400000);
}

export function isTaskOverdue(t: ActionItem): boolean {
  return t.status !== "completed" && !!t.dueDate && daysUntil(t.dueDate) < 0;
}
export function isTaskDueSoon(t: ActionItem): boolean {
  const d = daysUntil(t.dueDate);
  return t.status !== "completed" && !!t.dueDate && d >= 0 && d <= 3;
}

export const timeAgo = (iso: string): string => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "JUST NOW";
  if (s < 3600) return `${Math.floor(s / 60)}M AGO`;
  if (s < 86400) return `${Math.floor(s / 3600)}H AGO`;
  return `${Math.floor(s / 86400)}D AGO`;
};

// ── Labels & tones ───────────────────────────────────────────
export const MEETING_STATUS: Record<string, { label: string; tone: string }> = {
  "upcoming":    { label: "Upcoming", tone: "cyan" },
  "in-progress": { label: "In Progress", tone: "yellow" },
  "completed":   { label: "Completed", tone: "green" },
  "cancelled":   { label: "Cancelled", tone: "gray" },
};
export const AGENDA_STATUS: Record<string, { label: string; tone: string }> = {
  "not-started":   { label: "Not Started", tone: "gray" },
  "in-discussion": { label: "In Discussion", tone: "cyan" },
  "discussed":     { label: "Discussed", tone: "green" },
  "skipped":       { label: "Skipped", tone: "amber" },
  "postponed":     { label: "Postponed", tone: "red" },
};
export const TASK_STATUS: Record<string, { label: string; tone: string }> = {
  "pending":     { label: "Pending", tone: "amber" },
  "in-progress": { label: "In Progress", tone: "cyan" },
  "completed":   { label: "Completed", tone: "green" },
};
export const PRIORITY: Record<string, { label: string; tone: string }> = {
  low: { label: "Low", tone: "gray" },
  medium: { label: "Medium", tone: "cyan" },
  high: { label: "High", tone: "amber" },
  critical: { label: "Critical", tone: "red" },
};
export const DECISION_STATUS: Record<string, { label: string; tone: string }> = {
  proposed: { label: "Proposed", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  deferred: { label: "Deferred", tone: "gray" },
};
export const ATTENDANCE: Record<string, { label: string; tone: string }> = {
  invited: { label: "Invited", tone: "gray" },
  present: { label: "Present", tone: "green" },
  absent: { label: "Absent", tone: "red" },
  excused: { label: "Excused", tone: "amber" },
};

export const personName = (p: Person | null | undefined): string => (p ? p.fullName : "—");

// ── Meeting templates ────────────────────────────────────────
export const MEETING_TEMPLATES: MeetingTemplate[] = [
  {
    id: "tpl_general", name: "General Meeting",
    purpose: "General coordination meeting.",
    agenda: [
      { title: "Opening and objectives", minutes: 5 },
      { title: "Main discussion", minutes: 30 },
      { title: "Decisions and assignments", minutes: 15 },
      { title: "Closing remarks", minutes: 5 },
    ],
  },
  {
    id: "tpl_planning", name: "Project Planning",
    purpose: "Define scope, milestones, and ownership for a project.",
    agenda: [
      { title: "Scope and objectives", minutes: 20 },
      { title: "Milestones and timeline", minutes: 30 },
      { title: "Ownership matrix", minutes: 20 },
      { title: "Risk review", minutes: 15 },
    ],
  },
  {
    id: "tpl_progress", name: "Progress Review",
    purpose: "Review progress against objectives and escalate blockers.",
    agenda: [
      { title: "Status reports", minutes: 30 },
      { title: "Blocker escalation", minutes: 20 },
      { title: "Metric review", minutes: 15 },
      { title: "Next steps", minutes: 10 },
    ],
  },
  {
    id: "tpl_training", name: "Training & Operations Review",
    purpose: "Assess readiness, equipment, and drill programs.",
    agenda: [
      { title: "Equipment inventory check", minutes: 15 },
      { title: "Schedule conflict resolution", minutes: 20 },
      { title: "Drill program assessment", minutes: 20 },
      { title: "Sign-off", minutes: 10 },
    ],
  },
];

// ── Minutes generation (deterministic, no AI) ────────────────
export function buildMinutesMarkdown(
  meeting: Meeting, agenda: AgendaItem[], note: MeetingNote | undefined,
  decisions: Decision[], actions: ActionItem[], people: Person[], settings: AppSettings,
): string {
  const ppl = (id: string | null) => people.find((p) => p.id === id)?.fullName ?? "—";
  const stripHtml = (html: string) =>
    html.replace(/<input[^>]*type="checkbox"[^>]*checked[^>]*>/gi, "[x] ")
        .replace(/<input[^>]*type="checkbox"[^>]*>/gi, "[ ] ")
        .replace(/<div class="chk">/gi, "- ").replace(/<\/div>/gi, "")
        .replace(/<li>/gi, "- ").replace(/<\/li>/gi, "")
        .replace(/<h2>/gi, "\n### ").replace(/<\/h2>/gi, "\n")
        .replace(/<h3>/gi, "\n#### ").replace(/<\/h3>/gi, "\n")
        .replace(/<\/p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
        .replace(/<b>|<strong>/gi, "**").replace(/<\/b>|<\/strong>/gi, "**")
        .replace(/<i>|<em>/gi, "*").replace(/<\/i>|<\/em>/gi, "*")
        .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n").trim();

  const L: string[] = [];
  L.push(`# MEETING MINUTES — ${meeting.title.toUpperCase()}`);
  L.push(`RHODES · Personal Meeting Operations · Record ${meeting.id.toUpperCase()}`);
  L.push(``);
  L.push(`## 1 · MEETING DETAILS`);
  L.push(`- Date: ${formatDate(meeting.date, settings.dateFormat)}`);
  L.push(`- Time: ${formatTime(meeting.startTime, settings.timeFormat)} — ${formatTime(meeting.endTime, settings.timeFormat)}`);
  L.push(`- Location: ${meeting.location || "—"}`);
  L.push(`- Organizer: ${ppl(meeting.organizerId)}`);
  L.push(`- Status: ${MEETING_STATUS[meeting.status]?.label ?? meeting.status}`);
  if (meeting.purpose) L.push(`- Purpose: ${meeting.purpose}`);
  L.push(``);
  L.push(`## 2 · ATTENDANCE`);
  if (!meeting.attendeeIds.length) L.push(`- No attendees recorded.`);
  meeting.attendeeIds.forEach((id) => {
    const att = meeting.attendance[id] ?? "invited";
    L.push(`- ${ppl(id)} — ${ATTENDANCE[att]?.label ?? att}`);
  });
  L.push(``);
  L.push(`## 3 · AGENDA`);
  agenda.forEach((a, i) => {
    L.push(`${i + 1}. ${a.title} (${a.estimatedMinutes} min) — ${AGENDA_STATUS[a.status]?.label ?? a.status} · ${ppl(a.presenterId)}`);
    if (a.description) L.push(`   ${a.description}`);
  });
  if (!agenda.length) L.push(`- Agenda not recorded.`);
  L.push(``);
  L.push(`## 4 · DISCUSSION NOTES`);
  L.push(note && note.content.trim() ? stripHtml(note.content) : "- No notes recorded.");
  L.push(``);
  L.push(`## 5 · DECISIONS`);
  decisions.forEach((d, i) => {
    L.push(`${i + 1}. **[${DECISION_STATUS[d.status]?.label ?? d.status}]** ${d.title}`);
    if (d.description) L.push(`   ${d.description}`);
    L.push(`   Approved by: ${ppl(d.approvedBy)} · Date: ${formatDate(d.decisionDate, settings.dateFormat)}`);
  });
  if (!decisions.length) L.push(`- No decisions recorded.`);
  L.push(``);
  L.push(`## 6 · ACTION ITEMS`);
  actions.forEach((t, i) => {
    L.push(`${i + 1}. ${t.title} — ${ppl(t.assigneeId)} · Due ${formatDate(t.dueDate, settings.dateFormat)} · ${PRIORITY[t.priority]?.label ?? t.priority} · ${TASK_STATUS[t.status]?.label ?? t.status}`);
    if (t.description) L.push(`   ${t.description}`);
  });
  if (!actions.length) L.push(`- No action items recorded.`);
  L.push(``);
  L.push(`## 7 · CLOSING`);
  L.push(meeting.closingNotes?.trim() ? meeting.closingNotes : "- No closing notes recorded.");
  L.push(`- Next meeting: ${meeting.nextMeetingDate ? formatDateLong(meeting.nextMeetingDate) : "—"}`);
  L.push(``);
  L.push(`—`);
  L.push(`Generated locally by RHODES v1.0 · No network operations performed.`);
  return L.join("\n");
}

// ── File download / import ───────────────────────────────────
export function downloadFile(name: string, content: string, mime = "text/plain"): void {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("File could not be read"));
    r.readAsText(file);
  });
}

export function friendlyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
