// ─────────────────────────────────────────────────────────────
// RHODES · application shell — sidebar, top bar, global search
// ─────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  LayoutDashboard, CalendarRange, Users, ListTodo, Archive, Settings, Search,
  Sun, Moon, Monitor, Bell, Command, Clock3,
} from "lucide-react";
import { Insignia } from "@/components/Insignia";
import { useAppData, useDerived, useMotionScale } from "@/hooks/store";
import { Badge, Modal, SaveIndicator } from "@/components/ui";
import { formatDateLong, formatTime, isTaskDueSoon, isTaskOverdue, timeAgo, todayISO } from "@/utils/helpers";
import { BackgroundEnvironment } from "./BackgroundEnvironment";

export type SectionId = "command" | "meetings" | "personnel" | "tasks" | "archive" | "settings";
export interface Route { section: SectionId; meetingId?: string | null; archiveId?: string | null }

export const SECTIONS: { id: SectionId; code: string; label: string; icon: React.ElementType }[] = [
  { id: "command", code: "R·01", label: "Command Center", icon: LayoutDashboard },
  { id: "meetings", code: "R·02", label: "Meeting Operations", icon: CalendarRange },
  { id: "personnel", code: "R·03", label: "Personnel Registry", icon: Users },
  { id: "tasks", code: "R·04", label: "Task Operations", icon: ListTodo },
  { id: "archive", code: "R·05", label: "Records Archive", icon: Archive },
  { id: "settings", code: "R·06", label: "System Configuration", icon: Settings },
];

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ── Top-bar clock ─────────────────────────────────────────────
function LocalClock() {
  const now = useNow();
  const { data } = useAppData();
  const s = data.settings;
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = formatDateLong(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  const timeStr = formatTime(`${pad(now.getHours())}:${pad(now.getMinutes())}`, s.timeFormat) + `:${pad(now.getSeconds())}`;
  return (
    <div style={{ textAlign: "right", lineHeight: 1.25 }}>
      <div className="mono" style={{ color: "var(--text)", fontSize: 12, letterSpacing: "0.08em" }}>{timeStr}</div>
      <div className="mono" style={{ color: "var(--text-3)", fontSize: 9.5, letterSpacing: "0.1em" }}>{dateStr.toUpperCase()}</div>
    </div>
  );
}

// ── Notifications popover (derived from live data) ────────────
function Notifications({ navigate }: { navigate: (r: Route) => void }) {
  const [open, setOpen] = useState(false);
  const { data } = useAppData();
  const { overdue, dueSoon, upcoming } = useDerived();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const today = todayISO();
  const todayMeetings = data.meetings.filter((m) => m.date === today && m.status !== "cancelled");
  const count = overdue.length + dueSoon.length + todayMeetings.length;
  const people = data.personnel;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="editor-tool" style={{ width: 34, height: 34, position: "relative" }}
        onClick={() => setOpen((v) => !v)} aria-label={`Activity — ${count} items need attention`} title="Activity">
        <Bell size={16} />
        {count > 0 && (
          <span style={{ position: "absolute", top: 2, right: 2, width: 7, height: 7, background: "var(--amber)" }} />
        )}
      </button>
      {open && (
        <div className="panel" style={{ position: "absolute", right: 0, top: 42, width: 320, zIndex: 80, boxShadow: "0 16px 40px rgba(0,0,0,0.4)" }}>
          <div className="panel-head"><span className="mono-label">Activity Feed · {String(count).padStart(2, "0")}</span></div>
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            {count === 0 && <div className="panel-body small dim">No items require attention. Systems nominal.</div>}
            {todayMeetings.map((m) => (
              <button key={m.id} className="row-line row-click" style={{ width: "100%", background: "none", border: "none", borderBottom: "1px solid var(--border-soft)", textAlign: "left", cursor: "pointer" }}
                onClick={() => { setOpen(false); navigate({ section: "meetings", meetingId: m.id }); }}>
                <Clock3 size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
                <span className="small" style={{ color: "var(--text-2)" }}>Today {m.startTime} — {m.title}</span>
              </button>
            ))}
            {overdue.map((t) => (
              <button key={t.id} className="row-line row-click" style={{ width: "100%", background: "none", border: "none", borderBottom: "1px solid var(--border-soft)", textAlign: "left", cursor: "pointer" }}
                onClick={() => { setOpen(false); navigate({ section: "tasks" }); }}>
                <span className="dot" style={{ width: 7, height: 7, background: "var(--crit)", flexShrink: 0 }} />
                <span className="small" style={{ color: "var(--text-2)" }}>Overdue — {t.title} ({people.find((p) => p.id === t.assigneeId)?.fullName ?? "Unassigned"})</span>
              </button>
            ))}
            {dueSoon.map((t) => (
              <button key={t.id} className="row-line row-click" style={{ width: "100%", background: "none", border: "none", borderBottom: "1px solid var(--border-soft)", textAlign: "left", cursor: "pointer" }}
                onClick={() => { setOpen(false); navigate({ section: "tasks" }); }}>
                <span className="dot" style={{ width: 7, height: 7, background: "var(--warn)", flexShrink: 0 }} />
                <span className="small" style={{ color: "var(--text-2)" }}>Due soon — {t.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Global search palette (Ctrl+K) ────────────────────────────
function GlobalSearch({ open, onClose, navigate }: { open: boolean; onClose: () => void; navigate: (r: Route) => void }) {
  const { data } = useAppData();
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQ(""); setTimeout(() => inputRef.current?.focus(), 60); } }, [open]);

  const results = useMemo(() => {
    if (!q.trim()) return null;
    const needle = q.trim().toLowerCase();
    const hit = (s: string | undefined | null) => (s ?? "").toLowerCase().includes(needle);
    return {
      meetings: data.meetings.filter((m) => hit(m.title) || hit(m.location) || hit(m.purpose)).slice(0, 5),
      people: data.personnel.filter((p) => hit(p.fullName) || hit(p.role) || hit(p.department) || hit(p.code)).slice(0, 5),
      tasks: data.actionItems.filter((t) => hit(t.title) || hit(t.description)).slice(0, 5),
      decisions: data.decisions.filter((d) => hit(d.title) || hit(d.description)).slice(0, 5),
    };
  }, [q, data]);

  const go = (r: Route) => { onClose(); navigate(r); };

  return (
    <Modal open={open} onClose={onClose} title="Global Search" code="CTRL+K" width={640}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border)", background: "var(--bg)", padding: "0 12px" }}>
        <Search size={15} style={{ color: "var(--text-3)", flexShrink: 0 }} />
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search meetings, personnel, tasks, decisions…"
          style={{ flex: 1, height: 40, background: "transparent", border: "none", outline: "none", color: "var(--text)", fontSize: "var(--fs-body)" }} />
        <span className="mono dim">ESC</span>
      </div>
      <div style={{ marginTop: 14 }}>
        {!results && <div className="small dim" style={{ padding: "12px 2px" }}>Type to query local records. All searches run offline against the local database.</div>}
        {results && !results.meetings.length && !results.people.length && !results.tasks.length && !results.decisions.length && (
          <div className="small dim" style={{ padding: "12px 2px" }}>No local records match “{q}”.</div>
        )}
        {results && results.meetings.length > 0 && (
          <>
            <div className="mono-label" style={{ padding: "8px 0 4px" }}>Meetings</div>
            {results.meetings.map((m) => (
              <button key={m.id} className="row-line row-click" style={{ width: "100%", background: "none", border: "none", borderBottom: "1px solid var(--border-soft)", textAlign: "left", cursor: "pointer" }}
                onClick={() => go({ section: "meetings", meetingId: m.id })}>
                <CalendarRange size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
                <span className="small" style={{ flex: 1 }}>{m.title}</span>
                <span className="mono dim">{m.date}</span>
              </button>
            ))}
          </>
        )}
        {results && results.people.length > 0 && (
          <>
            <div className="mono-label" style={{ padding: "12px 0 4px" }}>Personnel</div>
            {results.people.map((p) => (
              <button key={p.id} className="row-line row-click" style={{ width: "100%", background: "none", border: "none", borderBottom: "1px solid var(--border-soft)", textAlign: "left", cursor: "pointer" }}
                onClick={() => go({ section: "personnel" })}>
                <Users size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
                <span className="small" style={{ flex: 1 }}>{p.fullName} <span className="dim">— {p.role}</span></span>
                <span className="mono dim">{p.code}</span>
              </button>
            ))}
          </>
        )}
        {results && results.tasks.length > 0 && (
          <>
            <div className="mono-label" style={{ padding: "12px 0 4px" }}>Action Items</div>
            {results.tasks.map((t) => (
              <button key={t.id} className="row-line row-click" style={{ width: "100%", background: "none", border: "none", borderBottom: "1px solid var(--border-soft)", textAlign: "left", cursor: "pointer" }}
                onClick={() => go({ section: "meetings", meetingId: t.meetingId })}>
                <ListTodo size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
                <span className="small" style={{ flex: 1 }}>{t.title}</span>
                <span className="mono dim">{t.dueDate}</span>
              </button>
            ))}
          </>
        )}
        {results && results.decisions.length > 0 && (
          <>
            <div className="mono-label" style={{ padding: "12px 0 4px" }}>Decisions</div>
            {results.decisions.map((d) => (
              <button key={d.id} className="row-line row-click" style={{ width: "100%", background: "none", border: "none", borderBottom: "1px solid var(--border-soft)", textAlign: "left", cursor: "pointer" }}
                onClick={() => go({ section: "meetings", meetingId: d.meetingId })}>
                <Archive size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
                <span className="small" style={{ flex: 1 }}>{d.title}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}

// ── Shell ─────────────────────────────────────────────────────
export function AppShell({ route, navigate, children, onQuickNote }: {
  route: Route; navigate: (r: Route) => void; children: React.ReactNode; onQuickNote: () => void;
}) {
  const { data, saveState, updateSettings } = useAppData();
  const { overdue } = useDerived();
  const { off } = useMotionScale();
  const [searchOpen, setSearchOpen] = useState(false);

  const activeId: SectionId = route.meetingId ? "meetings" : route.section;
  const active = SECTIONS.find((s) => s.id === activeId)!;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
      if (e.ctrlKey && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen(true); }
      if (e.ctrlKey && !typing && e.key.toLowerCase() === "n" && !e.shiftKey) { e.preventDefault(); navigate({ section: "meetings" }); window.dispatchEvent(new CustomEvent("rhodes:new-meeting")); }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); onQuickNote(); }
      if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); window.dispatchEvent(new CustomEvent("rhodes:flush")); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [navigate, onQuickNote]);

  const theme = data.settings.theme;
  const cycleTheme = () => updateSettings({ theme: theme === "terminal" ? "archive" : theme === "archive" ? "system" : "terminal" });
  const ThemeIcon = theme === "terminal" ? Moon : theme === "archive" ? Sun : Monitor;

  return (
    <div className="app-root" style={{ display: "flex", flexDirection: "column", height: "100vh", position: "relative" }}>
      <BackgroundEnvironment />

      {/* ── Top HUD ─────────────────────────────── */}
      <header style={{
        height: 72, flexShrink: 0, display: "flex", alignItems: "center", gap: 16, padding: "0 24px", position: "relative", zIndex: 9,
        background: "rgba(21, 23, 25, 0.85)", backdropFilter: "blur(24px)", borderBottom: "1px solid var(--border-soft)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.4)"
      }}>
        {/* Left: Branding & Core Nav */}
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <button className="linklike" onClick={() => navigate({ section: "command" })} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Insignia size={32} />
            <div style={{ textAlign: "left", lineHeight: 1.1 }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, letterSpacing: "0.1em", color: "#F5F5F5" }}>RHODES</div>
              <div className="mono" style={{ color: "var(--text-3)", fontSize: 8.5, letterSpacing: "0.15em" }}>OPERATIONS DECK</div>
            </div>
          </button>
          <div style={{ width: 1, height: 24, background: "var(--border)" }} />
          <button className="editor-tool" style={{ width: 34, height: 34 }} title="Dashboard" onClick={() => navigate({ section: "command" })}><LayoutDashboard size={18} color="#F5F5F5" /></button>
          <button className="editor-tool" style={{ width: 34, height: 34 }} title="Settings" onClick={() => navigate({ section: "settings" })}><Settings size={18} color="#F5F5F5" /></button>
        </div>

        {/* Center: Context */}
        <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", gap: 12, minWidth: 0 }}>
          <span className="mono" style={{ color: "var(--accent)", fontSize: 10, letterSpacing: "0.2em", background: "var(--accent-dim)", padding: "4px 8px", border: "1px solid var(--accent)" }}>{active.code}</span>
          <span style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text)" }}>
            {route.meetingId ? "Meeting Workspace" : active.label}
          </span>
        </div>

        {/* Right: Tools & Status */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button onClick={() => setSearchOpen(true)}
            style={{
              display: "flex", alignItems: "center", gap: 9, height: 36, padding: "0 16px", background: "rgba(0,0,0,0.6)", border: "1px solid var(--border)",
              cursor: "pointer", color: "var(--text-3)", transition: "border-color 140ms linear, background 140ms linear",
              clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 0 100%)"
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--accent-dim)"; e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "rgba(0,0,0,0.6)"; e.currentTarget.style.color = "var(--text-3)"; }}>
            <Search size={13} />
            <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 9 }}>
              <Command size={9} /> K
            </span>
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <SaveIndicator state={saveState} />
            <Notifications navigate={navigate} />
          </div>

          <div style={{ width: 1, height: 24, background: "var(--border)" }} />
          <LocalClock />

          <button className="editor-tool" style={{ width: 34, height: 34 }} onClick={cycleTheme}
            title="Cycle theme" aria-label="Cycle theme">
            <ThemeIcon size={16} color="#F5F5F5" />
          </button>
        </div>
      </header>

      {/* ── Main content area ─────────────────────────── */}
      {/* ── Main content area ─────────────────────────── */}
      <main style={{ flex: 1, overflowY: "auto", position: "relative", zIndex: 1 }}>
        <div style={{ padding: "32px 40px", maxWidth: 1600, margin: "0 auto", minHeight: "calc(100vh - 72px)" }}>{children}</div>
      </main>

      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} navigate={navigate} />
    </div>
  );
}
