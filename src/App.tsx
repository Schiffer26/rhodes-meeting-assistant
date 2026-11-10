// ─────────────────────────────────────────────────────────────
// RHODES · application root
// Boot sequence → shell → section router.
// ─────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { StickyNote } from "lucide-react";
import { DataProvider, useAppData, useMotionScale } from "@/hooks/store";
import type { StorageAdapter } from "@/services/storage";
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
import { BootCenterLogo, BOOT_CENTER_LOGO_SRC } from "@/components/BootCenterLogo";
import { Button, Field, Modal } from "@/components/ui";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RecoveryBanner, RecoveryScreen } from "@/components/Recovery";
import { todayISO } from "@/utils/helpers";

// ── Boot sequence ─────────────────────────────────────────────
// Four-phase cinematic startup: power activation → insignia reconstruction →
// terminal initialization → command center deployment.
//
// Stages are driven by one timer set; the finish() guard makes skipping and
// the timer mutually idempotent, so no duplicate completion callback can fire
// and the timers are always cleared before unmount.
const BOOT_PHASES = [
  { code: "01", label: "Frame calibration" },
  { code: "02", label: "Optics reconstruction" },
  { code: "03", label: "Terminal initialization" },
  { code: "04", label: "Command center deployment" },
] as const;
const BOOT_METER = 14;
const BOOT_FILLED = [4, 7, 11, BOOT_METER];

function BootSequence({ done }: { done: () => void }) {
  const { reduced } = useMotionScale();
  const [stage, setStage] = useState(0);
  const finished = useRef(false);
  const doneRef = useRef(done);
  const skipRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef<number[]>([]);
  doneRef.current = done;

  // every pending timer is cancelled before completion can run
  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  const finish = useCallback(() => {
    if (finished.current) return;      // idempotent: skip, keys and the timer share this path
    finished.current = true;
    clearTimers();                     // no stage transition can follow the hand-off
    doneRef.current();
  }, [clearTimers]);

  // The sequence starts only once the official mark is decoded. Until then the
  // boot screen simply holds its first frame — the shell is never a fallback.
  const [logoReady, setLogoReady] = useState(false);
  useEffect(() => {
    let settled = false;
    let failsafe = 0;
    // idempotent: the first successful decode, load error or failsafe wins, and
    // the guard timer is dropped immediately so nothing lingers after settling
    const settle = () => {
      if (settled) return;
      settled = true;
      if (failsafe) { window.clearTimeout(failsafe); failsafe = 0; }
      setLogoReady(true);
    };
    // decode() resolves only once the bitmap is ready to paint; browsers without
    // it (or a decode rejection) fall back to the load/error events
    const afterLoad = () => {
      if (typeof img.decode !== "function") { settle(); return; }
      try {
        img.decode().then(settle, settle);
      } catch {
        settle();
      }
    };
    const img = new Image();
    img.addEventListener("load", afterLoad);
    img.addEventListener("error", settle);   // a missing file must not stall launch
    // armed before anything can settle synchronously, so `settle()` always has a
    // timer to drop and no guard ever outlives readiness
    failsafe = window.setTimeout(settle, 1500);
    img.src = BOOT_CENTER_LOGO_SRC;
    if (img.complete && img.naturalWidth > 0) afterLoad();
    return () => {
      settled = true;
      if (failsafe) window.clearTimeout(failsafe);
      img.removeEventListener("load", afterLoad);
      img.removeEventListener("error", settle);
    };
  }, []);

  useEffect(() => {
    if (!logoReady || finished.current) return;   // no timers before the mark is ready, or after a skip
    const timeline = reduced ? [0, 240, 470, 700] : [0, 620, 1240, 1980];
    const stageTimers = timeline.map((ms, i) => window.setTimeout(() => setStage(i), ms));
    const endTimer = window.setTimeout(finish, reduced ? 1040 : 2620);
    timers.current = [...stageTimers, endTimer];
    return () => {
      // second safeguard: nothing survives if the overlay unmounts for any other reason
      stageTimers.forEach(window.clearTimeout);
      window.clearTimeout(endTimer);
      timers.current = [];
    };
  }, [reduced, finish, logoReady]);

  // While the dialog is up it owns the keyboard: the shell's shortcuts are
  // swallowed in the capture phase, Tab cycles inside the dialog, and Escape
  // stays the global skip. Enter and Space are left to the native button.
  useEffect(() => {
    const holdFocus = () => skipRef.current?.focus({ preventScroll: true });
    const onKeyDown = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Tab") {
        e.preventDefault();
        holdFocus();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
        return;
      }
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        if (document.activeElement === skipRef.current) return;   // native activation handles it
        e.preventDefault();
        finish();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Node | null;
      if (target && dialogRef.current?.contains(target)) return;
      holdFocus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    holdFocus();
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [finish]);

  const filled = BOOT_FILLED[stage];
  const phase = BOOT_PHASES[stage];

  const tag = (label: string, value: string, side: "left" | "right", order: number) => (
    <div className={`boot-tag ${side}`} style={{ ["--i" as string]: order }}>
      <span className="boot-tag-key">{label}</span>
      <span className="boot-tag-val">{value}</span>
    </div>
  );

  return (
    <motion.div
      ref={dialogRef}
      className={`boot-overlay${reduced ? " is-reduced" : ""}`}
      data-stage={stage}
      initial={false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0.18 : 0.45, ease: "easeInOut" }}
      role="dialog"
      aria-modal="true"
      aria-label="RHODES system initialization">

      {/* ── scenery: architectural frame, grid, light sweeps ── */}
      <div className="boot-scenery" aria-hidden="true">
        <div className="boot-grid" />
        <div className="boot-horizon" />
        <div className="boot-frame">
          <span className="boot-corner tl" />
          <span className="boot-corner tr" />
          <span className="boot-corner bl" />
          <span className="boot-corner br" />
          <span className="boot-rail rail-top" />
          <span className="boot-rail rail-bottom" />
        </div>
        <div className="boot-sweep sweep-a" />
        <div className="boot-sweep sweep-b" />
      </div>

      {/* ── core: insignia rig, lockup, meter ── */}
      <div className="boot-core">
        <div className="boot-rig">
          <div className="boot-tags left">
            {tag("System", "RHODES", "left", 0)}
            {tag("Operation mode", "Local", "left", 1)}
          </div>

          <div className="boot-emblem">
            <div className="boot-rings">
              <span className="boot-ring ring-outer" />
              <span className="boot-ring ring-ticks" />
              <span className="boot-ring ring-inner" />
              <span className="boot-cross h" />
              <span className="boot-cross v" />
              <span className="boot-scan" />
            </div>
            <div className="boot-emblem-mark">
              <BootCenterLogo className="boot-logo" />
            </div>
          </div>

          <div className="boot-tags right">
            {tag("Network", "Offline", "right", 0)}
            {tag("Session", "Local", "right", 1)}
          </div>
        </div>

        <div className="boot-lockup">
          <div className="boot-wordmark">RHODES</div>
          <div className="boot-sub">Rhodes Island — Local Operations Terminal</div>
        </div>

        <div className="boot-meter" aria-hidden="true">
          {Array.from({ length: BOOT_METER }, (_, i) => (
            <span key={i} className="boot-seg" data-on={i < filled ? "1" : "0"} style={{ ["--i" as string]: i }} />
          ))}
        </div>

        <div className="boot-phase" aria-live="polite" aria-atomic="true">
          <span className="boot-phase-code">{phase.code}</span>
          <span className="boot-phase-label" key={phase.code}>{phase.label}</span>
          <span className="boot-phase-total" aria-hidden="true">/ 04</span>
        </div>
      </div>

      <button ref={skipRef} type="button" className="boot-skip" onClick={finish} aria-keyshortcuts="Escape">
        <span>Skip initialization</span>
        <kbd aria-hidden="true">ESC</kbd>
      </button>
    </motion.div>
  );
}

// ── Quick note modal (Ctrl+Shift+N) ───────────────────────────
// Exported so the persistence behaviour of this writer can be driven in
// isolation by the regression harness; the shell mounts it exactly as before.
export function QuickNoteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
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
          const html = `${note?.content ?? ""}<p><span class="ts">[${ts}]</span> ${text.trim().replace(/</g, "&lt;")}</p>`;
          // A refusal (recovery write lock) must not close the modal or clear the
          // text: the operator's note is still here to retry.
          if (!saveNote(meetingId, html)) {
            toast.error("Not saved — the records are locked while a recovery copy is taken. Your note is still here; append it again in a moment.");
            return;
          }
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
  // Layout effect, not effect: the saved theme, type scale and motion mode are
  // written to <html> in the same commit that first renders the boot screen, so
  // the very first painted frame already uses the operator's preference.
  useLayoutEffect(() => {
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
  // Meeting Operations and Personnel Registry paint their own page artwork; the
  // closing status strip gets a local contrast treatment there and only there.
  const hasPageArtwork =
    !route.meetingId &&
    (route.section === "meetings" || route.section === "personnel");
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

  // Ctrl+S → force persist; report what actually happened
  useEffect(() => {
    const h = async () => {
      const res = await flush();
      if (res.ok) toast.success("All records synchronized to local storage.");
      else toast.error(res.error ?? "Records could not be saved.");
    };
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
      <RecoveryBanner />
      <AnimatePresence>{showBoot && <BootSequence key="boot" done={() => setBooted(true)} />}</AnimatePresence>

      {/* The shell mounts only after the hand-off — nothing of the Command
          Center, the HUD or the navigation can paint behind the boot screen.
          During the exit the boot overlay is still mounted on top, so the
          reveal stays the same crossfade. */}
      {!showBoot && (
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
            {/* One faulty screen must never take the whole console down (1.3.11). */}
            <ErrorBoundary scope="screen" key={wipeKey}>{renderSection()}</ErrorBoundary>
            <div style={{ height: 48 }} />
            {/* Status strip. On the two screens that paint a page artwork the
                strip keeps its own contrast (local scrim + one contrast step),
                so the decorative line never sinks into the plate behind it. */}
            <div className={`mono workspace-foot${hasPageArtwork ? " has-art" : ""}`}>
              <span className="workspace-foot-text">
                RHODES OS 1.0 · {SECTIONS.find((x) => x.id === route.section)?.code ?? "R·03"} · LOCAL OPERATIONS · NO NETWORK
              </span>
            </div>
          </motion.div>
        </AnimatePresence>
      </AppShell>
      )}

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
  const { ready, recoveryBlocking } = useAppData();
  // A payload that could not be trusted blocks the console: the operator must
  // see what was preserved before any new write can reach the live key.
  if (ready && recoveryBlocking) return <RecoveryScreen />;
  if (!ready) {
    // Only reachable when an adapter cannot hydrate synchronously. It uses the
    // boot field's own palette, so the transition into the boot screen is a
    // continuation rather than a flash of another screen.
    return (
      <div className="boot-gate" role="status">
        <span className="boot-gate-label">ESTABLISHING LOCAL LINK…</span>
      </div>
    );
  }
  return <Core />;
}

export default function App({ adapter }: { adapter?: StorageAdapter } = {}) {
  return (
    <DataProvider adapter={adapter}>
      <ToastProvider>
        <ErrorBoundary scope="app">
          <Gate />
        </ErrorBoundary>
      </ToastProvider>
    </DataProvider>
  );
}
