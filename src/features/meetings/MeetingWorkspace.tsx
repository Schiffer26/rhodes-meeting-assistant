// ─────────────────────────────────────────────────────────────
// RHODES · SCREEN 3 — MEETING WORKSPACE
// The core operational surface: header, tabbed sections,
// attendee rail, quick capture. Staggered panel entrance.
// ─────────────────────────────────────────────────────────────
import React, { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, CirclePlay, CircleStop, Pencil, RotateCcw } from "lucide-react";
import { Badge, Button, Corners, Panel, SaveIndicator, ScanWipe } from "@/components/ui";
import { useAppData, useMotionScale } from "@/hooks/store";
import { useUi } from "@/hooks/ui";
import type { MeetingStatus } from "@/types";
import { MEETING_STATUS, formatDateLong, formatTime } from "@/utils/helpers";
import type { Route } from "@/layout/AppShell";
import {
  ActionsPanel, AgendaPanel, AttendeesRail, DecisionsPanel, MinutesPanel, NotesPanel, OverviewPanel, QuickCaptureRail,
} from "./WorkspacePanels";

type TabId = "overview" | "agenda" | "notes" | "decisions" | "actions" | "minutes";
const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "agenda", label: "Agenda" },
  { id: "notes", label: "Notes" },
  { id: "decisions", label: "Decisions" },
  { id: "actions", label: "Action Items" },
  { id: "minutes", label: "Minutes" },
];

export function MeetingWorkspace({ meetingId, navigate }: { meetingId: string; navigate: (r: Route) => void }) {
  const { data, saveState, setMeetingStatus } = useAppData();
  const ui = useUi();
  const { off, scale } = useMotionScale();
  const [tab, setTab] = useState<TabId>("overview");

  const meeting = data.meetings.find((m) => m.id === meetingId);
  const agenda = useMemo(() => data.agendaItems.filter((a) => a.meetingId === meetingId), [data.agendaItems, meetingId]);
  const tasks = useMemo(() => data.actionItems.filter((t) => t.meetingId === meetingId), [data.actionItems, meetingId]);
  const decisions = useMemo(() => data.decisions.filter((d) => d.meetingId === meetingId), [data.decisions, meetingId]);

  if (!meeting) {
    return (
      <Panel title="Workspace Error" code="RECORD NOT FOUND">
        <div style={{ padding: 20 }}>
          <p className="small dim">This meeting record no longer exists. It may have been deleted.</p>
          <Button style={{ marginTop: 14 }} icon={<ArrowLeft size={13} />} onClick={() => navigate({ section: "meetings" })}>Back to directory</Button>
        </div>
      </Panel>
    );
  }

  const st = MEETING_STATUS[meeting.status];
  const counts: Record<TabId, number | null> = {
    overview: null, agenda: agenda.length, notes: null,
    decisions: decisions.length, actions: tasks.length, minutes: null,
  };

  // ── tab semantics: stable ids, roving tabIndex, arrow-key navigation
  const tabBase = `ws-${meeting.id}`;
  const tabIdOf = (id: TabId) => `${tabBase}-tab-${id}`;
  const panelId = `${tabBase}-panel`; // one persistent region, content swapped per tab
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  const focusTab = (id: TabId) => {
    setTab(id);
    // focus follows selection (automatic activation)
    requestAnimationFrame(() => tabRefs.current[id]?.focus());
  };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    focusTab(TABS[next].id);
  };

  const stagger = (i: number) => off
    ? {}
    : { initial: { opacity: 0, y: 12 * scale }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.3 * scale, delay: i * 0.09 * scale, ease: [0.22, 0.61, 0.36, 1] as const } };

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {/* ── Header (appears first) ──────────────────── */}
      <motion.div {...stagger(0)}>
        <Panel pad={false} className="clip-corner" style={{ borderLeft: "4px solid var(--accent)" }}>
          <div style={{ padding: "20px 24px", display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
            <button className="editor-tool" style={{ width: 44, height: 44, border: "1px solid var(--border)", flexShrink: 0, background: "var(--surface-2)" }}
              onClick={() => navigate({ section: "meetings" })} title="Back to Meeting Operations" aria-label="Back to Meeting Operations">
              <ArrowLeft size={18} />
            </button>
            <div style={{ flex: "1 1 320px", minWidth: 0 }}>
              <div className="mono" style={{ color: "var(--accent)", fontSize: 11, letterSpacing: "0.15em", marginBottom: 6 }}>// MEETING WORKSPACE · {meeting.id.toUpperCase().slice(0, 12)}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 4, flexWrap: "wrap" }}>
                <h1 className="ws-title" style={{ fontFamily: "var(--font-display)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.02em", margin: 0, lineHeight: 1 }}>
                  {meeting.title}
                </h1>
                <button className="editor-tool" style={{ background: "var(--surface-2)", width: 32, height: 32 }} onClick={() => ui.openMeetingForm(meeting.id)} title="Edit meeting details" aria-label="Edit meeting details"><Pencil size={14} /></button>
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginTop: 10, letterSpacing: "0.06em" }}>
                {formatDateLong(meeting.date).toUpperCase()} · {formatTime(meeting.startTime, data.settings.timeFormat)}—{formatTime(meeting.endTime, data.settings.timeFormat)}
                {meeting.location && <> · {meeting.location.toUpperCase()}</>}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <SaveIndicator state={saveState} />
              <select className="select" style={{ height: 34, width: 150, fontSize: "var(--fs-small)" }}
                value={meeting.status} onChange={(e) => setMeetingStatus(meeting.id, e.target.value as MeetingStatus)}
                aria-label="Meeting status">
                <option value="upcoming">Upcoming</option>
                <option value="in-progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
              {meeting.status === "upcoming" && (
                <Button variant="primary" icon={<CirclePlay size={14} />} onClick={() => setMeetingStatus(meeting.id, "in-progress")}>Start Meeting</Button>
              )}
              {meeting.status === "in-progress" && (
                <Button variant="primary" icon={<CircleStop size={14} />} onClick={() => setMeetingStatus(meeting.id, "completed")}>End Meeting</Button>
              )}
              {meeting.status === "completed" && (
                <Button icon={<RotateCcw size={13} />} onClick={() => setMeetingStatus(meeting.id, "upcoming")}>Reopen</Button>
              )}
              <Badge tone={st.tone}>{st.label}</Badge>
            </div>
          </div>

          {/* ── Tabs ─────────────────────────────── */}
          <div className="tabs" role="tablist" aria-label="Workspace sections" style={{ padding: "0 10px" }}>
            {TABS.map((t, i) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={tabIdOf(t.id)}
                aria-selected={tab === t.id}
                aria-controls={panelId}
                tabIndex={tab === t.id ? 0 : -1}
                ref={(el) => { tabRefs.current[t.id] = el; }}
                onKeyDown={(e) => onTabKeyDown(e, i)}
                className={`tab ${tab === t.id ? "on" : ""}`}
                onClick={() => setTab(t.id)}>
                {t.label}
                {counts[t.id] !== null && <span className="count">{counts[t.id]}</span>}
                {tab === t.id && !off && (
                  <motion.span layoutId="ws-tab-ind"
                    style={{ position: "absolute", left: 0, right: 0, bottom: -1, height: 2, background: "var(--accent)" }}
                    transition={{ duration: 0.22 * scale, ease: "easeOut" }} />
                )}
              </button>
            ))}
          </div>
        </Panel>
      </motion.div>

      {/* ── Body grid (agenda / notes follow, rail last) ── */}
      <div className="ws-grid">
        <motion.div {...stagger(1)} style={{ minWidth: 0 }}>
          <div role="tabpanel" id={panelId} aria-labelledby={tabIdOf(tab)} tabIndex={0} className="ws-tabpanel">
            <AnimatePresence mode="wait">
              <ScanWipe key={`${meeting.id}-${tab}`} wipeKey={`${meeting.id}-${tab}`}>
                {tab === "overview" && <OverviewPanel meeting={meeting} />}
                {tab === "agenda" && <AgendaPanel meeting={meeting} />}
                {tab === "notes" && <NotesPanel meeting={meeting} />}
                {tab === "decisions" && <DecisionsPanel meeting={meeting} />}
                {tab === "actions" && <ActionsPanel meeting={meeting} />}
                {tab === "minutes" && <MinutesPanel meeting={meeting} />}
              </ScanWipe>
            </AnimatePresence>
          </div>
        </motion.div>

        <motion.div {...stagger(2)} style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <AttendeesRail meeting={meeting} />
          <QuickCaptureRail meeting={meeting} />
          <div className="panel halftone" style={{ height: 6, border: "none", opacity: 0.5 }} aria-hidden />
          <Panel title="Record Integrity" pad={false}>
            <div className="panel-body" style={{ display: "grid", gap: 6 }}>
              <div className="mono" style={{ fontSize: 9.5, color: "var(--text-3)", letterSpacing: "0.1em", display: "flex", justifyContent: "space-between" }}>
                <span>AGENDA ENTRIES</span><span style={{ color: "var(--text-2)" }}>{agenda.length}</span>
              </div>
              <div className="mono" style={{ fontSize: 9.5, color: "var(--text-3)", letterSpacing: "0.1em", display: "flex", justifyContent: "space-between" }}>
                <span>DECISIONS LOGGED</span><span style={{ color: "var(--text-2)" }}>{decisions.length}</span>
              </div>
              <div className="mono" style={{ fontSize: 9.5, color: "var(--text-3)", letterSpacing: "0.1em", display: "flex", justifyContent: "space-between" }}>
                <span>ACTION ITEMS</span><span style={{ color: "var(--text-2)" }}>{tasks.length}</span>
              </div>
              <div className="mono" style={{ fontSize: 9.5, color: "var(--text-3)", letterSpacing: "0.1em", display: "flex", justifyContent: "space-between" }}>
                <span>RECORD UPDATED</span><span style={{ color: "var(--text-2)" }}>{new Date(meeting.updatedAt).toLocaleDateString()}</span>
              </div>
            </div>
          </Panel>
        </motion.div>
      </div>
    </div>
  );
}
