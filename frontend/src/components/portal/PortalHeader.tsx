"use client";

import { motion } from "motion/react";
import { LogOut, MessageSquareText } from "lucide-react";
import { ProfileMenu } from "@/components/auth/ProfileMenu";
import { StatusOrb, type OrbTone } from "@/components/ui/StatusOrb";
import type { SessionUser } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages";
import type { AgentStatus, PortalOverview } from "@/lib/portal-api";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

const STATUS: Record<AgentStatus, { tone: OrbTone; label: MessageKey; className: string }> = {
  online: { tone: "signal", label: "status.online", className: "border-signal/30 bg-signal/10 text-signal" },
  degraded: { tone: "warn", label: "status.degraded", className: "border-warn/30 bg-warn/10 text-warn" },
  offline: { tone: "halt", label: "status.offline", className: "border-halt/35 bg-halt/10 text-halt-soft" },
};

function initials(company: string): string {
  const words = company.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : company.slice(0, 2)).toUpperCase();
}

interface PortalHeaderProps {
  company: string;
  overview: PortalOverview | null;
  /** The signed-in account. Null on an access link, which has no account behind it. */
  user: SessionUser | null;
  canSignOut: boolean;
  onAsk: () => void;
  onSignOut: () => void;
}

export function PortalHeader({ company, overview, user, canSignOut, onAsk, onSignOut }: PortalHeaderProps) {
  const { t, number } = useI18n();
  const status = overview ? STATUS[overview.agentStatus] : null;

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
            <span className="font-normal text-ink-3"> • {t("portal.subtitle")}</span>
          </h1>
        </div>

        {status ? (
          <p
            role="status"
            title={t("status.uptimeNote")}
            className={cn(
              "inline-flex min-h-8 items-center gap-2 rounded-full border px-3 font-mono text-xs tabular-nums",
              status.className,
            )}
          >
            <StatusOrb tone={status.tone} pulse={overview?.agentStatus === "online"} />
            {t(status.label)}
            {overview?.uptimePercentage != null && (
              <span className="text-ink-2">• {t("status.uptime", { percent: `${number(overview.uptimePercentage, 2)}%` })}</span>
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
            {t("portal.ask")}
            <span className="hidden font-medium opacity-70 md:inline">{t("portal.askExtra")}</span>
          </motion.button>
          {canSignOut && (
            <button
              type="button"
              onClick={onSignOut}
              aria-label={t("common.signOut")}
              title={t("common.signOut")}
              className="inline-flex size-10 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-white/6 hover:text-ink"
            >
              <LogOut aria-hidden className="size-4" />
            </button>
          )}
          {user && <ProfileMenu user={user} />}
        </div>
      </div>
    </header>
  );
}
