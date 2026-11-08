// ─────────────────────────────────────────────────────────────
// RHODES · SCREEN 1 — COMMAND CENTER
// ─────────────────────────────────────────────────────────────
import React from "react";
import {
  Plus, CalendarClock, ListTodo, AlarmClock, AlertTriangle, ArrowRight,
  FileText, StickyNote, Archive, MapPin, Users,
} from "lucide-react";
import { Badge, Button, Empty, Panel, Reveal, Stagger, StaggerItem } from "@/components/ui";
import { useAppData, useDerived } from "@/hooks/store";
import { useUi } from "@/hooks/ui";
import type { Route } from "@/layout/AppShell";
import {
  MEETING_STATUS, PRIORITY, formatDate, formatTime, formatDateLong,
  isTaskDueSoon, isTaskOverdue, todayISO, daysUntil, timeAgo, personName,
} from "@/utils/helpers";
import { Insignia } from "@/components/Insignia";

export function CommandCenter({ navigate }: { navigate: (r: Route) => void }) {
  const { data, setActionStatus } = useAppData();
  const { upcoming, openTasks, overdue, dueSoon } = useDerived();
  const ui = useUi();
  const people = data.personnel;
  const s = data.settings;

  const today = todayISO();
  const recent = [...data.meetings].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
  const followUps = openTasks
    .filter((t) => isTaskOverdue(t) || isTaskDueSoon(t))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 4);

  // Arknights-style Main Menu Tile
  const NavTile = ({ title, subtitle, icon: Icon, onClick, tone = "white", size = "large" }: { title: string, subtitle: string, icon: any, onClick: () => void, tone?: "white" | "cyan" | "dark", size?: "large" | "medium" | "small" }) => {
    const isCyan = tone === "cyan";
    const isDark = tone === "dark";
    const bg = isCyan ? "var(--accent)" : isDark ? "var(--surface-2)" : "var(--panel-white)";
    const fg = isCyan ? "#101314" : isDark ? "var(--text)" : "var(--text-dark)";
    const subFg = isCyan ? "rgba(16, 19, 20, 0.7)" : isDark ? "var(--text-3)" : "rgba(23, 25, 27, 0.55)";
    
    return (
      <button onClick={onClick} className={`clip-corner panel ${isDark ? 'solid' : 'white'}`}
        style={{
          background: bg, color: fg, display: "flex", flexDirection: "column",
          padding: size === "large" ? "24px" : size === "medium" ? "18px" : "14px",
          height: "100%", cursor: "pointer", transition: "transform 140ms linear, filter 140ms linear",
          position: "relative", overflow: "hidden", textAlign: "left", alignItems: "flex-start"
        }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-4px)"; e.currentTarget.style.filter = "brightness(1.05)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.filter = "brightness(1)"; }}>
        
        {/* Decorative background element */}
        <div style={{ position: "absolute", right: "-10%", bottom: "-20%", opacity: 0.05, transform: "rotate(-15deg)" }}>
          <Icon size={size === "large" ? 180 : 120} color={fg} />
        </div>

        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: size === "large" ? 44 : size === "medium" ? 32 : 24, fontWeight: 700, lineHeight: 1, textTransform: "uppercase" }}>{title}</div>
        </div>
        
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: size === "large" ? 40 : 20, width: "100%" }}>
          <div style={{ background: fg, width: 24, height: 2 }} />
          <div className="mono" style={{ fontSize: size === "large" ? 12 : 10, letterSpacing: "0.15em", color: subFg }}>{subtitle}</div>
          <Icon size={16} style={{ marginLeft: "auto", opacity: 0.5 }} />
        </div>
      </button>
    );
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr 480px", gap: 32, minHeight: "calc(100vh - 140px)" }}>
      
      {/* ── LEFT: Operations Notices (Stacked Event Plates) ── */}
      <Stagger style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <StaggerItem>
          <div style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(8px)", borderLeft: "4px solid var(--accent)", padding: "16px 20px" }}>
            <div className="mono" style={{ color: "var(--accent)", fontSize: 10, letterSpacing: "0.15em" }}>// UPCOMING SCHED.</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 700, margin: "4px 0" }}>{String(upcoming.length).padStart(2, "0")}</div>
            {upcoming.slice(0, 2).map((m) => (
              <div key={m.id} style={{ display: "flex", gap: 12, marginTop: 12, cursor: "pointer" }} onClick={() => navigate({ section: "meetings", meetingId: m.id })}>
                <div className="mono" style={{ color: "var(--text-3)", fontSize: 11 }}>{m.startTime}</div>
                <div className="small" style={{ color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.title}</div>
              </div>
            ))}
            {upcoming.length === 0 && <div className="small dim" style={{ marginTop: 8 }}>Schedule clear.</div>}
          </div>
        </StaggerItem>

        <StaggerItem>
          <div style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(8px)", borderLeft: "4px solid var(--crit)", padding: "16px 20px" }}>
            <div className="mono" style={{ color: "var(--crit)", fontSize: 10, letterSpacing: "0.15em" }}>// URGENT ITEMS</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 700, margin: "4px 0" }}>{String(overdue.length).padStart(2, "0")}</div>
            {followUps.map((t) => (
              <div key={t.id} style={{ display: "flex", gap: 12, marginTop: 12, cursor: "pointer" }} onClick={() => navigate({ section: "tasks" })}>
                <div className="mono" style={{ color: isTaskOverdue(t) ? "var(--crit)" : "var(--warn)", fontSize: 11 }}>{daysUntil(t.dueDate) === 0 ? "TDY" : `D${daysUntil(t.dueDate) < 0 ? '' : '+'}${daysUntil(t.dueDate)}`}</div>
                <div className="small" style={{ color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</div>
              </div>
            ))}
            {followUps.length === 0 && <div className="small dim" style={{ marginTop: 8 }}>No priority follow-ups.</div>}
          </div>
        </StaggerItem>
        
        <StaggerItem>
          <div className="panel solid clip-corner" style={{ padding: 0, overflow: "hidden", marginTop: "auto" }}>
            <div style={{ background: "var(--surface-3)", padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="mono-label" style={{ color: "var(--text)" }}>RECENT ACTIVITY</span>
              <button className="linklike mono" style={{ fontSize: 10 }} onClick={() => navigate({ section: "archive" })}>ARCHIVE →</button>
            </div>
            <div style={{ padding: "8px 0" }}>
              {recent.map((m) => (
                <div key={m.id} className="row-line row-click" style={{ padding: "8px 16px", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }} onClick={() => navigate({ section: "meetings", meetingId: m.id })}>
                  <FileText size={12} style={{ color: "var(--text-3)", flexShrink: 0 }} />
                  <div className="small" style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.title}</div>
                  <Badge tone={MEETING_STATUS[m.status].tone} dot={false}>{MEETING_STATUS[m.status].label}</Badge>
                </div>
              ))}
            </div>
          </div>
        </StaggerItem>
      </Stagger>

      {/* ── CENTER: RHODES Focal Identity ── */}
      <Reveal delay={0.1}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", height: "100%", position: "relative" }}>
          <div style={{ position: "relative" }}>
            <Insignia size={180} accent="var(--accent)" fg="rgba(255,255,255,0.8)" />
            <div className="pulse" style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 280, height: 280, border: "1px dashed var(--accent)", borderRadius: "50%", opacity: 0.1, pointerEvents: "none" }} />
          </div>
          
          <div style={{ textAlign: "center", marginTop: 40 }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 64, fontWeight: 700, letterSpacing: "0.2em", lineHeight: 1 }}>RHODES</div>
            <div className="mono" style={{ color: "var(--accent)", fontSize: 14, letterSpacing: "0.4em", marginTop: 8 }}>MEETING OPERATIONS</div>
            
            <div style={{ display: "flex", gap: 24, justifyContent: "center", marginTop: 32 }}>
              <div style={{ textAlign: "center" }}>
                <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", letterSpacing: "0.15em" }}>OPERATOR</div>
                <div className="small" style={{ fontWeight: 600, marginTop: 4 }}>System Admin</div>
              </div>
              <div style={{ width: 1, height: 24, background: "var(--border-soft)" }} />
              <div style={{ textAlign: "center" }}>
                <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", letterSpacing: "0.15em" }}>STATUS</div>
                <div className="small" style={{ fontWeight: 600, marginTop: 4, color: "var(--ok)" }}>Nominal</div>
              </div>
              <div style={{ width: 1, height: 24, background: "var(--border-soft)" }} />
              <div style={{ textAlign: "center" }}>
                <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", letterSpacing: "0.15em" }}>ACTIVE TASKS</div>
                <div className="small" style={{ fontWeight: 600, marginTop: 4 }}>{String(openTasks.length).padStart(2, "0")}</div>
              </div>
            </div>
          </div>
        </div>
      </Reveal>

      {/* ── RIGHT: Main Navigation Tiles ── */}
      <Stagger style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <StaggerItem style={{ flex: "2 1 0" }}>
          <NavTile 
            title="Meeting Operations" 
            subtitle="SCHEDULE & COORDINATION" 
            icon={CalendarClock} 
            onClick={() => navigate({ section: "meetings" })} 
            size="large" 
          />
        </StaggerItem>
        
        <StaggerItem style={{ flex: "1 1 0" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, height: "100%" }}>
            <NavTile 
              title="Personnel" 
              subtitle="PARTICIPANT REGISTRY" 
              icon={Users} 
              onClick={() => navigate({ section: "personnel" })} 
              size="small" 
            />
            <NavTile 
              title="Task Ops" 
              subtitle="RESPONSIBILITIES" 
              icon={ListTodo} 
              onClick={() => navigate({ section: "tasks" })} 
              size="small" 
            />
          </div>
        </StaggerItem>

        <StaggerItem style={{ flex: "1 1 0" }}>
          <NavTile 
            title="Records Archive" 
            subtitle="HISTORICAL DOCUMENTATION" 
            icon={Archive} 
            onClick={() => navigate({ section: "archive" })} 
            tone="dark" 
            size="medium" 
          />
        </StaggerItem>

        <StaggerItem style={{ flex: "1.5 1 0" }}>
          <NavTile 
            title="New Meeting" 
            subtitle="COMMENCE BRIEFING" 
            icon={Plus} 
            onClick={() => ui.openMeetingForm()} 
            tone="cyan" 
            size="medium" 
          />
        </StaggerItem>
      </Stagger>
    </div>
  );
}
