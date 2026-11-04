"use client";

import { motion, useMotionTemplate, useMotionValue, type Variants } from "motion/react";
import type { PointerEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SpotlightCardProps {
  children: ReactNode;
  className?: string;
  /** Space-separated RGB triplet for the glow, e.g. "0 245 212". */
  glow?: string;
  id?: string;
  /** Entrance variants, inherited from a staggering parent. */
  variants?: Variants;
}

/** Glass surface whose border and fill light up under the cursor. */
export function SpotlightCard({ children, className, glow = "0 245 212", id, variants }: SpotlightCardProps) {
  const x = useMotionValue(-400);
  const y = useMotionValue(-400);

  function track(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    x.set(event.clientX - rect.left);
    y.set(event.clientY - rect.top);
  }

  const borderGlow = useMotionTemplate`radial-gradient(340px circle at ${x}px ${y}px, rgb(${glow} / 0.65), transparent 70%)`;
  const surfaceGlow = useMotionTemplate`radial-gradient(420px circle at ${x}px ${y}px, rgb(${glow} / 0.07), transparent 70%)`;

  return (
    <motion.div
      id={id}
      variants={variants}
      onPointerMove={track}
      className={cn("group/spot surface sheen min-w-0 rounded-3xl", className)}
    >
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover/spot:opacity-100"
        style={{ background: surfaceGlow }}
      />
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-[inherit] p-px opacity-0 transition-opacity duration-300 [mask-composite:exclude] [mask:linear-gradient(#000_0_0)_content-box,linear-gradient(#000_0_0)] group-hover/spot:opacity-100"
        style={{ background: borderGlow }}
      />
      <div className="relative h-full">{children}</div>
    </motion.div>
  );
}
