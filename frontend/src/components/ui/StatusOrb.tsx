import { cn } from "@/lib/utils";

export type OrbTone = "signal" | "warn" | "halt" | "muted";

const TONE_CLASS: Record<OrbTone, string> = {
  signal: "bg-signal",
  warn: "bg-warn",
  halt: "bg-halt",
  muted: "bg-white/40",
};

export function StatusOrb({ tone, pulse = true, className }: { tone: OrbTone; pulse?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse && <span className={cn("animate-orb absolute inset-0 rounded-full", TONE_CLASS[tone])} />}
      <span className={cn("relative size-2 rounded-full", TONE_CLASS[tone])} />
    </span>
  );
}
