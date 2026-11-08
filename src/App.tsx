// ─────────────────────────────────────────────────────────────
// RHODES · application root
// Boot sequence → shell → section router.
// ─────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { StickyNote } from "lucide-react";
import { DataProvider, useAppData, useMotionScale } from "@/hooks/store";
import { UiContext } from "@/hooks/ui";
import { ToastProvider, useToast } from "@/components/toast";
import { AppShell, Route, SECTIONS } from "@/layout/AppShell";
import { CommandCenter } from "@/features/dashboard/CommandCenter";
import { MeetingOperations } from "@/features/meetings/MeetingOperations";
import { MeetingWorkspace } from "@/features/meetings/MeetingWorkspace";
import { MeetingFormModal } from "@/features/meetings/MeetingForm";
import { ActionItemFormModal } from "@/features/tasks/ActionItemForm";
import { PersonnelRegistry } from "@/features/personnel/PersonnelRegistry";
import { TaskOperations } from "@/features/tasks/TaskOperations";
import { RecordsArchive } from "@/features/archive/RecordsArchive";
import { SystemConfiguration } from "@/features/settings/SystemConfiguration";
import { Insignia } from "@/components/Insignia";
import { Button, Field, Modal } from "@/components/ui";
import { todayISO } from "@/utils/helpers";

// ── Boot sequence (~1.3s) ─────────────────────────────────────
function BootSequence({ done }: { done: () => void }) {
  const { scale } = useMotionScale();
  useEffect(() => {
    const t = window.setTimeout(done, 1350 * (scale || 1) + 150);
    return () => window.clearTimeout(t);
  }, [done, scale]);

  return (
    <motion.div className="boot-overlay" onClick={done} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}
      role="status" aria-label="RHODES initializing">
      {/* signal sweep */}
      <motion.div style={{ position: "absolute", top: "50%", left: 0, height: 1, background: "linear-gradient(90deg, transparent, #18d1ff, transparent)", width: "100%" }}
        initial={{ scaleX: 0, opacity: 0 }} animate={{ scaleX: 1, opacity: [0, 1, 0.4] }}
        transition={{ duration: 0.5 * (scale || 1) }} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
        <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 * (scale || 1), delay: 0.12 * (scale || 1), ease: "easeOut" }}>
          <Insignia size={64} />
        </motion.div>
        <motion.div
          initial={{ opacity: 0, letterSpacing: "0.6em" }} animate={{ opacity: 1, letterSpacing: "0.34em" }}
          transition={{ duration: 0.45 * (scale || 1), delay: 0.35 * (scale || 1) }}
          style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700, color: "#f0f0f0" }}>
          RHODES
        </motion.div>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 * (scale || 1), duration: 0.3 }}
          style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.3em", color: "#8d8d8d", textTransform: "uppercase" }}>
          Meeting Operations Terminal · Local Link Established
        </motion.div>
        <motion.div initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.6 * (scale || 1), delay: 0.65 * (scale || 1), ease: "linear" }}
          style={{ width: 220, height: 2, background: "#18d1ff", transformOrigin: "left" }} />
      </div>
    </motion.div>
  );
}

// ── Quick note modal (Ctrl+Shift+N) ───────────────────────────
function QuickNoteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, saveNote } = useAppData();
  const toast = useToast();
  const [meetingId, setMeetingId] = useState("");
  const [text, setText] = useState("");

  useEffect(() => {
    if (open) {
      setText("");
      const upcoming = data.meetings.filter((m) => m.status !== "cancelled").sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
      const next = upcoming.find((m) => m.date >= todayISO()) ?? upcoming[0];
      setMeetingId(next?.id ?? "");
    }
  }, [open, data.meetings]);

  return (
    <Modal open={open} onClose={onClose} title="Quick Note" code="CTRL+SHIFT+N" width={520}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={<StickyNote size={14} />} onClick={() => {
          if (!meetingId) { toast.error("Select a meeting record."); return; }
          if (!text.trim()) { toast.error("Write the note first."); return; }
          const note = data.notes.find((n) => n.meetingId === meetingId);
          const d = new Date();
          const ts = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          saveNote(meetingId, `${note?.content ?? ""}<p><span class="ts">[${ts}]</span> ${text.trim().replace(/</g, "&lt;")}</p>`);
          toast.success("Quick note appended to the record.");
          onClose();
        }}>Append to Record</Button>
      </>}>
      <div style={{ display: "grid", gap: 14 }}>
        <Field label="Target record" hint="The note lands in that meeting's discussion log with a timestamp.">
          <select className="select" value={meetingId} onChange={(e) => setMeetingId(e.target.value)}>
            {data.meetings.map((m) => <option key={m.id} value={m.id}>{m.date} — {m.title}</option>)}
          </select>
        </Field>
        <Field label="Note">
          <textarea className="textarea" autoFocus value={text} onChange={(e) => setText(e.target.value)}
            placeholder="Capture it now — refine it in the workspace later…" />
        </Field>
      </div>
    </Modal>
  );
}

// ── Theme / motion / typography attributes on <html> ──────────
function useDocumentFlags() {
  const { data } = useAppData();
  const s = data.settings;
  const [osDark, setOsDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = (e: MediaQueryListEvent) => setOsDark(e.matches);
    mq.addEventListener?.("change", h);
    return () => mq.removeEventListener?.("change", h);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    const resolved = s.theme === "terminal" ? "terminal" : s.theme === "archive" ? "archive" : osDark ? "terminal" : "archive";
    root.setAttribute("data-theme", resolved);
    root.setAttribute("data-font", s.fontSize);
    root.setAttribute("data-density", s.density);
    root.setAttribute("data-motion", s.motionPreference);
    root.style.colorScheme = resolved === "terminal" ? "dark" : "light";
  }, [s.theme, s.fontSize, s.density, s.motionPreference, osDark]);
}

// ── Application core ──────────────────────────────────────────
function Core() {
  const { data, flush } = useAppData();
  const toast = useToast();
  const { off } = useMotionScale();
  useDocumentFlags();

  const [route, setRoute] = useState<Route>({ section: "command" });
  const [booted, setBooted] = useState(false);
  const [meetingForm, setMeetingForm] = useState<{ open: boolean; meetingId: string | null }>({ open: false, meetingId: null });
  const [taskForm, setTaskForm] = useState<{ open: boolean; meetingId: string | null }>({ open: false, meetingId: null });
  const [quickNote, setQuickNote] = useState(false);

  const navigate = useCallback((r: Route) => {
    setRoute(r);
    requestAnimationFrame(() => document.querySelector("main")?.scrollTo({ top: 0 }));
  }, []);

  // Ctrl+N fallback listener for the meeting form (event from shell)
  useEffect(() => {
    const h = () => setMeetingForm({ open: true, meetingId: null });
    window.addEventListener("rhodes:new-meeting", h);
    return () => window.removeEventListener("rhodes:new-meeting", h);
  }, []);

  // Ctrl+S → force persist
  useEffect(() => {
    const h = () => { flush(); toast.success("All records synchronized to local storage."); };
    window.addEventListener("rhodes:flush", h);
    return () => window.removeEventListener("rhodes:flush", h);
  }, [flush, toast]);

  const ui = useMemo(() => ({
    openMeetingForm: (meetingId?: string) => setMeetingForm({ open: true, meetingId: meetingId ?? null }),
    openQuickNote: () => setQuickNote(true),
    openTaskForm: (meetingId?: string) => setTaskForm({ open: true, meetingId: meetingId ?? null }),
  }), []);

  const showBoot = !booted && data.settings.startupAnimation && !off;

  const renderSection = () => {
    if (route.meetingId) return <MeetingWorkspace meetingId={route.meetingId} navigate={navigate} />;
    switch (route.section) {
      case "command": return <CommandCenter navigate={navigate} />;
      case "meetings": return <MeetingOperations navigate={navigate} />;
      case "personnel": return <PersonnelRegistry navigate={navigate} />;
      case "tasks": return <TaskOperations navigate={navigate} />;
      case "archive": return <RecordsArchive navigate={navigate} openId={route.archiveId} />;
      case "settings": return <SystemConfiguration />;
      default: return <CommandCenter navigate={navigate} />;
    }
  };

  const wipeKey = route.meetingId ? `ws-${route.meetingId}` : route.section;

  return (
    <UiContext.Provider value={ui}>
      <AnimatePresence>{showBoot && <BootSequence key="boot" done={() => setBooted(true)} />}</AnimatePresence>
      <AppShell route={route} navigate={navigate} onQuickNote={() => setQuickNote(true)}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={wipeKey}
            initial={off ? undefined : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={off ? undefined : { opacity: 0 }}
            transition={{ duration: off ? 0 : 0.26, ease: "easeOut" }}
            style={{ position: "relative", maxWidth: 1460, margin: "0 auto" }}>
            {!off && (
              <motion.span className="scan-line"
                initial={{ top: "0%", opacity: 0.9 }} animate={{ top: "100%", opacity: 0 }}
                transition={{ duration: 0.42, ease: "linear" }} />
            )}
            {renderSection()}
            <div style={{ height: 48 }} />
            <div className="mono" style={{ textAlign: "center", fontSize: 10, letterSpacing: "0.3em", color: "var(--text-3)", opacity: 0.55, paddingBottom: 32 }}>
              RHODES OS 1.0 · {SECTIONS.find((x) => x.id === route.section)?.code ?? "R·03"} · LOCAL OPERATIONS · NO NETWORK
            </div>
          </motion.div>
        </AnimatePresence>
      </AppShell>

      {/* Global modals */}
      <MeetingFormModal open={meetingForm.open} meetingId={meetingForm.meetingId}
        onClose={() => setMeetingForm((s) => ({ ...s, open: false }))}
        onCreated={(id) => navigate({ section: "meetings", meetingId: id })} />
      <ActionItemFormModal open={taskForm.open} defaultMeetingId={taskForm.meetingId}
        onClose={() => setTaskForm((s) => ({ ...s, open: false }))} />
      <QuickNoteModal open={quickNote} onClose={() => setQuickNote(false)} />
    </UiContext.Provider>
  );
}

function Gate() {
  const { ready } = useAppData();
  if (!ready) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0f0f10" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.3em", color: "#8d8d8d" }}>ESTABLISHING LOCAL LINK…</span>
      </div>
    );
  }
  return <Core />;
}

export default function App() {
  return (
    <DataProvider>
      <ToastProvider>
        <Gate />
      </ToastProvider>
    </DataProvider>
  );
}
