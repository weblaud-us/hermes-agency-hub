"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SPRING } from "@/lib/motion";
import { cn, copyToClipboard } from "@/lib/utils";

type CopyState = "idle" | "copied" | "failed";

interface CopyButtonProps {
  value: string;
  label: string;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
}

export function CopyButton({ value, label, children, className, disabled }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    const copied = await copyToClipboard(value);
    setState(copied ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  }

  const Icon = state === "copied" ? Check : state === "failed" ? X : Copy;
  const announced = state === "copied" ? `${label}: copied` : state === "failed" ? `${label}: copy failed` : label;

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.94 }}
      transition={SPRING}
      onClick={copy}
      disabled={disabled}
      aria-label={announced}
      title={label}
      className={cn(
        "inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/4 px-2 text-xs font-medium text-ink-2 transition-colors hover:border-white/20 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
        state === "copied" && "border-signal/40 text-signal hover:text-signal",
        state === "failed" && "border-halt/50 text-halt-soft hover:text-halt-soft",
        className,
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={state}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.1 } }}
          transition={SPRING}
        >
          <Icon aria-hidden className="size-3.5" />
        </motion.span>
      </AnimatePresence>
      {children}
    </motion.button>
  );
}
