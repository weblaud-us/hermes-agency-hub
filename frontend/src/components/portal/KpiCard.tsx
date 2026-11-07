"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { SpotlightCard } from "@/components/ui/SpotlightCard";
import { riseIn } from "@/lib/motion";

export function KpiCard({
  icon,
  label,
  value,
  unit,
  footer,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  unit: string | null;
  footer: ReactNode;
}) {
  return (
    <motion.div variants={riseIn} className="h-full">
      <SpotlightCard className="h-full rounded-2xl p-4">
        <div className="flex h-full flex-col justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-xs font-medium text-ink-2">
              <span className="text-ink-3">{icon}</span>
              {label}
            </p>
            <p className="mt-3 flex flex-wrap items-baseline gap-x-1.5 font-mono tabular-nums">
              <span className="text-[1.75rem] font-semibold leading-none tracking-tight text-ink">{value}</span>
              {unit && <span className="text-xs text-ink-3">{unit}</span>}
            </p>
          </div>
          {footer}
        </div>
      </SpotlightCard>
    </motion.div>
  );
}

export function FooterNote({ children }: { children: ReactNode }) {
  return <p className="flex min-h-9 items-end text-xs leading-snug text-ink-3">{children}</p>;
}
