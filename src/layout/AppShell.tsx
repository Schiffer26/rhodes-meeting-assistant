// ─────────────────────────────────────────────────────────────
// RHODES · application shell
// Operational system toolbar (HUD), global search, notifications,
// keyboard shortcuts. The HUD is a solid graphite instrument bar
// in both themes so the interface reads as equipment, not a page.
// ─────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  LayoutDashboard, CalendarRange, Users, ListTodo, Archive, Settings, Search,
  Sun, Moon, Monitor, Bell, Command, Clock3, Keyboard,
} from "lucide-react";
import { RhodesLogo } from "@/components/RhodesLogo";
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

// ── Top-bar clock ──────────────────────────────────────────────────────
function LocalClock() {
  const now = useNow();
  const { data } = useAppData();
  const s = data.settings;
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = formatDateLong(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  const timeStr = formatTime(`${pad(now.getHours())}:${pad(now.getMinutes())}`, s.timeFormat) + `:${pad(now.getSeconds())}`;
  return (
    <div className="hud-clock">
      <div className="t">{timeStr}</div>
      <div className="d">{dateStr.toUpperCase()}</div>
    </div>
  );
}

// ── Notifications popover (derived from live data) ─────────────────────
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

  const rowStyle: React.CSSProperties = {
    width: "100%", background: "none", border: "none",
    borderBottom: "1px solid var(--border-soft)", textAlign: "left",
    cursor: "pointer", padding: "9px 14px", display: "flex", alignItems: "center", gap: 10,
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="hud-btn" style={{ position: "relative" }}
        onClick={() => setOpen((v) => !v)} aria-label={`Activity — ${count} items need attention`} title="Activity">
        <Bell size={16} />
        {count > 0 && <span className="hud-alert-dot" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="panel" style={{ position: "absolute", right: 0, top: 46, width: 340, zIndex: 80, boxShadow: "var(--shadow)" }}>
            <div className="panel-head">
              <span className="mono-label">Activity Feed</span>
              <span className="hud-code" style={{ fontSize: 9, padding: "3px 7px" }}>{String(count).padStart(2, "0")} OPEN</span>
            </div>
            <div style={{ maxHeight: 340, overflowY: "auto" }}>
              {count === 0 && <div className="panel-body small dim">No items require attention. Systems nominal.</div>}
              {todayMeetings.map((m) => (
                <button key={m.id} style={rowStyle}
                  onClick={() => { setOpen(false); navigate({ section: "meetings", meetingId: m.id }); }}>
                  <Clock3 size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
                  <span className="small" style={{ color: "var(--text-2)" }}>Today {m.startTime} — {m.title}</span>
                </button>
              ))}
              {overdue.map((t) => (
                <button key={t.id} style={rowStyle}
                  onClick={() => { setOpen(false); navigate({ section: "tasks" }); }}>
                  <span style={{ width: 7, height: 7, background: "var(--crit)", flexShrink: 0 }} />
                  <span className="small" style={{ color: "var(--text-2)" }}>Overdue — {t.title} ({people.find((p) => p.id === t.assigneeId)?.fullName ?? "Unassigned"})</span>
                </button>
              ))}
              {dueSoon.map((t) => (
                <button key={t.id} style={rowStyle}
                  onClick={() => { setOpen(false); navigate({ section: "tasks" }); }}>
                  <span style={{ width: 7, height: 7, background: "var(--warn)", flexShrink: 0 }} />
                  <span className="small" style={{ color: "var(--text-2)" }}>Due soon — {t.title}</span>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Global search palette (Ctrl+K) ─────────────────────────────────────
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
        <Search size={15} style={{ color: "var(--accent)", flexShrink: 0 }} />
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

// ── Keyboard shortcut legend ───────────────────────────────────────────
const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "CTRL + K", action: "Open global search" },
  { keys: "CTRL + N", action: "Register a new meeting" },
  { keys: "CTRL + SHIFT + N", action: "Capture a quick note" },
  { keys: "CTRL + S", action: "Force save to local storage" },
  { keys: "ESC", action: "Dismiss the active dialog" },
];

function ShortcutLegend({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard Controls" code="SHORTCUT MAP" width={480}>
      <div style={{ display: "grid", gap: 2 }}>
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className="strip" style={{ borderBottom: "1px solid var(--border-soft)" }}>
            <span className="hud-kbd" style={{ color: "var(--accent)", borderColor: "var(--accent)" }}>{s.keys}</span>
            <span className="strip-val" style={{ flex: 1 }}>{s.action}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ── Shell ──────────────────────────────────────────────────────────────
export function AppShell({ route, navigate, children, onQuickNote }: {
  route: Route; navigate: (r: Route) => void; children: React.ReactNode; onQuickNote: () => void;
}) {
  const { data, saveState, updateSettings } = useAppData();
  const { overdue } = useDerived();
  const { off } = useMotionScale();
  const [searchOpen, setSearchOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);

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
  const sectionTitle = route.meetingId ? "Meeting Workspace" : active.label;

  return (
    <div className="app-root" style={{ display: "flex", flexDirection: "column", height: "100vh", position: "relative" }}>
      <BackgroundEnvironment />
      <a className="skip-link" href="#rhodes-main">Skip to content</a>

      {/* ── Top HUD ─────────────────────────────────────────────── */}
      <header className="hud">
        {/* Left: identity + quick destinations */}
        <div className="hud-cell" style={{ gap: 0, padding: 0 }}>
          <button className="hud-brand" onClick={() => navigate({ section: "command" })} aria-label="RHODES — Command Center">
            <span className="hud-logo">
              <RhodesLogo />
            </span>
            <span>
              <span className="hud-wordmark" style={{ display: "block" }}>RHODES</span>
              <span className="hud-sub" style={{ display: "block" }}>OPERATIONS DECK</span>
            </span>
          </button>
          <div className="hud-sep" />
          <div style={{ display: "flex", gap: 4, paddingLeft: 10 }}>
            <button className="hud-btn hud-opt" style={{ width: 38, height: 38 }} title="Command Center" aria-label="Command Center"
              aria-current={activeId === "command" ? "page" : undefined}
              onClick={() => navigate({ section: "command" })}><LayoutDashboard size={17} /></button>
            <button className="hud-btn hud-opt" style={{ width: 38, height: 38 }} title="System Configuration" aria-label="System Configuration"
              aria-current={activeId === "settings" ? "page" : undefined}
              onClick={() => navigate({ section: "settings" })}><Settings size={17} /></button>
          </div>
        </div>

        {/* Center: active section identity */}
        <div className="hud-cell" style={{ flex: 1, minWidth: 0, gap: 14 }}>
          <span className="hud-code" aria-hidden="true">{active.code}</span>
          <span className="hud-title" aria-live="polite">{sectionTitle}</span>
          <span style={{ flex: 1, height: 1, background: "var(--hud-line)", minWidth: 20 }} />
        </div>

        {/* Right: tools & status */}
        <div className="hud-cell" style={{ gap: 12 }}>
          <button className="hud-search" onClick={() => setSearchOpen(true)} aria-label="Open global search">
            <Search size={13} />
            <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 9 }}>
              <Command size={9} /> K
            </span>
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ color: "var(--hud-dim)" }}><SaveIndicator state={saveState} /></span>
            <Notifications navigate={navigate} />
            <button className="hud-btn hud-kbd-opt" style={{ width: 34, height: 34 }} onClick={() => setKeysOpen(true)}
              title="Keyboard controls" aria-label="Keyboard controls"><Keyboard size={16} /></button>
          </div>

          <div className="hud-sep" style={{ height: 34, alignSelf: "center", margin: 0 }} />
          <LocalClock />

          <button className="hud-btn" onClick={cycleTheme} title="Cycle theme" aria-label="Cycle theme">
            <ThemeIcon size={16} />
          </button>
        </div>
      </header>

      {/* ── Main content area ───────────────────────────────────── */}
      <main id="rhodes-main" tabIndex={-1} style={{ flex: 1, overflowY: "auto", position: "relative", zIndex: 1 }}>
        <div style={{ padding: "20px 32px 28px", maxWidth: 1600, margin: "0 auto", minHeight: "calc(100vh - 68px)" }}>{children}</div>
      </main>

      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} navigate={navigate} />
      <ShortcutLegend open={keysOpen} onClose={() => setKeysOpen(false)} />
    </div>
  );
}
