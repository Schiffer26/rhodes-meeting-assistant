// ─────────────────────────────────────────────────────────────
// RHODES · meeting creation / edit form (shared modal)
// ─────────────────────────────────────────────────────────────
import React, { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button, Field, Modal } from "@/components/ui";
import { useAppData } from "@/hooks/store";
import { useToast } from "@/components/toast";
import { MEETING_TEMPLATES, todayISO } from "@/utils/helpers";
import { useUi } from "@/hooks/ui";

export function MeetingFormModal({ meetingId, open, onClose, onCreated }: {
  meetingId?: string | null; open: boolean; onClose: () => void; onCreated?: (id: string) => void;
}) {
  const { data, createMeeting, updateMeeting, createPerson } = useAppData();
  const toast = useToast();
  const editing = meetingId ? data.meetings.find((m) => m.id === meetingId) ?? null : null;

  const [template, setTemplate] = useState("tpl_general");
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [date, setDate] = useState(todayISO());
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [location, setLocation] = useState("");
  const [organizerId, setOrganizerId] = useState<string | null>(null);
  const [attendeeIds, setAttendeeIds] = useState<string[]>([]);
  const [agenda, setAgenda] = useState<{ title: string; minutes: number }[]>([]);
  const [newPersonName, setNewPersonName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (editing) {
      setTitle(editing.title); setPurpose(editing.purpose); setDate(editing.date);
      setStartTime(editing.startTime); setEndTime(editing.endTime); setLocation(editing.location);
      setOrganizerId(editing.organizerId); setAttendeeIds(editing.attendeeIds);
      setAgenda([]); setTemplate("custom");
    } else {
      setTitle(""); setPurpose(""); setDate(todayISO());
      setStartTime("09:00"); setEndTime("10:00"); setLocation("");
      setOrganizerId(null); setAttendeeIds([]); setNewPersonName("");
      applyTemplate("tpl_general");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, meetingId]);

  const applyTemplate = (tplId: string) => {
    setTemplate(tplId);
    const tpl = MEETING_TEMPLATES.find((t) => t.id === tplId);
    if (tpl) {
      setPurpose((p) => p || tpl.purpose);
      setAgenda(tpl.agenda.map((a) => ({ ...a })));
    }
  };

  const submit = () => {
    const e: Record<string, string> = {};
    if (!title.trim()) e.title = "A meeting title is required.";
    if (!date) e.date = "A meeting date is required.";
    if (endTime && startTime && endTime <= startTime) e.endTime = "End time must be after the start time.";
    setErrors(e);
    if (Object.keys(e).length) { toast.error("Check the highlighted fields."); return; }

    if (editing) {
      updateMeeting(editing.id, {
        title: title.trim(), purpose: purpose.trim(), date, startTime, endTime,
        location: location.trim(), organizerId,
        attendeeIds,
      });
      toast.success(`Meeting “${title.trim()}” updated.`);
      onClose();
    } else {
      const m = createMeeting({
        title, purpose, date, startTime, endTime, location,
        organizerId, attendeeIds, agendaDraft: agenda,
      });
      toast.success(`Meeting “${m.title}” registered.`);
      onClose();
      onCreated?.(m.id);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={680}
      title={editing ? "Edit Meeting" : "New Meeting"}
      code={editing ? `RECORD ${editing.id.toUpperCase()}` : "RECORD CREATION"}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} icon={<Plus size={14} />}>
          {editing ? "Save Changes" : "Create Meeting"}
        </Button>
      </>}>
      <div style={{ display: "grid", gap: 16 }}>
        {!editing && (
          <Field label="Template" hint="Templates seed a starter agenda — everything remains editable.">
            <select className="select" value={template} onChange={(e) => applyTemplate(e.target.value)}>
              {MEETING_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              <option value="custom">Custom (blank)</option>
            </select>
          </Field>
        )}
        <Field label="Meeting title" required error={errors.title}>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Monthly Operations Review" autoFocus />
        </Field>
        <Field label="Purpose">
          <textarea className="textarea" style={{ minHeight: 64 }} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="What should this meeting achieve?" />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="Date" required error={errors.date}>
            <input className="input input-mono" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Start time">
            <input className="input input-mono" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </Field>
          <Field label="End time" error={errors.endTime}>
            <input className="input input-mono" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Location">
            <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Command Deck — Room C-2" />
          </Field>
          <Field label="Organizer">
            <select className="select" value={organizerId ?? ""} onChange={(e) => setOrganizerId(e.target.value || null)}>
              <option value="">— Select personnel —</option>
              {data.personnel.map((p) => <option key={p.id} value={p.id}>{p.fullName} · {p.code}</option>)}
            </select>
          </Field>
        </div>

        <Field label={`Attendees (${attendeeIds.length})`}>
          <div style={{ border: "1px solid var(--border)", background: "var(--bg)", maxHeight: 150, overflowY: "auto" }}>
            {data.personnel.map((p) => (
              <label key={p.id} className="row-line" style={{ cursor: "pointer", padding: "7px 12px" }}>
                <input type="checkbox" className="checkbox"
                  checked={attendeeIds.includes(p.id)}
                  onChange={(e) => setAttendeeIds((ids) => e.target.checked ? [...ids, p.id] : ids.filter((i) => i !== p.id))} />
                <span className="small" style={{ flex: 1 }}>{p.fullName}</span>
                <span className="mono dim">{p.code} · {p.department}</span>
              </label>
            ))}
            {!data.personnel.length && <div className="small dim" style={{ padding: 12 }}>Personnel registry is empty.</div>}
          </div>
        </Field>
        {!editing && (
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" style={{ flex: 1 }} value={newPersonName} onChange={(e) => setNewPersonName(e.target.value)}
              placeholder="Quick-add a new person to the registry…" />
            <Button size="sm" style={{ height: 36 }} onClick={() => {
              if (!newPersonName.trim()) return;
              const p = createPerson({ fullName: newPersonName.trim(), role: "", department: "", email: "", phone: "", notes: "Added during meeting creation." });
              setAttendeeIds((ids) => [...ids, p.id]);
              setNewPersonName("");
              toast.success(`${p.fullName} added to the registry (${p.code}).`);
            }}>Register</Button>
          </div>
        )}

        {!editing && (
          <Field label={`Agenda (${agenda.length} items)`} hint="Starter entries — refine them in the meeting workspace.">
            <div style={{ display: "grid", gap: 6 }}>
              {agenda.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="mono dim" style={{ width: 26, flexShrink: 0 }}>{String(i + 1).padStart(2, "0")}</span>
                  <input className="input" style={{ flex: 1 }} value={a.title}
                    onChange={(e) => setAgenda((xs) => xs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} placeholder="Agenda topic" />
                  <input className="input input-mono" type="number" min={1} style={{ width: 86 }}
                    value={a.minutes} title="Estimated minutes"
                    onChange={(e) => setAgenda((xs) => xs.map((x, j) => (j === i ? { ...x, minutes: parseInt(e.target.value) || 0 } : x)))} />
                  <button className="editor-tool" onClick={() => setAgenda((xs) => xs.filter((_, j) => j !== i))} aria-label="Remove agenda line"><Trash2 size={13} /></button>
                </div>
              ))}
              <button className="linklike mono" style={{ fontSize: 10.5, letterSpacing: "0.12em", textTransform: "uppercase", alignSelf: "flex-start", marginTop: 4 }}
                onClick={() => setAgenda((xs) => [...xs, { title: "", minutes: 10 }])}>
                + Add agenda line
              </button>
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}

// Host component wired through the UI context — mounted once in App.
export function MeetingFormHost({ state, close, onCreated }: {
  state: { open: boolean; meetingId: string | null }; close: () => void; onCreated?: (id: string) => void;
}) {
  const ui = useUi();
  void ui;
  return <MeetingFormModal open={state.open} meetingId={state.meetingId} onClose={close} onCreated={onCreated} />;
}
