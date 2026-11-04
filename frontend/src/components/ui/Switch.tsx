"use client";

import { motion } from "motion/react";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

export function Switch({ checked, onChange, label }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="-m-2 inline-flex size-fit items-center justify-center rounded-full p-2.5"
    >
      <span
        className={cn(
          "flex h-5 w-9 items-center rounded-full border p-0.5 transition-colors duration-200",
          checked ? "border-signal/50 bg-signal/25" : "border-white/15 bg-white/5",
        )}
      >
        <motion.span
          animate={{ x: checked ? 16 : 0 }}
          transition={SPRING}
          className={cn("size-3.5 rounded-full", checked ? "bg-signal" : "bg-white/55")}
        />
      </span>
    </button>
  );
}
