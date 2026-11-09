// ─────────────────────────────────────────────────────────────
// RHODES · SCREEN 2 — MEETING OPERATIONS (directory)
// ─────────────────────────────────────────────────────────────
import React, { useMemo, useState } from "react";
import {
  Plus, Search, LayoutList, CalendarDays, ChevronLeft, ChevronRight,
  Pencil, Trash2, MapPin, Users, ArrowRight,
} from "lucide-react";
import { Badge, Button, ConfirmDialog, Empty, PageHeader, Panel, Reveal } from "@/components/ui";
import { useAppData } from "@/hooks/store";
import { useToast } from "@/components/toast";
import { useUi } from "@/hooks/ui";
import type { Route } from "@/layout/AppShell";
import { Meeting, MeetingStatus } from "@/types";
import { MEETING_STATUS, formatDate, formatTime, personName, todayISO } from "@/utils/helpers";

type StatusFilter = "all" | MeetingStatus;

function CalendarView({ meetings, onOpen }: { meetings: Meeting[]; onOpen: (id: string) => void }) {
  const { data } = useAppData();
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const y = cursor.getFullYear(), mo = cursor.getMonth();
  const first = new Date(y, mo, 1);
  const startOffset = (first.getDay() + 6) % 7; // week starts Monday
  const dim = new Date(y, mo + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(new Date(y, mo, i - startOffset + 1));
  for (let i = 1; i <= dim; i++) cells.push(new Date(y, mo, i));
  while (cells.length % 7 !== 0) cells.push(new Date(y, mo + 1, cells.length - dim - startOffset + 1));

  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = todayISO();
  const monthName = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" }).toUpperCase();

  return (
    <Panel pad={false}
      title="Schedule Matrix" code={monthName}
      actions={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button className="editor-tool" style={{ border: "1px solid var(--border)" }} aria-label="Previous month"
            onClick={() => setCursor(new Date(y, mo - 1, 1))}><ChevronLeft size={14} /></button>
          <button className="btn btn-sm" onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</button>
          <button className="editor-tool" style={{ border: "1px solid var(--border)" }} aria-label="Next month"
            onClick={() => setCursor(new Date(y, mo + 1, 1))}><ChevronRight size={14} /></button>
        </div>
      }>
      <div style={{ padding: "0 16px 16px" }}>
        <div className="cal-grid" style={{ marginTop: 14 }}>
          {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((d) => (
            <div key={d} className="mono-label" style={{ padding: "7px 8px", background: "var(--surface-2)" }}>{d}</div>
          ))}
          {cells.map((d, i) => {
            if (!d) return <div key={i} className="cal-cell dim-day" />;
            const key = iso(d);
            const dayMeetings = meetings.filter((m) => m.date === key);
            return (
              <div key={i} className={`cal-cell ${d.getMonth() !== mo ? "dim-day" : ""} ${key === today ? "today" : ""}`}>
                <div className="mono" style={{ fontSize: 10, color: key === today ? "var(--accent)" : "var(--text-3)", letterSpacing: "0.08em" }}>
                  {String(d.getDate()).padStart(2, "0")}
                </div>
                {dayMeetings.slice(0, 3).map((m) => (
                  <button key={m.id} type="button" className="cal-chip" onClick={() => onOpen(m.id)}
                    aria-label={`Open ${m.title}`}
                    style={{ borderLeftColor: m.status === "cancelled" ? "var(--text-3)" : m.status === "completed" ? "var(--ok)" : "var(--accent)" }}
                    title={`${m.startTime} — ${m.title}`}>
                    {m.startTime} {m.title}
                  </button>
                ))}
                {dayMeetings.length > 3 && <div className="mono dim" style={{ fontSize: 9, marginTop: 3 }}>+{dayMeetings.length - 3} MORE</div>}
              </div>
            );
          })}
        </div>
      </div>
      <span aria-hidden style={{ display: "none" }}>{data.settings.dateFormat}</span>
    </Panel>
  );
}

export function MeetingOperations({ navigate }: { navigate: (r: Route) => void }) {
  const { data, deleteMeeting } = useAppData();
  const toast = useToast();
  const ui = useUi();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [view, setView] = useState<"list" | "calendar">("list");
  const [confirmDel, setConfirmDel] = useState<Meeting | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.meetings
      .filter((m) => (filter === "all" ? true : m.status === filter))
      .filter((m) => (dateFrom ? m.date >= dateFrom : true))
      .filter((m) => !needle || [m.title, m.location, m.purpose, personName(data.personnel.find((p) => p.id === m.organizerId))]
        .some((s) => s.toLowerCase().includes(needle)))
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  }, [data.meetings, data.personnel, filter, q, dateFrom]);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: data.meetings.length, upcoming: 0, "in-progress": 0, completed: 0, cancelled: 0 };
    data.meetings.forEach((m) => c[m.status]++);
    return c;
  }, [data.meetings]);

  const FILTERS: { id: StatusFilter; label: string }[] = [
    { id: "all", label: "All" }, { id: "upcoming", label: "Upcoming" }, { id: "in-progress", label: "In Progress" },
    { id: "completed", label: "Completed" }, { id: "cancelled", label: "Cancelled" },
  ];

  return (
    <div style={{ display: "grid", gap: 24 }}>
            <Reveal>
        <PageHeader
          eyebrow={`// OPERATIONS DIRECTORY · ${data.meetings.length} RECORDS`}
          title="Meeting Operations"
          actions={<Button variant="primary" size="lg" style={{ height: 48, padding: "0 32px", fontSize: 14 }} icon={<Plus size={16} />} onClick={() => ui.openMeetingForm()}>New Meeting</Button>}
        />
      </Reveal>

      {/* ── Filter bar ────────────────────────────── */}
      <Reveal delay={0.06}>
        <Panel pad={false}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 14px", flexWrap: "wrap" }}>
            <div className="seg" role="tablist" aria-label="Status filter">
              {FILTERS.map((f) => (
                <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? "on" : ""} onClick={() => setFilter(f.id)}>
                  {f.label} · {counts[f.id]}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--border)", background: "var(--bg)", padding: "0 10px", height: 32, flex: "0 1 260px", marginLeft: "auto" }}>
              <Search size={13} style={{ color: "var(--text-3)", flexShrink: 0 }} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search meetings…" aria-label="Search meetings"
                style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text)", fontSize: "var(--fs-small)" }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="mono-label">From</span>
              <input type="date" className="input input-mono" style={{ height: 32, padding: "4px 8px", width: 150 }} value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)} aria-label="Filter from date" />
            </div>
            <div className="seg" role="group" aria-label="View mode">
              <button className={view === "list" ? "on" : ""} onClick={() => setView("list")} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><LayoutList size={12} /> List</button>
              <button className={view === "calendar" ? "on" : ""} onClick={() => setView("calendar")} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><CalendarDays size={12} /> Calendar</button>
            </div>
          </div>
        </Panel>
      </Reveal>

      {view === "calendar" ? (
        <Reveal delay={0.1}>
          <CalendarView meetings={filtered} onOpen={(id) => navigate({ section: "meetings", meetingId: id })} />
        </Reveal>
      ) : (
        <Reveal delay={0.1}>
          <Panel pad={false} title={`Directory — ${FILTERS.find((f) => f.id === filter)!.label}`} code={`${filtered.length} ENTRIES`} className="clip-corner-bottom">
            {filtered.length === 0 && (
              <Empty icon={<Search size={18} />} title="No meetings found"
                hint={q || dateFrom || filter !== "all" ? "Adjust or clear the active filters." : "Register your first meeting to begin."}
                action={<Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={() => ui.openMeetingForm()}>New Meeting</Button>} />
            )}
            <div>
              {filtered.map((m) => {
                const org = data.personnel.find((p) => p.id === m.organizerId);
                return (
                  <div key={m.id} className="row-line meeting-row">
                    <span style={{ width: 3, alignSelf: "stretch", background: MEETING_STATUS[m.status].tone === "cyan" ? "var(--accent)" : MEETING_STATUS[m.status].tone === "green" ? "var(--ok)" : MEETING_STATUS[m.status].tone === "yellow" ? "var(--amber)" : "var(--border)", flexShrink: 0 }} />
                    <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                      <button type="button" className="row-open" onClick={() => navigate({ section: "meetings", meetingId: m.id })}
                        aria-label={`Open ${m.title} workspace`}>
                        <span className="small row-open-title" style={{ fontWeight: 600, color: "var(--text)", display: "block" }}>{m.title}</span>
                      </button>
                      <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2, display: "flex", gap: 14, flexWrap: "wrap" }}>
                        <span>{formatDate(m.date, data.settings.dateFormat)} · {formatTime(m.startTime, data.settings.timeFormat)}—{formatTime(m.endTime, data.settings.timeFormat)}</span>
                        {m.location && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><MapPin size={10} />{m.location}</span>}
                      </div>
                    </div>
                    <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", width: 150, flexShrink: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}><Users size={10} /> {m.attendeeIds.length} ATTENDEES</div>
                      <div style={{ marginTop: 2 }}>ORG · {org ? org.fullName.toUpperCase().slice(0, 16) : "—"}</div>
                    </div>
                    <Badge tone={MEETING_STATUS[m.status].tone}>{MEETING_STATUS[m.status].label}</Badge>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button className="editor-tool" title="Edit meeting" aria-label={`Edit ${m.title}`}
                        onClick={() => ui.openMeetingForm(m.id)}><Pencil size={13} /></button>
                      <button className="editor-tool" title="Delete meeting" aria-label={`Delete ${m.title}`}
                        onClick={() => setConfirmDel(m)} style={{ color: "var(--crit)" }}><Trash2 size={13} /></button>
                      <button className="editor-tool" title="Open workspace" aria-label={`Open ${m.title} workspace`}
                        onClick={() => navigate({ section: "meetings", meetingId: m.id })}><ArrowRight size={13} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        </Reveal>
      )}

      <ConfirmDialog open={!!confirmDel} onCancel={() => setConfirmDel(null)}
        title="Delete Meeting Record"
        message={<>Delete <b style={{ color: "var(--text)" }}>“{confirmDel?.title}”</b>? Agenda entries, notes, decisions and action items linked to this record will also be removed. This cannot be undone.</>}
        confirmLabel="Delete Record"
        onConfirm={() => {
          if (confirmDel) { deleteMeeting(confirmDel.id); toast.success("Meeting record deleted."); }
          setConfirmDel(null);
        }} />
    </div>
  );
}
