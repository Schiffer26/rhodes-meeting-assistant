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
import { Insignia } from "@/components/Insignia";

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
    title, subtitle, icon: Icon, onClick, tone = "light", size = "large", index, meta, ariaLabel,
  }: {
    title: string; subtitle: string; icon: any; onClick: () => void;
    tone?: "light" | "dark" | "cyan"; size?: "large" | "medium" | "small";
    index: string; meta?: string; ariaLabel?: string;
  }) => {
    const isCyan = tone === "cyan";
    const isDark = tone === "dark";
    const bg = isCyan ? "var(--accent)" : isDark ? "var(--surface-2)" : "var(--panel-white)";
    const fg = isCyan ? "#0E1012" : isDark ? "var(--text)" : "var(--text-dark)";
    const subFg = isCyan ? "rgba(14,16,18,0.72)" : isDark ? "var(--text-3)" : "rgba(23,25,27,0.58)";
    const ruleFg = isCyan ? "#0E1012" : isDark ? "var(--accent)" : "var(--accent)";
    const pad = size === "large" ? 24 : size === "medium" ? 18 : 14;
    const titleSize = size === "large" ? 42 : size === "medium" ? 27 : 21;

    return (
      <button onClick={onClick} className="nav-tile clip-corner"
        style={{
          background: bg, color: fg, padding: pad, height: "100%",
          minHeight: size === "large" ? 210 : size === "medium" ? 128 : 104,
          borderColor: isDark ? "var(--border)" : "var(--border-soft)",
        }}
        aria-label={ariaLabel ?? title}>
        {/* background iconography */}
        <span className="nav-bg">
          <Icon size={size === "large" ? 190 : size === "medium" ? 130 : 96} color={fg} />
        </span>

        <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative" }}>
          <span className="nav-index" style={{ color: subFg }}>{index}</span>
          <span className="nav-arrow" style={{ color: ruleFg }}><ArrowRight size={15} /></span>
        </span>

        <span style={{ flex: 1, display: "flex", alignItems: "center", position: "relative" }}>
          <span className="module-label" style={{ fontSize: titleSize, lineHeight: 0.98 }}>{title}</span>
        </span>

        <span style={{ display: "flex", alignItems: "center", gap: 12, position: "relative" }}>
          <span className="nav-rule" style={{ background: ruleFg }} />
          <span className="mono" style={{ fontSize: size === "large" ? 11 : 9.5, letterSpacing: "0.16em", color: subFg }}>{subtitle}</span>
          {meta && (
            <span className="mono" style={{ marginLeft: "auto", fontSize: 10, letterSpacing: "0.12em", color: fg, opacity: 0.85 }}>
              {meta}
            </span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "minmax(248px, 286px) minmax(0, 1fr) minmax(348px, 420px)",
      gap: "18px 20px",
      alignItems: "stretch",
    }}>

      {/* ══ LEFT — operational information ═════════════════════════ */}
      <Stagger style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        {/* Priority notifications */}
        <StaggerItem>
          <div style={{ display: "grid", gap: 6 }}>
            {overdue.length > 0 ? (
              <div className="notice notice-crit">
                <AlertTriangle size={14} style={{ color: "var(--crit)", flexShrink: 0 }} />
                <span style={{ flex: 1 }}>
                  <span className="n-title" style={{ color: "var(--crit)", display: "block" }}>Overdue Actions</span>
                  <span className="n-body">{overdue.length} item{overdue.length === 1 ? "" : "s"} past deadline</span>
                </span>
                <span className="metric-value" style={{ fontSize: 22, color: "var(--crit)" }}>{String(overdue.length).padStart(2, "0")}</span>
              </div>
            ) : (
              <div className="notice notice-ok">
                <span style={{ width: 8, height: 8, background: "var(--ok)", flexShrink: 0 }} />
                <span style={{ flex: 1 }}>
                  <span className="n-title" style={{ color: "var(--ok)", display: "block" }}>Task Queue Clear</span>
                  <span className="n-body">No overdue responsibilities</span>
                </span>
                <span className="metric-value" style={{ fontSize: 22, color: "var(--ok)" }}>00</span>
              </div>
            )}

            {dueSoon.length > 0 && (
              <div className="notice notice-attn">
                <AlarmClock size={14} style={{ color: "var(--amber)", flexShrink: 0 }} />
                <span style={{ flex: 1 }}>
                  <span className="n-title" style={{ color: "var(--amber)", display: "block" }}>Due Soon</span>
                  <span className="n-body">Within the next 72 hours</span>
                </span>
                <span className="metric-value" style={{ fontSize: 22, color: "var(--amber)" }}>{String(dueSoon.length).padStart(2, "0")}</span>
              </div>
            )}

            {inProgress.length > 0 && (
              <div className="notice notice-warn">
                <Activity size={14} style={{ color: "var(--warn)", flexShrink: 0 }} />
                <span style={{ flex: 1 }}>
                  <span className="n-title" style={{ color: "var(--warn)", display: "block" }}>Session Running</span>
                  <span className="n-body">{inProgress[0].title}</span>
                </span>
                <span className="metric-value" style={{ fontSize: 22, color: "var(--warn)" }}>{String(inProgress.length).padStart(2, "0")}</span>
              </div>
            )}

</div>
        </StaggerItem>

        {/* Upcoming schedule — light information plate */}
        <StaggerItem>
          <div className="plate clip-corner" style={{ padding: "12px 15px", borderLeft: "4px solid var(--accent)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <span className="mono-label" style={{ color: "rgba(23,25,27,0.6)" }}>// Upcoming Schedule</span>
              <span className="mono" style={{ fontSize: 9, letterSpacing: "0.16em", color: "rgba(23,25,27,0.45)" }}>T+72H</span>
            </div>
            <div className="metric-value" style={{ fontSize: 36, color: "var(--text-dark)", margin: "3px 0 8px" }}>
              {String(upcoming.length).padStart(2, "0")}
            </div>
            <div style={{ height: 1, background: "var(--plate-line)" }} />
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              {upcoming.slice(0, 3).map((m) => (
                <div key={m.id} style={{ display: "flex", gap: 10, alignItems: "baseline", cursor: "pointer" }}
                  onClick={() => navigate({ section: "meetings", meetingId: m.id })}>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--accent-blue)", flexShrink: 0, letterSpacing: "0.06em" }}>
                    {formatTime(m.startTime, s.timeFormat)}
                  </span>
                  <span className="small" style={{ color: "var(--text-dark)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {m.title}
                  </span>
                </div>
              ))}
              {upcoming.length === 0 && <span className="small" style={{ color: "rgba(23,25,27,0.55)" }}>Schedule clear.</span>}
            </div>
          </div>
        </StaggerItem>

        {/* Urgent action items — dark industrial plate */}
        <StaggerItem>
          <div className="panel ink clip-corner" style={{ borderLeft: "4px solid var(--crit)", padding: "12px 15px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <span className="mono-label" style={{ color: "var(--crit)" }}>// Urgent Actions</span>
              <span className="mono" style={{ fontSize: 9, letterSpacing: "0.16em", color: "var(--text-3)" }}>
                {String(followUps.length).padStart(2, "0")} TRACKED
              </span>
            </div>
            <div className="metric-value" style={{ fontSize: 36, color: "var(--text)", margin: "3px 0 8px" }}>
              {String(overdue.length + dueSoon.length).padStart(2, "0")}
            </div>
            <div style={{ height: 1, background: "var(--border-soft)" }} />
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              {followUps.map((t) => (
                <div key={t.id} style={{ display: "flex", gap: 10, alignItems: "baseline", cursor: "pointer" }}
                  onClick={() => navigate({ section: "tasks" })}>
                  <span className="mono" style={{ fontSize: 10.5, color: isTaskOverdue(t) ? "var(--crit)" : "var(--warn)", flexShrink: 0 }}>
                    {daysUntil(t.dueDate) === 0 ? "TDY" : daysUntil(t.dueDate) < 0 ? `−${Math.abs(daysUntil(t.dueDate))}D` : `+${daysUntil(t.dueDate)}D`}
                  </span>
                  <span className="small" style={{ color: "var(--text-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {t.title}
                  </span>
                </div>
              ))}
              {followUps.length === 0 && <span className="small dim">No priority follow-ups.</span>}
            </div>
          </div>
        </StaggerItem>

        {/* Recent activity */}
        <StaggerItem style={{ marginTop: "auto" }}>
          <div className="panel clip-corner-bottom" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ background: "var(--surface-2)", padding: "7px 13px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="mono-label" style={{ color: "var(--text)" }}>Recent Activity</span>
              <button className="linklike mono" style={{ fontSize: 9.5 }} onClick={() => navigate({ section: "archive" })}>ARCHIVE →</button>
            </div>
            <div>
              {recent.slice(0, 3).map((m) => (
                <div key={m.id} className="row-line row-click" style={{ padding: "5px 13px", background: "none", border: "none", display: "flex", alignItems: "center", gap: 9, cursor: "pointer", width: "100%", textAlign: "left" }}
                  onClick={() => navigate({ section: "meetings", meetingId: m.id })}>
                  <FileText size={12} style={{ color: "var(--text-3)", flexShrink: 0 }} />
                  <span className="small" style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.title}</span>
                  <span className="mono" style={{
                    fontSize: 8, letterSpacing: "0.1em", textTransform: "uppercase", flexShrink: 0,
                    padding: "2px 5px", border: "1px solid currentColor", opacity: 0.92,
                    color: TONE_VAR[MEETING_STATUS[m.status].tone] ?? "var(--text-3)",
                  }}>{STATUS_CODE[m.status] ?? MEETING_STATUS[m.status].label}</span>
                </div>
              ))}
              {recent.length === 0 && <div className="panel-body small dim">No records yet.</div>}
            </div>
          </div>
        </StaggerItem>
      </Stagger>

      {/* ══ CENTRE — RHODES identity ═══════════════════════════════ */}
      <Reveal delay={0.08}>
        <div style={{
          display: "flex", flexDirection: "column", justifyContent: "center",
          height: "100%", minHeight: 520, position: "relative", padding: "8px 8px 0",
        }}>
          {/* soft scrim so the environment reads as depth, not noise */}
          <div aria-hidden style={{
            position: "absolute", inset: "-10px -6px 0",
            background: "radial-gradient(74% 58% at 50% 44%, color-mix(in srgb, var(--bg) 62%, transparent) 0%, color-mix(in srgb, var(--bg) 34%, transparent) 62%, transparent 100%)",
            pointerEvents: "none", zIndex: 0,
          }} />
          <div className="viewport" style={{ flex: "1 1 auto", minHeight: 280, maxHeight: 372, width: "100%", zIndex: 1 }}>
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

            <div className="reticle" style={{ width: 296, height: 296, opacity: 0.18 }} />
            <div className="reticle" style={{ width: 392, height: 392, opacity: 0.09 }} />

            <div style={{ position: "relative", zIndex: 2 }}>
              <Insignia size={148} accent="var(--accent)" fg="var(--text)" />
            </div>
          </div>

          <div style={{ textAlign: "center", position: "relative", zIndex: 1 }}>
            <div className="module-label" style={{ fontSize: 54, letterSpacing: "0.26em", lineHeight: 1, marginRight: "-0.26em", color: "var(--text)" }}>RHODES</div>
            <div className="mono" style={{ color: "var(--accent)", fontSize: 11.5, letterSpacing: "0.34em", marginTop: 10 }}>
              MEETING OPERATIONS TERMINAL
            </div>
            <div className="tick-rule" style={{ margin: "16px auto 0", width: 240 }} />
          </div>

          <div className="readout" style={{ marginTop: 16, position: "relative", zIndex: 1 }}>
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
      <Stagger style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <StaggerItem style={{ flex: "2 1 0" }}>
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

        <StaggerItem style={{ flex: "1 1 0" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, height: "100%" }}>
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

        <StaggerItem style={{ flex: "1.1 1 0" }}>
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

        <StaggerItem style={{ flex: "1.25 1 0" }}>
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
      <Reveal delay={0.14} style={{ gridColumn: "1 / -1" }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2.1fr) minmax(260px, 1fr)", gap: 22, alignItems: "start" }}>
          <Panel title="Recent Records" code={`${recent.length} OF ${data.meetings.length} · MOST RECENTLY TOUCHED`} pad={false} className="clip-corner-bottom">
            {recent.length === 0 && <Empty icon={<FileText size={18} />} title="No records on file" hint="Register the first meeting to begin the operational log." />}
            {recent.map((m) => (
              <div key={m.id} className="strip" role="button" tabIndex={0} style={{ cursor: "pointer" }}
                onClick={() => navigate({ section: "meetings", meetingId: m.id })}
                onKeyDown={(e) => { if (e.key === "Enter") navigate({ section: "meetings", meetingId: m.id }); }}>
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
              </div>
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
