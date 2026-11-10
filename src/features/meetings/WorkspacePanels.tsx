// ─────────────────────────────────────────────────────────────
// RHODES · MEETING WORKSPACE — internal panels
// Overview / Agenda / Notes / Decisions / Action Items / Minutes
// Attendees rail / Quick Capture
// ─────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, Bold, CheckCircle2, Clock3, Copy, FileDown, Heading2, Heading3,
  Italic, List, ListOrdered, Pencil, Plus, Printer, RotateCcw, SquareCheck, Timer, Trash2, UserRound, X,
} from "lucide-react";
import { Badge, Button, ConfirmDialog, Empty, Field, Modal, Panel, SaveIndicator } from "@/components/ui";
import { useAppData } from "@/hooks/store";
import { useToast } from "@/components/toast";
import { useUi } from "@/hooks/ui";
import type { AgendaItem, AgendaStatus, AttendanceStatus, Decision, Meeting } from "@/types";
import {
  AGENDA_STATUS, ATTENDANCE, DECISION_STATUS, MEETING_STATUS, PRIORITY, TASK_STATUS,
  buildMinutesMarkdown, downloadFile, formatDate, formatDateLong, formatTime,
  isTaskOverdue, personName, todayISO,
} from "@/utils/helpers";
import { ActionItemFormModal } from "@/features/tasks/ActionItemForm";

// ── helpers ──────────────────────────────────────────────────
const sel = (v: string, onChange: (v: string) => void, options: [string, string][], label: string) => (
  <select className="select" style={{ height: 30, width: 116, flex: "0 0 auto", padding: "3px 24px 3px 9px", fontSize: "var(--fs-small)" }}
    value={v} onChange={(e) => onChange(e.target.value)} aria-label={label}>
    {options.map(([val, lab]) => <option key={val} value={val}>{lab}</option>)}
  </select>
);

export function minutesPrintHtml(md: string, title: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = md.split("\n");
  let html = `<h1>${esc(title)}</h1><div class="mono-label">GENERATED LOCALLY BY RHODES · ${esc(todayISO())}</div>`;
  for (const ln of lines) {
    if (ln.startsWith("# ")) continue;
    if (ln.startsWith("## ")) html += `<h2>${esc(ln.slice(3))}</h2>`;
    else if (ln.startsWith("### ")) html += `<h3 style="font-size:13px;margin:10px 0 4px">${esc(ln.slice(4))}</h3>`;
    else if (ln.startsWith("- ") || ln.startsWith("[x] ") || ln.startsWith("[ ] ")) html += `<div style="padding:1.5px 0 1.5px 14px">· ${esc(ln.replace(/^- /, ""))}</div>`;
    else if (/^\d+\./.test(ln)) html += `<div style="padding:1.5px 0 1.5px 14px">${esc(ln)}</div>`;
    else if (ln.trim() === "—") html += `<hr style="border:none;border-top:1px solid #ccc;margin:14px 0"/>`;
    else if (ln.trim()) html += `<p style="margin:3px 0;font-size:12px">${esc(ln).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>")}</p>`;
    else html += `<div style="height:5px"/>`;
  }
  return html;
}

export function printHtml(html: string) {
  let root = document.getElementById("print-root");
  if (!root) { root = document.createElement("div"); root.id = "print-root"; document.body.appendChild(root); }
  root.innerHTML = html;
  window.print();
}

// ═══ OVERVIEW ═══════════════════════════════════════════════
export function OverviewPanel({ meeting }: { meeting: Meeting }) {
  const { data } = useAppData();
  const s = data.settings;
  const agenda = data.agendaItems.filter((a) => a.meetingId === meeting.id).sort((x, y) => x.sortOrder - y.sortOrder);
  const tasks = data.actionItems.filter((t) => t.meetingId === meeting.id);
  const decisions = data.decisions.filter((d) => d.meetingId === meeting.id);
  const discussed = agenda.filter((a) => a.status === "discussed").length;
  const done = tasks.filter((t) => t.status === "completed").length;
  const organizer = data.personnel.find((p) => p.id === meeting.organizerId);
  const totalMin = agenda.reduce((acc, a) => acc + a.estimatedMinutes, 0);
  const attCount = (st: AttendanceStatus) => meeting.attendeeIds.filter((id) => (meeting.attendance[id] ?? "invited") === st).length;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Panel title="Meeting Brief" code={meeting.id.toUpperCase()} pad={false}>
        <div className="panel-body" style={{ borderBottom: "1px solid var(--border-soft)" }}>
          <div className="mono-label" style={{ marginBottom: 6 }}>Purpose</div>
          <p className="small" style={{ color: "var(--text-2)", lineHeight: 1.7, margin: 0 }}>
            {meeting.purpose || "No purpose recorded. Edit the meeting to add objectives."}
          </p>
        </div>
        <div className="panel-body">
          <dl className="kv">
            <dt>Date</dt><dd>{formatDateLong(meeting.date)} ({formatDate(meeting.date, s.dateFormat)})</dd>
            <dt>Time</dt><dd>{formatTime(meeting.startTime, s.timeFormat)} — {formatTime(meeting.endTime, s.timeFormat)}</dd>
            <dt>Location</dt><dd>{meeting.location || "—"}</dd>
            <dt>Organizer</dt><dd>{organizer ? `${organizer.fullName} · ${organizer.role || "—"}` : "—"}</dd>
            <dt>Est. Duration</dt><dd>{totalMin > 0 ? `${totalMin} min of scheduled agenda` : "—"}</dd>
            <dt>Attendance</dt><dd>{attCount("present")} present · {attCount("absent")} absent · {attCount("excused")} excused · {attCount("invited")} invited</dd>
          </dl>
        </div>
      </Panel>

      <div className="stat-grid-4">
        {[
          { l: "AGENDA PROGRESS", v: `${discussed}/${agenda.length}` },
          { l: "ACTIONS DONE", v: `${done}/${tasks.length}` },
          { l: "DECISIONS", v: String(decisions.length).padStart(2, "0") },
          { l: "PARTICIPANTS", v: String(meeting.attendeeIds.length).padStart(2, "0") },
        ].map((x) => (
          <div key={x.l} className="panel" style={{ padding: "12px 14px" }}>
            <div className="mono-label">{x.l}</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700, marginTop: 4, color: "var(--accent)" }}>{x.v}</div>
          </div>
        ))}
      </div>

      <Panel title="Agenda Summary" code={`${agenda.length} ENTRIES`} pad={false}>
        {agenda.length === 0 && <div className="panel-body small dim">No agenda entries yet. Add topics in the Agenda tab.</div>}
        {agenda.map((a, i) => (
          <div key={a.id} className="row-line" style={{ padding: "9px 14px" }}>
            <span className="mono" style={{ color: "var(--accent)", width: 24, flexShrink: 0 }}>{String(i + 1).padStart(2, "0")}</span>
            <span className="small" style={{ flex: 1, color: "var(--text-2)" }}>{a.title}</span>
            <span className="mono dim" style={{ fontSize: 10 }}>{a.estimatedMinutes} MIN · {personName(data.personnel.find((p) => p.id === a.presenterId))}</span>
            <Badge tone={AGENDA_STATUS[a.status].tone} dot={false}>{AGENDA_STATUS[a.status].label}</Badge>
          </div>
        ))}
      </Panel>
    </div>
  );
}

// ═══ AGENDA ═════════════════════════════════════════════════
export function AgendaPanel({ meeting }: { meeting: Meeting }) {
  const { data, addAgendaItem, updateAgendaItem, deleteAgendaItem, moveAgendaItem, setAgendaStatus } = useAppData();
  const toast = useToast();
  const [newTitle, setNewTitle] = useState("");
  const [newMin, setNewMin] = useState(10);
  const [editing, setEditing] = useState<AgendaItem | null>(null);
  const [confirmDel, setConfirmDel] = useState<AgendaItem | null>(null);

  const agenda = data.agendaItems.filter((a) => a.meetingId === meeting.id).sort((x, y) => x.sortOrder - y.sortOrder);

  const [eTitle, setETitle] = useState(""); const [eDesc, setEDesc] = useState("");
  const [ePresenter, setEPresenter] = useState<string>(""); const [eMin, setEMin] = useState(10);
  useEffect(() => {
    if (editing) { setETitle(editing.title); setEDesc(editing.description); setEPresenter(editing.presenterId ?? ""); setEMin(editing.estimatedMinutes); }
  }, [editing]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Panel title="Agenda Sequence" code={`${agenda.length} ENTRIES`} pad={false}>
        {agenda.length === 0 && <Empty icon={<List size={18} />} title="Agenda is empty" hint="Define the topics this meeting will work through, in order." />}
        {agenda.map((a, i) => (
          <div key={a.id} className="row-line" style={{ alignItems: "flex-start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "center", paddingTop: 2 }}>
              <button className="editor-tool" style={{ width: 20, height: 16 }} disabled={i === 0} aria-label="Move up"
                onClick={() => moveAgendaItem(meeting.id, a.id, -1)}><ArrowUp size={11} /></button>
              <span className="mono" style={{ color: "var(--accent)", fontSize: 12 }}>{String(i + 1).padStart(2, "0")}</span>
              <button className="editor-tool" style={{ width: 20, height: 16 }} disabled={i === agenda.length - 1} aria-label="Move down"
                onClick={() => moveAgendaItem(meeting.id, a.id, 1)}><ArrowDown size={11} /></button>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="small" style={{ fontWeight: 600, color: "var(--text)" }}>{a.title}</div>
              {a.description && <div className="small dim" style={{ marginTop: 2 }}>{a.description}</div>}
              <div className="mono" style={{ fontSize: 9.5, color: "var(--text-3)", marginTop: 4, display: "flex", gap: 14 }}>
                <span><Timer size={9} style={{ verticalAlign: -1 }} /> {a.estimatedMinutes} MIN</span>
                <span><UserRound size={9} style={{ verticalAlign: -1 }} /> {personName(data.personnel.find((p) => p.id === a.presenterId)).toUpperCase()}</span>
              </div>
            </div>
            {sel(a.status, (v) => setAgendaStatus(a.id, v as AgendaStatus),
              [["not-started", "Not Started"], ["in-discussion", "In Discussion"], ["discussed", "Discussed"], ["skipped", "Skipped"], ["postponed", "Postponed"]],
              `Status of ${a.title}`)}
            <button className="editor-tool" onClick={() => setEditing(a)} title="Edit agenda item" aria-label={`Edit ${a.title}`}><Pencil size={13} /></button>
            <button className="editor-tool" style={{ color: "var(--crit)" }} onClick={() => setConfirmDel(a)} title="Remove agenda item" aria-label={`Remove ${a.title}`}><Trash2 size={13} /></button>
          </div>
        ))}
        {/* inline add */}
        <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border-soft)", background: "var(--surface-2)" }}>
          <input className="input" style={{ flex: 1, height: 32 }} placeholder="Add agenda topic and press Enter…"
            value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && newTitle.trim()) { addAgendaItem(meeting.id, { title: newTitle, estimatedMinutes: newMin }); setNewTitle(""); toast.success("Agenda entry added."); } }} />
          <input className="input input-mono" type="number" min={1} style={{ width: 76, height: 32 }} value={newMin}
            onChange={(e) => setNewMin(parseInt(e.target.value) || 1)} title="Estimated minutes" aria-label="Estimated minutes" />
          <Button size="sm" style={{ height: 32 }} variant="primary" onClick={() => {
            if (!newTitle.trim()) return;
            addAgendaItem(meeting.id, { title: newTitle, estimatedMinutes: newMin });
            setNewTitle(""); toast.success("Agenda entry added.");
          }}>Add</Button>
        </div>
      </Panel>

      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit Agenda Item" code={editing?.id.toUpperCase()} width={520}
        footer={<>
          <Button onClick={() => setEditing(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => {
            if (!eTitle.trim()) { toast.error("Topic title is required."); return; }
            updateAgendaItem(editing!.id, { title: eTitle.trim(), description: eDesc.trim(), presenterId: ePresenter || null, estimatedMinutes: eMin });
            toast.success("Agenda item updated."); setEditing(null);
          }}>Save</Button>
        </>}>
        <div style={{ display: "grid", gap: 14 }}>
          <Field label="Topic title" required><input className="input" value={eTitle} onChange={(e) => setETitle(e.target.value)} /></Field>
          <Field label="Description"><textarea className="textarea" style={{ minHeight: 56 }} value={eDesc} onChange={(e) => setEDesc(e.target.value)} /></Field>
          <div className="form-pin">
            <Field label="Presenter / responsible">
              <select className="select" value={ePresenter} onChange={(e) => setEPresenter(e.target.value)}>
                <option value="">— Unassigned —</option>
                {data.personnel.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
              </select>
            </Field>
            <Field label="Est. minutes"><input type="number" min={1} className="input input-mono" value={eMin} onChange={(e) => setEMin(parseInt(e.target.value) || 1)} /></Field>
          </div>
        </div>
      </Modal>

      <ConfirmDialog open={!!confirmDel} onCancel={() => setConfirmDel(null)} title="Remove Agenda Item"
        message={<>Remove <b style={{ color: "var(--text)" }}>“{confirmDel?.title}”</b> from the agenda? A recovery copy of the current records is written first.</>} confirmLabel="Remove"
        onConfirm={() => {
          const target = confirmDel;
          setConfirmDel(null);
          if (!target) return;
          void deleteAgendaItem(target.id).then((res) => {
            if (res.ok) toast.success("Agenda entry removed. A recovery copy was preserved.");
            else toast.error(res.error ?? "The agenda entry could not be removed.");
          });
        }} />
    </div>
  );
}

// ═══ NOTES ══════════════════════════════════════════════════
/**
 * Drafts the store refused to take (recovery write lock) outlive the panel, so
 * navigating away cannot silently discard what the operator typed. An entry is
 * removed the moment a save is accepted.
 */
const unsavedDrafts = new Map<string, string>();

export function NotesPanel({ meeting }: { meeting: Meeting }) {
  const { data, saveNote, saveState, flush } = useAppData();
  const toast = useToast();
  const note = data.notes.find((n) => n.meetingId === meeting.id);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const pending = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // A refusal is not the same as "still typing": the indicator must never read
  // "Saved" while the store is holding the draft back.
  const [refused, setRefused] = useState(false);
  const [words, setWords] = useState(0);

  useEffect(() => {
    // A draft kept from an earlier refusal is shown (and retried) first.
    const draft = unsavedDrafts.get(meeting.id);
    let keptDraft = false;
    if (draft != null) {
      // The stored copy is the fallback until the store takes the draft: a second
      // refusal must keep the draft and leave the editor visibly unsaved.
      if (saveNote(meeting.id, draft)) unsavedDrafts.delete(meeting.id);
      else keptDraft = true;
    }
    const html = draft ?? note?.content ?? "";
    if (ref.current) ref.current.innerHTML = html;
    // Restored-but-unsaved content is never marked saved.
    setDirty(keptDraft);
    setRefused(keptDraft);
    pending.current = keptDraft ? html : null;
    setWords(countWords(html));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.id]);

  const countWords = (html: string) => html.replace(/<[^>]+>/g, " ").trim().split(/\s+/).filter(Boolean).length;

  const doSave = useCallback((html: string) => {
    // Only clear the draft once the store has taken it. A refusal (write lock)
    // keeps `pending` and the dirty flag, so the content is still here to retry
    // instead of disappearing with the panel.
    if (!saveNote(meeting.id, html)) { setRefused(true); return; }
    pending.current = null;
    setDirty(false);
    setRefused(false);
  }, [meeting.id, saveNote]);

  const scheduleSave = useCallback(() => {
    const html = ref.current?.innerHTML ?? "";
    pending.current = html;
    setDirty(true);
    setWords(countWords(html));
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => doSave(html), 800);
  }, [doSave]);

  // flush pending content on unmount or on global save shortcut
  useEffect(() => {
    const onFlush = () => {
      if (pending.current != null) { if (timer.current) window.clearTimeout(timer.current); doSave(pending.current); flush(); }
    };
    window.addEventListener("rhodes:flush", onFlush);
    return () => {
      window.removeEventListener("rhodes:flush", onFlush);
      if (timer.current) window.clearTimeout(timer.current);
      if (pending.current != null) {
        const draft = pending.current;
        // Keep the draft in the module-level stash if the store refused it, so a
        // remount of the same meeting can still save it.
        if (!saveNote(meeting.id, draft)) unsavedDrafts.set(meeting.id, draft);
        else unsavedDrafts.delete(meeting.id);
      }
    };
  }, [meeting.id, saveNote, doSave, flush]);

  const exec = (cmd: string, val?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, val);
    scheduleSave();
  };
  const insertTimestamp = () => {
    const d = new Date();
    const ts = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    exec("insertHTML", `<span class="ts">[${ts}]</span>&nbsp;`);
  };
  const insertChecklist = () => exec("insertHTML", `<div class="chk"><input type="checkbox"/>&nbsp;<span>Checklist item</span></div>`);

  const toolBtn = (label: string, icon: React.ReactNode, fn: () => void) => (
    <button className="editor-tool" title={label} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={fn}>{icon}</button>
  );

  const state = refused ? "error" : dirty || saveState === "saving" ? "saving" : saveState === "error" ? "error" : "saved";

  return (
    <Panel title="Discussion Notes" code="MANUAL CAPTURE · AUTOSAVE" pad={false}
      actions={<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span className="mono dim">{words} WORDS</span>
        <SaveIndicator state={state} />
        {saveState === "error" && <Button size="sm" variant="danger" onClick={() => flush()}>Retry</Button>}
      </div>}>
      <div style={{ display: "flex", gap: 2, padding: "6px 10px", borderBottom: "1px solid var(--border-soft)", background: "var(--surface-2)", flexWrap: "wrap" }}>
        {toolBtn("Bold", <Bold size={13} />, () => exec("bold"))}
        {toolBtn("Italic", <Italic size={13} />, () => exec("italic"))}
        <span style={{ width: 1, background: "var(--border)", margin: "4px 6px" }} />
        {toolBtn("Heading", <Heading2 size={13} />, () => exec("formatBlock", "h2"))}
        {toolBtn("Subheading", <Heading3 size={13} />, () => exec("formatBlock", "h3"))}
        {toolBtn("Paragraph", <span className="mono" style={{ fontSize: 10 }}>¶</span>, () => exec("formatBlock", "p"))}
        <span style={{ width: 1, background: "var(--border)", margin: "4px 6px" }} />
        {toolBtn("Bulleted list", <List size={13} />, () => exec("insertUnorderedList"))}
        {toolBtn("Numbered list", <ListOrdered size={13} />, () => exec("insertOrderedList"))}
        {toolBtn("Checklist line", <SquareCheck size={13} />, insertChecklist)}
        <span style={{ width: 1, background: "var(--border)", margin: "4px 6px" }} />
        {toolBtn("Insert timestamp", <Clock3 size={13} />, insertTimestamp)}
      </div>
      <div ref={ref} className="editor-area" contentEditable suppressContentEditableWarning
        data-ph="Begin recording the discussion here. Content saves automatically after a short pause…"
        aria-label="Meeting notes editor"
        onInput={scheduleSave}
        onBlur={() => { if (pending.current != null) { if (timer.current) window.clearTimeout(timer.current); doSave(pending.current); } }}
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (t.tagName === "INPUT") {
            const box = t as HTMLInputElement;
            // persist toggle state into the saved markup attribute
            window.setTimeout(() => {
              if (box.checked) box.setAttribute("checked", ""); else box.removeAttribute("checked");
              scheduleSave();
            }, 30);
          }
        }} />
      <div className="mono dim" style={{ padding: "7px 14px", borderTop: "1px solid var(--border-soft)", fontSize: 9, letterSpacing: "0.14em", display: "flex", justifyContent: "space-between" }}>
        <span>AUTOSAVE ACTIVE · 800MS IDLE · CTRL+S FORCES SAVE</span>
        {note?.updatedAt && <span>LAST SAVED {new Date(note.updatedAt).toLocaleTimeString()}</span>}
      </div>
    </Panel>
  );
}

// ═══ DECISIONS ══════════════════════════════════════════════
export function DecisionsPanel({ meeting }: { meeting: Meeting }) {
  const { data, createDecision, updateDecision, deleteDecision } = useAppData();
  const toast = useToast();
  const decisions = data.decisions.filter((d) => d.meetingId === meeting.id);
  const agenda = data.agendaItems.filter((a) => a.meetingId === meeting.id);
  const [form, setForm] = useState<Decision | "new" | null>(null);
  const [confirmDel, setConfirmDel] = useState<Decision | null>(null);

  const editing = form === "new" ? null : form;
  const [f, setF] = useState({ title: "", description: "", agendaItemId: "", approvedBy: "", decisionDate: todayISO(), status: "proposed" as Decision["status"] });
  useEffect(() => {
    if (form === "new") setF({ title: "", description: "", agendaItemId: "", approvedBy: "", decisionDate: todayISO(), status: "proposed" });
    else if (form) setF({ title: form.title, description: form.description, agendaItemId: form.agendaItemId ?? "", approvedBy: form.approvedBy ?? "", decisionDate: form.decisionDate, status: form.status });
  }, [form]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Panel title="Decision Log" code={`${decisions.length} ENTRIES`} pad={false}
        actions={<Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setForm("new")}>Record Decision</Button>}>
        {decisions.length === 0 && <Empty icon={<CheckCircle2 size={18} />} title="No decisions recorded" hint="Record what was agreed so the minutes stay truthful." />}
        {decisions.map((d, i) => (
          <div key={d.id} className="row-line" style={{ alignItems: "flex-start" }}>
            <span className="mono" style={{ color: "var(--accent)", paddingTop: 2 }}>D-{String(i + 1).padStart(2, "0")}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="small" style={{ fontWeight: 600, color: "var(--text)" }}>{d.title}</div>
              {d.description && <div className="small dim" style={{ marginTop: 2 }}>{d.description}</div>}
              <div className="mono" style={{ fontSize: 9.5, color: "var(--text-3)", marginTop: 4 }}>
                APPROVED BY {personName(data.personnel.find((p) => p.id === d.approvedBy)).toUpperCase()} · {formatDate(d.decisionDate, data.settings.dateFormat)}
                {d.agendaItemId && agenda.find((a) => a.id === d.agendaItemId) && <> · AGENDA: {agenda.find((a) => a.id === d.agendaItemId)!.title.toUpperCase()}</>}
              </div>
            </div>
            <Badge tone={DECISION_STATUS[d.status].tone}>{DECISION_STATUS[d.status].label}</Badge>
            <button className="editor-tool" onClick={() => setForm(d)} aria-label={`Edit ${d.title}`}><Pencil size={13} /></button>
            <button className="editor-tool" style={{ color: "var(--crit)" }} onClick={() => setConfirmDel(d)} aria-label={`Delete ${d.title}`}><Trash2 size={13} /></button>
          </div>
        ))}
      </Panel>

      <Modal open={!!form} onClose={() => setForm(null)} title={editing ? "Edit Decision" : "Record Decision"} code="DECISION LOG" width={560}
        footer={<>
          <Button onClick={() => setForm(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => {
            if (!f.title.trim()) { toast.error("Decision title is required."); return; }
            const payload = { meetingId: meeting.id, title: f.title.trim(), description: f.description.trim(), agendaItemId: f.agendaItemId || null, approvedBy: f.approvedBy || null, decisionDate: f.decisionDate, status: f.status };
            if (editing) { updateDecision(editing.id, payload); toast.success("Decision updated."); }
            else { createDecision(payload); toast.success("Decision recorded."); }
            setForm(null);
          }}>{editing ? "Save Changes" : "Record"}</Button>
        </>}>
        <div style={{ display: "grid", gap: 14 }}>
          <Field label="Decision title" required><input className="input" autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Explanation"><textarea className="textarea" style={{ minHeight: 60 }} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Rationale, constraints, context…" /></Field>
          <div className="form-2">
            <Field label="Related agenda item">
              <select className="select" value={f.agendaItemId} onChange={(e) => setF({ ...f, agendaItemId: e.target.value })}>
                <option value="">— None —</option>
                {agenda.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
              </select>
            </Field>
            <Field label="Approved by">
              <select className="select" value={f.approvedBy} onChange={(e) => setF({ ...f, approvedBy: e.target.value })}>
                <option value="">— Not applicable —</option>
                {data.personnel.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
              </select>
            </Field>
            <Field label="Decision date"><input type="date" className="input input-mono" value={f.decisionDate} onChange={(e) => setF({ ...f, decisionDate: e.target.value })} /></Field>
            <Field label="Status">
              <select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Decision["status"] })}>
                <option value="proposed">Proposed</option><option value="approved">Approved</option>
                <option value="rejected">Rejected</option><option value="deferred">Deferred</option>
              </select>
            </Field>
          </div>
        </div>
      </Modal>

      <ConfirmDialog open={!!confirmDel} onCancel={() => setConfirmDel(null)} title="Delete Decision"
        message={<>Delete decision <b style={{ color: "var(--text)" }}>“{confirmDel?.title}”</b>? A recovery copy of the current records is written first.</>} confirmLabel="Delete"
        onConfirm={() => {
          const target = confirmDel;
          setConfirmDel(null);
          if (!target) return;
          void deleteDecision(target.id).then((res) => {
            if (res.ok) toast.success("Decision deleted. A recovery copy was preserved.");
            else toast.error(res.error ?? "The decision could not be deleted.");
          });
        }} />
    </div>
  );
}

// ═══ ACTION ITEMS ═══════════════════════════════════════════
export function ActionsPanel({ meeting }: { meeting: Meeting }) {
  const { data, setActionStatus, deleteActionItem, updateActionItem } = useAppData();
  const toast = useToast();
  const ui = useUi();
  const tasks = data.actionItems.filter((t) => t.meetingId === meeting.id);
  const [editId, setEditId] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Panel title="Action Items" code={`${tasks.length} ENTRIES`} pad={false}
        actions={<Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => ui.openTaskForm(meeting.id)}>Add Action Item</Button>}>
        {tasks.length === 0 && <Empty icon={<CheckCircle2 size={18} />} title="No action items" hint="Capture responsibilities as they are assigned during the meeting." />}
        {tasks.map((t) => {
          const odd = isTaskOverdue(t);
          return (
            <div key={t.id} className="row-line">
              <input type="checkbox" className="checkbox" checked={t.status === "completed"} aria-label={`Toggle ${t.title}`}
                onChange={(e) => setActionStatus(t.id, e.target.checked ? "completed" : "pending")} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="small" style={{ fontWeight: 600, color: t.status === "completed" ? "var(--text-3)" : "var(--text)", textDecoration: t.status === "completed" ? "line-through" : "none" }}>{t.title}</div>
                <div className="mono" style={{ fontSize: 9.5, color: "var(--text-3)", marginTop: 2 }}>
                  {personName(data.personnel.find((p) => p.id === t.assigneeId)).toUpperCase()} · DUE {formatDate(t.dueDate, data.settings.dateFormat)}
                  {odd && <span style={{ color: "var(--crit)" }}> · OVERDUE</span>}
                </div>
              </div>
              {sel(t.priority, (v) => updateActionItem(t.id, { priority: v as never }), [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["critical", "Critical"]], `Priority of ${t.title}`)}
              {sel(t.status, (v) => setActionStatus(t.id, v as never), [["pending", "Pending"], ["in-progress", "In Progress"], ["completed", "Completed"]], `Status of ${t.title}`)}
              <button className="editor-tool" onClick={() => setEditId(t.id)} aria-label={`Edit ${t.title}`}><Pencil size={13} /></button>
              <button className="editor-tool" style={{ color: "var(--crit)" }} onClick={() => setConfirmDel(t.id)} aria-label={`Delete ${t.title}`}><Trash2 size={13} /></button>
            </div>
          );
        })}
      </Panel>

      <ActionItemFormModal open={!!editId} taskId={editId} onClose={() => setEditId(null)} defaultMeetingId={meeting.id} />
      <ConfirmDialog open={!!confirmDel} onCancel={() => setConfirmDel(null)} title="Delete Action Item"
        message="Delete this action item? A recovery copy of the current records is written first; this cannot be undone in the interface." confirmLabel="Delete"
        onConfirm={() => {
          const target = confirmDel;
          setConfirmDel(null);
          if (!target) return;
          void deleteActionItem(target).then((res) => {
            if (res.ok) toast.success("Action item deleted. A recovery copy was preserved.");
            else toast.error(res.error ?? "The action item could not be deleted.");
          });
        }} />
    </div>
  );
}

// ═══ MINUTES ════════════════════════════════════════════════
export function MinutesPanel({ meeting }: { meeting: Meeting }) {
  const { data, updateMeeting, saveState } = useAppData();
  const toast = useToast();
  const agenda = data.agendaItems.filter((a) => a.meetingId === meeting.id).sort((x, y) => x.sortOrder - y.sortOrder);
  const note = data.notes.find((n) => n.meetingId === meeting.id);
  const decisions = data.decisions.filter((d) => d.meetingId === meeting.id);
  const actions = data.actionItems.filter((t) => t.meetingId === meeting.id);
  const generated = useMemo(
    () => buildMinutesMarkdown(meeting, agenda, note, decisions, actions, data.personnel, data.settings),
    [meeting, agenda, note, decisions, actions, data.personnel, data.settings]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const effective = meeting.minuteOverride ?? generated;
  const fileBase = `RHODES-minutes-${meeting.date}-${meeting.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Panel title="Minutes Generator" code="DETERMINISTIC · LOCAL" pad={false}
        actions={<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <SaveIndicator state={saveState} />
          <Button size="sm" icon={editing ? <X size={13} /> : <Pencil size={13} />} onClick={() => { setDraft(effective); setEditing(!editing); }}>
            {editing ? "Close Editor" : "Manual Corrections"}
          </Button>
          <Button size="sm" icon={<Copy size={13} />} onClick={() => { navigator.clipboard.writeText(effective).then(() => toast.success("Minutes copied to clipboard.")).catch(() => toast.error("Clipboard unavailable.")); }}>Copy MD</Button>
          <Button size="sm" icon={<FileDown size={13} />} onClick={() => { downloadFile(`${fileBase}.md`, effective, "text/markdown"); toast.success("Markdown exported."); }}>Export MD</Button>
          <Button size="sm" icon={<Printer size={13} />} onClick={() => printHtml(minutesPrintHtml(effective, `Meeting Minutes — ${meeting.title}`))}>Print</Button>
        </div>}>
        <div className="panel-body form-2" style={{ gap: 16, borderBottom: "1px solid var(--border-soft)" }}>
          <Field label="Closing notes" hint="Included verbatim in the minutes.">
            <textarea className="textarea" style={{ minHeight: 74 }} value={meeting.closingNotes}
              onChange={(e) => updateMeeting(meeting.id, { closingNotes: e.target.value })} placeholder="Summarize the outcome…" />
          </Field>
          <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <Field label="Next meeting date" hint="Shown in the closing section.">
              <input type="date" className="input input-mono" value={meeting.nextMeetingDate}
                onChange={(e) => updateMeeting(meeting.id, { nextMeetingDate: e.target.value })} />
            </Field>
            {meeting.minuteOverride != null && (
              <Button size="sm" icon={<RotateCcw size={13} />} onClick={() => { updateMeeting(meeting.id, { minuteOverride: null }); toast.success("Minutes regenerated from current data."); }}>
                Regenerate from data (discard edits)
              </Button>
            )}
          </div>
        </div>
        {editing ? (
          <div style={{ padding: 16 }}>
            <div className="mono-label" style={{ marginBottom: 8 }}>Manual corrections — markdown source{meeting.minuteOverride != null ? " (edited copy active)" : ""}</div>
            <textarea className="textarea" style={{ minHeight: 460, fontFamily: "var(--font-mono)", fontSize: "var(--fs-small)", lineHeight: 1.7 }}
              value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Minutes markdown editor" />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
              <Button size="sm" onClick={() => setEditing(false)}>Discard</Button>
              <Button size="sm" variant="primary" onClick={() => { updateMeeting(meeting.id, { minuteOverride: draft }); toast.success("Manual corrections saved."); setEditing(false); }}>Save Corrections</Button>
            </div>
          </div>
        ) : (
          <div style={{ padding: 20 }}>
            <div className="minutes-doc">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <h1>{meeting.title}</h1>
                  <div className="mono-label" style={{ marginTop: 4 }}>MEETING MINUTES · RECORD {meeting.id.toUpperCase()}</div>
                </div>
                <Badge tone={MEETING_STATUS[meeting.status].tone}>{MEETING_STATUS[meeting.status].label}</Badge>
              </div>
              {meeting.minuteOverride != null && (
                <div className="small" style={{ color: "var(--warn)", marginTop: 8, fontFamily: "var(--font-mono)", letterSpacing: "0.08em", display: "flex", alignItems: "center", gap: 7 }}>
                  <RotateCcw size={12} /> MANUAL CORRECTIONS ACTIVE — REGENERATE FROM DATA TO DISCARD
                </div>
              )}
              <MinutesBody md={effective} meeting={meeting} />
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

// Renders the minutes markdown as a structured local document
export function MinutesBody({ md, meeting }: { md: string; meeting?: Meeting }) {
  void meeting;
  const sections = md.split("\n## ");
  const head = sections[0].replace(/^#\s*/, "").split("\n");
  return (
    <div style={{ marginTop: 14 }}>
      {sections.slice(1).map((sec, i) => {
        const [title, ...body] = sec.split("\n");
        return (
          <div key={i}>
            <h2>{title}</h2>
            <div style={{ fontSize: "var(--fs-small)", color: "var(--text-2)", lineHeight: 1.85 }}>
              {body.join("\n").split("\n").map((ln, j) => {
                if (!ln.trim()) return null;
                if (ln.startsWith("### ")) return <div key={j} style={{ fontWeight: 700, color: "var(--text)", marginTop: 8, fontSize: "var(--fs-body)" }}>{ln.slice(4)}</div>;
                const md2 = ln.replace(/\*\*(.+?)\*\*/g, "◂$1▸");
                const parts = md2.split(/◂|▸/);
                return (
                  <div key={j} style={{ paddingLeft: ln.startsWith("- ") || /^\d+\./.test(ln) ? 10 : 0 }}>
                    {parts.map((p, k) => (k % 2 === 1 ? <b key={k} style={{ color: "var(--text)" }}>{p}</b> : p.replace(/\*(.+?)\*/g, "$1")))}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="mono dim" style={{ marginTop: 18, fontSize: 9, letterSpacing: "0.16em" }}>{head.slice(1).join(" · ")}</div>
    </div>
  );
}

// ═══ ATTENDEES RAIL ═════════════════════════════════════════
export function AttendeesRail({ meeting }: { meeting: Meeting }) {
  const { data, addAttendee, removeAttendee, setAttendance } = useAppData();
  const [pick, setPick] = useState("");
  const candidates = data.personnel.filter((p) => !meeting.attendeeIds.includes(p.id));

  return (
    <Panel title="Attendees" code={`${meeting.attendeeIds.length} REGISTERED`} pad={false}>
      {meeting.attendeeIds.length === 0 && <div className="panel-body small dim">No participants registered for this meeting.</div>}
      {meeting.attendeeIds.map((id) => {
        const p = data.personnel.find((x) => x.id === id);
        if (!p) return null;
        return (
          <div key={id} className="row-line" style={{ padding: "8px 12px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="small" style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.fullName}</div>
              <div className="mono" style={{ fontSize: 9, color: "var(--text-3)" }}>{p.code}</div>
            </div>
            {sel(meeting.attendance[id] ?? "invited", (v) => setAttendance(meeting.id, id, v as AttendanceStatus),
              [["invited", "Invited"], ["present", "Present"], ["absent", "Absent"], ["excused", "Excused"]],
              `Attendance of ${p.fullName}`)}
            <button className="editor-tool" onClick={() => removeAttendee(meeting.id, id)} aria-label={`Remove ${p.fullName}`} title="Remove attendee"><X size={12} /></button>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 6, padding: 10, borderTop: "1px solid var(--border-soft)", background: "var(--surface-2)" }}>
        <select className="select" style={{ flex: 1, height: 30, fontSize: "var(--fs-small)" }} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add attendee from registry">
          <option value="">+ Add from registry…</option>
          {candidates.map((p) => <option key={p.id} value={p.id}>{p.fullName} · {p.code}</option>)}
        </select>
        <Button size="sm" disabled={!pick} onClick={() => { if (pick) { addAttendee(meeting.id, pick); setPick(""); } }}>Add</Button>
      </div>
    </Panel>
  );
}

// ═══ QUICK CAPTURE ══════════════════════════════════════════
export function QuickCaptureRail({ meeting }: { meeting: Meeting }) {
  const { saveNote, createDecision, createActionItem, data } = useAppData();
  const toast = useToast();
  const [kind, setKind] = useState<"note" | "decision" | "action">("note");
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const v = text.trim();
    if (!v) return;
    let accepted: boolean;
    if (kind === "note") {
      const note = data.notes.find((n) => n.meetingId === meeting.id);
      const d = new Date();
      const ts = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      accepted = saveNote(meeting.id, `${note?.content ?? ""}<p><span class="ts">[${ts}]</span> ${v.replace(/</g, "&lt;")}</p>`);
      if (accepted) toast.success("Note appended to discussion log.");
    } else if (kind === "decision") {
      accepted = createDecision({ meetingId: meeting.id, title: v, description: "", agendaItemId: null, approvedBy: null, decisionDate: todayISO(), status: "proposed" });
      if (accepted) toast.success("Decision captured as PROPOSED.");
    } else {
      accepted = createActionItem({ meetingId: meeting.id, title: v, description: "", agendaItemId: null, assigneeId: null, dueDate: todayISO(), priority: "medium", status: "pending" });
      if (accepted) toast.success("Action item captured — refine assignee and deadline.");
    }
    if (!accepted) {
      // Refused by the recovery write lock: keep the text so it can be retried
      // instead of clearing the box and losing it.
      toast.error("Not saved — the records are locked while a recovery copy is taken. Your text is still here; log it again in a moment.");
      return;
    }
    setText("");
    inputRef.current?.focus();
  };

  return (
    <Panel title="Quick Capture" code="NO NAVIGATION" pad={false}>
      <div className="panel-body" style={{ display: "grid", gap: 10 }}>
        <div className="seg" role="group" aria-label="Capture mode" style={{ width: "100%" }}>
          {([["note", "Note"], ["decision", "Decision"], ["action", "Action"]] as const).map(([k, lab]) => (
            <button key={k} className={kind === k ? "on" : ""} style={{ flex: 1 }} onClick={() => setKind(k)}>{lab}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input ref={inputRef} className="input" style={{ height: 32, flex: 1 }}
            placeholder={kind === "note" ? "Jot a note into the log…" : kind === "decision" ? "Capture a decision…" : "Capture an action item…"}
            value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          <Button size="sm" variant="primary" style={{ height: 32 }} onClick={submit}>Log</Button>
        </div>
        <span className="mono" style={{ fontSize: 8.5, letterSpacing: "0.14em", color: "var(--text-3)" }}>
          TIMESTAMPED APPEND · DECISIONS OPEN AS PROPOSED
        </span>
      </div>
    </Panel>
  );
}
