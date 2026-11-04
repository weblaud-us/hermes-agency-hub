"use client";

import { Pause, Play, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog } from "@/components/ui/Dialog";
import { StatusOrb } from "@/components/ui/StatusOrb";
import type { HubClient, ServiceProbe, Tenant, TenantHealth } from "@/lib/api";
import { cn } from "@/lib/utils";

const TAIL_LINES = 200;

function ProbeTile({ label, probe }: { label: string; probe: ServiceProbe | null }) {
  const reachable = probe?.reachable ?? false;
  return (
    <div className="min-w-0 rounded-xl border border-white/7 bg-white/2 px-3 py-2">
      <p className="text-[11px] text-ink-3">{label}</p>
      <p className="mt-1 flex items-center gap-1.5 font-mono text-xs tabular-nums text-ink">
        <StatusOrb tone={probe ? (reachable ? "signal" : "halt") : "muted"} pulse={false} />
        {probe ? (reachable ? `Reachable${probe.latencyMs != null ? `, ${Math.round(probe.latencyMs)}ms` : ""}` : "Unreachable") : "Not probed"}
      </p>
    </div>
  );
}

function DrawerBody({ hub, tenant, onClose }: { hub: HubClient; tenant: Tenant; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [logError, setLogError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [health, setHealth] = useState<TenantHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  const checkHealth = useCallback(async () => {
    setChecking(true);
    setHealthError(null);
    try {
      setHealth(await hub.tenantHealth(tenant.id));
    } catch (error) {
      setHealthError(error instanceof Error ? error.message : "Health check failed.");
    } finally {
      setChecking(false);
    }
  }, [hub, tenant.id]);

  useEffect(() => {
    let cancelled = false;
    hub
      .tenantHealth(tenant.id)
      .then((result) => {
        if (!cancelled) setHealth(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setHealthError(error instanceof Error ? error.message : "Health check failed.");
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hub, tenant.id]);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await hub.logs(tenant.id, TAIL_LINES);
        if (cancelled) return;
        setLines(next);
        setLogError(null);
      } catch (error) {
        if (cancelled) return;
        setLogError(error instanceof Error ? error.message : "Could not read logs.");
      }
      if (!cancelled) timer = setTimeout(poll, hub.logPollMs);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hub, tenant.id, paused]);

  useEffect(() => {
    const node = scroller.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [lines]);

  function onScroll() {
    const node = scroller.current;
    if (!node) return;
    following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-white/7 px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-ink">{tenant.companyName}</h2>
          <p className="mt-0.5 truncate font-mono text-xs text-ink-3">hermes-client-{tenant.slug} · read-only log stream</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close terminal"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-white/6 hover:text-ink"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      <div className="border-b border-white/7 px-5 py-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="font-mono text-xs text-ink-2">
            {checking && !health
              ? "Checking container..."
              : health
                ? `state: ${health.containerState}${health.containerHealth ? ` (${health.containerHealth})` : ""} · restarts: ${health.restartCount}`
                : "Health unavailable"}
          </p>
          <button
            type="button"
            onClick={checkHealth}
            disabled={checking}
            aria-label="Re-run the health probe"
            className="inline-flex size-9 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-white/6 hover:text-ink disabled:opacity-50"
          >
            <RefreshCw aria-hidden className={cn("size-3.5", checking && "animate-spin-slow")} />
          </button>
        </div>
        {healthError && (
          <p role="alert" className="mb-2 text-xs text-halt-soft">
            {healthError}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <ProbeTile label="Dashboard probe" probe={health?.dashboard ?? null} />
          <ProbeTile label="API probe" probe={health?.api ?? null} />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 px-5 py-2.5">
        <p className="flex items-center gap-2 font-mono text-xs text-ink-2">
          <StatusOrb tone={paused ? "muted" : "signal"} pulse={!paused} />
          {paused ? "Paused" : "Tailing"}
          <span className="tabular-nums text-ink-3">{lines.length} lines</span>
        </p>
        <div className="flex items-center gap-1.5">
          <CopyButton value={lines.join("\n")} label="Copy logs" />
          <button
            type="button"
            onClick={() => setPaused((value) => !value)}
            aria-label={paused ? "Resume tailing" : "Pause tailing"}
            className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg border border-white/10 bg-white/4 text-ink-2 transition-colors hover:border-white/20 hover:text-ink"
          >
            {paused ? <Play aria-hidden className="size-3.5" /> : <Pause aria-hidden className="size-3.5" />}
          </button>
        </div>
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        role="log"
        aria-label={`${tenant.companyName} container logs`}
        aria-live="off"
        tabIndex={0}
        className="thin-scroll min-h-0 flex-1 overflow-y-auto bg-black/40 px-5 py-3 font-mono text-xs leading-6 text-ink-2"
      >
        {logError && (
          <p role="alert" className="mb-2 text-halt-soft">
            {logError}
          </p>
        )}
        {lines.length === 0 && !logError && <p className="text-ink-3">Waiting for log output...</p>}
        {lines.map((line, index) => (
          <div key={index} className="wrap-break-word">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TerminalDrawer({
  hub,
  tenant,
  onClose,
}: {
  hub: HubClient;
  tenant: Tenant | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={tenant !== null} onClose={onClose} title="Live terminal" placement="right">
      {tenant && <DrawerBody key={tenant.id} hub={hub} tenant={tenant} onClose={onClose} />}
    </Dialog>
  );
}
