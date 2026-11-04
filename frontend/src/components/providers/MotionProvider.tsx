"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { SPRING } from "@/lib/motion";

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={SPRING}>
      {children}
    </MotionConfig>
  );
}
