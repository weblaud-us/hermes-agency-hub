"use client";

import { motion } from "motion/react";
import { ArrowLeft, Plus } from "lucide-react";
import Link from "next/link";
import { ProfileMenu } from "@/components/auth/ProfileMenu";
import { Sparkline } from "@/components/ui/Sparkline";
import { SpotlightCard } from "@/components/ui/SpotlightCard";
import { StatusOrb, type OrbTone } from "@/components/ui/StatusOrb";
import { Wordmark } from "@/components/ui/Wordmark";
import type { FleetSnapshot } from "@/lib/api";
import { PERMISSIONS, type SessionUser } from "@/lib/auth";
import { riseIn, staggerContainer } from "@/lib/motion";
import { cn, formatCurrency, formatInteger } from "@/lib/utils";

interface TelemetryHeaderProps {
  snapshot: FleetSnapshot | null;
  mode: "live" | "mock" | null;
  stale: boolean;
  user: SessionUser | null;
  onProvision: () => void;
  /** The fleet figures only make sense on the fleet tab, and not every role may read them. */
  showFleet: boolean;
}

function clusterState(snapshot: FleetSnapshot | null, stale: boolean): { tone: OrbTone; label: string } {
  if (!snapshot) return { tone: "muted", label: "Connecting" };
  if (stale) return { tone: "halt", label: "Hub unreachable" };
  if (!snapshot.health.ok) return { tone: "halt", label: "Hub degraded" };
  if (snapshot.health.docker === false) return { tone: "warn", label: "Docker unreachable" };
  return { tone: "signal", label: "Cluster healthy" };
}

function KpiCard({
  label,
  value,
  unit,
  caption,
  children,
}: {
  label: string;
  value: string;
  unit?: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div variants={riseIn} className="h-full">
      <SpotlightCard className="h-full rounded-2xl p-4">
        <div className="flex h-full flex-col justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-ink-2">{label}</p>
            <p className="mt-2 flex flex-wrap items-baseline gap-x-1.5 font-mono tabular-nums">
              <span className="text-[1.65rem] font-semibold leading-none tracking-tight text-ink">{value}</span>
              {unit && <span className="text-xs text-ink-3">{unit}</span>}
            </p>
            <p className="mt-1.5 text-xs text-ink-3">{caption}</p>
          </div>
          {children}
        </div>
      </SpotlightCard>
    </motion.div>
  );
}

function NotReported() {
  return <div className="flex h-9 items-end font-mono text-[11px] text-ink-3">Not exposed by the hub API</div>;
}

export function TelemetryHeader({ snapshot, mode, stale, user, onProvision, showFleet }: TelemetryHeaderProps) {
  const cluster = clusterState(snapshot, stale);
  const metrics = snapshot?.metrics;
  const history = snapshot?.history;

  const memoryKnown = metrics?.memoryUsedGb != null && metrics.memoryTotalGb != null;
  const toolCallsKnown = metrics?.toolCalls24h != null;

  return (
    <header>
      <div className="surface flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-2xl px-3 py-2.5 sm:px-4">
        <Link
          href="/"
          aria-label="Back to the marketing site"
          className="inline-flex size-9 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-white/6 hover:text-ink"
        >
          <ArrowLeft aria-hidden className="size-4" />
        </Link>
        <div className="flex items-center gap-3">
          <Wordmark />
          <h1 className="hidden text-sm text-ink-3 lg:block">Agency Console</h1>
        </div>

        {showFleet && (
          <div className="flex items-center gap-2.5 font-mono text-xs tabular-nums" role="status">
            <StatusOrb tone={cluster.tone} pulse={cluster.tone === "signal"} />
            <span className="text-ink-2">{cluster.label}</span>
            {snapshot?.health.latencyMs != null && !stale && <span className="text-ink-3">{snapshot.health.latencyMs}ms</span>}
          </div>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex min-h-10 items-center rounded-lg border px-3 font-mono text-[11px] uppercase tracking-wider",
              mode === "live" ? "border-signal/35 bg-signal/10 text-signal" : "border-warn/35 bg-warn/10 text-warn",
            )}
          >
            {mode === "live" ? "Live hub" : mode === "mock" ? "Sample data" : "Connecting"}
          </span>
          {user?.permissions.includes(PERMISSIONS.provision) && (
            <motion.button
              type="button"
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.97 }}
              onClick={onProvision}
              disabled={!mode}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-signal px-3.5 text-[13px] font-semibold text-obsidian transition-colors hover:bg-[#3ff9e2] disabled:opacity-50"
            >
              <Plus aria-hidden className="size-4" />
              Provision client
            </motion.button>
          )}
          {user && <ProfileMenu user={user} preview={mode === "mock"} />}
        </div>
      </div>

      {showFleet && (
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <KpiCard
          label="Active Tenant Containers"
          value={metrics ? `${metrics.running} / ${metrics.slots}` : "--"}
          unit="Slots"
          caption={metrics ? `${Math.max(0, metrics.slots - metrics.running)} slots free` : "Loading"}
        >
          <Sparkline data={history?.running ?? []} label="Active containers" format={(v) => `${Math.round(v)} running`} />
        </KpiCard>

        <KpiCard
          label="Host Memory & CPU Pressure"
          value={memoryKnown ? `${metrics.memoryUsedGb!.toFixed(1)} GB` : "--"}
          unit={memoryKnown ? `/ ${metrics.memoryTotalGb} GB` : undefined}
          caption={metrics?.cpuPct != null ? `CPU ${Math.round(metrics.cpuPct)}% across tenants` : "Host metrics unavailable"}
        >
          {memoryKnown || !metrics ? (
            <Sparkline
              data={history?.memory ?? []}
              label="Host memory"
              color="var(--color-hyper-soft)"
              format={(v) => `${v.toFixed(1)} GB`}
            />
          ) : (
            <NotReported />
          )}
        </KpiCard>

        <KpiCard
          label="24h Autonomous Tool Calls"
          value={toolCallsKnown ? formatInteger(metrics.toolCalls24h!) : "--"}
          unit={toolCallsKnown ? "executions" : undefined}
          caption={toolCallsKnown ? "Across all tenants" : "Tool-call counts unavailable"}
        >
          {toolCallsKnown || !metrics ? (
            <Sparkline
              data={history?.toolCalls ?? []}
              label="Tool calls per sample"
              format={(v) => `${formatInteger(v)} calls`}
            />
          ) : (
            <NotReported />
          )}
        </KpiCard>

        <KpiCard
          label="Monthly Recurring Retainer Run-Rate"
          value={metrics ? formatCurrency(metrics.mrr) : "--"}
          unit="MRR"
          caption={metrics?.mrrIsEstimate ? "Estimate: active tenants at list price" : "From running tenants"}
        >
          <Sparkline
            data={history?.mrr ?? []}
            label="Monthly recurring retainer"
            color="var(--color-hyper-soft)"
            format={(v) => formatCurrency(v)}
          />
        </KpiCard>
      </motion.div>
      )}
    </header>
  );
}
