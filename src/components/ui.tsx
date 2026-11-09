// ─────────────────────────────────────────────────────────────
// RHODES · reusable UI primitives
//
// The design language: solid monochromatic plates, technical
// micro-labels, selective corner cuts, high-contrast status
// blocks. Surfaces are opaque — glass is used only for the
// modal scrim, never for content panels.
// ─────────────────────────────────────────────────────────────
import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, X } from "lucide-react";
import { useMotionScale } from "@/hooks/store";
import { cn } from "@/utils/cn";

// corner indicators (geometric bracket motif)
export function Corners({ color }: { color?: string }) {
  const style = color ? ({ ["--accent" as string]: color } as React.CSSProperties) : undefined;
  return (
    <span aria-hidden style={style}>
      <span className="cx tl" /><span className="cx tr" /><span className="cx bl" /><span className="cx br" />
    </span>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────
export type PanelVariant = "solid" | "light" | "ink" | "accent" | "raised";

const PANEL_CLASS: Record<PanelVariant, string> = {
  solid: "",
  light: "white",
  ink: "ink",
  accent: "accent",
  raised: "raised",
};

export function Panel({
  title, code, actions, children, className, bodyClass, pad = true, corners = false,
  accentBar = false, variant = "solid", style,
}: {
  title?: string; code?: string; actions?: React.ReactNode; children?: React.ReactNode;
  className?: string; bodyClass?: string; pad?: boolean; corners?: boolean;
  accentBar?: boolean; variant?: PanelVariant; style?: React.CSSProperties;
}) {
  return (
    <section className={cn("panel", PANEL_CLASS[variant], accentBar && "panel-accent-bar", className)} style={style}>
      {corners && <Corners />}
      {title && (
        <header className="panel-head">
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
            <span className="mono-label">{title}</span>
            {code && <span className="mono" style={{ color: "var(--text-3)", opacity: 0.7 }}>{code}</span>}
          </div>
          {actions && <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className={cn(pad && "panel-body", bodyClass)}>{children}</div>}
    </section>
  );
}

// ── Motion wrappers ────────────────────────────────────────────────────
// Framer-Motion entrance helpers honouring the motion setting.
export function Reveal({ children, delay = 0, y = 12, x = 0, className, as = "div", style }: {
  children: React.ReactNode; delay?: number; y?: number; x?: number;
  className?: string; as?: "div" | "section"; style?: React.CSSProperties;
}) {
  const { off, scale } = useMotionScale();
  const Tag = (as === "div" ? motion.div : motion.section) as typeof motion.div;
  if (off) return <div className={className} style={style}>{children}</div>;
  return (
    <Tag
      className={className} style={style}
      initial={{ opacity: 0, x: x * scale, y: y * scale }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: 0.28 * (scale || 0.45), delay: delay * scale, ease: [0.22, 0.61, 0.36, 1] }}
    >
      {children}
    </Tag>
  );
}

export function Stagger({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  const { off, scale } = useMotionScale();
  if (off) return <div className={className} style={style}>{children}</div>;
  return (
    <motion.div className={className} style={style} initial="hidden" animate="show"
      variants={{ hidden: {}, show: { transition: { staggerChildren: 0.055 * scale } } }}>
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className, style, x = 0 }: { children: React.ReactNode; className?: string; style?: React.CSSProperties; x?: number }) {
  const { off, scale } = useMotionScale();
  if (off) return <div className={className} style={style}>{children}</div>;
  return (
    <motion.div className={className} style={style}
      variants={{
        hidden: { opacity: 0, x: x * scale, y: 10 * scale },
        show: { opacity: 1, x: 0, y: 0, transition: { duration: 0.24 * (scale || 0.45), ease: [0.22, 0.61, 0.36, 1] } },
      }}>
      {children}
    </motion.div>
  );
}

// Thin scanline wipe used on section navigation
export function ScanWipe({ children, wipeKey, className }: { children: React.ReactNode; wipeKey: string; className?: string }) {
  const { off, scale } = useMotionScale();
  if (off) return <div className={className}>{children}</div>;
  return (
    <motion.div key={wipeKey} className={cn("scan-reveal", className)}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.3 * (scale || 0.5), ease: "easeOut" }}>
      <motion.span className="scan-line"
        initial={{ top: "0%" }} animate={{ top: "100%" }}
        transition={{ duration: 0.42 * (scale || 0.6), ease: "linear" }} />
      {children}
    </motion.div>
  );
}

// ── Button ─────────────────────────────────────────────────────────────
type BtnVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";
export function Button({
  variant = "secondary", size, loading, icon, children, className, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant; size?: "sm" | "lg"; loading?: boolean; icon?: React.ReactNode;
}) {
  return (
    <button className={cn("btn", variant === "primary" && "btn-primary", variant === "danger" && "btn-danger",
      variant === "ghost" && "btn-ghost", variant === "outline" && "btn-outline",
      size === "sm" && "btn-sm", size === "lg" && "btn-lg", className)}
      disabled={loading || rest.disabled} {...rest}>
      {loading ? <Loader2 size={14} className="spin" /> : icon}
      {children}
    </button>
  );
}

// ── Field ──────────────────────────────────────────────────────────────
export function Field({ label, required, error, hint, children, inline }: {
  label: string; required?: boolean; error?: string; hint?: string; children: React.ReactNode; inline?: boolean;
}) {
  return (
    <div className="field" style={inline ? { flexDirection: "row", alignItems: "center", gap: 12 } : undefined}>
      <label className="field-label">{label}{required && <span className="req">*</span>}</label>
      <div style={{ flex: inline ? 1 : undefined, display: "flex", flexDirection: "column", gap: 6 }}>
        {children}
        {hint && !error && <span className="field-hint">{hint}</span>}
        {error && <span className="field-error">{error}</span>}
      </div>
    </div>
  );
}

// ── Badge ──────────────────────────────────────────────────────────────
const TONE_COLOR: Record<string, string> = {
  cyan: "var(--accent)", green: "var(--ok)", amber: "var(--warn)",
  red: "var(--crit)", yellow: "var(--amber)", gray: "var(--text-3)",
};

export function Badge({ tone = "gray", dot = true, solid = false, children, className }: {
  tone?: string; dot?: boolean; solid?: boolean; children: React.ReactNode; className?: string;
}) {
  const dotColor = TONE_COLOR[tone] ?? "var(--text-3)";
  return (
    <span className={cn("badge", `badge-${tone}`, solid && "badge-solid", className)}>
      {dot && !solid && <span className={cn("dot", tone === "yellow" && "pulse")} style={{ background: dotColor }} />}
      {children}
    </span>
  );
}

// ── Status indicator ───────────────────────────────────────────────────
export function StatusChip({ tone = "gray", label }: { tone?: string; label: string }) {
  return (
    <span className="badge" style={{ gap: 8 }}>
      <span style={{ width: 8, height: 8, background: TONE_COLOR[tone] ?? "var(--text-3)", flex: "none" }} />
      <span style={{ color: "var(--text-2)" }}>{label}</span>
    </span>
  );
}

// ── Save indicator ─────────────────────────────────────────────────────
export function SaveIndicator({ state }: { state: "idle" | "saving" | "saved" | "error" }) {
  const label = state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "error" ? "Save failed — retry" : "Standby";
  return <span className={cn("save-ind", state)}><span className="sq" />{label}</span>;
}

// ── Metric block ───────────────────────────────────────────────────────
export function StatBlock({ label, value, tone, sub, variant = "solid" }: {
  label: string; value: React.ReactNode; tone?: string; sub?: string; variant?: PanelVariant;
}) {
  const color = tone ? (TONE_COLOR[tone] ?? "var(--text)") : "var(--text)";
  return (
    <div className={cn("panel", PANEL_CLASS[variant])} style={{ padding: "12px 14px" }}>
      <div className="mono-label">{label}</div>
      <div className="metric-value" style={{ marginTop: 6, fontSize: "var(--fs-section)", color }}>{value}</div>
      {sub && <div className="mono" style={{ fontSize: 9, letterSpacing: "0.12em", color: "var(--text-3)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ── Page masthead ──────────────────────────────────────────────────────
export function PageHeader({ eyebrow, title, meta, actions }: {
  eyebrow: string; title: string; meta?: string; actions?: React.ReactNode;
}) {
  return (
    <div className="masthead">
      <div>
        <span className="masthead-eyebrow">{eyebrow}</span>
        <h1 className="masthead-title">{title}</h1>
        {meta && <div className="masthead-meta">{meta}</div>}
      </div>
      {actions}
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────
export function Empty({ icon, title, hint, action }: {
  icon?: React.ReactNode; title: string; hint?: string; action?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "38px 20px", textAlign: "center" }}>
      <div className="clip-corner-sm" style={{
        width: 46, height: 46, border: "1px solid var(--border)", display: "flex",
        alignItems: "center", justifyContent: "center", color: "var(--text-3)",
        background: "var(--surface-2)",
      }}>
        {icon}
      </div>
      <span className="mono-label" style={{ color: "var(--text-2)" }}>{title}</span>
      {hint && <span className="small dim" style={{ maxWidth: 340 }}>{hint}</span>}
      {action}
    </div>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, code, width = 620, children, footer }: {
  open: boolean; onClose: () => void; title: string; code?: string; width?: number;
  children: React.ReactNode; footer?: React.ReactNode;
}) {
  const { off, scale } = useMotionScale();
  React.useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: off ? 0 : 0.18 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
          <motion.div className="modal-panel clip-corner-sm" style={{ width, maxWidth: "100%" }}
            initial={off ? undefined : { opacity: 0, y: 14 * scale, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={off ? undefined : { opacity: 0, y: 8 * scale }}
            transition={{ duration: 0.22 * (scale || 0.5), ease: [0.22, 0.61, 0.36, 1] }}>
            <header className="modal-head">
              <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                <span className="section-title" style={{ fontSize: "var(--fs-comp)" }}>{title}</span>
                {code && <span className="mono dim">{code}</span>}
              </div>
              <button className="editor-tool" onClick={onClose} aria-label="Close dialog (Esc)"><X size={16} /></button>
            </header>
            <div className="modal-body">{children}</div>
            {footer && <footer className="modal-foot">{footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function ConfirmDialog({ open, onCancel, onConfirm, title, message, confirmLabel = "Confirm" }: {
  open: boolean; onCancel: () => void; onConfirm: () => void; title: string; message: React.ReactNode; confirmLabel?: string;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title} code="CONFIRM REQUIRED" width={460}
      footer={<>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm} autoFocus>{confirmLabel}</Button>
      </>}>
      <div style={{ display: "flex", gap: 14 }}>
        <div style={{ width: 4, alignSelf: "stretch" }} className="hazard" />
        <div className="small dim-2" style={{ lineHeight: 1.6 }}>{message}</div>
      </div>
    </Modal>
  );
}
