"use client";

import { motion } from "motion/react";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

interface MeterProps {
  value: number;
  max: number;
  label: string;
  /** Text for assistive tech and the title tooltip, e.g. "1.1GB of 2.0GB". */
  valueText: string;
  className?: string;
}

/** Thin usage bar. Crossing 85% turns it amber; the row also says "High". */
export function Meter({ value, max, label, valueText, className }: MeterProps) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuenow={Number(value.toFixed(2))}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuetext={valueText}
      title={`${label}: ${valueText}`}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-white/10", className)}
    >
      <motion.div
        initial={false}
        animate={{ scaleX: ratio }}
        transition={SPRING}
        className={cn("h-full origin-left rounded-full", ratio >= 0.85 ? "bg-warn" : "bg-signal")}
      />
    </div>
  );
}
