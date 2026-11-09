// ─────────────────────────────────────────────────────────────
// RHODES · action item create/edit form (shared modal)
// ─────────────────────────────────────────────────────────────
import React, { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button, Field, Modal } from "@/components/ui";
import { useAppData } from "@/hooks/store";
import { useToast } from "@/components/toast";
import { Priority, TaskStatus } from "@/types";
import { todayISO } from "@/utils/helpers";

export function ActionItemFormModal({ taskId, open, onClose, defaultMeetingId }: {
  taskId?: string | null; open: boolean; onClose: () => void; defaultMeetingId?: string | null;
}) {
  const { data, createActionItem, updateActionItem } = useAppData();
  const toast = useToast();
  const editing = taskId ? data.actionItems.find((t) => t.id === taskId) ?? null : null;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [meetingId, setMeetingId] = useState<string>(defaultMeetingId ?? "");
  const [agendaItemId, setAgendaItemId] = useState<string>("");
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [dueDate, setDueDate] = useState(todayISO());
  const [priority, setPriority] = useState<Priority>("medium");
  const [status, setStatus] = useState<TaskStatus>("pending");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setErr("");
    if (editing) {
      setTitle(editing.title); setDescription(editing.description);
      setMeetingId(editing.meetingId); setAgendaItemId(editing.agendaItemId ?? "");
      setAssigneeId(editing.assigneeId ?? ""); setDueDate(editing.dueDate);
      setPriority(editing.priority); setStatus(editing.status);
    } else {
      setTitle(""); setDescription("");
      setMeetingId(defaultMeetingId ?? data.meetings[0]?.id ?? "");
      setAgendaItemId(""); setAssigneeId(""); setDueDate(todayISO());
      setPriority("medium"); setStatus("pending");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId, defaultMeetingId]);

  const agendaOptions = data.agendaItems.filter((a) => a.meetingId === meetingId);

  const submit = () => {
    if (!title.trim()) { setErr("A task title is required."); return; }
    if (!meetingId) { setErr("Select the originating meeting."); return; }
    const payload = {
      meetingId, agendaItemId: agendaItemId || null, title: title.trim(), description: description.trim(),
      assigneeId: assigneeId || null, dueDate, priority, status,
    };
    if (editing) { updateActionItem(editing.id, payload); toast.success("Action item updated."); }
    else { createActionItem(payload); toast.success("Action item registered."); }
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Edit Action Item" : "New Action Item"} code="TASK OPERATIONS" width={560}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} icon={<Plus size={14} />}>{editing ? "Save Changes" : "Register Task"}</Button>
      </>}>
      <div style={{ display: "grid", gap: 14 }}>
        <Field label="Task title" required error={err}>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="What must be done?" />
        </Field>
        <Field label="Description">
          <textarea className="textarea" style={{ minHeight: 60 }} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="form-2">
          <Field label="Originating meeting" required>
            <select className="select" value={meetingId} onChange={(e) => { setMeetingId(e.target.value); setAgendaItemId(""); }}>
              <option value="">— Select —</option>
              {data.meetings.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
            </select>
          </Field>
          <Field label="Related agenda item">
            <select className="select" value={agendaItemId} onChange={(e) => setAgendaItemId(e.target.value)}>
              <option value="">— None —</option>
              {agendaOptions.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
            </select>
          </Field>
          <Field label="Assigned to">
            <select className="select" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">— Unassigned —</option>
              {data.personnel.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
            </select>
          </Field>
          <Field label="Due date">
            <input type="date" className="input input-mono" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Priority">
            <select className="select" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              <option value="low">Low</option><option value="medium">Medium</option>
              <option value="high">High</option><option value="critical">Critical</option>
            </select>
          </Field>
          <Field label="Status">
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
              <option value="pending">Pending</option><option value="in-progress">In Progress</option><option value="completed">Completed</option>
            </select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}
