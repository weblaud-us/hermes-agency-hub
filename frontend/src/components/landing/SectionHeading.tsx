"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { riseIn, staggerContainer } from "@/lib/motion";

interface SectionHeadingProps {
  eyebrow: string;
  title: ReactNode;
  children: ReactNode;
}

export function SectionHeading({ eyebrow, title, children }: SectionHeadingProps) {
  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.4 }}
      className="mx-auto mb-12 max-w-3xl text-center"
    >
      <motion.p variants={riseIn} className="font-mono text-xs uppercase tracking-[0.18em] text-signal">
        {eyebrow}
      </motion.p>
      <motion.h2
        variants={riseIn}
        className="text-gradient mt-4 text-balance text-3xl font-semibold leading-[1.12] tracking-[-0.03em] sm:text-5xl"
      >
        {title}
      </motion.h2>
      <motion.p variants={riseIn} className="mx-auto mt-5 max-w-2xl text-pretty text-base leading-relaxed text-ink-2">
        {children}
      </motion.p>
    </motion.div>
  );
}
