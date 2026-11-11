// ─────────────────────────────────────────────────────────────
// RHODES · SCREEN 7 — SYSTEM CONFIGURATION
// Every control is live: theme, motion, interface, local data.
// ─────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from "react";
import {
  Cpu, Database, FileDown, FileUp, HardDrive, Monitor, Moon, RotateCcw, Sun, Trash2,
} from "lucide-react";
import { Button, ConfirmDialog, PageHeader, Panel, Reveal, Stagger, StaggerItem } from "@/components/ui";
import { useAppData } from "@/hooks/store";
import type { ImportPreview } from "@/hooks/store";
import { useToast } from "@/components/toast";
import { storage } from "@/services/storage";
import { downloadFile, friendlyBytes, readFileText } from "@/utils/helpers";
import type { Density, FontSize, MotionPref, ThemeMode } from "@/types";

/**
 * One block of non-blocking import findings, listed verbatim in the order the
 * reader produced them. Rendered only when there is something to list, so a
 * clean file shows no heading and no empty list.
 */
function ImportNotice({ label, title, items, colour, note }: {
  label: string; title: string; items: string[]; colour: string; note: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: 10 }} aria-label={label}>
      <div className="small" style={{ color: colour, fontWeight: 600 }}>{title}</div>
      {/* Tailwind's reset drops list markers; they carry the reading here. */}
      <ul className="small dim-2" style={{ margin: "4px 0 0", paddingLeft: 16, listStyle: "disc" }}>
        {items.map((item, i) => (
          <li key={`${i}-${item}`} style={{ marginTop: 2 }}>{item}</li>
        ))}
      </ul>
      <div className="small dim-2" style={{ marginTop: 6 }}>{note}</div>
    </section>
  );
}

export function SystemConfiguration() {
  const { data, updateSettings, exportJSON, previewImport, importJSON, resetToDemo, restoreDefaultSettings } = useAppData();
  const toast = useToast();
  const s = data.settings;
  const fileRef = useRef<HTMLInputElement>(null);
  const [usage, setUsage] = useState<{ bytes: number; keys: number } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDefaults, setConfirmDefaults] = useState(false);
  // A backup file is inspected first and only applied after an explicit confirm.
  const [pending, setPending] = useState<{ name: string; text: string; preview: ImportPreview } | null>(null);
  const [importing, setImporting] = useState(false);

  const refreshUsage = () => storage.usageInfo().then(setUsage).catch(() => setUsage(null));
  useEffect(() => { refreshUsage(); }, [data.meta.firstRunAt, data.meetings.length, data.actionItems.length, data.personnel.length]);

  const themeCard = (id: ThemeMode, label: string, sub: string, icon: React.ReactNode) => {
    const on = s.theme === id;
    return (
      <button onClick={() => { updateSettings({ theme: id }); toast.info(`Theme set to ${label}.`); }}
        aria-pressed={on}
        style={{
          flex: 1, padding: "16px 14px", cursor: "pointer", textAlign: "left", position: "relative",
          background: on ? "var(--accent-dim)" : "var(--surface-2)",
          border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
          transition: "all 150ms linear",
        }}>
        <span style={{ color: on ? "var(--accent)" : "var(--text-3)" }}>{icon}</span>
        <span className="mono" style={{ display: "block", marginTop: 10, fontSize: 11, letterSpacing: "0.14em", color: on ? "var(--accent)" : "var(--text-2)" }}>{label}</span>
        <span className="small dim" style={{ display: "block", marginTop: 3 }}>{sub}</span>
        {on && <span style={{ position: "absolute", top: -1, right: -1, width: 10, height: 10, borderTop: "2px solid var(--accent)", borderRight: "2px solid var(--accent)" }} />}
      </button>
    );
  };

  const motionRow = (id: MotionPref, label: string, sub: string) => {
    const on = s.motionPreference === id;
    return (
      <button onClick={() => updateSettings({ motionPreference: id })} aria-pressed={on}
        style={{
          display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "11px 14px", cursor: "pointer", textAlign: "left",
          background: on ? "var(--accent-dim)" : "transparent",
          border: "none", borderBottom: "1px solid var(--border-soft)",
        }}>
        <span style={{ width: 9, height: 9, border: `1.5px solid ${on ? "var(--accent)" : "var(--text-3)"}`, background: on ? "var(--accent)" : "transparent", flexShrink: 0 }} />
        <span style={{ flex: 1 }}>
          <span className="small" style={{ display: "block", fontWeight: 600, color: on ? "var(--accent)" : "var(--text)" }}>{label}</span>
          <span className="mono" style={{ fontSize: 9, color: "var(--text-3)", letterSpacing: "0.1em" }}>{sub}</span>
        </span>
      </button>
    );
  };

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <Reveal>
        <PageHeader eyebrow="// LOCAL TERMINAL · CONFIGURATION SECTOR" title="System Configuration" />
      </Reveal>

      <Stagger className="page-split">
        {/* ── Appearance ─────────────────────────── */}
        <StaggerItem>
          <Panel title="Appearance" code="DISPLAY" corners>
            <div className="theme-pick">
              {themeCard("terminal", "TERMINAL", "Dark operations display", <Moon size={17} />)}
              {themeCard("archive", "ARCHIVE", "Light documentation display", <Sun size={17} />)}
              {themeCard("system", "SYSTEM", "Follow operating system", <Monitor size={17} />)}
            </div>
            <div className="mono dim" style={{ marginTop: 12, fontSize: 9, letterSpacing: "0.12em" }}>
              PREFERENCE PERSISTS LOCALLY · STATUS COLORS PRESERVE MEANING IN BOTH THEMES
            </div>
          </Panel>
        </StaggerItem>

        {/* ── Motion ────────────────────────────── */}
        <StaggerItem>
          <Panel title="Motion" code="ANIMATION PROFILE" pad={false}>
            {motionRow("immersive", "Immersive", "FULL SEQUENCE SET · BOOT CINEMATIC · SCANLINE TRANSITIONS")}
            {motionRow("reduced", "Reduced", "SHORTENED FADES · AMBIENT MOTION PAUSED")}
            <button onClick={() => updateSettings({ motionPreference: "off" })} aria-pressed={s.motionPreference === "off"}
              style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "11px 14px", cursor: "pointer", textAlign: "left", background: s.motionPreference === "off" ? "var(--accent-dim)" : "transparent", border: "none" }}>
              <span style={{ width: 9, height: 9, border: `1.5px solid ${s.motionPreference === "off" ? "var(--accent)" : "var(--text-3)"}`, background: s.motionPreference === "off" ? "var(--accent)" : "transparent", flexShrink: 0 }} />
              <span style={{ flex: 1 }}>
                <span className="small" style={{ display: "block", fontWeight: 600, color: s.motionPreference === "off" ? "var(--accent)" : "var(--text)" }}>Off</span>
                <span className="mono" style={{ fontSize: 9, color: "var(--text-3)", letterSpacing: "0.1em" }}>ALL ANIMATION DISABLED · INSTANT RESPONSE</span>
              </span>
            </button>
            <div className="row-line" style={{ borderTop: "1px solid var(--border-soft)", justifyContent: "space-between" }}>
              <div>
                <div className="small" style={{ fontWeight: 600 }}>Startup initialization sequence</div>
                <div className="mono dim" style={{ fontSize: 9, letterSpacing: "0.1em" }}>CINEMATIC BOOT ON APPLICATION LAUNCH</div>
              </div>
              <input type="checkbox" className="checkbox" style={{ width: 18, height: 18 }} checked={s.startupAnimation}
                onChange={(e) => updateSettings({ startupAnimation: e.target.checked })} aria-label="Enable startup animation" />
            </div>
          </Panel>
        </StaggerItem>

        {/* ── Interface ─────────────────────────── */}
        <StaggerItem>
          <Panel title="Interface" code="READING PROFILE">
            <div className="form-2" style={{ gap: 14 }}>
              <label className="field">
                <span className="field-label">Font size</span>
                <select className="select" value={s.fontSize} onChange={(e) => updateSettings({ fontSize: e.target.value as FontSize })}>
                  <option value="small">Compact — 13px</option>
                  <option value="medium">Standard — 14px</option>
                  <option value="large">Large — 16px</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Display density</span>
                <select className="select" value={s.density} onChange={(e) => updateSettings({ density: e.target.value as Density })}>
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Date format</span>
                <select className="select" value={s.dateFormat} onChange={(e) => updateSettings({ dateFormat: e.target.value as typeof s.dateFormat })}>
                  <option value="iso">YYYY-MM-DD</option>
                  <option value="dmy">DD/MM/YYYY</option>
                  <option value="mdy">MM/DD/YYYY</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Time format</span>
                <select className="select" value={s.timeFormat} onChange={(e) => updateSettings({ timeFormat: e.target.value as typeof s.timeFormat })}>
                  <option value="24h">24-hour</option>
                  <option value="12h">12-hour</option>
                </select>
              </label>
            </div>
            <div className="small dim-2" style={{ marginTop: 14, padding: 10, border: "1px dashed var(--border)" }}>
              Preview — 2025-03-14, 14:30 · <span className="mono">OPERATIONS REVIEW</span> · <b style={{ color: "var(--accent)" }}>Cyan accent</b> · <span className="dim">muted</span>
            </div>
          </Panel>
        </StaggerItem>

        {/* ── Local Data ────────────────────────── */}
        <StaggerItem>
          <Panel title="Local Data" code="STORAGE & MAINTENANCE" pad={false}>
            <div className="panel-body" style={{ borderBottom: "1px solid var(--border-soft)", display: "flex", gap: 14, alignItems: "center" }}>
              <HardDrive size={18} style={{ color: "var(--accent)", flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div className="small" style={{ fontWeight: 600 }}>Prototype storage adapter — {data.meta.adapter === "localStorage-prototype" ? "browser localStorage" : data.meta.adapter}</div>
                <div className="mono dim" style={{ fontSize: 9, letterSpacing: "0.1em", marginTop: 2 }}>
                  DATABASE {usage ? friendlyBytes(usage.bytes) : "—"} · {data.meetings.length + data.agendaItems.length + data.personnel.length + data.notes.length + data.decisions.length + data.actionItems.length} ENTITIES · FUTURE: ELECTRON IPC → SQLITE
                </div>
              </div>
            </div>
            <div className="form-2" style={{ gap: 10, padding: 16 }}>
              <Button icon={<FileDown size={13} />} onClick={() => {
                downloadFile(`rhodes-backup-${new Date().toISOString().slice(0, 10)}.json`, exportJSON(), "application/json");
                toast.success("Backup exported.");
              }}>Export Backup</Button>
              <Button icon={<FileUp size={13} />} onClick={() => fileRef.current?.click()}>Import Backup</Button>
              <Button icon={<RotateCcw size={13} />} onClick={() => setConfirmReset(true)}>Reset Sample Data</Button>
              <Button icon={<Trash2 size={13} />} onClick={() => setConfirmDefaults(true)}>Restore Default Settings</Button>
            </div>
            <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }}
              aria-label="Import JSON backup file"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                try {
                  const text = await readFileText(file);
                  // Read-only inspection: nothing is written or replaced yet.
                  const preview = previewImport(text);
                  if (!preview.ok) { toast.error(preview.error ?? "Import failed."); return; }
                  setPending({ name: file.name, text, preview });
                } catch {
                  toast.error("File could not be read.");
                }
              }} />
          </Panel>
        </StaggerItem>
      </Stagger>

      {/* ── Application ─────────────────────────── */}
      <Reveal delay={0.1}>
        <Panel title="Application" code="BUILD MANIFEST" className="clip-corner-bottom">
          <div className="page-split-wide">
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Cpu size={16} style={{ color: "var(--accent)" }} />
                <span style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700, letterSpacing: "0.1em" }}>RHODES</span>
                <span className="mono-label">VERSION 1.0 · FRONTEND PROTOTYPE</span>
              </div>
              <dl className="kv" style={{ marginTop: 12 }}>
                <dt>Architecture</dt><dd>Local-first · no accounts · no network dependencies</dd>
                <dt>Storage now</dt><dd>{storage.label} — clearly provisional</dd>
                <dt>Storage target</dt><dd>Electron main process → SQLite via secure IPC</dd>
                <dt>Capture mode</dt><dd>Manual documentation only (AI reserved for future phases)</dd>
                <dt>Platform</dt><dd>Windows desktop (Electron shell, later phase)</dd>
              </dl>
            </div>
            <div>
              <div className="mono-label" style={{ marginBottom: 8 }}>Module Roadmap</div>
              <ul className="tick-list">
                <li><b>R-2.0</b> — Electron shell + SQLite adapter (interface already defined)</li>
                <li><b>R-2.1</b> — Rich minutes templating and recurring meetings</li>
                <li><b>R-2.2</b> — Offline model-assisted drafting (local only, explicitly opt-in)</li>
                <li><b>R-2.3</b> — Multi-profile archives and sealed record signing</li>
              </ul>
            </div>
          </div>
        </Panel>
      </Reveal>

      <ConfirmDialog open={!!pending} onCancel={() => { if (!importing) setPending(null); }} title="Replace All Records"
        confirmLabel={importing ? "Importing…" : "Replace records"}
        onConfirm={async () => {
          if (!pending || importing) return;
          setImporting(true);
          const res = await importJSON(pending.text);
          setImporting(false);
          setPending(null);
          if (res.ok) {
            const lost = res.dropped ?? 0;
            toast.success(
              `Backup imported from ${pending.name}.` +
              (lost ? ` ${lost} draft${lost === 1 ? "" : "s"} captured during the import belonged to a replaced record and ${lost === 1 ? "was" : "were"} discarded.` : ""),
            );
            refreshUsage();
          } else {
            toast.error(res.error ?? "Import failed. No records were changed.");
          }
        }}
        message={pending && (
          <div style={{ lineHeight: 1.6 }}>
            <div>
              This replaces <b>all</b> current records with the contents of <b>{pending.name}</b>.
            </div>
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>Incoming</dt>
              <dd>
                {pending.preview.counts?.meetings ?? 0} meetings · {pending.preview.counts?.personnel ?? 0} personnel ·{" "}
                {pending.preview.counts?.actionItems ?? 0} action items · {pending.preview.counts?.notes ?? 0} notes ·{" "}
                {pending.preview.counts?.decisions ?? 0} decisions
              </dd>
              <dt>Current</dt>
              <dd>
                {pending.preview.current?.meetings ?? 0} meetings · {pending.preview.current?.personnel ?? 0} personnel ·{" "}
                {pending.preview.current?.actionItems ?? 0} action items · {pending.preview.current?.notes ?? 0} notes ·{" "}
                {pending.preview.current?.decisions ?? 0} decisions
              </dd>
            </dl>
            {(pending.preview.counts?.total ?? 0) === 0 && (
              <div className="small" style={{ marginTop: 10, color: "var(--warn)", fontWeight: 600 }}>
                This file contains no records. Confirming will leave the registry empty.
              </div>
            )}
            {!!pending.preview.adjustments?.length && (
              // What the reader had to do to a complete file: a schema
              // migration, defaults for a missing block. Nothing is missing.
              <ImportNotice
                label="Import adjustments"
                colour="var(--accent)"
                title={`Import adjustments — ${pending.preview.adjustments.length}`}
                items={pending.preview.adjustments}
                note={<>These are housekeeping, not losses: the file was read in full and brought up to the current
                  format. Every record it contains is imported.</>}
              />
            )}
            {!!pending.preview.warnings?.length && (
              // People the file names but does not contain. The records that
              // mention them still import — the reference is what is unknown.
              <ImportNotice
                label="Unresolved personnel references"
                colour="var(--warn)"
                title={`Unresolved personnel references — ${pending.preview.warnings.length}`}
                items={pending.preview.warnings}
                note={<>These warnings do not block the import. A missing person is not a broken record: the
                  affected meeting, decision or task still imports, and the person appears as <b>Unassigned</b> until
                  you add them to the registry.</>}
              />
            )}
            <div className="small dim-2" style={{ marginTop: 10 }}>
              A recovery snapshot of the current records is written before anything is replaced, and the
              new records are only applied once they have been written successfully.
            </div>
          </div>
        )} />

      <ConfirmDialog open={confirmReset} onCancel={() => setConfirmReset(false)} title="Reset Sample Data"
        message="Replace ALL current records with the original demonstration dataset? Your interface preferences (theme, motion, formats) are preserved. A recovery copy of the current records is written first; this cannot be undone in the interface."
        confirmLabel="Reset Data"
        onConfirm={async () => {
          setConfirmReset(false);
          const res = await resetToDemo();
          if (res.ok) { toast.success("Sample dataset restored."); refreshUsage(); }
          else toast.error(res.error ?? "The sample dataset could not be restored.");
        }} />
      <ConfirmDialog open={confirmDefaults} onCancel={() => setConfirmDefaults(false)} title="Restore Default Settings"
        message="Reset theme, motion, and interface preferences to factory defaults? Records are not affected."
        confirmLabel="Restore Defaults"
        onConfirm={() => { restoreDefaultSettings(); setConfirmDefaults(false); toast.success("Default settings restored."); }} />
    </div>
  );
}
