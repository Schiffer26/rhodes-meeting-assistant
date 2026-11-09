// ─────────────────────────────────────────────────────────────
// RHODES · SCREEN 5 — TASK OPERATIONS
// All action items: list + board views, search, sorting,
// filtering, direct status updates, automatic overdue logic.
// ─────────────────────────────────────────────────────────────
import React, { useMemo, useState } from "react";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Columns3, LayoutList, Plus, Search, Trash2, Pencil } from "lucide-react";
import { Badge, Button, ConfirmDialog, Empty, PageHeader, Panel, Reveal } from "@/components/ui";
import { useAppData } from "@/hooks/store";
import { useToast } from "@/components/toast";
import { useUi } from "@/hooks/ui";
import { ActionItemFormModal } from "./ActionItemForm";
import type { Route } from "@/layout/AppShell";
import { ActionItem, TaskStatus } from "@/types";
import { PRIORITY, TASK_STATUS, daysUntil, formatDate, isTaskOverdue, personName } from "@/utils/helpers";

type Tab = "all" | "pending" | "in-progress" | "completed" | "overdue";

export function TaskOperations({ navigate }: { navigate: (r: Route) => void }) {
  const { data, setActionStatus, updateActionItem, deleteActionItem } = useAppData();
  const toast = useToast();
  const ui = useUi();
  const [tab, setTab] = useState<Tab>("all");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"list" | "board">("list");
  const [sortAsc, setSortAsc] = useState(true);
  const [fAssignee, setFAssignee] = useState("");
  const [fPriority, setFPriority] = useState("");
  const [fMeeting, setFMeeting] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<ActionItem | null>(null);

  const counts = useMemo(() => ({
    all: data.actionItems.length,
    pending: data.actionItems.filter((t) => t.status === "pending").length,
    "in-progress": data.actionItems.filter((t) => t.status === "in-progress").length,
    completed: data.actionItems.filter((t) => t.status === "completed").length,
    overdue: data.actionItems.filter(isTaskOverdue).length,
  }), [data.actionItems]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.actionItems
      .filter((t) => tab === "all" ? true : tab === "overdue" ? isTaskOverdue(t) : t.status === tab)
      .filter((t) => !fAssignee || t.assigneeId === fAssignee)
      .filter((t) => !fPriority || t.priority === fPriority)
      .filter((t) => !fMeeting || t.meetingId === fMeeting)
      .filter((t) => !needle || [t.title, t.description, personName(data.personnel.find((p) => p.id === t.assigneeId)), data.meetings.find((m) => m.id === t.meetingId)?.title]
        .some((s) => (s ?? "").toLowerCase().includes(needle)))
      .sort((a, b) => (sortAsc ? 1 : -1) * a.dueDate.localeCompare(b.dueDate));
  }, [data, tab, q, fAssignee, fPriority, fMeeting, sortAsc]);

  const meetingTitle = (id: string) => data.meetings.find((m) => m.id === id)?.title ?? "—";
  const selStyle: React.CSSProperties = { height: 30, fontSize: "var(--fs-small)", padding: "3px 26px 3px 9px", width: "auto" };

  const TaskRow = ({ t }: { t: ActionItem }) => {
    const od = isTaskOverdue(t);
    const dl = daysUntil(t.dueDate);
    return (
      <div className="row-line" style={{ borderLeft: `2px solid ${od ? "var(--crit)" : t.status === "completed" ? "var(--ok)" : "transparent"}` }}>
        <input type="checkbox" className="checkbox" checked={t.status === "completed"} aria-label={`Toggle ${t.title}`}
          onChange={(e) => setActionStatus(t.id, e.target.checked ? "completed" : "pending")} />
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <button className="linklike" style={{ display: "block", textAlign: "left", fontWeight: 600, fontSize: "var(--fs-small)", color: t.status === "completed" ? "var(--text-3)" : "var(--text)", textDecoration: t.status === "completed" ? "line-through" : "none" }}
            onClick={() => navigate({ section: "meetings", meetingId: t.meetingId })}>
            {t.title}
          </button>
          <div className="mono" style={{ fontSize: 9.5, color: "var(--text-3)", marginTop: 2 }}>
            {meetingTitle(t.meetingId).toUpperCase()} · {personName(data.personnel.find((p) => p.id === t.assigneeId)).toUpperCase()}
          </div>
        </div>
        <Badge tone={PRIORITY[t.priority].tone} dot={t.priority === "critical"}>{PRIORITY[t.priority].label}</Badge>
        <span className="mono" style={{ fontSize: 10, width: 128, flexShrink: 0, color: od ? "var(--crit)" : "var(--text-3)" }}>
          {od ? `OVERDUE ${Math.abs(dl)}D` : dl === 0 ? "DUE TODAY" : t.status === "completed" ? "CLOSED" : `D-${dl} · ${formatDate(t.dueDate, data.settings.dateFormat)}`}
        </span>
        <select className="select" style={selStyle} value={t.status} aria-label={`Status of ${t.title}`}
          onChange={(e) => setActionStatus(t.id, e.target.value as TaskStatus)}>
          <option value="pending">Pending</option><option value="in-progress">In Progress</option><option value="completed">Completed</option>
        </select>
        <div style={{ display: "flex", gap: 2 }}>
          <button className="editor-tool" onClick={() => setEditId(t.id)} title="Edit task" aria-label={`Edit ${t.title}`}><Pencil size={13} /></button>
          <button className="editor-tool" style={{ color: "var(--crit)" }} onClick={() => setConfirmDel(t)} title="Delete task" aria-label={`Delete ${t.title}`}><Trash2 size={13} /></button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <Reveal>
        <PageHeader
          eyebrow={`// RESPONSIBILITY TRACKING · ${counts.all} TOTAL`}
          title="Task Operations"
          actions={<Button variant="primary" size="lg" style={{ height: 48, padding: "0 30px", fontSize: 13 }} icon={<Plus size={16} />} onClick={() => ui.openTaskForm()}>Add Action Item</Button>}
        />
      </Reveal>

      <Reveal delay={0.06}>
        <Panel pad={false}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", flexWrap: "wrap" }}>
            <div className="seg" role="tablist" aria-label="Task filter">
              {([["all", "All"], ["pending", "Pending"], ["in-progress", "In Progress"], ["completed", "Completed"], ["overdue", "Overdue"]] as [Tab, string][]).map(([id, lab]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                  {lab} · {counts[id]}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexWrap: "wrap", alignItems: "center" }}>
              <select className="select" style={selStyle} value={fAssignee} onChange={(e) => setFAssignee(e.target.value)} aria-label="Filter by assignee">
                <option value="">All assignees</option>
                {data.personnel.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
              </select>
              <select className="select" style={selStyle} value={fPriority} onChange={(e) => setFPriority(e.target.value)} aria-label="Filter by priority">
                <option value="">All priorities</option>
                <option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
              </select>
              <select className="select" style={selStyle} value={fMeeting} onChange={(e) => setFMeeting(e.target.value)} aria-label="Filter by meeting">
                <option value="">All meetings</option>
                {data.meetings.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
              </select>
              <button className="btn btn-sm" onClick={() => setSortAsc(!sortAsc)} title="Sort by deadline">
                {sortAsc ? <ArrowUpNarrowWide size={13} /> : <ArrowDownWideNarrow size={13} />} Deadline
              </button>
              <div className="seg" aria-label="View mode">
                <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}><LayoutList size={12} /></button>
                <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}><Columns3 size={12} /></button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 7, border: "1px solid var(--border)", background: "var(--bg)", padding: "0 9px", height: 30 }}>
                <Search size={12} style={{ color: "var(--text-3)" }} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search tasks"
                  style={{ width: 120, background: "transparent", border: "none", outline: "none", color: "var(--text)", fontSize: "var(--fs-small)" }} />
              </div>
            </div>
          </div>
        </Panel>
      </Reveal>

      {view === "list" ? (
        <Reveal delay={0.1}>
          <Panel title="Task Register" code={`${filtered.length} ENTRIES`} pad={false} className="clip-corner-bottom">
            {filtered.length === 0 && <Empty icon={<LayoutList size={18} />} title="No action items match" hint="Adjust the filters or register a new task." />}
            {filtered.map((t) => <TaskRow key={t.id} t={t} />)}
          </Panel>
        </Reveal>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--gap)", alignItems: "start" }}>
          {(["pending", "in-progress", "completed"] as TaskStatus[]).map((st, ci) => {
            const col = filtered.filter((t) => t.status === st);
            return (
              <Reveal key={st} delay={0.08 + ci * 0.05}>
                <Panel title={TASK_STATUS[st].label} code={`${col.length}`} pad={false} accentBar={st !== "completed"}>
                  <div style={{ minHeight: 120, display: "grid", gap: 8, padding: 10, alignContent: "start" }}>
                    {col.length === 0 && <div className="small dim" style={{ padding: "14px 6px" }}>No {TASK_STATUS[st].label.toLowerCase()} tasks.</div>}
                    {col.map((t) => {
                      const od = isTaskOverdue(t);
                      return (
                        <div key={t.id} className="panel panel-2" style={{ padding: 12, borderLeft: od ? "2px solid var(--crit)" : "1px solid var(--border)" }}>
                          <div className="small" style={{ fontWeight: 600, color: "var(--text)" }}>{t.title}</div>
                          <div className="mono" style={{ fontSize: 9, color: "var(--text-3)", marginTop: 4, letterSpacing: "0.06em" }}>
                            {personName(data.personnel.find((p) => p.id === t.assigneeId)).toUpperCase()}
                          </div>
                          <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <Badge tone={PRIORITY[t.priority].tone} dot={false}>{PRIORITY[t.priority].label}</Badge>
                            <span className="mono" style={{ fontSize: 9, color: od ? "var(--crit)" : "var(--text-3)" }}>
                              {od ? "OVERDUE" : formatDate(t.dueDate, data.settings.dateFormat)}
                            </span>
                            <select className="select" style={{ ...selStyle, marginLeft: "auto", width: "auto" }} value={t.status}
                              aria-label={`Status of ${t.title}`} onChange={(e) => setActionStatus(t.id, e.target.value as TaskStatus)}>
                              <option value="pending">Pending</option><option value="in-progress">In Progress</option><option value="completed">Completed</option>
                            </select>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Panel>
              </Reveal>
            );
          })}
        </div>
      )}

      <ActionItemFormModal open={!!editId} taskId={editId} onClose={() => setEditId(null)} />
      <ConfirmDialog open={!!confirmDel} onCancel={() => setConfirmDel(null)} title="Delete Action Item"
        message={<>Delete <b style={{ color: "var(--text)" }}>“{confirmDel?.title}”</b>?</>} confirmLabel="Delete"
        onConfirm={() => { if (confirmDel) { deleteActionItem(confirmDel.id); toast.success("Action item deleted."); } setConfirmDel(null); }} />
    </div>
  );
}
