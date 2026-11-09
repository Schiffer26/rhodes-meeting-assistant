// ─────────────────────────────────────────────────────────────
// RHODES · SCREEN 4 — PERSONNEL REGISTRY
// Archive-file presentation: structured IDs, department tags,
// meeting history and assigned action items per person.
// ─────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useState } from "react";
import { Mail, Pencil, Phone, Plus, Search, Trash2, UserRound, X } from "lucide-react";
import { Badge, Button, ConfirmDialog, Empty, Field, Modal, PageHeader, Panel, Reveal } from "@/components/ui";
import { useAppData } from "@/hooks/store";
import { useToast } from "@/components/toast";
import { PageBackdrop } from "@/components/PageBackdrop";
import type { Route } from "@/layout/AppShell";
import { Person } from "@/types";
import { DECISION_STATUS, MEETING_STATUS, PRIORITY, TASK_STATUS, formatDate, isTaskOverdue } from "@/utils/helpers";

export function PersonnelRegistry({ navigate }: { navigate: (r: Route) => void }) {
  const { data, createPerson, updatePerson, deletePerson } = useAppData();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [form, setForm] = useState<Person | "new" | null>(null);
  const [detail, setDetail] = useState<Person | null>(null);
  const [confirmDel, setConfirmDel] = useState<Person | null>(null);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return data.personnel
      .filter((p) => !n || [p.fullName, p.role, p.department, p.code, p.email].some((s) => s.toLowerCase().includes(n)))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [data.personnel, q]);

  const editing = form === "new" ? null : form;
  const [f, setF] = useState({ fullName: "", role: "", department: "", email: "", phone: "", notes: "" });
  const [err, setErr] = useState("");
  useEffect(() => {
    setErr("");
    if (form === "new") setF({ fullName: "", role: "", department: "", email: "", phone: "", notes: "" });
    else if (form) setF({ fullName: form.fullName, role: form.role, department: form.department, email: form.email, phone: form.phone, notes: form.notes });
  }, [form]);

  return (
    <div className="page-canvas">
      <PageBackdrop screen="personnel" />
      <div className="page-stack">
            <Reveal>
        <PageHeader
          eyebrow={`// PERSONNEL ARCHIVE · ${data.personnel.length} REGISTERED`}
          title="Personnel Registry"
          actions={<Button variant="primary" size="lg" style={{ height: 48, padding: "0 32px", fontSize: 14 }} icon={<Plus size={16} />} onClick={() => setForm("new")}>Register Person</Button>}
        />
      </Reveal>

      <Reveal delay={0.06}>
        <Panel pad={false}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px" }}>
            <Search size={14} style={{ color: "var(--text-3)" }} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, role, department, or ID…"
              aria-label="Search personnel"
              style={{ flex: 1, height: 30, background: "transparent", border: "none", outline: "none", color: "var(--text)", fontSize: "var(--fs-body)" }} />
            <span className="mono dim">{filtered.length} / {data.personnel.length}</span>
          </div>
        </Panel>
      </Reveal>

      <Reveal delay={0.1}>
        <Panel title="Registry Files" code={`${filtered.length} FILES`} pad={false} className="clip-corner-bottom">
          {filtered.length === 0 && (
            <Empty icon={<UserRound size={18} />} title="No personnel files found"
              hint={q ? "No registry file matches this query." : "Register the first person to begin."}
              action={<Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setForm("new")}>Register Person</Button>} />
          )}
          <table className="tbl">
            <thead>
              <tr><th style={{ width: 90 }}>ID</th><th>Full Name</th><th>Position / Role</th><th>Department</th><th>Contact</th><th style={{ width: 120 }}>Ops</th></tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const meetingCount = data.meetings.filter((m) => m.attendeeIds.includes(p.id) || m.organizerId === p.id).length;
                const taskCount = data.actionItems.filter((t) => t.assigneeId === p.id && t.status !== "completed").length;
                return (
                  <tr key={p.id} className="person-row">
                    <td className="mono" style={{ color: "var(--accent)", letterSpacing: "0.1em" }}>{p.code}</td>
                    <td>
                      <button type="button" className="row-open" onClick={() => setDetail(p)}
                        aria-label={`Open personnel file for ${p.fullName}`}>
                        <span className="small row-open-title" style={{ fontWeight: 600, color: "var(--text)", display: "block" }}>{p.fullName}</span>
                        <span className="mono dim" style={{ fontSize: 9, display: "block" }}>{meetingCount} MEETINGS · {taskCount} OPEN TASKS</span>
                      </button>
                    </td>
                    <td className="small dim-2">{p.role || "—"}</td>
                    <td><Badge tone="gray" dot={false}>{p.department || "UNASSIGNED"}</Badge></td>
                    <td className="small dim">{p.email || p.phone || "—"}</td>
                    <td>
                      <div style={{ display: "flex", gap: 2 }}>
                        <button className="editor-tool" onClick={() => setForm(p)} title="Edit file" aria-label={`Edit ${p.fullName}`}><Pencil size={13} /></button>
                        <button className="editor-tool" style={{ color: "var(--crit)" }} onClick={() => setConfirmDel(p)} title="Delete file" aria-label={`Delete ${p.fullName}`}><Trash2 size={13} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      </Reveal>

      {/* ── Personnel file detail ─────────────── */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.fullName ?? ""} code={detail ? `PERSONNEL FILE · ${detail.code}` : ""} width={640}
        footer={<>
          <Button onClick={() => setDetail(null)}>Close</Button>
          <Button variant="primary" onClick={() => { setForm(detail); }}>Edit File</Button>
        </>}>
        {detail && <PersonFile person={detail} navigate={(r) => { setDetail(null); navigate(r); }} />}
      </Modal>

      {/* ── Create/edit form ──────────────────── */}
      <Modal open={!!form} onClose={() => setForm(null)} title={editing ? "Edit Personnel File" : "Register Person"} code={editing?.code ?? "NEW FILE"} width={560}
        footer={<>
          <Button onClick={() => setForm(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => {
            if (!f.fullName.trim()) { setErr("Full name is required."); return; }
            if (editing) { updatePerson(editing.id, { ...f, fullName: f.fullName.trim() }); toast.success(`${f.fullName} updated.`); }
            else { const p = createPerson({ ...f, fullName: f.fullName.trim() }); toast.success(`Registered ${p.fullName} as ${p.code}.`); }
            setForm(null);
          }}>{editing ? "Save Changes" : "Register"}</Button>
        </>}>
        <div style={{ display: "grid", gap: 14 }}>
          <Field label="Full name" required error={err}>
            <input className="input" autoFocus value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
          </Field>
          <div className="form-2">
            <Field label="Position / role"><input className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} /></Field>
            <Field label="Department"><input className="input" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
            <Field label="Email (optional)"><input className="input input-mono" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="name@rhodes.local" /></Field>
            <Field label="Phone (optional)"><input className="input input-mono" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          </div>
          <Field label="Additional notes"><textarea className="textarea" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </div>
      </Modal>

      <ConfirmDialog open={!!confirmDel} onCancel={() => setConfirmDel(null)} title="Delete Personnel File"
        message={<>Delete <b style={{ color: "var(--text)" }}>{confirmDel?.fullName} ({confirmDel?.code})</b>? They will be removed from meeting attendee lists; their action items become unassigned. This cannot be undone.</>}
        confirmLabel="Delete File"
        onConfirm={() => { if (confirmDel) { deletePerson(confirmDel.id); toast.success("Personnel file deleted."); } setConfirmDel(null); }} />
      </div>
    </div>
  );
}

function PersonFile({ person, navigate }: { person: Person; navigate: (r: Route) => void }) {
  const { data } = useAppData();
  const s = data.settings;
  const history = data.meetings
    .filter((m) => m.attendeeIds.includes(person.id) || m.organizerId === person.id)
    .sort((a, b) => b.date.localeCompare(a.date));
  const tasks = data.actionItems.filter((t) => t.assigneeId === person.id);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="grid-lines" style={{ position: "relative", border: "1px solid var(--border)", padding: 16, background: "var(--bg)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, position: "relative" }}>
          <div>
            <div className="mono-label-bright">{person.code}</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 700, textTransform: "uppercase", marginTop: 4 }}>{person.fullName}</div>
            <div className="small dim-2" style={{ marginTop: 2 }}>{person.role || "—"} · {person.department || "—"}</div>
          </div>
          <div className="hazard" style={{ width: 44, height: 8, flexShrink: 0 }} />
        </div>
        <div className="mono" style={{ display: "flex", gap: 18, marginTop: 12, fontSize: 9.5, color: "var(--text-3)", letterSpacing: "0.06em", flexWrap: "wrap", position: "relative" }}>
          <span><Mail size={10} style={{ verticalAlign: -1 }} /> {person.email || "NO EMAIL ON FILE"}</span>
          <span><Phone size={10} style={{ verticalAlign: -1 }} /> {person.phone || "NO PHONE ON FILE"}</span>
        </div>
        {person.notes && <p className="small dim-2" style={{ marginTop: 10, position: "relative" }}>{person.notes}</p>}
      </div>

      <div>
        <div className="mono-label" style={{ marginBottom: 6 }}>Meeting History · {history.length}</div>
        <div style={{ border: "1px solid var(--border)" }}>
          {history.length === 0 && <div className="small dim" style={{ padding: 12 }}>No meeting records reference this person.</div>}
          {history.slice(0, 6).map((m) => (
            <button key={m.id} className="row-line row-click" style={{ width: "100%", background: "none", border: "none", borderBottom: "1px solid var(--border-soft)", textAlign: "left", cursor: "pointer", padding: "8px 12px" }}
              onClick={() => navigate({ section: "meetings", meetingId: m.id })}>
              <span className="small" style={{ flex: 1, color: "var(--text-2)" }}>{m.title}</span>
              <span className="mono dim" style={{ fontSize: 9.5 }}>{formatDate(m.date, s.dateFormat)} · {m.organizerId === person.id ? "ORGANIZER" : (m.attendance[person.id] ?? "INVITED").toUpperCase()}</span>
              <Badge tone={MEETING_STATUS[m.status].tone} dot={false}>{MEETING_STATUS[m.status].label}</Badge>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mono-label" style={{ marginBottom: 6 }}>Assigned Action Items · {tasks.length}</div>
        <div style={{ border: "1px solid var(--border)" }}>
          {tasks.length === 0 && <div className="small dim" style={{ padding: 12 }}>No action items assigned.</div>}
          {tasks.slice(0, 6).map((t) => (
            <div key={t.id} className="row-line" style={{ padding: "8px 12px" }}>
              <span className="small" style={{ flex: 1, color: t.status === "completed" ? "var(--text-3)" : "var(--text-2)", textDecoration: t.status === "completed" ? "line-through" : "none" }}>{t.title}</span>
              {isTaskOverdue(t) && <span className="mono" style={{ color: "var(--crit)", fontSize: 9 }}>OVERDUE</span>}
              <span className="mono dim" style={{ fontSize: 9.5 }}>DUE {formatDate(t.dueDate, s.dateFormat)}</span>
              <Badge tone={PRIORITY[t.priority].tone} dot={false}>{PRIORITY[t.priority].label}</Badge>
              <Badge tone={TASK_STATUS[t.status].tone} dot={false}>{TASK_STATUS[t.status].label}</Badge>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
