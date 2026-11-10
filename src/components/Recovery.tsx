// ─────────────────────────────────────────────────────────────
// RHODES · Recovery surface (1.3.11)
//
// When the stored payload cannot be read, the loader preserves it and hands
// the app an empty, valid record set plus a description of what happened.
// These two components are the only things the operator sees in that state:
//
//   RecoveryScreen — blocking; nothing can be written until a choice is made.
//   RecoveryBanner — non-blocking; records were repaired/migrated but usable.
//
// Both are read-only apart from the explicit actions they expose. Neither one
// rewrites the stored payload on its own.
// ─────────────────────────────────────────────────────────────
import React, { useState } from "react";
import { AlertTriangle, Download, HardDriveDownload, ShieldAlert, X } from "lucide-react";
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

function downloadPreserved(info: RecoveryInfo): void {
  if (!info.preservedRaw) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadFile(`rhodes-preserved-${stamp}.json`, info.preservedRaw, "application/json");
}

export function RecoveryScreen() {
  const { recovery, dismissRecovery, startWithDemoData } = useAppData();
  const [confirmDemo, setConfirmDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  if (!recovery) return null;

  // Writing is only allowed once a second copy of the original exists: either
  // the snapshot the loader wrote, or a file the operator has just downloaded.
  const preserved = !!recovery.snapshotKey || downloaded;

  const start = async () => {
    setBusy(true);
    setError(null);
    const res = await startWithDemoData();
    setBusy(false);
    setConfirmDemo(false);
    if (!res.ok) setError(res.error ?? "The demonstration dataset could not be written.");
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
          {recovery.snapshotError
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
              {recovery.counts.kept} kept
              {recovery.counts.dropped > 0 ? ` · ${recovery.counts.dropped} set aside` : ""}
            </dd>
          </dl>

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
            onClick={() => { downloadPreserved(recovery); setDownloaded(true); }}
            disabled={!recovery.preservedRaw}
          >
            Download preserved copy
          </Button>
          <Button icon={<HardDriveDownload size={13} />} onClick={() => setConfirmDemo(true)} disabled={busy || !preserved}>
            Start with demo data
          </Button>
          <Button variant="primary" onClick={dismissRecovery} disabled={busy || !preserved}>
            Continue with empty workspace
          </Button>
        </div>

        {!preserved && (
          <p className="small" style={{ marginTop: 14, color: "var(--warn)", lineHeight: 1.6 }}>
            A second copy does not exist yet, so writing is blocked — anything written now would destroy
            the only copy of these records. Download the preserved copy first to unlock the options above.
          </p>
        )}

        <p className="mono" style={{ marginTop: 18, fontSize: 10, letterSpacing: "0.08em", color: "var(--text-3)", lineHeight: 1.7 }}>
          CONTINUING WITH AN EMPTY WORKSPACE LEAVES THE PRESERVED COPY IN PLACE AND DOES NOT DELETE IT.
          NEW EDITS ARE WRITTEN TO THE LIVE KEY ONLY.
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
  const { recovery, dismissRecovery } = useAppData();
  if (!recovery) return null;
  // The blocking states are handled by <RecoveryScreen/>.
  if (recovery.kind === "corrupt" || recovery.kind === "invalid") return null;

  return (
    <div
      role="status"
      style={{
        position: "fixed", left: 16, bottom: 16, zIndex: 150,
        maxWidth: 460, display: "flex", alignItems: "flex-start", gap: 10,
        padding: "10px 12px", background: "var(--surface)",
        border: "1px solid var(--border)", borderLeft: "3px solid var(--warn)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--text-2)" }}>
          {KIND_LABEL[recovery.kind]}
        </div>
        <div className="small" style={{ lineHeight: 1.5, marginTop: 3 }}>{recovery.message}</div>
        <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
          {recovery.preservedRaw && (
            <button
              className="mono"
              onClick={() => downloadPreserved(recovery)}
              style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--accent)", background: "none", border: 0, cursor: "pointer", padding: 0 }}
            >
              DOWNLOAD PRESERVED COPY
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
      <button className="editor-tool" style={{ width: 22, height: 22 }} onClick={dismissRecovery} aria-label="Dismiss recovery notice">
        <X size={12} />
      </button>
    </div>
  );
}
