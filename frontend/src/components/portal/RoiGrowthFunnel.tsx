"use client";

import { motion } from "motion/react";
import { ArrowDownRight, ArrowUpRight, Minus, RotateCw, TrendingDown, TrendingUp } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { riseIn, SPRING, staggerContainer } from "@/lib/motion";
import type { PortalClient, RoiFunnel, RoiReport, RoiResult } from "@/lib/portal-api";
import { cn } from "@/lib/utils";

function Panel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <motion.section variants={riseIn} className={cn("surface min-w-0 rounded-2xl p-4 sm:p-5", className)}>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <div className="mt-4">{children}</div>
    </motion.section>
  );
}

function EmptyNote({ title, body }: { title: string; body: string }) {
  return (
    <div className="surface rounded-2xl px-5 py-10 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-2">{body}</p>
    </div>
  );
}

/**
 * A stepped bar per stage, so the widths compare directly. One hue, with stage names,
 * values and step rates always in text, so nothing depends on reading the colour.
 */
function Funnel({ funnel, ecommerce }: { funnel: RoiFunnel; ecommerce: boolean }) {
  const { t, number, percent } = useI18n();
  const stages = [
    { label: t("roi.funnelInquiries"), value: funnel.totalInquiries, shade: "bg-signal/35" },
    { label: t("roi.funnelQualified"), value: funnel.qualifiedLeads, shade: "bg-signal/60" },
    { label: ecommerce ? t("roi.funnelOrders") : t("roi.funnelBookings"), value: funnel.confirmedOutcomes, shade: "bg-signal" },
  ];
  const top = Math.max(1, funnel.totalInquiries);

  const rates = stages.map((stage, index) => {
    if (index === 0) return null;
    const previous = stages[index - 1].value;
    return previous > 0 ? (stage.value / previous) * 100 : null;
  });
  const lowest = rates.reduce<number | null>((worst, rate) => (rate !== null && (worst === null || rate < worst) ? rate : worst), null);

  return (
    <div>
      <ol className="space-y-3">
        {stages.map((stage, index) => {
          const rate = rates[index];
          return (
            <li key={stage.label}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-sm text-ink-2">{stage.label}</span>
                <span className="font-mono text-lg font-semibold tabular-nums text-ink">{number(stage.value)}</span>
              </div>
              <div className="mt-1.5 h-8 overflow-hidden rounded-md bg-white/4">
                <motion.div
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: stage.value / top }}
                  transition={{ ...SPRING, delay: index * 0.08 }}
                  className={cn("h-full origin-left rounded-r-sm", stage.shade)}
                />
              </div>
              {rate !== null && (
                <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
                  <span className="tabular-nums">{t("roi.stepOf", { percent: percent(Math.round(rate * 10) / 10) })}</span>
                  {rate === lowest && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-warn/30 bg-warn/8 px-1.5 py-0.5 text-[11px] font-medium text-warn">
                      <ArrowDownRight aria-hidden className="size-3" />
                      {t("roi.biggestDrop")}
                    </span>
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {funnel.conversionRate !== null && (
        <p className="mt-4 border-t border-white/7 pt-3 text-sm text-ink-2">{t("roi.overall", { percent: percent(funnel.conversionRate) })}</p>
      )}
    </div>
  );
}

function Delta({ before, now, format }: { before: number; now: number; format: (value: number) => string }) {
  const { t } = useI18n();
  const change = now - before;
  const Icon = change > 0 ? ArrowUpRight : change < 0 ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center justify-end gap-1 font-mono tabular-nums",
        change > 0 ? "text-signal" : change < 0 ? "text-warn" : "text-ink-3",
      )}
      title={t("roi.change")}
    >
      <Icon aria-hidden className="size-3.5" />
      {change > 0 ? "+" : ""}
      {format(change)}
    </span>
  );
}

function Comparison({ report, funnel, result, ecommerce }: { report: RoiReport; funnel: RoiFunnel; result: RoiResult; ecommerce: boolean }) {
  const { t, number, percent, money } = useI18n();
  const baseline = report.baseline;
  if (!baseline) return null;
  const count = (value: number) => number(value, 1);
  const cash = (value: number) => money(value, report.currency);
  const rows = [
    { label: t("roi.rowInquiries"), before: baseline.monthlyInquiries, now: funnel.totalInquiries, format: count },
    { label: t("roi.rowConversion"), before: baseline.conversionRate, now: funnel.conversionRate ?? 0, format: percent },
    { label: ecommerce ? t("roi.rowOrders") : t("roi.rowBookings"), before: result.baselineOutcomes, now: result.currentOutcomes, format: count },
    { label: t("roi.rowProfit"), before: result.baselineGrossProfit, now: result.currentGrossProfit, format: cash },
  ];
  return (
    <div className="thin-scroll -mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[30rem] text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-3">
            <th scope="col" className="pb-2 font-medium">{t("roi.metric")}</th>
            <th scope="col" className="pb-2 text-right font-medium">{t("roi.before")}</th>
            <th scope="col" className="pb-2 text-right font-medium">{t("roi.thisMonth")}</th>
            <th scope="col" className="pb-2 text-right font-medium">{t("roi.change")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-white/6">
              <th scope="row" className="py-2.5 pr-3 text-left font-normal text-ink-2">{row.label}</th>
              <td className="py-2.5 text-right font-mono tabular-nums text-ink-3">{row.format(row.before)}</td>
              <td className="py-2.5 text-right font-mono font-medium tabular-nums text-ink">{row.format(row.now)}</td>
              <td className="py-2.5 pl-3 text-right">
                <Delta before={row.before} now={row.now} format={row.format} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Line({ label, value, emphasis, sign }: { label: string; value: string; emphasis?: boolean; sign?: "-" | "=" }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-1.5", emphasis && "border-t border-white/10 pt-2.5")}>
      <dt className={cn("min-w-0 text-sm", emphasis ? "font-medium text-ink" : "text-ink-2")}>
        {sign === "-" && <span aria-hidden className="mr-1.5 text-ink-3">−</span>}
        {label}
      </dt>
      <dd className={cn("shrink-0 font-mono tabular-nums", emphasis ? "font-semibold text-ink" : "text-ink-2")}>{value}</dd>
    </div>
  );
}

function RoiCard({ report, result }: { report: RoiReport; result: RoiResult }) {
  const { t, money, percent, number } = useI18n();
  const cash = (value: number) => money(value, report.currency);
  const roi = result.roiPercent;
  const verdict =
    roi === null ? t("roi.noInvestment") : roi > 0 ? t("roi.positive") : roi < 0 ? t("roi.negative") : t("roi.even");
  const Icon = roi !== null && roi < 0 ? TrendingDown : TrendingUp;

  return (
    <div>
      <div className="rounded-xl border border-white/8 bg-white/3 p-4">
        <p className="text-xs font-medium text-ink-2">{t("roi.percent")}</p>
        <p className="mt-1 flex items-center gap-2 font-mono text-4xl font-semibold tabular-nums tracking-tight text-ink">
          {roi !== null && <Icon aria-hidden className={cn("size-7", roi < 0 ? "text-warn" : "text-signal")} />}
          {roi === null ? "--" : percent(roi)}
        </p>
        <p className="mt-3 text-xs font-medium text-ink-2">{t("roi.lineNet")}</p>
        <p className="mt-0.5 font-mono text-xl font-semibold tabular-nums text-ink">{cash(result.netValue)}</p>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">{verdict}</p>
      </div>

      <dl className="mt-3">
        <Line label={t("roi.lineCurrent")} value={cash(result.currentGrossProfit)} />
        <p className="-mt-1 pb-1 text-xs text-ink-3">
          {t("roi.working", { outcomes: number(result.currentOutcomes), value: cash(result.valuePerOutcome) })}
        </p>
        <Line label={t("roi.lineBaseline")} value={cash(result.baselineGrossProfit)} sign="-" />
        <Line label={t("roi.lineIncremental")} value={cash(result.incrementalGrossProfit)} emphasis />
        <Line label={t("roi.lineRetainer")} value={cash(result.retainer)} />
        <Line label={t("roi.lineAds")} value={cash(result.adSpend)} />
        <Line label={t("roi.lineInvestment")} value={cash(result.totalInvestment)} emphasis />
        <Line label={t("roi.lineNet")} value={cash(result.netValue)} emphasis />
      </dl>
    </div>
  );
}

export function RoiGrowthFunnel({ client }: { client: PortalClient }) {
  const { t, month } = useI18n();
  const [period, setPeriod] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<RoiReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await client.roi(period);
      setReport(next);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("roi.error"));
    }
  }, [client, period, t]);

  useEffect(() => {
    let cancelled = false;
    client.roi(period).then(
      (next) => {
        if (!cancelled) {
          setReport(next);
          setError(null);
        }
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : t("roi.error"));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, period, t]);

  if (error && !report) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
        <p>{error}</p>
        <button type="button" onClick={load} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70">
          <RotateCw aria-hidden className="size-3.5" />
          {t("common.retry")}
        </button>
      </div>
    );
  }

  if (!report) {
    return (
      <div aria-busy="true" aria-label={t("common.loading")} className="grid gap-3 lg:grid-cols-2">
        <div className="h-72 animate-pulse rounded-2xl bg-white/4" />
        <div className="h-72 animate-pulse rounded-2xl bg-white/4" />
      </div>
    );
  }

  const ecommerce = report.businessMode === "ecommerce";
  const periods = Array.from(new Set([report.period, ...report.availablePeriods])).sort().reverse();

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-ink">{t("roi.title")}</h2>
        <label className="flex items-center gap-2 text-xs text-ink-3">
          {t("roi.month")}
          <select
            value={report.period}
            onChange={(event) => setPeriod(event.target.value)}
            className="field min-h-10 w-auto py-1.5 text-xs"
          >
            {periods.map((value) => (
              <option key={value} value={value} className="bg-[#101016]">
                {month(value)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!report.funnel ? (
        <EmptyNote title={t("roi.emptyMonthTitle")} body={t("roi.emptyMonthBody")} />
      ) : (
        <motion.div key={report.period} variants={staggerContainer} initial="hidden" animate="show" className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="grid min-w-0 grid-cols-1 gap-3">
            <Panel title={t("roi.funnelTitle")}>
              <Funnel funnel={report.funnel} ecommerce={ecommerce} />
            </Panel>
            {report.result && (
              <Panel title={t("roi.compareTitle")}>
                <Comparison report={report} funnel={report.funnel} result={report.result} ecommerce={ecommerce} />
              </Panel>
            )}
          </div>
          {report.result ? (
            <Panel title={t("roi.formulaTitle")}>
              <RoiCard report={report} result={report.result} />
            </Panel>
          ) : (
            <motion.div variants={riseIn}>
              <EmptyNote title={t("roi.noBaselineTitle")} body={t("roi.noBaselineBody")} />
            </motion.div>
          )}
        </motion.div>
      )}
    </div>
  );
}
