import type { Transition, Variants } from "motion/react";

export const SPRING: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 25,
  mass: 0.8,
};

export const staggerContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};

export const riseIn: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: SPRING },
};
