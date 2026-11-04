import { BRAND } from "@/lib/provisioning";
import { cn } from "@/lib/utils";

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold text-ink", className)}>
      <svg aria-hidden viewBox="0 0 24 24" className="size-5 shrink-0">
        <circle cx="12" cy="12" r="9" fill="none" stroke="var(--color-hyper)" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="3.6" fill="var(--color-signal)" />
        <circle cx="18.4" cy="5.6" r="2.1" fill="var(--color-signal)" />
      </svg>
      <span className="whitespace-nowrap text-sm">{BRAND}</span>
    </span>
  );
}
