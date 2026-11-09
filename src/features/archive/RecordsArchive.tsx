// ─────────────────────────────────────────────────────────────
// RHODES · SCREEN 6 — RECORDS ARCHIVE
// Documentation-oriented interface: full meeting records,
// search + filtering, Markdown export, print, JSON backup.
// ─────────────────────────────────────────────────────────────
import React, { useMemo, useState } from "react";
import { Copy, Database, FileDown, FileText, Printer, Search } from "lucide-react";
import { Badge, Button, Empty, PageHeader, Panel, Reveal } from "@/components/ui";
import { useAppData } from "@/hooks/store";
import { useToast } from "@/components/toast";
import { minutesPrintHtml, printHtml, MinutesBody } from "@/features/meetings/WorkspacePanels";
import type { Route } from "@/layout/AppShell";
import {
  ATTENDANCE, MEETING_STATUS, buildMinutesMarkdown, downloadFile, formatDate, formatDateLong, formatTime,
} from "@/utils/helpers";

export function RecordsArchive({ navigate, openId }: { navigate: (r: Route) => void; openId?: string | null }) {
  const { data, exportJSON } = useAppData();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [fPerson, setFPerson] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(openId ?? null);

  const records = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...data.meetings]
      .sort((a, b) => b.date.localeCompare(a.date))
      .filter((m) => !fStatus || m.status === fStatus)
      .filter((m) => !fPerson || m.attendeeIds.includes(fPerson) || m.organizerId === fPerson)
      .filter((m) => !needle || [m.title, m.date, m.location].some((s) => s.toLowerCase().includes(needle)));
  }, [data.meetings, q, fStatus, fPerson]);

  const selected = records.find((m) => m.id === selectedId) ?? data.meetings.find((m) => m.id === selectedId) ?? null;
  const completed = data.meetings.filter((m) => m.status === "completed").length;
  const decisionCount = data.decisions.length;

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <Reveal>
        <PageHeader
          eyebrow={`// DOCUMENTATION VAULT · ${data.meetings.length} RECORDS`}
          title="Records Archive"
          meta={`${completed} COMPLETED MEETINGS · ${decisionCount} DECISIONS · ${data.notes.length} NOTE FILES`}
          actions={<Button variant="secondary" size="lg" style={{ height: 48, padding: "0 30px", fontSize: 13 }} icon={<Database size={16} />} onClick={() => {
            downloadFile(`rhodes-backup-${new Date().toISOString().slice(0, 10)}.json`, exportJSON(), "application/json");
            toast.success("Full data backup exported as JSON.");
          }}>Export Backup</Button>}
        />
      </Reveal>

      <Reveal delay={0.06}>
        <Panel pad={false}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 280px" }}>
              <Search size={14} style={{ color: "var(--text-3)", flexShrink: 0 }} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title, date, or location…"
                aria-label="Search records"
                style={{ flex: 1, height: 30, background: "transparent", border: "none", outline: "none", color: "var(--text)", fontSize: "var(--fs-body)" }} />
            </div>
            <select className="select" style={{ width: "auto", height: 30, fontSize: "var(--fs-small)" }} value={fPerson} onChange={(e) => setFPerson(e.target.value)} aria-label="Filter by person">
              <option value="">All personnel</option>
              {data.personnel.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
            </select>
            <select className="select" style={{ width: "auto", height: 30, fontSize: "var(--fs-small)" }} value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All statuses</option>
              <option value="upcoming">Upcoming</option><option value="in-progress">In Progress</option>
              <option value="completed">Completed</option><option value="cancelled">Cancelled</option>
            </select>
            <span className="mono dim">{records.length} RECORD{records.length === 1 ? "" : "S"}</span>
          </div>
        </Panel>
      </Reveal>

      <div style={{ display: "grid", gridTemplateColumns: "340px minmax(0, 1fr)", gap: "var(--gap)", alignItems: "start" }}>
        {/* ── Record index ─────────────────────── */}
        <Reveal delay={0.1}>
          <Panel title="Record Index" code="DESCENDING" pad={false} className="archive-index clip-corner-bottom">
            {records.length === 0 && <Empty icon={<Search size={18} />} title="No records match" hint="Adjust the query or filters." />}
            <div style={{ maxHeight: 640, overflowY: "auto" }}>
              {records.map((m) => {
                const n = data.notes.find((x) => x.meetingId === m.id);
                const on = selectedId === m.id;
                return (
                  <button key={m.id} onClick={() => setSelectedId(m.id)}
                    aria-current={on}
                    style={{
                      width: "100%", textAlign: "left", cursor: "pointer", border: "none",
                      padding: "11px 14px", borderBottom: "1px solid var(--border-soft)",
                      background: on ? "var(--accent-dim)" : "transparent",
                      borderLeft: on ? "2px solid var(--accent)" : "2px solid transparent",
                      transition: "background-color 130ms linear",
                    }}>
                    <div className="small" style={{ fontWeight: 600, color: on ? "var(--accent)" : "var(--text)" }}>{m.title}</div>
                    <div className="mono" style={{ fontSize: 9, color: "var(--text-3)", marginTop: 3, letterSpacing: "0.08em" }}>
                      {formatDate(m.date, data.settings.dateFormat)} · {m.attendeeIds.length} PAX · NOTES {n ? "YES" : "NO"} · MINUTES {m.minuteOverride != null ? "EDITED" : "AUTO"}
                    </div>
                    <div style={{ marginTop: 5 }}><Badge tone={MEETING_STATUS[m.status].tone} dot={false}>{MEETING_STATUS[m.status].label}</Badge></div>
                  </button>
                );
              })}
            </div>
          </Panel>
        </Reveal>

        {/* ── Documentation view ───────────────── */}
        <Reveal delay={0.14}>
          {!selected ? (
            <Panel><Empty icon={<FileText size={18} />} title="Select a record" hint="Choose a record from the index to review its complete documentation." /></Panel>
          ) : (
            <RecordDoc meetingId={selected.id} navigate={navigate} toast={toast} />
          )}
        </Reveal>
      </div>
    </div>
  );
}

function RecordDoc({ meetingId, navigate, toast }: { meetingId: string; navigate: (r: Route) => void; toast: ReturnType<typeof useToast> }) {
  const { data } = useAppData();
  const meeting = data.meetings.find((m) => m.id === meetingId)!;
  const s = data.settings;
  const agenda = data.agendaItems.filter((a) => a.meetingId === meetingId).sort((x, y) => x.sortOrder - y.sortOrder);
  const note = data.notes.find((n) => n.meetingId === meetingId);
  const decisions = data.decisions.filter((d) => d.meetingId === meetingId);
  const actions = data.actionItems.filter((t) => t.meetingId === meetingId);
  const md = meeting.minuteOverride ?? buildMinutesMarkdown(meeting, agenda, note, decisions, actions, data.personnel, s);
  const fileBase = `RHODES-record-${meeting.date}-${meeting.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

  return (
    <Panel title="Full Documentation" code={meeting.id.toUpperCase()} pad={false}
      actions={<div style={{ display: "flex", gap: 8 }}>
        <Button size="sm" icon={<Copy size={13} />} onClick={() => navigator.clipboard.writeText(md).then(() => toast.success("Minutes markdown copied."))}>Copy</Button>
        <Button size="sm" icon={<FileDown size={13} />} onClick={() => { downloadFile(`${fileBase}.md`, md, "text/markdown"); toast.success("Meeting notes exported as Markdown."); }}>Markdown</Button>
        <Button size="sm" icon={<Printer size={13} />} onClick={() => printHtml(minutesPrintHtml(md, `Meeting Minutes — ${meeting.title}`))}>Print</Button>
        <Button size="sm" variant="primary" onClick={() => navigate({ section: "meetings", meetingId })}>Open Workspace</Button>
      </div>}>
      <div style={{ padding: 20, maxHeight: 700, overflowY: "auto" }}>
        <div className="minutes-doc">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
            <div>
              <h1>{meeting.title}</h1>
              <div className="mono-label" style={{ marginTop: 4 }}>{formatDateLong(meeting.date).toUpperCase()} · {formatTime(meeting.startTime, s.timeFormat)}—{formatTime(meeting.endTime, s.timeFormat)} · {(meeting.location || "—").toUpperCase()}</div>
            </div>
            <Badge tone={MEETING_STATUS[meeting.status].tone}>{MEETING_STATUS[meeting.status].label}</Badge>
          </div>
          <MinutesBody md={md} meeting={meeting} />
        </div>
      </div>
    </Panel>
  );
}
