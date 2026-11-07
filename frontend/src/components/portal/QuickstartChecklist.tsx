"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Rocket } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages";
import type { PortalClient } from "@/lib/portal-api";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type QuickstartTab = "knowledge" | "channels" | "social";
export type QuickstartView = "profile" | "catalog";

interface Step {
  key: "profile" | "catalog" | "channels" | "autopilot";
  title: MessageKey;
  body: MessageKey;
  action: MessageKey;
  tab: QuickstartTab;
  view?: QuickstartView;
}

const STEPS: Step[] = [
  { key: "profile", title: "quickstart.profile", body: "quickstart.profileBody", action: "quickstart.profileAction", tab: "knowledge", view: "profile" },
  { key: "catalog", title: "quickstart.catalog", body: "quickstart.catalogBody", action: "quickstart.catalogAction", tab: "knowledge", view: "catalog" },
  { key: "channels", title: "quickstart.channels", body: "quickstart.channelsBody", action: "quickstart.channelsAction", tab: "channels" },
  { key: "autopilot", title: "quickstart.autopilot", body: "quickstart.autopilotBody", action: "quickstart.autopilotAction", tab: "social" },
];

type Done = Record<Step["key"], boolean>;

const storageKey = (subdomain: string) => `portal.quickstart.collapsed.${subdomain}`;

function readCollapsed(subdomain: string): boolean {
  try {
    return localStorage.getItem(storageKey(subdomain)) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(subdomain: string, collapsed: boolean): void {
  try {
    localStorage.setItem(storageKey(subdomain), collapsed ? "1" : "0");
  } catch {
    // Storage blocked: the banner still collapses for this page's lifetime.
  }
}

/**
 * The four things a new business does before the Coordinator can work for it. Each step is
 * ticked from what is actually saved, not from what was clicked, so a step finished in
 * another tab or by the agency's team still counts. Once all four are done the banner goes.
 */
export function QuickstartChecklist({
  client,
  subdomain,
  refreshKey,
  onGo,
}: {
  client: PortalClient;
  subdomain: string;
  /** Changes whenever something that could complete a step has been saved. */
  refreshKey: number;
  onGo: (tab: QuickstartTab, view?: QuickstartView) => void;
}) {
  const { t, number } = useI18n();
  const [done, setDone] = useState<Done | null>(null);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(subdomain));

  useEffect(() => {
    let cancelled = false;
    const settle = async <T,>(read: Promise<T>, test: (value: T) => boolean) => {
      try {
        return test(await read);
      } catch {
        // A section that cannot be read is treated as not done yet, which is the safe
        // answer: the banner stays, and its link leads to where the failure is explained.
        return false;
      }
    };
    Promise.all([
      settle(client.knowledge.businessSetup(), (setup) => setup.updated_at !== null),
      settle(client.knowledge.catalog(), (catalog) => catalog.items.length > 0),
      settle(client.channels(), (channels) => channels.some((channel) => channel.status === "connected")),
      settle(client.socialAutopilot(), (social) => social.autopilotSocial),
    ]).then(([profile, catalog, channels, autopilot]) => {
      if (!cancelled) setDone({ profile, catalog, channels, autopilot });
    });
    return () => {
      cancelled = true;
    };
  }, [client, refreshKey]);

  if (!done) return null;
  const finished = STEPS.filter((step) => done[step.key]).length;
  if (finished === STEPS.length) return null;
  const next = STEPS.find((step) => !done[step.key]);

  function toggle() {
    setCollapsed((current) => {
      writeCollapsed(subdomain, !current);
      return !current;
    });
  }

  return (
    <section aria-label={t("quickstart.title")} className="mb-4 rounded-2xl border border-signal/25 bg-signal/6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-signal/15 text-signal">
          <Rocket className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">{t("quickstart.title")}</h2>
          <p className="text-xs text-ink-3">
            {t("quickstart.progress", { done: number(finished), total: number(STEPS.length) })}
            {next && collapsed ? ` • ${t("quickstart.next", { step: t(next.title) })}` : ""}
          </p>
        </div>
        {collapsed && next && (
          <button
            type="button"
            onClick={() => onGo(next.tab, next.view)}
            className="inline-flex min-h-10 items-center rounded-lg bg-signal px-3 text-[13px] font-semibold text-obsidian hover:bg-[#3ff9e2]"
          >
            {t(next.action)}
          </button>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("quickstart.expand") : t("quickstart.collapse")}
          className="inline-flex size-10 items-center justify-center rounded-lg text-ink-3 hover:bg-white/6 hover:text-ink"
        >
          <ChevronDown aria-hidden className={cn("size-4 transition-transform", collapsed && "-rotate-90")} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.ol
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING}
            className="grid gap-2 overflow-hidden px-4 pb-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            {STEPS.map((step, index) => {
              const complete = done[step.key];
              return (
                <li key={step.key} className="flex flex-col rounded-xl border border-white/8 bg-white/3 p-3">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-semibold",
                        complete ? "bg-signal text-obsidian" : "border border-white/20 text-ink-2",
                      )}
                    >
                      {complete ? <Check className="size-3.5" /> : index + 1}
                    </span>
                    <h3 className="text-[13px] font-semibold text-ink">
                      {t(step.title)}
                      {complete && <span className="sr-only"> ({t("quickstart.done")})</span>}
                    </h3>
                  </div>
                  <p className="mt-2 flex-1 text-xs leading-relaxed text-ink-3">{t(step.body)}</p>
                  <button
                    type="button"
                    onClick={() => onGo(step.tab, step.view)}
                    className={cn(
                      "mt-3 inline-flex min-h-10 items-center justify-center rounded-lg border px-3 text-[13px] font-medium",
                      complete ? "border-white/10 text-ink-3 hover:text-ink-2" : "border-signal/40 text-signal hover:bg-signal/10",
                    )}
                  >
                    {complete ? t("quickstart.review") : t(step.action)}
                  </button>
                </li>
              );
            })}
          </motion.ol>
        )}
      </AnimatePresence>
    </section>
  );
}
