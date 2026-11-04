"use client";

import { motion } from "motion/react";
import { Bot, Clock3, Gauge, LibraryBig, LogOut, MessageSquareText, TrendingDown, TrendingUp, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { Sparkline } from "@/components/ui/Sparkline";
import { SpotlightCard } from "@/components/ui/SpotlightCard";
import { StatusOrb, type OrbTone } from "@/components/ui/StatusOrb";
import type { AgentStatus, PortalOverview } from "@/lib/portal-api";
import { riseIn, SPRING, staggerContainer } from "@/lib/motion";
import { cn, formatInteger } from "@/lib/utils";

const STATUS: Record<AgentStatus, { tone: OrbTone; label: string; className: string }> = {
  online: { tone: "signal", label: "Coordinator Online", className: "border-signal/30 bg-signal/10 text-signal" },
  degraded: { tone: "warn", label: "Coordinator Degraded", className: "border-warn/30 bg-warn/10 text-warn" },
  offline: { tone: "halt", label: "Coordinator Offline", className: "border-halt/35 bg-halt/10 text-halt-soft" },
};

function initials(company: string): string {
  const words = company.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : company.slice(0, 2)).toUpperCase();
}

function KpiCard({
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

function FooterNote({ children }: { children: ReactNode }) {
  return <p className="flex min-h-9 items-end text-xs leading-snug text-ink-3">{children}</p>;
}

interface PortalHeaderProps {
  company: string;
  overview: PortalOverview | null;
  canSignOut: boolean;
  onAsk: () => void;
  onSignOut: () => void;
}

export function PortalHeader({ company, overview, canSignOut, onAsk, onSignOut }: PortalHeaderProps) {
  const status = overview ? STATUS[overview.agentStatus] : null;
  const trend = overview?.tasksTrendPct ?? null;
  const TrendIcon = trend !== null && trend < 0 ? TrendingDown : TrendingUp;

  return (
    <header>
      <div className="surface flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-linear-to-br from-hyper/40 to-signal/20 font-mono text-xs font-semibold text-ink"
          >
            {initials(company)}
          </span>
          <h1 className="min-w-0 truncate text-sm font-semibold tracking-wide text-ink">
            {company.toUpperCase()}
            <span className="font-normal text-ink-3"> • AI Operations Portal</span>
          </h1>
        </div>

        {status ? (
          <p
            role="status"
            title="Uptime is estimated over the last 30 days."
            className={cn(
              "inline-flex min-h-8 items-center gap-2 rounded-full border px-3 font-mono text-xs tabular-nums",
              status.className,
            )}
          >
            <StatusOrb tone={status.tone} pulse={overview?.agentStatus === "online"} />
            {status.label}
            {overview?.uptimePercentage != null && (
              <span className="text-ink-2">• {overview.uptimePercentage.toFixed(2)}% Uptime</span>
            )}
          </p>
        ) : (
          <div aria-hidden className="h-8 w-52 animate-pulse rounded-full bg-white/5" />
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <motion.button
            type="button"
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            transition={SPRING}
            onClick={onAsk}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-signal px-3.5 text-[13px] font-semibold text-obsidian transition-colors hover:bg-[#3ff9e2]"
          >
            <MessageSquareText aria-hidden className="size-4" />
            Ask Coordinator
            <span className="hidden font-medium opacity-70 md:inline">/ Test in Sandbox</span>
          </motion.button>
          {canSignOut && (
            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out"
              title="Sign out"
              className="inline-flex size-10 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-white/6 hover:text-ink"
            >
              <LogOut aria-hidden className="size-4" />
            </button>
          )}
        </div>
      </div>

      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <KpiCard
          icon={<Zap aria-hidden className="size-3.5" />}
          label="Autonomous Actions (30d)"
          value={overview?.tasksCompleted30d != null ? formatInteger(overview.tasksCompleted30d) : "--"}
          unit={overview?.tasksCompleted30d != null ? "Completed" : null}
          footer={
            overview && overview.tasksDaily.length >= 2 && overview.tasksCompleted30d != null ? (
              <div className="flex items-end gap-3">
                {trend !== null && (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 pb-0.5 font-mono text-xs tabular-nums",
                      trend >= 0 ? "text-signal" : "text-warn",
                    )}
                  >
                    <TrendIcon aria-hidden className="size-3.5" />
                    {trend >= 0 ? "+" : ""}
                    {Math.round(trend)}%
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <Sparkline data={overview.tasksDaily} label="Actions per day" format={(v) => `${formatInteger(v)} actions`} />
                </div>
              </div>
            ) : (
              <FooterNote>{overview ? "Builds up as your Coordinator works." : "Loading"}</FooterNote>
            )
          }
        />
        <KpiCard
          icon={<Clock3 aria-hidden className="size-3.5" />}
          label="Estimated Team Time Saved"
          value={overview?.estimatedHoursSaved != null ? overview.estimatedHoursSaved.toFixed(1) : "--"}
          unit={overview?.estimatedHoursSaved != null ? "Hours / mo" : null}
          footer={<FooterNote>Estimated from the actions completed in the last 30 days.</FooterNote>}
        />
        <KpiCard
          icon={<Gauge aria-hidden className="size-3.5" />}
          label="Avg. Lead / Order Response Time"
          value={overview?.avgResponseSeconds != null ? overview.avgResponseSeconds.toFixed(1) : "--"}
          unit={overview?.avgResponseSeconds != null ? "Seconds" : null}
          footer={<FooterNote>Average first reply on your messaging channels, last 30 days.</FooterNote>}
        />
        <KpiCard
          icon={<LibraryBig aria-hidden className="size-3.5" />}
          label="Learned Business Workflows"
          value={overview ? String(overview.learnedSkillCount) : "--"}
          unit={overview ? "Active Skills" : null}
          footer={
            <FooterNote>
              {overview ? (
                <span className="inline-flex items-center gap-1.5">
                  <Bot aria-hidden className="size-3.5 shrink-0" />
                  {overview.activeModelTier}
                </span>
              ) : (
                "Loading"
              )}
            </FooterNote>
          }
        />
      </motion.div>
    </header>
  );
}
