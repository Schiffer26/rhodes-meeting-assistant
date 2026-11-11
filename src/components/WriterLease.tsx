// ─────────────────────────────────────────────────────────────
// RHODES · Writer-lease banner (1.3.12 Phase 3 follow-up)
//
// One window at a time may write. The window that does not hold the lease can
// read everything but cannot change anything: its document may be older than
// what the owning window has already saved, so letting it write would put the
// older copy back and lose records (that is the cross-tab defect this exists to
// prevent). The state is stated plainly rather than discovered through a lost
// edit, and the window takes over by itself as soon as the owner goes away.
//
// Same visual language as the recovery banner: a small status panel in the
// corner, no layout of its own, no theme changes.
// ─────────────────────────────────────────────────────────────
import { AlertTriangle, Lock } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { useAppData } from "@/hooks/store";

export function WriterLeaseBanner() {
  const { readOnly, recovery, reloadFromStorage, writeLease } = useAppData();
  // The recovery banner uses the same corner, and it must stay readable: this
  // one sits above it instead of on top of it. Measured rather than assumed,
  // because the recovery notice has variable height.
  const [lift, setLift] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const other = document.querySelector<HTMLElement>("[data-recovery-notice]");
      setLift(other ? Math.round(other.getBoundingClientRect().height) + 8 : 0);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [readOnly, recovery]);

  // Nothing to say while the lease is being decided, when this window owns it,
  // or when the browser cannot arbitrate at all (see `writeLease`).
  if (!readOnly) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-lease-state={writeLease}
      style={{
        position: "fixed", left: 16, bottom: 16 + lift, zIndex: 150,
        // A status notice is information, not a surface: it must never take a
        // click or a hit-test away from the page underneath. Only its own
        // control is interactive.
        pointerEvents: "none",
        maxWidth: 460, display: "flex", alignItems: "flex-start", gap: 10,
        padding: "10px 12px", background: "var(--surface)",
        border: "1px solid var(--border)",
        borderLeft: "3px solid var(--warn)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <Lock size={14} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--warn)" }}>
          READ-ONLY · ANOTHER WINDOW OWNS EDITING
        </div>
        <div className="small" style={{ lineHeight: 1.5, marginTop: 3 }}>
          Another RHODES window is editing these records, so this window will not write over them.
          Everything is still readable here. Close the other window and editing is handed to this one
          automatically.
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
          <button
            className="mono"
            onClick={reloadFromStorage}
            style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--accent)", background: "none", border: 0, cursor: "pointer", padding: 0, pointerEvents: "auto" }}
          >
            RELOAD THESE RECORDS
          </button>
          <span className="mono" aria-hidden="true" style={{ fontSize: 10, color: "var(--text-3)" }}>·</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-3)", display: "flex", alignItems: "center", gap: 4 }}>
            <AlertTriangle size={11} /> NOTHING TYPED HERE IS SAVED
          </span>
        </div>
      </div>
    </div>
  );
}
