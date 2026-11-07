"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check } from "lucide-react";
import { useState } from "react";
import { SectionHeading } from "@/components/landing/SectionHeading";
import { Segmented } from "@/components/ui/Segmented";
import { SpotlightCard } from "@/components/ui/SpotlightCard";
import { SPRING } from "@/lib/motion";

type Vertical = "commerce" | "leads" | "exec";

const VERTICALS: Record<
  Vertical,
  {
    tab: string;
    skill: string;
    title: string;
    summary: string;
    points: string[];
    manifest: string[];
  }
> = {
  commerce: {
    tab: "E-Commerce",
    skill: "catalog-keeper-ecommerce",
    title: "E-Commerce Catalog & Order Lookup",
    summary: "Keeps stock accurate, answers order and stock questions from the store's own data, and hands off anything that moves money.",
    points: [
      "Finds the order before it answers",
      "Only discusses an order with the address that placed it",
      "Escalates cancellations, refunds and address changes",
    ],
    manifest: [
      "name: catalog-keeper-ecommerce",
      "description: Keep products, variants and stock",
      "  accurate, and look up an order and its",
      "  shipment status for the customer.",
    ],
  },
  leads: {
    tab: "Lead Generation",
    skill: "sales-rep-inbox",
    title: "Sales Rep Inbox & Lead Qualifier",
    summary: "Answers every new message, scores the lead Hot or Warm, and captures the booking or enquiry.",
    points: [
      "Works out need, authority, budget and timeline",
      "Asks at most two questions per reply",
      "Scores each lead Hot or Warm and records it",
    ],
    manifest: [
      "name: sales-rep-inbox",
      "description: Answer new messages, qualify the",
      "  lead against need, authority, budget and",
      "  timeline, and capture the booking.",
    ],
  },
  exec: {
    tab: "Executive Ops",
    skill: "daily-executive-briefing",
    title: "Daily Executive Briefing",
    summary: "A scheduled morning summary of what the agent handled and what needs a human decision today.",
    points: [
      "Runs on a cron schedule, 08:00 UTC by default",
      "Draws on the tenant's persistent memory",
      "Sends to the channel the client already uses",
    ],
    manifest: [
      "name: daily-executive-briefing",
      "description: Summarise overnight activity",
      "  and flag decisions that need a person.",
      "schedule: 0 8 * * *",
    ],
  },
};

export function VerticalSkills() {
  const [vertical, setVertical] = useState<Vertical>("commerce");
  const active = VERTICALS[vertical];

  return (
    <section id="skills" className="mx-auto max-w-7xl px-4 py-24 sm:px-6">
      <SectionHeading eyebrow="Vertical Skills" title="Start with skills written for the job.">
        Mount a shared agency library read-only into every tenant, then let each agent add its own skills as it learns
        the client&apos;s business.
      </SectionHeading>

      <div className="mb-6 flex justify-center">
        <Segmented<Vertical>
          label="Vertical"
          value={vertical}
          onChange={setVertical}
          options={(Object.keys(VERTICALS) as Vertical[]).map((key) => ({ value: key, label: VERTICALS[key].tab }))}
        />
      </div>

      <SpotlightCard className="mx-auto max-w-5xl overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={vertical}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8, transition: { duration: 0.12 } }}
            transition={SPRING}
            className="grid gap-6 p-5 sm:p-8 md:grid-cols-2"
          >
            <div>
              <h3 className="text-xl font-semibold tracking-[-0.02em] text-ink">{active.title}</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-ink-2">{active.summary}</p>
              <ul className="mt-5 space-y-2.5">
                {active.points.map((point) => (
                  <li key={point} className="flex items-start gap-2.5 text-sm text-ink-2">
                    <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-signal" />
                    {point}
                  </li>
                ))}
              </ul>
            </div>
            <div className="overflow-hidden rounded-2xl border border-white/7 bg-black/30">
              <div className="border-b border-white/7 px-4 py-2.5 font-mono text-[11px] text-ink-3">
                {active.skill}/SKILL.md
              </div>
              <pre className="overflow-x-auto px-4 py-4 font-mono text-xs leading-6 text-ink-2">
                <span className="text-ink-3">---</span>
                {"\n"}
                {active.manifest.join("\n")}
                {"\n"}
                <span className="text-ink-3">---</span>
              </pre>
            </div>
          </motion.div>
        </AnimatePresence>
      </SpotlightCard>
    </section>
  );
}
