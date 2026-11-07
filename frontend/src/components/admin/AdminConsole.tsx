"use client";

import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, BadgeCheck, LibraryBig, RotateCw, Server } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ClientOpsDrawer } from "@/components/admin/ClientOpsDrawer";
import { ProvisionModal, type ProvisionTab } from "@/components/admin/ProvisionModal";
import { ShadowQaQueue } from "@/components/admin/ShadowQaQueue";
import { StarterKitsManager } from "@/components/admin/StarterKitsManager";
import { TelemetryHeader } from "@/components/admin/TelemetryHeader";
import { TenantTable } from "@/components/admin/TenantTable";
import { TerminalDrawer } from "@/components/admin/TerminalDrawer";
import { TerminateDialog } from "@/components/admin/TerminateDialog";
import { Segmented } from "@/components/ui/Segmented";
import { ToastProvider, useToast } from "@/components/ui/Toaster";
import {
  ApiError,
  connectHub,
  type FleetSnapshot,
  type HubConnection,
  type OnboardResult,
  type Tenant,
} from "@/lib/api";
import { goTo, PERMISSIONS } from "@/lib/auth";
import { LocaleProvider } from "@/lib/i18n";
import { SPRING } from "@/lib/motion";
import { TIERS, type TierId } from "@/lib/provisioning";
import { copyToClipboard } from "@/lib/utils";

type AdminTab = "fleet" | "qa" | "kits";

const TABS: { value: AdminTab; label: string; icon: ReactNode; permission: string }[] = [
  { value: "fleet", label: "Fleet & Provisioning", icon: <Server aria-hidden className="size-3.5" />, permission: PERMISSIONS.clientsRead },
  { value: "qa", label: "Shadow-Week QA", icon: <BadgeCheck aria-hidden className="size-3.5" />, permission: PERMISSIONS.qa },
  { value: "kits", label: "Starter Kits & Skills", icon: <LibraryBig aria-hidden className="size-3.5" />, permission: PERMISSIONS.skillsRead },
];

function ConsoleBody() {
  const params = useSearchParams();
  const notify = useToast();

  const [connection, setConnection] = useState<HubConnection | null>(null);
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const [requestedTab, setRequestedTab] = useState<string | null>(() => params.get("tab"));
  const [managing, setManaging] = useState<Tenant | null>(null);
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
  const ready = connection && connection.mode !== "signin" ? connection : null;
  const hub = ready?.hub ?? null;
  const user = ready?.user ?? null;
  const permissions = user?.permissions ?? [];
  const canReadFleet = permissions.includes(PERMISSIONS.clientsRead);
  const visibleTabs = TABS.filter((tab) => permissions.includes(tab.permission));
  const tab = (visibleTabs.find((row) => row.value === requestedTab) ?? visibleTabs[0])?.value ?? null;

  const refresh = useCallback(async () => {
    if (!hub) return;
    try {
      const next = await hub.fleet();
      setSnapshot(next);
      setStaleSince(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        goTo(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        return;
      }
      setStaleSince((current) => current ?? Date.now());
    }
  }, [hub]);

  useEffect(() => {
    let cancelled = false;
    connectHub().then((next) => {
      if (cancelled) return;
      if (next.mode === "signin") {
        goTo(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        return;
      }
      setConnection(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hub || !canReadFleet) return;
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
  }, [hub, refresh, canReadFleet]);

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

  function selectTab(next: AdminTab) {
    setRequestedTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
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

  const mode = ready?.mode ?? null;

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-4 sm:px-6 sm:py-6">
      <TelemetryHeader
        snapshot={snapshot}
        mode={mode}
        stale={staleSince !== null}
        user={user}
        onProvision={() => openProvision()}
        showFleet={tab === "fleet"}
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
        {mode === "mock" && (
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
                The hub is unreachable, so this console is showing sample data. Tenants, credentials and actions here are
                simulated.
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {visibleTabs.length > 1 && tab && (
        <div className="mt-4">
          <Segmented<AdminTab>
            label="Console sections"
            value={tab}
            onChange={selectTab}
            className="max-w-full flex-wrap rounded-2xl"
            optionClassName="px-3 sm:px-4"
            options={visibleTabs.map(({ value, label, icon }) => ({
              value,
              label: (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  {icon}
                  {label}
                </span>
              ),
            }))}
          />
        </div>
      )}

      {tab === "fleet" && (
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
          onManage={setManaging}
          permissions={permissions}
        />
      )}
      {tab === "qa" && ready && <ShadowQaQueue ops={ready.ops} />}
      {tab === "kits" && ready && <StarterKitsManager ops={ready.ops} permissions={permissions} />}

      {hub && ready && permissions.includes(PERMISSIONS.provision) && (
        <ProvisionModal
          key={provision.key}
          open={provision.open}
          hub={hub}
          ops={ready.ops}
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
      {ready && (
        <ClientOpsDrawer
          tenant={managing}
          ops={ready.ops}
          canEditRoi={permissions.includes(PERMISSIONS.roiWrite)}
          mock={mode === "mock"}
          onClose={() => setManaging(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

export function AdminConsole() {
  return (
    <LocaleProvider>
      <ToastProvider>
        <ConsoleBody />
      </ToastProvider>
    </LocaleProvider>
  );
}
