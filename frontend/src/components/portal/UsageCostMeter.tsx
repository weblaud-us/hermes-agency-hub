"use client";

import { motion } from "motion/react";
import { Calculator as CalculatorIcon, Coins, Film, ImageIcon, RotateCw, Sparkles, TextCursorInput } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { SpotlightCard } from "@/components/ui/SpotlightCard";
import {
  estimateMonth,
  usd,
  type AiPresetKey,
  type CalculatorInputs,
  type UsageSummary,
} from "@/lib/knowledge-api";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

const PRESET_ORDER: AiPresetKey[] = ["ultra_low_cost", "balanced", "premium_reasoning"];
const PRESET_LABEL: Record<AiPresetKey, string> = {
  ultra_low_cost: "Ultra low cost",
  balanced: "Balanced",
  premium_reasoning: "Premium reasoning",
};

interface UsageCostMeterProps {
  /** Loads this month's usage. Pass a stable function: a new one on every render reloads. */
  load: () => Promise<UsageSummary>;
  className?: string;
}

const compact = (value: number | null) =>
  value === null ? "Not recorded" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export function UsageCostMeter({ load, className }: UsageCostMeterProps) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setUsage(await load());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Usage could not be loaded.");
    } finally {
      setBusy(false);
    }
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (next) => {
        if (cancelled) return;
        setUsage(next);
        setError(null);
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Usage could not be loaded.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (!usage) {
    if (error) {
      return (
        <div role="alert" className={cn("flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft", className)}>
          <p>{error}</p>
          <button type="button" onClick={refresh} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70">
            <RotateCw aria-hidden className="size-3.5" />
            Try again
          </button>
        </div>
      );
    }
    return <div aria-busy="true" aria-label="Loading AI usage" className={cn("h-72 animate-pulse rounded-3xl bg-white/3", className)} />;
  }

  return (
    <section aria-label="AI usage and cost estimate" className={cn("space-y-4", className)}>
      <SpotlightCard className="rounded-3xl p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-ink">
              <Coins aria-hidden className="size-4 text-signal" />
              AI usage & cost estimate
            </h2>
            <p className="mt-1 text-xs text-ink-3">
              {monthName(usage.period)} so far. Based on the {usage.preset_label} preset
              {usage.preset_selected ? "" : " (none chosen yet, so this is the default)"}.
            </p>
            {usage.engines && (
              <p className="mt-1 font-mono text-[11px] text-ink-3">
                Engines: {Object.entries(usage.engines).map(([kind, name]) => `${kind} ${name}`).join(" · ")}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            aria-label="Refresh usage"
            className="inline-flex size-11 items-center justify-center rounded-xl border border-white/12 text-ink-2 transition-colors hover:border-white/25 hover:text-ink disabled:opacity-50"
          >
            <RotateCw aria-hidden className={cn("size-4", busy && "animate-spin-slow")} />
          </button>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat icon={<TextCursorInput aria-hidden className="size-3.5" />} label="Input tokens" value={compact(usage.input_tokens)} exact={usage.input_tokens} />
          <Stat icon={<Sparkles aria-hidden className="size-3.5" />} label="Output tokens" value={compact(usage.output_tokens)} exact={usage.output_tokens} />
          <Stat icon={<ImageIcon aria-hidden className="size-3.5" />} label="Branded images" value={String(usage.images_generated)} exact={usage.images_generated} />
          <Stat icon={<Film aria-hidden className="size-3.5" />} label="Reels" value={usage.reels_generated === null ? "Not tracked yet" : String(usage.reels_generated)} exact={usage.reels_generated} />
        </dl>

        <CostBreakdown usage={usage} />
      </SpotlightCard>

      <CostCalculator usage={usage} />

      <details className="rounded-2xl border border-white/8 bg-white/3 px-4 py-3 text-xs text-ink-3">
        <summary className="min-h-9 cursor-pointer text-ink-2">How these estimates are made</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
          {usage.assumptions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function monthName(period: string): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function Stat({ icon, label, value, exact }: { icon: ReactNode; label: string; value: string; exact: number | null }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/3 p-3.5">
      <dt className="flex items-center gap-1.5 text-xs text-ink-3">
        {icon}
        {label}
      </dt>
      <dd
        title={exact === null ? undefined : exact.toLocaleString("en-US")}
        className={cn("mt-2 font-mono tabular-nums text-ink", exact === null ? "text-sm text-ink-3" : "text-xl font-semibold tracking-tight")}
      >
        {value}
      </dd>
    </div>
  );
}

function CostBreakdown({ usage }: { usage: UsageSummary }) {
  const parts = [
    { key: "text", label: "Conversations (tokens)", value: usage.cost_text_usd, tone: "bg-signal" },
    { key: "images", label: "Branded images", value: usage.cost_images_usd, tone: "bg-hyper" },
    { key: "reels", label: "Reels", value: usage.cost_reels_usd, tone: "bg-gold" },
  ];
  const total = usage.cost_total_usd;
  const sum = parts.reduce((accumulator, part) => accumulator + (part.value ?? 0), 0);

  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">Estimated cost this month</h3>
        <p className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-ink">
          {total === null ? <span className="text-sm font-normal text-ink-3">Not enough data</span> : usd(total)}
        </p>
      </div>

      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-white/8" role="img" aria-label="Share of the estimate by cost type">
        {sum > 0 &&
          parts.map((part) =>
            part.value ? (
              <motion.span
                key={part.key}
                initial={false}
                animate={{ flexGrow: part.value }}
                transition={SPRING}
                className={cn("block h-full min-w-px", part.tone)}
                style={{ flexBasis: 0 }}
              />
            ) : null,
          )}
      </div>

      <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
        {parts.map((part) => (
          <li key={part.key} className="flex items-center justify-between gap-2 rounded-xl border border-white/8 px-3 py-2">
            <span className="flex min-w-0 items-center gap-2 text-ink-2">
              <span aria-hidden className={cn("size-2 shrink-0 rounded-full", part.tone)} />
              <span className="truncate">{part.label}</span>
            </span>
            <span className="font-mono tabular-nums text-ink">{part.value === null ? "--" : usd(part.value)}</span>
          </li>
        ))}
      </ul>
      {usage.cost_text_usd === null && (
        <p className="mt-2 text-xs text-ink-3">
          Your Coordinator has not recorded token counts for this month, so the conversation cost is unknown rather than zero.
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- the calculator
function CostCalculator({ usage }: { usage: UsageSummary }) {
  const [inputs, setInputs] = useState<CalculatorInputs>(usage.calculator);
  const set = (patch: Partial<CalculatorInputs>) => setInputs((current) => ({ ...current, ...patch }));

  const perPreset = useMemo(
    () =>
      PRESET_ORDER.map((key) => ({
        key,
        total: estimateMonth(usage.pricing[key], inputs),
      })),
    [usage.pricing, inputs],
  );
  const selected = usage.pricing[usage.preset];
  const selectedTotal = perPreset.find((row) => row.key === usage.preset)?.total ?? 0;
  const perMessage = (selected.input_per_mtok * inputs.input_tokens_per_message + selected.output_per_mtok * inputs.output_tokens_per_message) / 1_000_000;
  const cheapest = Math.min(...perPreset.map((row) => row.total));
  const dearest = Math.max(...perPreset.map((row) => row.total), 0.0001);

  return (
    <SpotlightCard className="rounded-3xl p-5 sm:p-6" glow="99 102 241">
      <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-ink">
        <CalculatorIcon aria-hidden className="size-4 text-hyper-soft" />
        Monthly cost calculator
      </h2>
      <p className="mt-1 text-xs text-ink-3">Slide to see what a month would cost at a different volume.</p>

      <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Slider label="Customer messages per day" value={inputs.messages_per_day} min={0} max={500} step={5} onChange={(value) => set({ messages_per_day: value })} />
          <Slider label="Image posts per month" value={inputs.image_posts_per_month} min={0} max={120} step={1} onChange={(value) => set({ image_posts_per_month: value })} />
          <Slider label="Reels per month" value={inputs.reels_per_month} min={0} max={60} step={1} onChange={(value) => set({ reels_per_month: value })} />
        </div>

        <div>
          <div className="rounded-2xl border border-white/8 bg-white/3 p-4" aria-live="polite">
            <p className="text-xs text-ink-3">Estimated total on {PRESET_LABEL[usage.preset]}</p>
            <p className="mt-1 font-mono text-3xl font-semibold tabular-nums tracking-tight text-ink">{usd(selectedTotal)}<span className="ml-1 text-xs font-normal text-ink-3">/ month</span></p>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <Unit label="Per image post" value={usd(selected.per_image, 3)} />
              <Unit label="Per reel" value={usd(selected.per_reel, 3)} />
              <Unit label="Per message" value={usd(perMessage, 4)} />
            </dl>
          </div>

          <ul className="mt-3 space-y-2" aria-label="The same month on each preset">
            {perPreset.map((row) => (
              <li key={row.key} className={cn("rounded-xl border px-3 py-2", row.key === usage.preset ? "border-signal/35 bg-signal/6" : "border-white/8")}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-ink-2">
                    {PRESET_LABEL[row.key]}
                    {row.key === usage.preset && <span className="ml-2 font-mono text-[10.5px] uppercase tracking-wider text-signal">current</span>}
                    {row.total === cheapest && row.key !== usage.preset && <span className="ml-2 font-mono text-[10.5px] uppercase tracking-wider text-ink-3">lowest</span>}
                  </span>
                  <span className="font-mono tabular-nums text-ink">{usd(row.total)}</span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
                  <motion.div initial={false} animate={{ scaleX: row.total / dearest }} transition={SPRING} className={cn("h-full origin-left rounded-full", row.key === usage.preset ? "bg-signal" : "bg-white/40")} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </SpotlightCard>
  );
}

function Unit({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-3">{label}</dt>
      <dd className="mt-0.5 font-mono tabular-nums text-ink">{value}</dd>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  const id = useId();
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm text-ink-2">
          {label}
        </label>
        <output htmlFor={id} className="font-mono text-sm tabular-nums text-ink">
          {value}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 h-11 w-full cursor-pointer accent-[#00f5d4]"
      />
    </div>
  );
}
