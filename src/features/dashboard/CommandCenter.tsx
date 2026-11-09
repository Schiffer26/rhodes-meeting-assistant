// ─────────────────────────────────────────────────────────────
// RHODES · SCREEN 1 — COMMAND CENTER
//
// Layout: three vertical regions (operations / identity / modules)
// over a full-width recent-records strip.
//
//   LEFT    operational information plates + priority notices
//   CENTRE  RHODES identity integrated into the vessel environment
//   RIGHT   navigation modules, each with its own treatment
//   BOTTOM  recent records as horizontal information strips
//
// Every figure on this screen is derived from stored records.
// ─────────────────────────────────────────────────────────────
import React from "react";
import {
  Plus, CalendarClock, ListTodo, AlarmClock, AlertTriangle, ArrowRight,
  FileText, Archive, MapPin, Users, Activity,
} from "lucide-react";
import { Badge, Empty, Panel, Reveal, Stagger, StaggerItem } from "@/components/ui";
import { useAppData, useDerived } from "@/hooks/store";
import { useUi } from "@/hooks/ui";
import type { Route } from "@/layout/AppShell";
import {
  MEETING_STATUS, formatDate, formatTime, formatDateLong,
  isTaskDueSoon, isTaskOverdue, todayISO, daysUntil, personName,
} from "@/utils/helpers";
import { RhodesLogo } from "@/components/RhodesLogo";

/** Semantic tone token → CSS variable, so status colouring stays theme-driven. */
/** Compact operation codes for the narrow activity rail. */
const STATUS_CODE: Record<string, string> = {
  upcoming: "SCHED", "in-progress": "LIVE", completed: "DONE", cancelled: "CANC",
};

const TONE_VAR: Record<string, string> = {
  cyan: "var(--accent)", blue: "var(--accent-blue)", green: "var(--ok)",
  amber: "var(--amber)", yellow: "var(--amber)", warn: "var(--warn)",
  red: "var(--crit)", gray: "var(--text-3)",
};

export function CommandCenter({ navigate }: { navigate: (r: Route) => void }) {
  const { data } = useAppData();
  const { upcoming, openTasks, overdue, dueSoon } = useDerived();
  const ui = useUi();
  const people = data.personnel;
  const s = data.settings;

  const today = todayISO();
  const todayMeetings = data.meetings.filter((m) => m.date === today && m.status !== "cancelled");
  const inProgress = data.meetings.filter((m) => m.status === "in-progress");
  const completedCount = data.meetings.filter((m) => m.status === "completed").length;

  const recent = [...data.meetings].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  const followUps = openTasks
    .filter((t) => isTaskOverdue(t) || isTaskDueSoon(t))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 3);

  // Operator identification follows the session that is actually running.
  const activeSession = inProgress[0] ?? null;
  const operatorName = activeSession ? personName(people.find((p) => p.id === activeSession.organizerId)) : "System Admin";
  const lastUpdate = data.meetings
    .map((m) => m.updatedAt)
    .sort()
    .slice(-1)[0];

  // ── Navigation module ───────────────────────────────────────────────
  const NavTile = ({
    title, subtitle, icon: Icon, onClick, tone = "light", size = "large", index, meta, ariaLabel, style,
  }: {
    title: string; subtitle: string; icon: any; onClick: () => void;
    tone?: "light" | "dark" | "cyan"; size?: "large" | "medium" | "small";
    index: string; meta?: string; ariaLabel?: string; style?: React.CSSProperties;
  }) => {
    const isCyan = tone === "cyan";
    const isDark = tone === "dark";
    const bg = isCyan ? "var(--accent)" : isDark ? "var(--surface-2)" : "var(--panel-white)";
    const fg = isCyan ? "#0E1012" : isDark ? "var(--text)" : "var(--text-dark)";
    const subFg = isCyan ? "rgba(14,16,18,0.72)" : isDark ? "var(--text-3)" : "rgba(23,25,27,0.58)";
    const ruleFg = isCyan ? "#0E1012" : "var(--accent)";
    const sizeClass = size === "large" ? "lg" : size === "medium" ? "md" : "sm";

    return (
      <button
        onClick={onClick}
        className={`nav-tile clip-corner ${sizeClass}`}
        style={{
          background: bg, color: fg, height: "100%",
          borderColor: isDark ? "var(--border)" : "var(--border-soft)",
          ...style,
        }}
        aria-label={ariaLabel ?? title}>
        {/* background iconography */}
        <span className="nav-bg">
          <Icon size={size === "large" ? 200 : size === "medium" ? 132 : 96} color={fg} />
        </span>

        <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative", zIndex: 1 }}>
          <span className="nav-index" style={{ color: subFg }}>{index}</span>
          <span className="nav-arrow" style={{ color: ruleFg }}><ArrowRight size={15} /></span>
        </span>

        <span style={{ flex: 1, display: "flex", alignItems: "center", position: "relative", zIndex: 1, padding: "6px 0" }}>
          <span className="nav-title">{title}</span>
        </span>

        <span className="nav-foot" style={{ position: "relative", zIndex: 1 }}>
          <span className="nav-rule" style={{ background: ruleFg }} />
          <span className="nav-sub" style={{ color: subFg }}>{subtitle}</span>
          {meta && <span className="nav-meta" style={{ color: fg }}>{meta}</span>}
        </span>
      </button>
    );
  };

  return (
    <div className="cmd-grid">
      <h1 className="sr-only">Command Center — Rhodes Operations Deck</h1>

      {/* ══ LEFT — operational information ═════════════════════════ */}
      <Stagger className="cmd-rail">
        {/* Priority notifications */}
        <StaggerItem x={-14}>
          <div style={{ display: "grid", gap: 6 }}>
            {overdue.length > 0 ? (
              <div className="notice notice-crit">
                <AlertTriangle size={14} style={{ color: "var(--crit)", flexShrink: 0 }} />
                <span className="notice-body">
                  <span className="n-title" style={{ color: "var(--crit)", display: "block" }}>Overdue Actions</span>
                  <span className="n-body">{overdue.length} item{overdue.length === 1 ? "" : "s"} past deadline</span>
                </span>
                <span className="metric-value" style={{ fontSize: 22, color: "var(--crit)" }}>{String(overdue.length).padStart(2, "0")}</span>
              </div>
            ) : (
              <div className="notice notice-ok">
                <span style={{ width: 8, height: 8, background: "var(--ok)", flexShrink: 0 }} />
                <span className="notice-body">
                  <span className="n-title" style={{ color: "var(--ok)", display: "block" }}>Task Queue Clear</span>
                  <span className="n-body">No overdue responsibilities</span>
                </span>
                <span className="metric-value" style={{ fontSize: 22, color: "var(--ok)" }}>00</span>
              </div>
            )}

            {dueSoon.length > 0 && (
              <div className="notice notice-attn">
                <AlarmClock size={14} style={{ color: "var(--amber)", flexShrink: 0 }} />
                <span className="notice-body">
                  <span className="n-title" style={{ color: "var(--amber)", display: "block" }}>Due Soon</span>
                  <span className="n-body">Within the next 72 hours</span>
                </span>
                <span className="metric-value" style={{ fontSize: 22, color: "var(--amber)" }}>{String(dueSoon.length).padStart(2, "0")}</span>
              </div>
            )}

            {inProgress.length > 0 && (
              <div className="notice notice-warn">
                <Activity size={14} style={{ color: "var(--warn)", flexShrink: 0 }} />
                <span className="notice-body">
                  <span className="n-title" style={{ color: "var(--warn)", display: "block" }}>Session Running</span>
                  <span className="n-body">{inProgress[0].title}</span>
                </span>
                <span className="metric-value" style={{ fontSize: 22, color: "var(--warn)" }}>{String(inProgress.length).padStart(2, "0")}</span>
              </div>
            )}

</div>
        </StaggerItem>

        {/* Upcoming schedule — light information plate */}
        <StaggerItem x={-14}>
          <div className="plate clip-corner rail-plate" style={{ borderLeft: "4px solid var(--accent)", boxShadow: "var(--shadow)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <span className="mono-label" style={{ color: "rgba(23,25,27,0.6)" }}>// Upcoming Schedule</span>
              <span className="mono rail-count" style={{ fontSize: 9, letterSpacing: "0.16em", color: "rgba(23,25,27,0.45)" }}>T+72H</span>
            </div>
            <div className="metric-value rail-metric" style={{ color: "var(--text-dark)" }}>
              {String(upcoming.length).padStart(2, "0")}
            </div>
            <div style={{ height: 1, background: "var(--plate-line)" }} />
            <div className="rail-rows">
              {upcoming.slice(0, 3).map((m) => (
                <button key={m.id} type="button" className="mini-row"
                  onClick={() => navigate({ section: "meetings", meetingId: m.id })}
                  aria-label={`Open ${m.title}`}>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--accent-blue)", flexShrink: 0, letterSpacing: "0.06em" }}>
                    {formatTime(m.startTime, s.timeFormat)}
                  </span>
                  <span className="small" style={{ color: "var(--text-dark)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>
                    {m.title}
                  </span>
                </button>
              ))}
              {upcoming.length === 0 && <span className="small" style={{ color: "rgba(23,25,27,0.55)" }}>Schedule clear.</span>}
            </div>
          </div>
        </StaggerItem>

        {/* Urgent action items — dark industrial plate */}
        <StaggerItem x={-14}>
          <div className="panel ink clip-corner rail-panel" style={{ borderLeft: "4px solid var(--crit)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <span className="mono-label" style={{ color: "var(--crit)" }}>// Urgent Actions</span>
              <span className="mono rail-count" style={{ fontSize: 9, letterSpacing: "0.16em", color: "var(--text-3)" }}>
                {String(followUps.length).padStart(2, "0")} TRACKED
              </span>
            </div>
            <div className="metric-value rail-metric" style={{ color: "var(--text)" }}>
              {String(overdue.length + dueSoon.length).padStart(2, "0")}
            </div>
            <div style={{ height: 1, background: "var(--border-soft)" }} />
            <div className="rail-rows">
              {followUps.map((t) => (
                <button key={t.id} type="button" className="mini-row"
                  onClick={() => navigate({ section: "tasks" })}
                  aria-label={`Open task registry for ${t.title}`}>
                  <span className="mono" style={{ fontSize: 10.5, color: isTaskOverdue(t) ? "var(--crit)" : "var(--warn)", flexShrink: 0 }}>
                    {daysUntil(t.dueDate) === 0 ? "TDY" : daysUntil(t.dueDate) < 0 ? `−${Math.abs(daysUntil(t.dueDate))}D` : `+${daysUntil(t.dueDate)}D`}
                  </span>
                  <span className="small" style={{ color: "var(--text-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>
                    {t.title}
                  </span>
                </button>
              ))}
              {followUps.length === 0 && <span className="small dim">No priority follow-ups.</span>}
            </div>
          </div>
        </StaggerItem>

        {/* Recent activity */}
        <StaggerItem x={-14} style={{ marginTop: "auto" }}>
          <div className="panel clip-corner-bottom" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ background: "var(--surface-2)", padding: "7px 13px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="mono-label" style={{ color: "var(--text)" }}>Recent Activity</span>
              <button className="linklike mono" style={{ fontSize: 9.5 }} onClick={() => navigate({ section: "archive" })}>ARCHIVE →</button>
            </div>
            <div>
              {recent.slice(0, 3).map((m) => (
                <button key={m.id} type="button" className="row-line row-click rail-activity-row"
                  style={{ background: "none", border: "none", display: "flex", alignItems: "center", gap: 9, cursor: "pointer", width: "100%", textAlign: "left", font: "inherit", color: "inherit" }}
                  onClick={() => navigate({ section: "meetings", meetingId: m.id })}
                  aria-label={`Open ${m.title}`}>
                  <FileText size={12} style={{ color: "var(--text-3)", flexShrink: 0 }} />
                  <span className="small" style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.title}</span>
                  <span className="mono" style={{
                    fontSize: 8, letterSpacing: "0.1em", textTransform: "uppercase", flexShrink: 0,
                    padding: "2px 5px", border: "1px solid currentColor", opacity: 0.92,
                    color: TONE_VAR[MEETING_STATUS[m.status].tone] ?? "var(--text-3)",
                  }}>{STATUS_CODE[m.status] ?? MEETING_STATUS[m.status].label}</span>
                </button>
              ))}
              {recent.length === 0 && <div className="panel-body small dim">No records yet.</div>}
            </div>
          </div>
        </StaggerItem>
      </Stagger>

      {/* ══ CENTRE — RHODES identity ═══════════════════════════════ */}
      <Reveal delay={0.08} className="cmd-identity">
        <div className="identity-stack">
          {/* soft scrim so the environment reads as depth, not noise */}
          <div className="identity-scrim" aria-hidden />
          <div className="viewport identity-stage">
            <span className="viewport-bracket vb-tl" />
            <span className="viewport-bracket vb-tr" />
            <span className="viewport-bracket vb-bl" />
            <span className="viewport-bracket vb-br" />

            <div className="scale-ticks" style={{ left: 6 }}>
              {Array.from({ length: 14 }, (_, i) => <i key={i} />)}
            </div>
            <div className="scale-ticks" style={{ right: 6 }}>
              {Array.from({ length: 14 }, (_, i) => <i key={i} />)}
            </div>

            <span className="insignia-mount" />
            <span className="insignia-horizon" />
            <div className="reticle reticle-1" />
            <div className="reticle reticle-2" />
            {/* instrument rings — slow, and still under reduced motion */}
            <svg className="ring-slow identity-ring" width="330" height="330" viewBox="0 0 330 330">
              <circle cx="165" cy="165" r="152" fill="none" stroke="var(--accent)" strokeWidth="1" strokeDasharray="2 26" opacity="0.55" />
              <circle cx="165" cy="13" r="2.5" fill="var(--accent)" />
            </svg>
            <svg className="ring-slow-rev identity-ring identity-ring-outer" width="424" height="424" viewBox="0 0 424 424">
              <circle cx="212" cy="212" r="198" fill="none" stroke="var(--border)" strokeWidth="1" strokeDasharray="34 18" opacity="0.7" />
              <circle cx="212" cy="14" r="2" fill="var(--border)" />
            </svg>

            <div className="identity-insignia">
              <RhodesLogo />
            </div>
          </div>

          <div className="identity-lockup">
            <div className="module-label identity-wordmark">RHODES</div>
            <div className="mono identity-sub">MEETING OPERATIONS TERMINAL</div>
            <div className="tick-rule identity-rule" />
          </div>

          <div className="readout identity-readout">
            <div className="readout-cell">
              <div className="readout-key">System Status</div>
              <div className="readout-val" style={{ color: "var(--ok)" }}>Nominal</div>
            </div>
            <div className="readout-cell">
              <div className="readout-key">Operator</div>
              <div className="readout-val" style={{ fontSize: 15 }}>{operatorName}</div>
            </div>
            <div className="readout-cell">
              <div className="readout-key">Active Tasks</div>
              <div className="readout-val">{String(openTasks.length).padStart(2, "0")}</div>
            </div>
            <div className="readout-cell">
              <div className="readout-key">Local Date</div>
              <div className="readout-val" style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {formatDateLong(today).toUpperCase()}
              </div>
            </div>
          </div>
        </div>
      </Reveal>

      {/* ══ RIGHT — navigation modules ═════════════════════════════ */}
      <Stagger className="cmd-nav">
        <StaggerItem x={16} className="nav-slot nav-slot-lg">
          <NavTile
            title="Meeting Operations"
            subtitle="SCHEDULE & COORDINATION"
            icon={CalendarClock}
            onClick={() => navigate({ section: "meetings" })}
            size="large"
            ariaLabel="Meeting Operations"
            index="R·02 / OPERATIONS"
            meta={`${data.meetings.length} RECORDS`}
          />
        </StaggerItem>

        <StaggerItem x={16} className="nav-slot nav-slot-pair">
          <div className="nav-pair">
            <NavTile
              title="Personnel"
              subtitle="REGISTRY"
              icon={Users}
              onClick={() => navigate({ section: "personnel" })}
              size="small"
              ariaLabel="Personnel Registry"
              index="R·03"
              meta={String(people.length).padStart(2, "0")}
            />
            <NavTile
              title="Task Ops"
              subtitle="RESPONSIBILITIES"
              icon={ListTodo}
              onClick={() => navigate({ section: "tasks" })}
              tone="dark"
              size="small"
              ariaLabel="Task Operations"
              index="R·04"
              meta={String(openTasks.length).padStart(2, "0")}
            />
          </div>
        </StaggerItem>

        <StaggerItem x={16} className="nav-slot nav-slot-archive">
          <NavTile
            title="Records Archive"
            subtitle="HISTORICAL DOCUMENTATION"
            icon={Archive}
            onClick={() => navigate({ section: "archive" })}
            tone="dark"
            size="medium"
            index="R·05"
            meta={`${completedCount} CLOSED`}
          />
        </StaggerItem>

        <StaggerItem x={16} className="nav-slot nav-slot-new">
          <NavTile
            title="New Meeting"
            subtitle="COMMENCE BRIEFING"
            icon={Plus}
            onClick={() => ui.openMeetingForm()}
            tone="cyan"
            size="medium"
            index="R·NEW"
          />
        </StaggerItem>
      </Stagger>

      {/* ══ BOTTOM — recent records ════════════════════════════════ */}
      <Reveal delay={0.14} className="cmd-bottom-wrap">
        <div className="cmd-bottom">
          <Panel title="Recent Records" code={`${recent.length} OF ${data.meetings.length} · MOST RECENTLY TOUCHED`} pad={false} className="clip-corner-bottom">
            {recent.length === 0 && <Empty icon={<FileText size={18} />} title="No records on file" hint="Register the first meeting to begin the operational log." />}
            {recent.map((m) => (
              <button key={m.id} type="button" className="strip strip-btn"
                onClick={() => navigate({ section: "meetings", meetingId: m.id })}
                aria-label={`Open ${m.title}`}>
                <span className="strip-key" style={{ color: "var(--accent)", minWidth: 88 }}>{formatDate(m.date, s.dateFormat)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="small" style={{ fontWeight: 600, color: "var(--text)", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {m.title}
                  </span>
                  <span className="mono" style={{ fontSize: 9.5, color: "var(--text-3)", display: "flex", gap: 12, flexWrap: "wrap", marginTop: 3 }}>
                    <span>{formatTime(m.startTime, s.timeFormat)}—{formatTime(m.endTime, s.timeFormat)}</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <Users size={9} /> {m.attendeeIds.length} PAX
                    </span>
                    {m.location && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <MapPin size={9} /> {m.location.toUpperCase()}
                      </span>
                    )}
                    <span>ORG · {personName(people.find((p) => p.id === m.organizerId)).toUpperCase()}</span>
                  </span>
                </span>
                <Badge tone={MEETING_STATUS[m.status].tone} dot={false}>{MEETING_STATUS[m.status].label}</Badge>
                <span className="nav-arrow" style={{ color: "var(--accent)" }}><ArrowRight size={14} /></span>
              </button>
            ))}
          </Panel>

          <Panel title="System Activity" code="LIVE COUNTS" pad={false} className="clip-corner-bottom">
            {[
              { k: "Meeting Records", v: data.meetings.length },
              { k: "Personnel On File", v: people.length },
              { k: "Decisions Logged", v: data.decisions.length },
              { k: "Note Files", v: data.notes.length },
              { k: "Open Actions", v: openTasks.length },
              { k: "Closed Meetings", v: completedCount },
            ].map((row) => (
              <div key={row.k} className="strip" style={{ padding: "9px 14px" }}>
                <span className="strip-key" style={{ flex: 1 }}>{row.k}</span>
                <span className="metric-value" style={{ fontSize: 19, color: "var(--accent)" }}>{String(row.v).padStart(2, "0")}</span>
              </div>
            ))}
            <div className="strip" style={{ padding: "9px 14px", background: "var(--surface-2)" }}>
              <span className="strip-key" style={{ flex: 1 }}>Last Write</span>
              <span className="mono" style={{ fontSize: 9.5, color: "var(--text-3)" }}>
                {lastUpdate ? new Date(lastUpdate).toLocaleString().toUpperCase() : "—"}
              </span>
            </div>
          </Panel>
        </div>
      </Reveal>
    </div>
  );
}
