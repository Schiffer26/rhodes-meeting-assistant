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
  /**
   * Two different statements, never merged: "this window may not write because
   * another one does" (state known, editing is safe) and "this browser cannot
   * arbitrate at all" (no protection, only a warning). The second one is not a
   * weaker version of the first — it is a limitation, and it says so.
   */
  const mode =
    readOnly ? "readonly" as const
    : writeLease === "unsupported" ? "unsupported" as const
    : null;
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
  }, [readOnly, recovery, writeLease]);

  // Nothing to say while the lease is being decided or when this window owns it.
  if (!mode) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      // `data-lease-state` is the store's own state; `data-lease-mode` is what
      // this notice is saying. Both are stable hooks for the regression suites.
      data-lease-state={writeLease}
      data-lease-mode={mode}
      style={{
        position: "fixed", left: 16, bottom: 16 + lift, zIndex: 150,
        // A status notice is information, not a surface: it must never take a
        // click or a hit-test away from the page underneath. Only its own
        // control is interactive.
        pointerEvents: "none",
        maxWidth: 460, display: "flex", alignItems: "flex-start", gap: 10,
        padding: "10px 12px", background: "var(--surface)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${mode === "readonly" ? "var(--warn)" : "var(--text-3)"}`,
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <Lock size={14} style={{ color: mode === "readonly" ? "var(--warn)" : "var(--text-2)", flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: "0.12em", color: mode === "readonly" ? "var(--warn)" : "var(--text-2)" }}>
          {mode === "readonly"
            ? "READ-ONLY · ANOTHER WINDOW OWNS EDITING"
            : "SINGLE-WINDOW MODE · THIS BROWSER CANNOT RESERVE EDITING"}
        </div>
        <div className="small" style={{ lineHeight: 1.5, marginTop: 3 }}>
          {mode === "readonly" ? (
            <>
              Another RHODES window is editing these records, so this window will not write over them.
              Everything is still readable here. Close the other window and editing is handed to this one
              automatically.
            </>
          ) : (
            <>
              This browser has no Web Locks API, so RHODES cannot hold editing to one window and a second
              window could not be prevented from writing. Keep one RHODES window open: changes made in
              another window are checked when this one writes its records away as you leave the page, not
              on every keystroke, so two windows editing at the same time can still lose work.
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
          {mode === "readonly" && <button
            className="mono"
            onClick={reloadFromStorage}
            style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--accent)", background: "none", border: 0, cursor: "pointer", padding: 0, pointerEvents: "auto" }}
          >
            RELOAD THESE RECORDS
          </button>}
          {mode === "readonly" && <span className="mono" aria-hidden="true" style={{ fontSize: 10, color: "var(--text-3)" }}>·</span>}
          <span className="mono" style={{ fontSize: 10, color: "var(--text-3)", display: "flex", alignItems: "center", gap: 4 }}>
            <AlertTriangle size={11} /> {mode === "readonly" ? "NOTHING TYPED HERE IS SAVED" : "ONE WINDOW AT A TIME"}
          </span>
        </div>
      </div>
    </div>
  );
}
