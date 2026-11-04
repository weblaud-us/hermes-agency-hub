"use client";

import { motion } from "motion/react";
import { useId, type ReactNode } from "react";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface SegmentedProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  optionClassName?: string;
}

/** Segmented control with a shared-layout pill. Arrow keys move the selection. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  optionClassName,
}: SegmentedProps<T>) {
  const groupId = useId();

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + step + options.length) % options.length];
    onChange(next.value);
    const buttons = event.currentTarget.parentElement?.querySelectorAll("button");
    buttons?.[options.indexOf(next)]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "inline-flex gap-1 rounded-full border border-white/8 bg-white/3 p-1",
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={onKeyDown}
            className={cn(
              "relative min-h-9 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
              selected ? "text-ink" : "text-ink-3 hover:text-ink-2",
              optionClassName,
            )}
          >
            {selected && (
              <motion.span
                layoutId={`activePill-${groupId}`}
                transition={SPRING}
                className="absolute inset-0 rounded-full border border-white/10 bg-white/9"
              />
            )}
            <span className="relative z-10">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
