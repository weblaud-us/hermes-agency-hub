"use client";

import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { SPRING } from "@/lib/motion";

type ToastTone = "success" | "info" | "error";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

type Notify = (message: string, tone?: ToastTone) => void;

const ToastContext = createContext<Notify>(() => undefined);

export function useToast(): Notify {
  return useContext(ToastContext);
}

const TONE_ICON = {
  success: <CheckCircle2 aria-hidden className="size-4 shrink-0 text-signal" />,
  info: <Info aria-hidden className="size-4 shrink-0 text-hyper-soft" />,
  error: <AlertTriangle aria-hidden className="size-4 shrink-0 text-halt" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const notify = useCallback<Notify>((message, tone = "success") => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts((current) => [...current.slice(-2), { id, tone, message }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), tone === "error" ? 7000 : 4200);
  }, []);

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-5 z-70 flex flex-col items-center gap-2"
      >
        <AnimatePresence initial={false} mode="popLayout">
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, transition: { duration: 0.16 } }}
              transition={SPRING}
              className="pointer-events-auto flex max-w-md items-start gap-2.5 rounded-2xl border border-white/10 bg-[#101016]/95 px-4 py-3 text-sm text-ink shadow-2xl shadow-black/50"
            >
              <span className="mt-0.5">{TONE_ICON[toast.tone]}</span>
              <span>{toast.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
