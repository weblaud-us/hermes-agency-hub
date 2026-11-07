"use client";

import { motion } from "motion/react";
import {
  BadgeCheck,
  BookOpenCheck,
  FlaskConical,
  KeyRound,
  LayoutGrid,
  LogIn,
  RadioTower,
  RotateCw,
  ShieldAlert,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { AgentSandboxDrawer } from "@/components/portal/AgentSandboxDrawer";
import { ApprovalCenter } from "@/components/portal/ApprovalCenter";
import { BusinessKnowledgeSetup } from "@/components/portal/BusinessKnowledgeSetup";
import { ChannelsHub } from "@/components/portal/ChannelsHub";
import { OverviewTab } from "@/components/portal/OverviewTab";
import { PortalHeader } from "@/components/portal/PortalHeader";
import { RoiGrowthFunnel } from "@/components/portal/RoiGrowthFunnel";
import { SocialAutopilotMonitor } from "@/components/portal/SocialAutopilotMonitor";
import { SecretInput } from "@/components/ui/SecretInput";
import { Segmented } from "@/components/ui/Segmented";
import { ToastProvider } from "@/components/ui/Toaster";
import {
  ApiError,
  connectPortal,
  consumeLinkToken,
  loadToken,
  saveToken,
  type PortalConnection,
  type PortalOverview,
  type PortalProfile,
} from "@/lib/portal-api";
import { fetchMe, goTo, logout, type SessionUser } from "@/lib/auth";
import { LanguageToggle, LocaleProvider, useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages";
import { SPRING } from "@/lib/motion";

const OVERVIEW_POLL_MS = 30_000;

type Tab = "overview" | "social" | "knowledge" | "growth" | "approvals" | "channels";

const TABS: { value: Tab; label: MessageKey; icon: ReactNode }[] = [
  { value: "overview", label: "tab.overview", icon: <LayoutGrid aria-hidden className="hidden size-3.5 sm:block" /> },
  { value: "social", label: "tab.social", icon: <Sparkles aria-hidden className="hidden size-3.5 sm:block" /> },
  { value: "knowledge", label: "tab.knowledge", icon: <BookOpenCheck aria-hidden className="hidden size-3.5 sm:block" /> },
  { value: "growth", label: "tab.growth", icon: <TrendingUp aria-hidden className="hidden size-3.5 sm:block" /> },
  { value: "approvals", label: "tab.approvals", icon: <BadgeCheck aria-hidden className="hidden size-3.5 sm:block" /> },
  { value: "channels", label: "tab.channels", icon: <RadioTower aria-hidden className="hidden size-3.5 sm:block" /> },
];

/** Old links and bookmarks: the sections that were folded into another tab. */
const LEGACY_TABS: Record<string, Tab> = { workspace: "overview", briefings: "channels", vault: "channels" };

function tabFrom(value: string | null): Tab {
  if (value && value in LEGACY_TABS) return LEGACY_TABS[value];
  return TABS.find((tab) => tab.value === value)?.value ?? "overview";
}

function companyFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function PortalSkeleton() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6" aria-busy="true" aria-label="Loading your portal">
      <div className="h-[60px] animate-pulse rounded-2xl bg-white/4" />
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-40 animate-pulse rounded-2xl bg-white/4" />
        ))}
      </div>
      <div className="mt-6 h-96 animate-pulse rounded-3xl bg-white/3" />
    </div>
  );
}

function PortalForbidden({ company }: { company: string }) {
  const { t } = useI18n();

  async function switchAccount() {
    await logout();
    goTo("/login?tab=client");
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div role="alert" className="surface sheen w-full max-w-md rounded-3xl p-6 text-center sm:p-8">
        <ShieldAlert aria-hidden className="mx-auto size-7 text-warn" />
        <p className="mt-3 font-mono text-xs uppercase tracking-[0.18em] text-ink-3">{company}</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink">{t("portal.forbiddenTitle")}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">{t("portal.forbiddenBody")}</p>
        <button
          type="button"
          onClick={switchAccount}
          className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian"
        >
          <LogIn aria-hidden className="size-4" />
          {t("portal.forbiddenAction")}
        </button>
      </div>
    </main>
  );
}

function PortalGate({
  company,
  subdomain,
  rejected,
  onSubmit,
}: {
  company: string;
  subdomain: string;
  rejected: boolean;
  onSubmit: (token: string) => Promise<string | null>;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(rejected ? t("portal.gateRejected") : null);
  const inputId = useId();
  const errorId = useId();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = value.trim();
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    const message = await onSubmit(token);
    setBusy(false);
    if (message) setError(message);
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING}
        className="surface sheen w-full max-w-md rounded-3xl p-6 sm:p-8"
      >
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-signal">{company}</p>
        <div className="flex items-start justify-between gap-3">
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">{t("portal.subtitle")}</h1>
          <LanguageToggle className="mt-2 shrink-0" />
        </div>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">{t("portal.gateBody")}</p>
        <Link
          href={`/login?tab=client&next=${encodeURIComponent(`/portal/${subdomain}`)}`}
          className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian transition-colors hover:bg-[#3ff9e2]"
        >
          <LogIn aria-hidden className="size-4" />
          {t("portal.gateSignIn")}
        </Link>
        <p className="mt-5 text-center text-xs text-ink-3">{t("portal.gateOr")}</p>
        <label htmlFor={inputId} className="mt-3 block text-sm font-medium text-ink-2">
          {t("portal.gateKey")}
        </label>
        <SecretInput
          id={inputId}
          secretName="access key"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className="mt-2"
        />
        {error && (
          <p id={errorId} role="alert" className="mt-2 text-sm text-halt-soft">
            {error}
          </p>
        )}
        <motion.button
          type="submit"
          whileTap={{ scale: 0.98 }}
          transition={SPRING}
          disabled={!value.trim() || busy}
          className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/15 px-4 text-sm font-semibold text-ink hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <KeyRound aria-hidden className="size-4" />
          {busy ? t("portal.gateOpening") : t("portal.gateOpen")}
        </motion.button>
      </motion.form>
    </main>
  );
}

function PortalBody({ subdomain }: { subdomain: string }) {
  const params = useSearchParams();
  const { t } = useI18n();
  const fallbackCompany = companyFromSlug(subdomain);

  const [connection, setConnection] = useState<PortalConnection | null>(null);
  const [overview, setOverview] = useState<PortalOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [profile, setProfile] = useState<PortalProfile | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [tab, setTab] = useState<Tab>(() => tabFrom(params.get("tab")));
  // Panels mount on first visit and stay mounted, so switching back keeps their
  // data and scroll position rather than loading again.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([tab]));

  const client = connection?.mode === "live" || connection?.mode === "mock" ? connection.client : null;

  useEffect(() => {
    let cancelled = false;
    // Saved before connecting: Strict Mode runs this effect twice in development,
    // and the first run has already removed the token from the address bar.
    const linked = consumeLinkToken();
    if (linked) saveToken(subdomain, linked);
    connectPortal(subdomain, loadToken(subdomain)).then((next) => {
      if (!cancelled) setConnection(next);
    });
    // Separate from the portal's own credential: a visitor on an access link has
    // no account, and the header simply shows no account menu.
    fetchMe().then(
      (me) => {
        if (!cancelled) setUser(me);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [subdomain]);

  const refreshProfile = useCallback(async () => {
    if (!client) return;
    try {
      setProfile(await client.profile());
    } catch {
      // The tabs that need it report their own errors.
    }
  }, [client]);

  const refreshOverview = useCallback(async () => {
    if (!client) return;
    try {
      const next = await client.overview();
      setOverview(next);
      setOverviewError(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        saveToken(subdomain, null);
        setOverview(null);
        setConnection({ mode: "signin", rejected: true });
        return;
      }
      setOverviewError(error instanceof Error ? error.message : t("portal.overviewError"));
    }
  }, [client, subdomain, t]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) await Promise.all([refreshOverview(), refreshProfile()]);
      if (!cancelled) timer = setTimeout(poll, OVERVIEW_POLL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, refreshOverview, refreshProfile]);

  function selectTab(next: Tab) {
    setTab(next);
    setVisited((current) => (current.has(next) ? current : new Set(current).add(next)));
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  }

  function signOut() {
    saveToken(subdomain, null);
    setOverview(null);
    setProfile(null);
    setChatOpen(false);
    setConnection({ mode: "signin", rejected: false });
  }

  async function submitToken(token: string): Promise<string | null> {
    saveToken(subdomain, token);
    const next = await connectPortal(subdomain, token);
    if (next.mode === "signin") {
      saveToken(subdomain, null);
      return t("portal.gateNotAccepted");
    }
    setConnection(next);
    return null;
  }

  if (!connection) return <PortalSkeleton />;
  if (connection.mode === "forbidden") return <PortalForbidden company={fallbackCompany} />;
  if (connection.mode === "signin") {
    return <PortalGate company={fallbackCompany} subdomain={subdomain} rejected={connection.rejected} onSubmit={submitToken} />;
  }
  if (!client) return <PortalSkeleton />;

  return (
    <div
      className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6"
      style={{ "--color-carbon": "rgb(13 13 18 / 0.78)" } as CSSProperties}
    >
      {client.mode === "mock" && (
        <div
          role="status"
          className="mb-4 flex items-start gap-2.5 rounded-2xl border border-warn/30 bg-warn/8 px-4 py-3 text-sm text-ink-2"
        >
          <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
          <p>
            <span className="font-semibold text-warn">{t("portal.sampleTitle")}</span> {t("portal.sampleBody")}
          </p>
        </div>
      )}
      {profile?.isDemo && (
        <div
          role="status"
          className="mb-4 flex items-start gap-2.5 rounded-2xl border border-warn/30 bg-warn/8 px-4 py-3 text-sm text-ink-2"
        >
          <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
          <p>
            <span className="font-semibold text-warn">{t("portal.demoTitle")}</span> {t("portal.demoBody")}
          </p>
        </div>
      )}

      <PortalHeader
        company={overview?.companyName ?? fallbackCompany}
        overview={overview}
        user={user}
        canSignOut={client.mode === "live" && !user}
        onAsk={() => setChatOpen(true)}
        onSignOut={signOut}
      />

      {overviewError && !overview && (
        <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
          <p>{overviewError}</p>
          <button
            type="button"
            onClick={refreshOverview}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70"
          >
            <RotateCw aria-hidden className="size-3.5" />
            {t("common.retry")}
          </button>
        </div>
      )}

      <div className="mt-6">
        <Segmented
          options={TABS.map(({ value, label, icon }) => ({
            value,
            label: (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                {icon}
                {t(label)}
                {value === "approvals" && (profile?.pendingApprovals ?? 0) > 0 && (
                  <span className="rounded-full bg-signal px-1.5 font-mono text-[10px] font-semibold leading-4 text-obsidian">
                    {profile?.pendingApprovals}
                  </span>
                )}
              </span>
            ),
          }))}
          value={tab}
          onChange={selectTab}
          label={t("portal.sectionsLabel")}
          className="max-w-full flex-wrap rounded-2xl"
          optionClassName="px-2.5 sm:px-4"
        />
      </div>

      <main className="mt-4">
        {TABS.map(({ value }) => {
          if (!visited.has(value)) return null;
          const active = tab === value;
          return (
            <motion.section
              key={value}
              role="tabpanel"
              aria-label={t(TABS.find((row) => row.value === value)!.label)}
              hidden={!active}
              initial={false}
              animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
              transition={SPRING}
            >
              {value === "overview" && (
                <OverviewTab
                  client={client}
                  overview={overview}
                  currency={profile?.currency ?? "USD"}
                  mode={profile?.businessMode ?? "general"}
                />
              )}
              {value === "social" && <SocialAutopilotMonitor client={client} onChanged={refreshProfile} />}
              {value === "knowledge" && <BusinessKnowledgeSetup client={client} onChanged={refreshOverview} />}
              {value === "growth" && <RoiGrowthFunnel client={client} />}
              {value === "approvals" && (
                <ApprovalCenter client={client} currency={profile?.currency ?? "USD"} onChanged={refreshProfile} />
              )}
              {value === "channels" && <ChannelsHub client={client} onChanged={refreshOverview} />}
            </motion.section>
          );
        })}
      </main>

      <AgentSandboxDrawer
        client={client}
        open={chatOpen}
        company={overview?.companyName ?? fallbackCompany}
        onClose={() => setChatOpen(false)}
      />
    </div>
  );
}

export function PortalApp({ subdomain }: { subdomain: string }) {
  return (
    <LocaleProvider>
      <ToastProvider>
        <PortalBody subdomain={subdomain} />
      </ToastProvider>
    </LocaleProvider>
  );
}
