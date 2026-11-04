"use client";

import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, KeyRound, RotateCw } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectHubDialog } from "@/components/admin/ConnectHubDialog";
import { ProvisionModal, type ProvisionTab } from "@/components/admin/ProvisionModal";
import { TelemetryHeader } from "@/components/admin/TelemetryHeader";
import { TenantTable } from "@/components/admin/TenantTable";
import { TerminalDrawer } from "@/components/admin/TerminalDrawer";
import { TerminateDialog } from "@/components/admin/TerminateDialog";
import { ToastProvider, useToast } from "@/components/ui/Toaster";
import {
  ApiError,
  HUB_URL,
  connectHub,
  loadAdminKey,
  saveAdminKey,
  type FleetSnapshot,
  type HubConnection,
  type MockReason,
  type OnboardResult,
  type Tenant,
} from "@/lib/api";
import { SPRING } from "@/lib/motion";
import { TIERS, type TierId } from "@/lib/provisioning";
import { copyToClipboard } from "@/lib/utils";

const MOCK_NOTICE: Record<MockReason, string> = {
  "no-url": "NEXT_PUBLIC_API_URL is not set, so this console is running on mock telemetry.",
  offline: `The hub at ${HUB_URL} is unreachable, so this console is running on mock telemetry.`,
  "no-key": "The hub is reachable. Connect with the admin key to go live; until then this is mock telemetry.",
  "key-rejected": "The hub rejected that admin key, so this console is back on mock telemetry.",
};

function ConsoleBody() {
  const params = useSearchParams();
  const notify = useToast();

  const [connection, setConnection] = useState<HubConnection | null>(null);
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [staleSince, setStaleSince] = useState<number | null>(null);

  const [connectOpen, setConnectOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [provision, setProvision] = useState<{ key: number; open: boolean; tab: ProvisionTab; tier: TierId }>(() => {
    const requested = params.get("provision");
    const tier = params.get("tier") as TierId | null;
    return {
      key: 0,
      open: requested === "cluster" || requested === "installer",
      tab: requested === "installer" ? "installer" : "cluster",
      tier: tier && tier in TIERS ? tier : "growth",
    };
  });
  const [logTenant, setLogTenant] = useState<Tenant | null>(null);
  const [terminating, setTerminating] = useState<Tenant | null>(null);
  const [restarting, setRestarting] = useState<Set<string>>(new Set());
  const [mintingPortalLink, setMintingPortalLink] = useState<Set<string>>(new Set());

  const searchRef = useRef<HTMLInputElement>(null);
  const hub = connection?.hub ?? null;

  const refresh = useCallback(async () => {
    if (!hub) return;
    try {
      const next = await hub.fleet();
      setSnapshot(next);
      setStaleSince(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        saveAdminKey(null);
        setSnapshot(null);
        setConnection(await connectHub(null));
        notify("The hub no longer accepts this admin key.", "error");
        return;
      }
      setStaleSince((current) => current ?? Date.now());
    }
  }, [hub, notify]);

  useEffect(() => {
    let cancelled = false;
    connectHub(loadAdminKey()).then((next) => {
      if (!cancelled) setConnection(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hub) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = setTimeout(poll, hub.pollMs);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hub, refresh]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function connectWithKey(key: string) {
    setConnecting(true);
    const next = await connectHub(key);
    setConnecting(false);
    if (next.mode === "live") {
      setSnapshot(null);
      setStaleSince(null);
      setConnection(next);
      setConnectOpen(false);
      notify("Connected to the live hub.");
      return null;
    }
    if (next.reason === "offline") return "The hub is not responding. Check that it is running and try again.";
    return "The hub rejected that key.";
  }

  async function disconnect() {
    saveAdminKey(null);
    setSnapshot(null);
    setStaleSince(null);
    setConnection(await connectHub(null));
    setConnectOpen(false);
    notify("Disconnected. The console is on mock telemetry.", "info");
  }

  function openProvision(tab: ProvisionTab = "cluster", tier: TierId = "growth") {
    setProvision((current) => ({ key: current.key + 1, open: true, tab, tier }));
  }

  function onProvisioned(result: OnboardResult) {
    notify(`${result.companyName} is provisioned.`);
    refresh();
  }

  async function restart(tenant: Tenant) {
    if (!hub) return;
    setRestarting((current) => new Set(current).add(tenant.id));
    notify(`Restarting ${tenant.companyName}.`, "info");
    const running = hub.restart(tenant.id);
    setTimeout(refresh, 80);
    try {
      await running;
      notify(`${tenant.companyName} is back up.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Restart failed.", "error");
    } finally {
      setRestarting((current) => {
        const next = new Set(current);
        next.delete(tenant.id);
        return next;
      });
      refresh();
    }
  }

  async function copyPortalLink(tenant: Tenant) {
    if (!hub) return;
    setMintingPortalLink((current) => new Set(current).add(tenant.id));
    try {
      const { portalUrl } = await hub.portalLink(tenant.id);
      const copied = await copyToClipboard(portalUrl);
      notify(
        copied
          ? `Portal link for ${tenant.companyName} copied. Send it to the business owner — it signs them in.`
          : "Could not write to the clipboard.",
        copied ? "success" : "error",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not mint a portal link.", "error");
    } finally {
      setMintingPortalLink((current) => {
        const next = new Set(current);
        next.delete(tenant.id);
        return next;
      });
    }
  }

  async function terminate(tenant: Tenant) {
    if (!hub) return "No hub connection.";
    try {
      const result = await hub.teardown(tenant.id);
      notify(
        result.archivePath
          ? `${tenant.companyName} terminated. Data archived to ${result.archivePath}.`
          : `${tenant.companyName} terminated.`,
      );
      setTerminating(null);
      refresh();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Terminate failed.";
    }
  }

  const mode = connection?.mode ?? null;
  const mockReason = connection?.mode === "mock" ? connection.reason : null;

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-4 sm:px-6 sm:py-6">
      <TelemetryHeader
        snapshot={snapshot}
        mode={mode}
        stale={staleSince !== null}
        onConnect={() => setConnectOpen(true)}
        onProvision={() => openProvision()}
      />

      <AnimatePresence initial={false}>
        {staleSince !== null && (
          <motion.div
            key="stale"
            role="alert"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING}
            className="overflow-hidden"
          >
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-halt/40 bg-halt/10 px-4 py-3 text-sm text-ink">
              <AlertTriangle aria-hidden className="size-4 shrink-0 text-halt" />
              <span className="min-w-0 flex-1">
                Lost contact with the hub at {new Date(staleSince).toLocaleTimeString()}. Figures below are stale and
                actions may fail. Retrying automatically.
              </span>
              <button
                type="button"
                onClick={refresh}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-xs font-medium hover:border-white/30"
              >
                <RotateCw aria-hidden className="size-3.5" />
                Retry now
              </button>
            </div>
          </motion.div>
        )}
        {mockReason && (
          <motion.div
            key="mock"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING}
            className="overflow-hidden"
          >
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-warn/30 bg-warn/8 px-4 py-3 text-sm text-ink-2">
              <AlertTriangle aria-hidden className="size-4 shrink-0 text-warn" />
              <span className="min-w-0 flex-1">
                {MOCK_NOTICE[mockReason]} Tenants, credentials and actions here are simulated.
              </span>
              {mockReason !== "no-url" && (
                <button
                  type="button"
                  onClick={() => setConnectOpen(true)}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-xs font-medium text-ink hover:border-white/30"
                >
                  <KeyRound aria-hidden className="size-3.5" />
                  Connect hub
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <TenantTable
        tenants={snapshot?.tenants ?? null}
        canRestart={hub?.canRestart ?? false}
        restarting={restarting}
        mintingPortalLink={mintingPortalLink}
        searchRef={searchRef}
        onProvision={() => openProvision()}
        onOpenLogs={setLogTenant}
        onRestart={restart}
        onTerminate={setTerminating}
        onCopyPortalLink={copyPortalLink}
      />

      {hub && (
        <ProvisionModal
          key={provision.key}
          open={provision.open}
          hub={hub}
          initialTab={provision.tab}
          initialTier={provision.tier}
          onClose={() => setProvision((current) => ({ ...current, open: false }))}
          onProvisioned={onProvisioned}
        />
      )}
      {hub && <TerminalDrawer hub={hub} tenant={logTenant} onClose={() => setLogTenant(null)} />}
      <TerminateDialog
        tenant={terminating}
        live={mode === "live"}
        onCancel={() => setTerminating(null)}
        onConfirm={terminate}
      />
      <ConnectHubDialog
        open={connectOpen}
        live={mode === "live"}
        connecting={connecting}
        onClose={() => setConnectOpen(false)}
        onConnect={connectWithKey}
        onDisconnect={disconnect}
      />
    </div>
  );
}

export function AdminConsole() {
  return (
    <ToastProvider>
      <ConsoleBody />
    </ToastProvider>
  );
}
