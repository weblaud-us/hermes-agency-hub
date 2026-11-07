"use client";

import { AnimatePresence, motion } from "motion/react";
import { Bot, Check, Clock3, Gauge, Lock, RotateCw, ShoppingBag, Store, TrendingDown, TrendingUp, Users, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { FooterNote, KpiCard } from "@/components/portal/KpiCard";
import { ModeWorkspace } from "@/components/portal/ModeWorkspace";
import { UsageCostMeter } from "@/components/portal/UsageCostMeter";
import { Segmented } from "@/components/ui/Segmented";
import { Sparkline } from "@/components/ui/Sparkline";
import { useI18n } from "@/lib/i18n";
import { riseIn, SPRING, staggerContainer } from "@/lib/motion";
import type { BusinessMode, PortalClient, PortalOverview, Roster, RosterAgent } from "@/lib/portal-api";
import { cn } from "@/lib/utils";

interface OverviewTabProps {
  client: PortalClient;
  overview: PortalOverview | null;
  currency: string;
  mode: BusinessMode;
}

function AgentCard({ agent, preview }: { agent: RosterAgent; preview: boolean }) {
  const { t } = useI18n();
  const on = !preview && agent.active;
  return (
    <motion.li
      layout
      variants={riseIn}
      initial="hidden"
      animate="show"
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      className={cn(
        "surface flex h-full flex-col gap-2.5 rounded-2xl p-4",
        !on && !preview && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="min-w-0 text-sm font-semibold leading-snug text-ink">{agent.name}</h4>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-wider",
            on
              ? "border-signal/30 bg-signal/10 text-signal"
              : preview
                ? "border-hyper/30 bg-hyper/10 text-hyper-soft"
                : "border-white/12 bg-white/4 text-ink-3",
          )}
        >
          {on ? <Check aria-hidden className="size-3" /> : !preview && <Lock aria-hidden className="size-3" />}
          {on ? t("overview.agentOn") : preview ? t("overview.agentPreview") : t("overview.agentOff")}
        </span>
      </div>
      <p className="text-[13px] leading-relaxed text-ink-2">{agent.role}</p>
      {agent.ecommerceOnly && (
        <p className="mt-auto inline-flex w-fit items-center gap-1.5 rounded-md bg-gold/10 px-2 py-0.5 text-[11px] font-medium text-gold">
          <ShoppingBag aria-hidden className="size-3" />
          {t("overview.agentOrdersOnly")}
        </p>
      )}
    </motion.li>
  );
}

function RosterSection({ client, onCount }: { client: PortalClient; onCount: (active: number) => void }) {
  const { t, number } = useI18n();
  const [roster, setRoster] = useState<Roster | null>(null);
  const [view, setView] = useState<BusinessMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await client.roster();
      onCount(next.rosters[next.businessMode].filter((agent) => agent.active).length);
      setRoster(next);
      setView((current) => current ?? next.businessMode);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("overview.rosterError"));
    }
  }, [client, onCount, t]);

  useEffect(() => {
    let cancelled = false;
    client.roster().then(
      (next) => {
        if (cancelled) return;
        onCount(next.rosters[next.businessMode].filter((agent) => agent.active).length);
        setRoster(next);
        setView((current) => current ?? next.businessMode);
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : t("overview.rosterError"));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, onCount, t]);

  if (error && !roster) {
    return (
      <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
        <p>{error}</p>
        <button
          type="button"
          onClick={load}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70"
        >
          <RotateCw aria-hidden className="size-3.5" />
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (!roster || !view) {
    return <div aria-busy="true" aria-label={t("common.loading")} className="mt-4 h-64 animate-pulse rounded-3xl bg-white/3" />;
  }

  const agents = roster.rosters[view];
  const preview = view !== roster.businessMode;
  const activeCount = agents.filter((agent) => agent.active).length;

  return (
    <section aria-label={t("overview.rosterTitle")} className="mt-6">
      <div className="surface sheen rounded-3xl p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold tracking-tight text-ink">{t("overview.modeTitle")}</h3>
            <p className="mt-1 max-w-2xl text-sm text-ink-2">{t("overview.modeBody")}</p>
          </div>
          <span
            className={cn(
              "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium",
              preview ? "border-hyper/30 bg-hyper/10 text-hyper-soft" : "border-signal/30 bg-signal/10 text-signal",
            )}
          >
            {preview ? t("overview.modePreview") : t("overview.modeActive")}
          </span>
        </div>

        <Segmented<BusinessMode>
          label={t("overview.modeLabel")}
          value={view}
          onChange={setView}
          className="mt-4 flex w-full flex-wrap rounded-2xl sm:inline-flex sm:w-auto"
          optionClassName="min-h-11 flex-1 px-4 text-center sm:flex-none"
          options={[
            {
              value: "general",
              label: (
                <span className="inline-flex items-center gap-2">
                  <Store aria-hidden className="size-4" />
                  {t("overview.modeGeneral")}
                  {roster.businessMode === "general" && <Check aria-hidden className="size-3.5 text-signal" />}
                </span>
              ),
            },
            {
              value: "ecommerce",
              label: (
                <span className="inline-flex items-center gap-2">
                  <ShoppingBag aria-hidden className="size-4" />
                  {t("overview.modeEcommerce")}
                  {roster.businessMode === "ecommerce" && <Check aria-hidden className="size-3.5 text-signal" />}
                </span>
              ),
            },
          ]}
        />
        <p className="mt-2 text-xs text-ink-3">
          {view === "general" ? t("overview.modeGeneralBody") : t("overview.modeEcommerceBody")}
        </p>
      </div>

      <h3 className="mt-6 flex flex-wrap items-baseline gap-x-3 text-base font-semibold tracking-tight text-ink">
        {t("overview.rosterTitle")}
        <span className="text-xs font-normal text-ink-3">
          {preview
            ? t("overview.rosterPreviewCount", { total: number(agents.length) })
            : t("overview.rosterCount", { active: number(activeCount), total: number(agents.length) })}
        </span>
      </h3>
      <ul className="relative mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <AnimatePresence mode="popLayout" initial={false}>
          {agents.map((agent) => (
            <AgentCard key={`${view}-${agent.key}`} agent={agent} preview={preview} />
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

export function OverviewTab({ client, overview, currency, mode }: OverviewTabProps) {
  const { t, number } = useI18n();
  const [activeAgents, setActiveAgents] = useState<number | null>(null);
  const loadUsage = useCallback(() => client.knowledge.usage(), [client]);
  const trend = overview?.tasksTrendPct ?? null;
  const TrendIcon = trend !== null && trend < 0 ? TrendingDown : TrendingUp;

  return (
    <div>
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <KpiCard
          icon={<Zap aria-hidden className="size-3.5" />}
          label={t("kpi.actions")}
          value={overview?.tasksCompleted30d != null ? number(overview.tasksCompleted30d) : "--"}
          unit={overview?.tasksCompleted30d != null ? t("kpi.actionsUnit") : null}
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
                    {number(Math.round(trend))}%
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <Sparkline
                    data={overview.tasksDaily}
                    label={t("kpi.actionsPerDay")}
                    format={(v) => t("kpi.actionsValue", { count: number(v) })}
                  />
                </div>
              </div>
            ) : (
              <FooterNote>{overview ? t("kpi.actionsEmpty") : t("common.loading")}</FooterNote>
            )
          }
        />
        <KpiCard
          icon={<Clock3 aria-hidden className="size-3.5" />}
          label={t("kpi.time")}
          value={overview?.estimatedHoursSaved != null ? number(overview.estimatedHoursSaved, 1) : "--"}
          unit={overview?.estimatedHoursSaved != null ? t("kpi.timeUnit") : null}
          footer={<FooterNote>{t("kpi.timeNote")}</FooterNote>}
        />
        <KpiCard
          icon={<Gauge aria-hidden className="size-3.5" />}
          label={t("kpi.response")}
          value={overview?.avgResponseSeconds != null ? number(overview.avgResponseSeconds, 1) : "--"}
          unit={overview?.avgResponseSeconds != null ? t("kpi.responseUnit") : null}
          footer={<FooterNote>{t("kpi.responseNote")}</FooterNote>}
        />
        <KpiCard
          icon={<Users aria-hidden className="size-3.5" />}
          label={t("overview.agentsLabel")}
          value={activeAgents !== null ? number(activeAgents) : "--"}
          unit={activeAgents !== null ? t("overview.agentsUnit") : null}
          footer={
            <FooterNote>
              {overview ? (
                <span className="inline-flex items-center gap-1.5">
                  <Bot aria-hidden className="size-3.5 shrink-0" />
                  {t("overview.agentsNote", { count: number(overview.learnedSkillCount) })}
                </span>
              ) : (
                t("common.loading")
              )}
            </FooterNote>
          }
        />
      </motion.div>

      <RosterSection client={client} onCount={setActiveAgents} />

      <UsageCostMeter load={loadUsage} className="mt-8" />

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={SPRING} className="mt-8">
        <ModeWorkspace client={client} currency={currency} mode={mode} key={mode} />
      </motion.div>
    </div>
  );
}
