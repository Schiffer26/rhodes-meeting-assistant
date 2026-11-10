// ─────────────────────────────────────────────────────────────
// RHODES · Fault isolation
//
// A render error anywhere in the interface used to empty #root, which — with
// records already persisted — locked the app into a blank screen with no way
// back. This boundary keeps the shell, explains what happened and offers three
// safe exits: retry, download the stored records, or reload.
//
// It never writes to storage and never invents data.
// ─────────────────────────────────────────────────────────────
import React from "react";
import { AlertTriangle, Download, RefreshCw, RotateCcw } from "lucide-react";
import { STORAGE_KEY } from "@/services/storage";
import { downloadFile } from "@/utils/helpers";

interface Props {
  children: React.ReactNode;
  /** "screen" keeps the HUD and navigation alive; "app" replaces the whole UI. */
  scope?: "screen" | "app";
}
interface State { error: Error | null }

function storedRecords(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Keep the trail in the console for support; never swallow it silently.
    console.error("RHODES screen fault:", error, info.componentStack);
  }

  private retry = () => this.setState({ error: null });

  private reload = () => window.location.reload();

  private download = () => {
    const raw = storedRecords();
    if (!raw) return;
    downloadFile(`rhodes-stored-${new Date().toISOString().slice(0, 10)}.json`, raw, "application/json");
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const scope = this.props.scope ?? "screen";
    const body = (
      <div className="page-stack" style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
        <div className="panel" style={{ padding: 22, borderLeft: "3px solid var(--crit)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <AlertTriangle size={18} style={{ color: "var(--crit)" }} />
            <span className="mono-label" style={{ color: "var(--crit)" }}>
              {scope === "app" ? "APPLICATION FAULT" : "SCREEN FAULT"} · RECORDS NOT AFFECTED
            </span>
          </div>
          <h1 className="masthead-title" style={{ marginTop: 12, fontSize: "clamp(22px, 3vw, 32px)" }}>
            This screen could not be rendered
          </h1>
          <p className="small dim-2" style={{ marginTop: 10, lineHeight: 1.6 }}>
            Your stored records were not modified. The fault happened while drawing this view, so
            nothing has been saved over your data. You can retry, download a copy of the stored
            records, or reload the application.
          </p>
          <pre
            className="mono"
            style={{
              marginTop: 14, padding: "10px 12px", background: "var(--surface-2)",
              border: "1px solid var(--border-soft)", fontSize: 11, lineHeight: 1.5,
              whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 160, overflow: "auto",
            }}
          >
            {error.message || String(error)}
          </pre>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 16 }}>
            <button className="btn" onClick={this.retry}>
              <RotateCcw size={13} style={{ marginRight: 8 }} />Retry this screen
            </button>
            <button className="btn" onClick={this.download}>
              <Download size={13} style={{ marginRight: 8 }} />Download stored records
            </button>
            <button className="btn btn-primary" onClick={this.reload}>
              <RefreshCw size={13} style={{ marginRight: 8 }} />Reload application
            </button>
          </div>
        </div>
      </div>
    );

    if (scope === "app") {
      return <div className="page-canvas" role="alert">{body}</div>;
    }
    // Keep the fault inside the page canvas so the HUD, navigation and status
    // strip stay usable — the operator can simply navigate to another screen.
    return <div className="page-canvas" role="alert">{body}</div>;
  }
}
