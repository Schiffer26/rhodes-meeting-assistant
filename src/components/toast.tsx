// RHODES · activity notifications (toasts)
import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { uid } from "@/utils/helpers";

type Kind = "success" | "error" | "info";
interface Toast { id: string; kind: Kind; msg: string }

interface ToastApi {
  success: (m: string) => void;
  error: (m: string) => void;
  info: (m: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const timers = useRef<Record<string, number>>({});

  const push = useCallback((kind: Kind, msg: string) => {
    const id = uid("toast");
    setItems((xs) => [...xs.slice(-3), { id, kind, msg }]);
    timers.current[id] = window.setTimeout(() => {
      setItems((xs) => xs.filter((x) => x.id !== id));
    }, 3400);
  }, []);

  const api: ToastApi = {
    success: (m) => push("success", m),
    error: (m) => push("error", m),
    info: (m) => push("info", m),
  };

  const icon = (k: Kind) =>
    k === "success" ? <CheckCircle2 size={15} /> : k === "error" ? <AlertTriangle size={15} /> : <Info size={15} />;
  const color = (k: Kind) => (k === "success" ? "var(--ok)" : k === "error" ? "var(--crit)" : "var(--accent)");

  return (
    <Ctx.Provider value={api}>
      {children}
      <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 300, display: "flex", flexDirection: "column", gap: 8, pointerEvents: "none" }}>
        <AnimatePresence>
          {items.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="panel"
              style={{ pointerEvents: "auto", display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", minWidth: 260, maxWidth: 380, borderLeft: `2px solid ${color(t.kind)}` }}
            >
              <span style={{ color: color(t.kind) }}>{icon(t.kind)}</span>
              <span className="small" style={{ flex: 1 }}>{t.msg}</span>
              <button
                className="editor-tool" style={{ width: 22, height: 22 }}
                onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}
                aria-label="Dismiss"
              >
                <X size={12} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast outside provider");
  return ctx;
}
