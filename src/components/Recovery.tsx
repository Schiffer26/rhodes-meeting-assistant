// ─────────────────────────────────────────────────────────────
// RHODES · Recovery surface (1.3.11)
//
// When the stored payload cannot be read (or had to be repaired), the loader
// hands the app the surviving record set plus a description of what happened.
// These two components are the only things the operator sees in that state:
//
//   RecoveryScreen — blocking; nothing can be written until a choice is made.
//   RecoveryBanner — non-blocking; records were repaired/migrated but usable.
//
// Both are read-only apart from the explicit actions they expose. Neither one
// rewrites the stored payload on its own, and neither can lift the write lock:
// a browser download is only an invitation to the operator to confirm — the page
// cannot verify that a file reached the disk.
// ─────────────────────────────────────────────────────────────
import React, { useState } from "react";
import { AlertTriangle, Check, Download, HardDriveDownload, RefreshCw, ShieldAlert, X } from "lucide-react";
import { Button, ConfirmDialog } from "@/components/ui";
import { useAppData } from "@/hooks/store";
import { downloadFile, friendlyBytes } from "@/utils/helpers";
import { SNAPSHOT_PREFIX } from "@/services/storage";
import type { RecoveryInfo } from "@/services/storage";

const KIND_LABEL: Record<RecoveryInfo["kind"], string> = {
  corrupt: "UNREADABLE PAYLOAD",
  invalid: "FAILED VALIDATION",
  repaired: "RECORDS SET ASIDE",
  migrated: "SCHEMA UPGRADE",
};

function preservedSize(info: RecoveryInfo): string {
  return info.preservedRaw ? friendlyBytes(new Blob([info.preservedRaw]).size) : "—";
}

/**
 * Trigger the browser download. This is intentionally the whole of the action:
 * nothing is marked as preserved here, because the page cannot know whether the
 * file was saved or where it went.
 */
function downloadPreserved(info: RecoveryInfo): void {
  if (!info.preservedRaw) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadFile(`rhodes-preserved-${stamp}.json`, info.preservedRaw, "application/json");
}

/** The one explicit statement that unlocks writing when no snapshot exists. */
function SaveConfirmation({ compact = false }: { compact?: boolean }) {
  const { confirmPreservedCopySaved } = useAppData();
  return (
    <div style={{ marginTop: compact ? 8 : 14 }}>
      <Button variant="outline" icon={<Check size={13} />} onClick={confirmPreservedCopySaved}>
        I have saved the preserved backup
      </Button>
      <p
        className="small"
        style={{ marginTop: 8, color: "var(--warn)", lineHeight: 1.6, maxWidth: 620 }}
      >
        RHODES cannot verify a browser download. Confirm only once the file is on your disk or in
        another safe location — writing stays locked until you do.
      </p>
    </div>
  );
}

export function RecoveryScreen() {
  const {
    recovery, dismissRecovery, startWithDemoData, writesBlocked, preservedCopyUnreadable,
    preservedCopyDownloadStarted, notePreservedCopyDownload, retryRecovery,
  } = useAppData();
  const [confirmDemo, setConfirmDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);

  if (!recovery) return null;

  // Writing is only allowed once a second copy of the original exists: a
  // snapshot the loader verifiably wrote, or a file the operator has confirmed.
  // The lock lives in the store, so this screen cannot be bypassed.
  const locked = writesBlocked;

  const start = async () => {
    setBusy(true);
    setError(null);
    const res = await startWithDemoData();
    setBusy(false);
    setConfirmDemo(false);
    if (!res.ok) setError(res.error ?? "The demonstration dataset could not be written.");
  };

  const retry = async () => {
    setRetrying(true);
    setError(null);
    const res = await retryRecovery();
    setRetrying(false);
    if (!res.ok) setError(`Storage still cannot be read (${res.error}). Nothing was changed.`);
  };

  return (
    <div className="page-canvas" role="alert" aria-live="assertive">
      <div className="page-stack" style={{ maxWidth: 760, margin: "0 auto", padding: "clamp(24px, 6vh, 72px) 24px" }}>
        <div className="mono-label" style={{ color: "var(--warn)" }}>
          // LOCAL DATA RECOVERY · {KIND_LABEL[recovery.kind]}
        </div>
        <h1 className="masthead-title" style={{ marginTop: 8, fontSize: "clamp(26px, 4vw, 42px)" }}>
          Your records were left untouched
        </h1>
        <p className="small dim-2" style={{ marginTop: 10, lineHeight: 1.65, maxWidth: 640 }}>
          {recovery.message}{" "}
          {preservedCopyUnreadable
            ? "The stored payload — if any — is still in place, and this screen writes nothing until the records can be read again."
            : recovery.snapshotError
              ? "Nothing has been overwritten: the stored payload is still in place, unchanged. This screen writes nothing until you choose an action."
              : "Nothing has been overwritten: the stored payload is still in place and a preserved copy was written beside it. This screen writes nothing until you choose an action."}
        </p>

        <div className="panel" style={{ marginTop: 20, padding: 18, borderLeft: "3px solid var(--warn)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ShieldAlert size={16} style={{ color: "var(--warn)" }} />
            <span className="mono-label" style={{ color: "var(--text-2)" }}>PRESERVED COPY</span>
          </div>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Storage key</dt>
            <dd className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>rhodes.prototype.db.v1</dd>
            <dt>Preserved as</dt>
            <dd className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>
              {recovery.snapshotKey ?? "not written — original left in place"}
            </dd>
            <dt>Original size</dt>
            <dd>{preservedSize(recovery)}</dd>
            <dt>Records readable</dt>
            <dd>
              {preservedCopyUnreadable
                ? "unknown — storage could not be read"
                : `${recovery.counts.kept} kept${recovery.counts.dropped > 0 ? ` · ${recovery.counts.dropped} set aside` : ""}`}
            </dd>
          </dl>

          {preservedCopyUnreadable && (
            <div
              className="small"
              style={{
                marginTop: 12, padding: "10px 12px", border: "1px solid var(--crit)",
                color: "var(--crit)", background: "var(--surface-2)", lineHeight: 1.55,
              }}
            >
              <b>RHODES could not access the stored records.</b> Because nothing could be read, RHODES
              cannot prove a second copy exists and cannot download the payload for you either. Writing
              stays blocked so an existing record set cannot be overwritten. Retry the read below; if it
              keeps failing, reload the application.
            </div>
          )}

          {recovery.snapshotError && (
            <div
              className="small"
              style={{
                marginTop: 12, padding: "10px 12px", border: "1px solid var(--crit)",
                color: "var(--crit)", background: "var(--surface-2)", lineHeight: 1.55,
              }}
            >
              <b>A preserved copy could not be written ({recovery.snapshotError}).</b> The original
              records are still stored, unchanged, under the key above — export or repair them before
              making any change.
            </div>
          )}

          {recovery.details.length > 0 && (
            <ul className="tick-list" style={{ marginTop: 12 }}>
              {recovery.details.map((line, i) => (
                <li key={i} className="mono" style={{ fontSize: 11, color: "var(--text-3)", wordBreak: "break-word" }}>
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <div className="small" role="alert" style={{ marginTop: 14, color: "var(--crit)" }}>{error}</div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 20 }}>
          <Button
            icon={<Download size={13} />}
            onClick={() => { downloadPreserved(recovery); notePreservedCopyDownload(); }}
            disabled={!recovery.preservedRaw || busy}
          >
            Download preserved copy
          </Button>
          {preservedCopyUnreadable && (
            <Button icon={<RefreshCw size={13} />} onClick={retry} disabled={busy || retrying}>
              {retrying ? "Retrying…" : "Retry storage read"}
            </Button>
          )}
          {preservedCopyUnreadable && (
            <Button variant="ghost" onClick={() => window.location.reload()} disabled={busy || retrying}>
              Reload application
            </Button>
          )}
          <Button icon={<HardDriveDownload size={13} />} onClick={() => setConfirmDemo(true)} disabled={busy || locked}>
            Start with demo data
          </Button>
          <Button variant={locked ? "secondary" : "primary"} onClick={dismissRecovery} disabled={busy || locked}>
            Continue with empty workspace
          </Button>
        </div>

        {locked && preservedCopyDownloadStarted && !preservedCopyUnreadable && <SaveConfirmation />}

        {locked && (
          <p className="small" style={{ marginTop: 14, color: "var(--warn)", lineHeight: 1.6 }}>
            {preservedCopyUnreadable
              ? "Writing is blocked: RHODES could not access the stored records and cannot prove a second copy exists. Retry the read or reload before making any change."
              : "A verified second copy does not exist yet, so writing is blocked — anything written now would destroy the only copy of these records. Download the preserved copy, confirm it is saved, then choose an action above."}
          </p>
        )}

        <p className="mono" style={{ marginTop: 18, fontSize: 10, letterSpacing: "0.08em", color: "var(--text-3)", lineHeight: 1.7 }}>
          {preservedCopyUnreadable
            ? "NOTHING HAS BEEN WRITTEN. THE STORED PAYLOAD — IF PRESENT — REMAINS UNDER THE KEY ABOVE."
            : <>CONTINUING WITH AN EMPTY WORKSPACE LEAVES THE PRESERVED COPY IN PLACE AND DOES NOT DELETE IT.
              NEW EDITS ARE WRITTEN TO THE LIVE KEY ONLY.</>}
        </p>
      </div>

      <ConfirmDialog
        open={confirmDemo}
        onCancel={() => setConfirmDemo(false)}
        onConfirm={start}
        title="Start With Demo Data"
        confirmLabel="Write demo dataset"
        message={
          <div style={{ lineHeight: 1.6 }}>
            This writes the demonstration dataset over the live storage key. The preserved copy of your
            original records stays in storage and can be downloaded above. This action is only useful if
            the original records cannot be recovered.
          </div>
        }
      />
    </div>
  );
}

export function RecoveryBanner() {
  const {
    recovery, dismissRecovery, writesBlocked, preservedCopyDownloadStarted,
    notePreservedCopyDownload, confirmPreservedCopySaved,
  } = useAppData();
  if (!recovery) return null;
  // The blocking states are handled by <RecoveryScreen/>.
  if (recovery.kind === "corrupt" || recovery.kind === "invalid") return null;

  return (
    <div
      role="status"
      data-recovery-notice=""
      style={{
        position: "fixed", left: 16, bottom: 16, zIndex: 150,
        maxWidth: 460, display: "flex", alignItems: "flex-start", gap: 10,
        padding: "10px 12px", background: "var(--surface)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${writesBlocked ? "var(--crit)" : "var(--warn)"}`,
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: "0.12em", color: writesBlocked ? "var(--crit)" : "var(--text-2)" }}>
          {KIND_LABEL[recovery.kind]}{writesBlocked ? " · WRITES LOCKED" : ""}
        </div>
        <div className="small" style={{ lineHeight: 1.5, marginTop: 3 }}>{recovery.message}</div>
        {writesBlocked && (
          <div className="small" style={{ lineHeight: 1.5, marginTop: 4, color: "var(--warn)" }}>
            Editing is disabled because no verified second copy of the stored records exists yet.
            Download the preserved copy, confirm it is saved, and writing unlocks — the stored records
            stay untouched until then.
          </div>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
          {recovery.preservedRaw && (
            <button
              className="mono"
              onClick={() => { downloadPreserved(recovery); notePreservedCopyDownload(); }}
              style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--accent)", background: "none", border: 0, cursor: "pointer", padding: 0 }}
            >
              DOWNLOAD PRESERVED COPY
            </button>
          )}
          {writesBlocked && preservedCopyDownloadStarted && recovery.preservedRaw && (
            <span className="mono" aria-hidden="true" style={{ fontSize: 10, color: "var(--text-3)" }}>·</span>
          )}
          {writesBlocked && preservedCopyDownloadStarted && recovery.preservedRaw && (
            <button
              className="mono"
              onClick={confirmPreservedCopySaved}
              style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--warn)", background: "none", border: 0, cursor: "pointer", padding: 0 }}
            >
              I HAVE SAVED THE BACKUP
            </button>
          )}
          {recovery.snapshotKey && (
            <span
              className="mono"
              title={recovery.snapshotKey}
              style={{ fontSize: 10, color: "var(--text-3)", wordBreak: "break-all" }}
            >
              {recovery.snapshotKey.slice(SNAPSHOT_PREFIX.length)}
            </span>
          )}
        </div>
      </div>
      {!writesBlocked && (
        <button className="editor-tool" style={{ width: 22, height: 22 }} onClick={dismissRecovery} aria-label="Dismiss recovery notice">
          <X size={12} />
        </button>
      )}
    </div>
  );
}
