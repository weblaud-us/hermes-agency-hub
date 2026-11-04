"use client";

import { motion } from "motion/react";
import { CalendarClock, FlaskConical, KeyRound, LibraryBig, RadioTower, RotateCw } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useState, type CSSProperties } from "react";
import { AgentSandboxDrawer } from "@/components/portal/AgentSandboxDrawer";
import { ChannelsMatrix } from "@/components/portal/ChannelsMatrix";
import { CronReportsFeed } from "@/components/portal/CronReportsFeed";
import { PortalHeader } from "@/components/portal/PortalHeader";
import { SkillsMemoryVault } from "@/components/portal/SkillsMemoryVault";
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
} from "@/lib/portal-api";
import { SPRING } from "@/lib/motion";

const OVERVIEW_POLL_MS = 30_000;

type Tab = "channels" | "briefings" | "vault";

const TABS: { value: Tab; label: React.ReactNode }[] = [
  {
    value: "channels",
    label: (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <RadioTower aria-hidden className="hidden size-3.5 sm:block" />
        Channels
      </span>
    ),
  },
  {
    value: "briefings",
    label: (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <CalendarClock aria-hidden className="hidden size-3.5 sm:block" />
        Briefings
      </span>
    ),
  },
  {
    value: "vault",
    label: (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <LibraryBig aria-hidden className="hidden size-3.5 sm:block" />
        Skills & Memory
      </span>
    ),
  },
];

const PANEL_NAMES: Record<Tab, string> = {
  channels: "Channels",
  briefings: "Briefings",
  vault: "Skills and memory",
};

function isTab(value: string | null): value is Tab {
  return value === "channels" || value === "briefings" || value === "vault";
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

function PortalGate({
  company,
  rejected,
  onSubmit,
}: {
  company: string;
  rejected: boolean;
  onSubmit: (token: string) => Promise<string | null>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    rejected ? "That access key is no longer valid. Ask your account manager for a new link." : null,
  );
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
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">AI Operations Portal</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          Open the secure link your account manager sent you, or paste your access key below.
        </p>
        <label htmlFor={inputId} className="mt-6 block text-sm font-medium text-ink-2">
          Access key
        </label>
        <SecretInput
          id={inputId}
          secretName="access key"
          autoFocus
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
          className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian disabled:cursor-not-allowed disabled:opacity-40"
        >
          <KeyRound aria-hidden className="size-4" />
          {busy ? "Opening your portal..." : "Open portal"}
        </motion.button>
      </motion.form>
    </main>
  );
}

function PortalBody({ subdomain }: { subdomain: string }) {
  const params = useSearchParams();
  const fallbackCompany = companyFromSlug(subdomain);

  const [connection, setConnection] = useState<PortalConnection | null>(null);
  const [overview, setOverview] = useState<PortalOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [tab, setTab] = useState<Tab>(() => {
    const requested = params.get("tab");
    return isTab(requested) ? requested : "channels";
  });
  // Panels mount on first visit and stay mounted, so switching back keeps their
  // data and scroll position rather than loading again.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([tab]));

  const client = connection && connection.mode !== "signin" ? connection.client : null;

  useEffect(() => {
    let cancelled = false;
    // Saved before connecting: Strict Mode runs this effect twice in development,
    // and the first run has already removed the token from the address bar.
    const linked = consumeLinkToken();
    if (linked) saveToken(subdomain, linked);
    connectPortal(subdomain, loadToken(subdomain)).then((next) => {
      if (!cancelled) setConnection(next);
    });
    return () => {
      cancelled = true;
    };
  }, [subdomain]);

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
      setOverviewError(error instanceof Error ? error.message : "Could not load your overview.");
    }
  }, [client, subdomain]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) await refreshOverview();
      if (!cancelled) timer = setTimeout(poll, OVERVIEW_POLL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, refreshOverview]);

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
    setChatOpen(false);
    setConnection({ mode: "signin", rejected: false });
  }

  async function submitToken(token: string): Promise<string | null> {
    saveToken(subdomain, token);
    const next = await connectPortal(subdomain, token);
    if (next.mode === "signin") {
      saveToken(subdomain, null);
      return "That access key was not accepted. Check it and try again.";
    }
    setConnection(next);
    return null;
  }

  if (!connection) return <PortalSkeleton />;
  if (connection.mode === "signin") {
    return <PortalGate company={fallbackCompany} rejected={connection.rejected} onSubmit={submitToken} />;
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
            <span className="font-semibold text-warn">Sample data.</span> This is a preview with example figures, because a
            live connection is not available right now. Nothing you change here is saved.
          </p>
        </div>
      )}

      <PortalHeader
        company={overview?.companyName ?? fallbackCompany}
        overview={overview}
        canSignOut={client.mode === "live"}
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
            Try again
          </button>
        </div>
      )}

      <div className="mt-6">
        <Segmented options={TABS} value={tab} onChange={selectTab} label="Portal sections" optionClassName="px-2.5 sm:px-4" />
      </div>

      <main className="mt-4">
        {TABS.map(({ value }) => {
          if (!visited.has(value)) return null;
          const active = tab === value;
          return (
            <motion.section
              key={value}
              role="tabpanel"
              aria-label={PANEL_NAMES[value]}
              hidden={!active}
              initial={false}
              animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
              transition={SPRING}
            >
              {value === "channels" && <ChannelsMatrix client={client} />}
              {value === "briefings" && <CronReportsFeed client={client} />}
              {value === "vault" && <SkillsMemoryVault client={client} onChanged={refreshOverview} />}
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
    <ToastProvider>
      <PortalBody subdomain={subdomain} />
    </ToastProvider>
  );
}
