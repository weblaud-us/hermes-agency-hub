"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { SectionHeading } from "@/components/landing/SectionHeading";
import { Segmented } from "@/components/ui/Segmented";
import { SPRING, riseIn, staggerContainer } from "@/lib/motion";
import { TIERS, TIER_ORDER, type TierId } from "@/lib/provisioning";
import { cn, formatCurrency, formatInteger } from "@/lib/utils";

type Billing = "retainer" | "license";

const TIER_COPY: Record<TierId, { pitch: string; retainer: string[]; license: string[] }> = {
  starter: {
    pitch: "A business that is always answered and always posting, for getting started.",
    retainer: ["24/7 inbox: WhatsApp, Messenger, Instagram", "Zero-touch social media autopilot", "Weekly ROI report"],
    license: ["Installs on one client server", "Social autopilot and inbox skills", "Generated install command"],
  },
  growth: {
    pitch: "The full specialist team for a business that wants growth, not just replies.",
    retainer: ["Everything in Presence", "Reels, ads and email specialists", "Daily executive summary and 1-tap approvals"],
    license: ["Installs on one client server", "Full shared skill library", "Self-authored skills and memory"],
  },
  enterprise: {
    pitch: "The whole growth system, with room for a busy store or several locations.",
    retainer: ["Everything in Growth", "Order desk and catalog keeper for online stores", "Dedicated resources and priority QA"],
    license: ["Sized for heavy workloads", "Automated SSL", "Full shared skill library"],
  },
};

const HOURS_PER_MONTH_FACTOR = 52 / 12;

function RoiConfigurator({
  billing,
  selected,
  onSelect,
}: {
  billing: Billing;
  selected: TierId;
  onSelect: (tier: TierId) => void;
}) {
  const [hours, setHours] = useState(20);
  const [rate, setRate] = useState(35);

  const value = hours * HOURS_PER_MONTH_FACTOR * rate;
  const cost = TIERS[selected].monthly;
  const net = value - cost;

  return (
    <div className="surface sheen mt-6 rounded-3xl p-5 sm:p-7">
      <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <h3 className="text-lg font-semibold tracking-[-0.02em] text-ink">Estimate your return</h3>
          <p className="mt-1.5 text-sm text-ink-2">Enter your own numbers. Nothing here is a guarantee of results.</p>

          <div className="mt-5 space-y-3">
            <div>
              <label htmlFor="roi-hours" className="flex items-baseline justify-between text-sm text-ink-2">
                Ops hours the agent takes over, per week
                <output htmlFor="roi-hours" className="font-mono text-sm tabular-nums text-ink">
                  {hours}h
                </output>
              </label>
              <input
                id="roi-hours"
                type="range"
                min={2}
                max={80}
                value={hours}
                onChange={(event) => setHours(Number(event.target.value))}
                className="range-input"
                style={{ "--fill": `${((hours - 2) / 78) * 100}%` } as React.CSSProperties}
              />
            </div>
            <div>
              <label htmlFor="roi-rate" className="flex items-baseline justify-between text-sm text-ink-2">
                Loaded hourly cost of that work
                <output htmlFor="roi-rate" className="font-mono text-sm tabular-nums text-ink">
                  ${rate}
                </output>
              </label>
              <input
                id="roi-rate"
                type="range"
                min={10}
                max={150}
                step={5}
                value={rate}
                onChange={(event) => setRate(Number(event.target.value))}
                className="range-input"
                style={{ "--fill": `${((rate - 10) / 140) * 100}%` } as React.CSSProperties}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col justify-between gap-4 rounded-2xl border border-white/7 bg-black/25 p-4 sm:p-5">
          <Segmented<TierId>
            label="Compare against tier"
            value={selected}
            onChange={onSelect}
            className="flex w-full"
            optionClassName="flex-1 text-center px-2"
            options={TIER_ORDER.map((id) => ({
              value: id,
              label: TIERS[id].label,
            }))}
          />
          <dl className="space-y-2.5 font-mono text-sm tabular-nums">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-3">Estimated value / mo</dt>
              <dd className="text-ink">{formatCurrency(value)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-3">Retainer / mo</dt>
              <dd className="text-ink">
                {billing === "retainer" ? `-${formatCurrency(cost)}` : "license by quote"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 border-t border-white/10 pt-2.5">
              <dt className="text-ink-2">{billing === "retainer" ? "Net / mo" : "Value to offset"}</dt>
              <dd className={cn("text-xl font-semibold", billing === "retainer" && net < 0 ? "text-warn" : "text-signal")}>
                {billing === "retainer" ? formatCurrency(net) : formatCurrency(value)}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}

export function PricingTiers() {
  const [billing, setBilling] = useState<Billing>("retainer");
  const [selected, setSelected] = useState<TierId>("growth");

  return (
    <section id="pricing" className="mx-auto max-w-7xl px-4 py-24 sm:px-6">
      <SectionHeading eyebrow="Pricing" title="One partner. One growth system. One monthly price.">
        Pick managed operations on your cluster, or install on the client&apos;s own infrastructure with a one-click
        command.
      </SectionHeading>

      <div className="mb-8 flex justify-center">
        <Segmented<Billing>
          label="Billing model"
          value={billing}
          onChange={setBilling}
          options={[
            { value: "retainer", label: "Managed Monthly Retainer" },
            { value: "license", label: "One-Click On-Premise License" },
          ]}
        />
      </div>

      <motion.div
        variants={staggerContainer}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.15 }}
        className="grid gap-4 lg:grid-cols-3"
      >
        {TIER_ORDER.map((id) => {
          const tier = TIERS[id];
          const copy = TIER_COPY[id];
          const featured = id === "growth";
          const features = billing === "retainer" ? copy.retainer : copy.license;
          const href =
            billing === "retainer"
              ? `/admin?provision=cluster&tier=${id}`
              : `/admin?provision=installer&tier=${id}`;
          return (
            <motion.article
              key={id}
              variants={riseIn}
              className={cn(
                "surface sheen flex flex-col rounded-3xl p-6 sm:p-7",
                featured && "beam-ring border-transparent lg:-my-2 lg:py-9",
              )}
            >
              <div className="relative flex flex-1 flex-col">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-base font-semibold text-ink">{tier.name}</h3>
                  {featured && (
                    <span className="rounded-full border border-signal/30 bg-signal/10 px-2.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider text-signal">
                      Most complete
                    </span>
                  )}
                </div>
                <p className="mt-2 min-h-10 text-sm text-ink-2">{copy.pitch}</p>

                <div className="mt-5 h-12 overflow-hidden">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.p
                      key={billing}
                      initial={{ opacity: 0, y: 18 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -14, transition: { duration: 0.12 } }}
                      transition={SPRING}
                      className="flex items-baseline gap-1.5"
                    >
                      {billing === "retainer" ? (
                        <>
                          <span className="text-4xl font-semibold tracking-[-0.03em] text-ink tabular-nums">
                            {formatCurrency(tier.monthly)}
                          </span>
                          <span className="text-sm text-ink-3">/mo</span>
                          <span className="ml-1 text-xs text-ink-3">+ {formatCurrency(tier.setup)} setup</span>
                        </>
                      ) : (
                        <>
                          <span className="text-4xl font-semibold tracking-[-0.03em] text-ink">Custom</span>
                          <span className="text-sm text-ink-3">quote</span>
                        </>
                      )}
                    </motion.p>
                  </AnimatePresence>
                </div>

                <p className="mt-4 rounded-xl border border-white/7 bg-black/20 px-3 py-2 font-mono text-xs tabular-nums text-ink-2">
                  {tier.memory} RAM / {tier.cpus} vCPU · {formatInteger(tier.conversations)} conversations
                </p>

                <ul className="mt-5 flex-1 space-y-2.5">
                  {features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5 text-sm text-ink-2">
                      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-signal" />
                      {feature}
                    </li>
                  ))}
                </ul>

                <Link
                  href={href}
                  className={cn(
                    "mt-7 inline-flex min-h-12 items-center justify-center gap-2 rounded-full text-sm font-semibold transition-colors",
                    featured
                      ? "bg-signal text-obsidian hover:bg-[#3ff9e2]"
                      : "border border-white/12 bg-white/4 text-ink hover:border-white/25 hover:bg-white/7",
                  )}
                >
                  {billing === "retainer" ? "Deploy this tier" : "Generate installer"}
                  <ArrowRight aria-hidden className="size-4" />
                </Link>
              </div>
            </motion.article>
          );
        })}
      </motion.div>

      <RoiConfigurator billing={billing} selected={selected} onSelect={setSelected} />
    </section>
  );
}
