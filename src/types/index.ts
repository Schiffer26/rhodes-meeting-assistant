// ─────────────────────────────────────────────────────────────
// RHODES · TypeScript data model
// Relationships are maintained through unique IDs.
// ─────────────────────────────────────────────────────────────

export type ID = string;

export type MeetingStatus = "upcoming" | "in-progress" | "completed" | "cancelled";
export type AgendaStatus = "not-started" | "in-discussion" | "discussed" | "skipped" | "postponed";
export type AttendanceStatus = "invited" | "present" | "absent" | "excused";
export type TaskStatus = "pending" | "in-progress" | "completed";
export type Priority = "low" | "medium" | "high" | "critical";
export type DecisionStatus = "proposed" | "approved" | "rejected" | "deferred";

export interface Meeting {
  id: ID;
  title: string;
  purpose: string;
  date: string; // YYYY-MM-DD (local)
  startTime: string; // HH:MM (24h)
  endTime: string; // HH:MM (24h)
  location: string;
  organizerId: ID | null;
  status: MeetingStatus;
  attendeeIds: ID[];
  attendance: Record<ID, AttendanceStatus>;
  closingNotes: string;
  nextMeetingDate: string; // YYYY-MM-DD or ''
  minuteOverride: string | null; // user-edited minutes markdown
  createdAt: string;
  updatedAt: string;
}

export interface AgendaItem {
  id: ID;
  meetingId: ID;
  title: string;
  description: string;
  presenterId: ID | null;
  estimatedMinutes: number;
  sortOrder: number;
  status: AgendaStatus;
}

export interface Person {
  id: ID;
  code: string; // structured identifier, e.g. OP-0001
  fullName: string;
  role: string;
  department: string;
  email: string;
  phone: string;
  notes: string;
  createdAt: string;
}

export interface MeetingNote {
  id: ID;
  meetingId: ID;
  content: string; // HTML authored by the manual editor
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  id: ID;
  meetingId: ID;
  agendaItemId: ID | null;
  title: string;
  description: string;
  approvedBy: ID | null;
  decisionDate: string; // YYYY-MM-DD
  status: DecisionStatus;
}

export interface ActionItem {
  id: ID;
  meetingId: ID;
  agendaItemId: ID | null;
  title: string;
  description: string;
  assigneeId: ID | null;
  dueDate: string; // YYYY-MM-DD
  priority: Priority;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export type ThemeMode = "terminal" | "archive" | "system";
export type MotionPref = "immersive" | "reduced" | "off";
export type FontSize = "small" | "medium" | "large";
export type Density = "comfortable" | "compact";
export type DateFormat = "iso" | "dmy" | "mdy";
export type TimeFormat = "24h" | "12h";

export interface AppSettings {
  theme: ThemeMode;
  motionPreference: MotionPref;
  startupAnimation: boolean;
  fontSize: FontSize;
  density: Density;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
}

export interface AppData {
  meetings: Meeting[];
  agendaItems: AgendaItem[];
  personnel: Person[];
  notes: MeetingNote[];
  decisions: Decision[];
  actionItems: ActionItem[];
  settings: AppSettings;
  meta: { version: number; firstRunAt: string; adapter: string };
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "terminal",
  motionPreference: "immersive",
  startupAnimation: true,
  fontSize: "medium",
  density: "comfortable",
  dateFormat: "iso",
  timeFormat: "24h",
};

export type SaveState = "idle" | "saving" | "saved" | "error";

// Meeting templates — local starter agendas.
export interface MeetingTemplate {
  id: string;
  name: string;
  purpose: string;
  agenda: { title: string; minutes: number }[];
}
