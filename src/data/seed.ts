// ─────────────────────────────────────────────────────────────
// RHODES · Demonstration seed data (all fictional)
// Dates are generated relative to the local date so the
// Command Center always shows live, truthful statistics.
// ─────────────────────────────────────────────────────────────
import type { AppData, Meeting, Person, AgendaItem, MeetingNote, Decision, ActionItem } from "@/types";
import { DEFAULT_SETTINGS } from "@/types";

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
const now = () => new Date().toISOString();

export function buildSeedData(): AppData {
  const personnel: Person[] = [
    { id: "p_amara", code: "OP-0001", fullName: "Amara Chen", role: "Operations Director", department: "Operations Command", email: "a.chen@rhodes.local", phone: "+1 555 0101", notes: "Primary coordinator for cross-department reviews.", createdAt: now() },
    { id: "p_jonas", code: "OP-0002", fullName: "Jonas Reed", role: "Logistics Manager", department: "Logistics", email: "j.reed@rhodes.local", phone: "+1 555 0102", notes: "Owns supply corridor scheduling.", createdAt: now() },
    { id: "p_kira", code: "OP-0003", fullName: "Kira Novak", role: "Training Supervisor", department: "Personnel Development", email: "k.novak@rhodes.local", phone: "", notes: "Readiness assessments and drill programs.", createdAt: now() },
    { id: "p_elias", code: "OP-0004", fullName: "Elias Brandt", role: "Engineering Lead", department: "Engineering", email: "e.brandt@rhodes.local", phone: "+1 555 0104", notes: "", createdAt: now() },
    { id: "p_mira", code: "OP-0005", fullName: "Mira Solberg", role: "Medical Coordinator", department: "Medical Division", email: "m.solberg@rhodes.local", phone: "+1 555 0105", notes: "Quarterly health audit owner.", createdAt: now() },
    { id: "p_theo", code: "OP-0006", fullName: "Theo Marchetti", role: "Security Officer", department: "Security", email: "", phone: "+1 555 0106", notes: "Access control and perimeter sweeps.", createdAt: now() },
  ];

  const meetings: Meeting[] = [
    {
      id: "m_ops_review", title: "Monthly Operations Review", purpose: "Review operational throughput, incident rates and resource allocation for the current cycle; confirm next-cycle priorities.",
      date: day(-7), startTime: "10:00", endTime: "11:30", location: "Command Deck — Room C-2", organizerId: "p_amara",
      status: "completed", attendeeIds: ["p_amara", "p_jonas", "p_elias", "p_theo"],
      attendance: { p_amara: "present", p_jonas: "present", p_elias: "present", p_theo: "excused" },
      closingNotes: "Cycle metrics accepted. Corridor re-routing proposal moves to planning. Next review to include logistics forecast annex.",
      nextMeetingDate: day(21), minuteOverride: null, createdAt: now(), updatedAt: now(),
    },
    {
      id: "m_training", title: "Training Room Readiness Meeting", purpose: "Verify training room equipment, scheduling conflicts and drill program status before the new intake cycle.",
      date: day(-2), startTime: "14:00", endTime: "15:00", location: "Personnel Development — Annex B", organizerId: "p_kira",
      status: "completed", attendeeIds: ["p_kira", "p_mira", "p_theo"],
      attendance: { p_kira: "present", p_mira: "present", p_theo: "absent" },
      closingNotes: "Two projectors flagged for replacement. Medical drill moved to next cycle.",
      nextMeetingDate: "", minuteOverride: null, createdAt: now(), updatedAt: now(),
    },
    {
      id: "m_sync", title: "Weekly Operations Sync", purpose: "Short synchronization on running maintenance windows and today\u2019s task board.",
      date: day(0), startTime: "09:00", endTime: "09:30", location: "Operations Floor — Huddle Point 3", organizerId: "p_jonas",
      status: "in-progress", attendeeIds: ["p_jonas", "p_amara", "p_elias"],
      attendance: { p_jonas: "present", p_amara: "present", p_elias: "invited" },
      closingNotes: "", nextMeetingDate: "", minuteOverride: null, createdAt: now(), updatedAt: now(),
    },
    {
      id: "m_planning", title: "Project Planning Session", purpose: "Define scope, milestones and ownership for the supply corridor re-routing project approved at the last operations review.",
      date: day(1), startTime: "13:00", endTime: "14:30", location: "Command Deck — Room C-2", organizerId: "p_amara",
      status: "upcoming", attendeeIds: ["p_amara", "p_jonas", "p_elias"],
      attendance: { p_amara: "invited", p_jonas: "invited", p_elias: "invited" },
      closingNotes: "", nextMeetingDate: "", minuteOverride: null, createdAt: now(), updatedAt: now(),
    },
    {
      id: "m_progress", title: "Department Progress Review", purpose: "Each department reports progress against quarterly objectives; blockers are escalated and assigned.",
      date: day(4), startTime: "10:30", endTime: "12:00", location: "Main Briefing Hall", organizerId: "p_mira",
      status: "upcoming", attendeeIds: ["p_mira", "p_amara", "p_kira", "p_elias", "p_theo"],
      attendance: {}, closingNotes: "", nextMeetingDate: "", minuteOverride: null, createdAt: now(), updatedAt: now(),
    },
    {
      id: "m_corridor", title: "Supply Corridor Coordination", purpose: "Align delivery windows with engineering maintenance to avoid corridor congestion.",
      date: day(9), startTime: "15:00", endTime: "16:00", location: "Logistics Bay — Office L-1", organizerId: "p_jonas",
      status: "upcoming", attendeeIds: ["p_jonas", "p_elias"],
      attendance: {}, closingNotes: "", nextMeetingDate: "", minuteOverride: null, createdAt: now(), updatedAt: now(),
    },
    {
      id: "m_vendor", title: "Vendor Equipment Briefing", purpose: "External briefing on replacement projector hardware.",
      date: day(6), startTime: "11:00", endTime: "11:45", location: "Reception — Room R-4", organizerId: "p_kira",
      status: "cancelled", attendeeIds: ["p_kira"],
      attendance: {}, closingNotes: "", nextMeetingDate: "", minuteOverride: null, createdAt: now(), updatedAt: now(),
    },
  ];

  const agendaItems: AgendaItem[] = [
    { id: "a_or_1", meetingId: "m_ops_review", title: "Cycle metrics recap", description: "Throughput, incident counts, energy draw versus plan.", presenterId: "p_amara", estimatedMinutes: 20, sortOrder: 0, status: "discussed" },
    { id: "a_or_2", meetingId: "m_ops_review", title: "Supply corridor congestion", description: "Root cause and the re-routing proposal from logistics.", presenterId: "p_jonas", estimatedMinutes: 25, sortOrder: 1, status: "discussed" },
    { id: "a_or_3", meetingId: "m_ops_review", title: "Engineering maintenance window", description: "Aligning corridor work with reactor maintenance downtime.", presenterId: "p_elias", estimatedMinutes: 20, sortOrder: 2, status: "discussed" },
    { id: "a_or_4", meetingId: "m_ops_review", title: "Next-cycle priorities", description: "Vote on ranked priority list.", presenterId: "p_amara", estimatedMinutes: 15, sortOrder: 3, status: "discussed" },
    { id: "a_tr_1", meetingId: "m_training", title: "Equipment inventory check", description: "Projectors, simulators and safety gear status.", presenterId: "p_kira", estimatedMinutes: 15, sortOrder: 0, status: "discussed" },
    { id: "a_tr_2", meetingId: "m_training", title: "Intake schedule conflicts", description: "Resolve overlap with medical drill calendar.", presenterId: "p_mira", estimatedMinutes: 20, sortOrder: 1, status: "discussed" },
    { id: "a_tr_3", meetingId: "m_training", title: "Drill program sign-off", description: "Confirm exercises for the new intake cycle.", presenterId: "p_kira", estimatedMinutes: 15, sortOrder: 2, status: "skipped" },
    { id: "a_sy_1", meetingId: "m_sync", title: "Maintenance windows", description: "Today\u2019s approved windows and responsible leads.", presenterId: "p_elias", estimatedMinutes: 10, sortOrder: 0, status: "in-discussion" },
    { id: "a_sy_2", meetingId: "m_sync", title: "Task board sweep", description: "Blockers and overdue items.", presenterId: "p_jonas", estimatedMinutes: 10, sortOrder: 1, status: "not-started" },
    { id: "a_pl_1", meetingId: "m_planning", title: "Scope and objectives", description: "Boundaries of the corridor re-routing project.", presenterId: "p_amara", estimatedMinutes: 20, sortOrder: 0, status: "not-started" },
    { id: "a_pl_2", meetingId: "m_planning", title: "Milestones and timeline", description: "Draft milestone plan with dates.", presenterId: "p_jonas", estimatedMinutes: 30, sortOrder: 1, status: "not-started" },
    { id: "a_pl_3", meetingId: "m_planning", title: "Ownership matrix", description: "Assign responsibility for each workstream.", presenterId: "p_elias", estimatedMinutes: 20, sortOrder: 2, status: "not-started" },
    { id: "a_pr_1", meetingId: "m_progress", title: "Department reports", description: "Progress against quarterly objectives per department.", presenterId: "p_mira", estimatedMinutes: 40, sortOrder: 0, status: "not-started" },
    { id: "a_pr_2", meetingId: "m_progress", title: "Blocker escalation", description: "Unblock items requiring cross-team support.", presenterId: "p_amara", estimatedMinutes: 25, sortOrder: 1, status: "not-started" },
  ];

  const notes: MeetingNote[] = [
    {
      id: "n_ops", meetingId: "m_ops_review",
      content: `<h2>Cycle metrics</h2><p>Throughput at <b>96.2%</b> of plan. Two minor incidents — both in Logistics, none critical.</p><p>Energy draw +4% due to extended maintenance on lift 3.</p><h2>Corridor congestion</h2><p>Peak-hour congestion traced to overlapping delivery windows. Jonas presented a <i>two-lane re-routing proposal</i> using the east service corridor.</p><ul><li>East corridor supports the load with minor re-surfacing</li><li>Engineering confirms downtime alignment is possible</li></ul><div class="chk"><input type="checkbox" checked/> Circulate proposal annex before planning session</div><div class="chk"><input type="checkbox"/> Reserve east corridor survey slot</div>`,
      createdAt: now(), updatedAt: now(),
    },
    {
      id: "n_train", meetingId: "m_training",
      content: `<h2>Equipment</h2><p>Two projectors end-of-life — replacement requisition drafted. Simulators all pass checks.</p><h2>Schedule</h2><p>Medical drill overlaps intake week 2; Mira agrees to move the drill to next cycle.</p>`,
      createdAt: now(), updatedAt: now(),
    },
    { id: "n_sync", meetingId: "m_sync", content: `<p><span class="ts">[09:04]</span> Window W-2 opened early; lift 3 crew on site.</p>`, createdAt: now(), updatedAt: now() },
  ];

  const decisions: Decision[] = [
    { id: "d_1", meetingId: "m_ops_review", agendaItemId: "a_or_2", title: "Approve east corridor re-routing", description: "Proceed with the two-lane re-routing proposal; engineering survey precedes scheduling.", approvedBy: "p_amara", decisionDate: day(-7), status: "approved" },
    { id: "d_2", meetingId: "m_ops_review", agendaItemId: "a_or_4", title: "Next-cycle priority ranking", description: "Priority order: corridor project, lift 3 overhaul, drill program refresh.", approvedBy: null, decisionDate: day(-7), status: "approved" },
    { id: "d_3", meetingId: "m_training", agendaItemId: "a_tr_1", title: "Replace two projectors", description: "Requisition submitted; vendor briefing postponed pending quotes.", approvedBy: "p_kira", decisionDate: day(-2), status: "approved" },
    { id: "d_4", meetingId: "m_training", agendaItemId: "a_tr_2", title: "Move medical drill to next cycle", description: "De-conflicts intake week 2 at the cost of a later drill date.", approvedBy: null, decisionDate: day(-2), status: "deferred" },
  ];

  const actionItems: ActionItem[] = [
    { id: "t_1", meetingId: "m_ops_review", agendaItemId: "a_or_2", title: "Compile corridor survey report", description: "Structural survey of the east service corridor with load ratings.", assigneeId: "p_elias", dueDate: day(-1), priority: "high", status: "pending", createdAt: now(), updatedAt: now() },
    { id: "t_2", meetingId: "m_ops_review", agendaItemId: "a_or_4", title: "Publish next-cycle priority list", description: "Circulate the approved ranking to all department leads.", assigneeId: "p_amara", dueDate: day(-5), priority: "medium", status: "completed", createdAt: now(), updatedAt: now() },
    { id: "t_3", meetingId: "m_training", agendaItemId: "a_tr_1", title: "Order replacement projectors", description: "Two units, matching mounting standard of Annex B.", assigneeId: "p_kira", dueDate: day(2), priority: "medium", status: "in-progress", createdAt: now(), updatedAt: now() },
    { id: "t_4", meetingId: "m_ops_review", agendaItemId: "a_or_3", title: "Confirm maintenance downtime table", description: "Send final downtime windows to logistics for corridor planning.", assigneeId: "p_elias", dueDate: day(3), priority: "critical", status: "in-progress", createdAt: now(), updatedAt: now() },
    { id: "t_5", meetingId: "m_training", agendaItemId: "a_tr_2", title: "Publish revised drill calendar", description: "Reflect the moved medical drill and notify personnel.", assigneeId: "p_mira", dueDate: day(1), priority: "high", status: "pending", createdAt: now(), updatedAt: now() },
    { id: "t_6", meetingId: "m_sync", agendaItemId: "a_sy_1", title: "Post today's window roster", description: "Pin window roster at Huddle Point 3.", assigneeId: "p_jonas", dueDate: day(0), priority: "low", status: "completed", createdAt: now(), updatedAt: now() },
    { id: "t_7", meetingId: "m_ops_review", agendaItemId: null, title: "Archive cycle metrics to records", description: "Upload the signed-off metric sheets to the records archive shelf.", assigneeId: "p_theo", dueDate: day(12), priority: "low", status: "pending", createdAt: now(), updatedAt: now() },
  ];

  return {
    meetings, agendaItems, personnel, notes, decisions, actionItems,
    settings: { ...DEFAULT_SETTINGS },
    meta: { version: 1, firstRunAt: now(), adapter: "localStorage-prototype" },
  };
}
