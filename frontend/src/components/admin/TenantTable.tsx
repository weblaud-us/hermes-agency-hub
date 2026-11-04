"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  ExternalLink,
  KeyRound,
  Layers,
  Link2,
  Power,
  RotateCw,
  Search,
  SquareTerminal,
  UserRoundCheck,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { Meter } from "@/components/ui/Meter";
import { Segmented } from "@/components/ui/Segmented";
import { StatusOrb, type OrbTone } from "@/components/ui/StatusOrb";
import { useToast } from "@/components/ui/Toaster";
import type { DeploymentMode, Tenant, TenantStatus } from "@/lib/api";
import { SPRING } from "@/lib/motion";
import { TIERS } from "@/lib/provisioning";
import { cn, copyToClipboard, formatUptime } from "@/lib/utils";

type StatusFilter = "all" | TenantStatus;
type ModeFilter = "all" | DeploymentMode;

interface TenantTableProps {
  tenants: Tenant[] | null;
  canRestart: boolean;
  restarting: Set<string>;
  mintingPortalLink: Set<string>;
  searchRef: RefObject<HTMLInputElement | null>;
  onProvision: () => void;
  onOpenLogs: (tenant: Tenant) => void;
  onRestart: (tenant: Tenant) => void;
  onTerminate: (tenant: Tenant) => void;
  onCopyPortalLink: (tenant: Tenant) => void;
}

const STATUS_META: Record<TenantStatus, { label: string; tone: OrbTone; text: string }> = {
  running: { label: "Running", tone: "signal", text: "text-signal" },
  provisioning: { label: "Provisioning", tone: "warn", text: "text-warn" },
  halted: { label: "Halted", tone: "halt", text: "text-halt-soft" },
};

const ROW_GRID =
  "xl:grid-cols-[minmax(15rem,1.35fr)_minmax(13rem,1fr)_minmax(14rem,1fr)_minmax(9rem,0.6fr)_auto]";

function CellLabel({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 font-mono text-[10.5px] uppercase tracking-wider text-ink-3 xl:hidden">{children}</p>;
}

function Uptime({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatUptime(now - new Date(since).getTime())}</>;
}

function RowAction({
  label,
  icon,
  onClick,
  unavailableReason,
  tone,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  unavailableReason?: string | null;
  tone?: "danger";
}) {
  const notify = useToast();
  const unavailable = Boolean(unavailableReason);
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.92 }}
      transition={SPRING}
      aria-label={unavailable ? `${label} (unavailable)` : label}
      aria-disabled={unavailable}
      title={unavailableReason ?? label}
      onClick={() => {
        if (unavailableReason) notify(unavailableReason, "info");
        else onClick();
      }}
      className={cn(
        "inline-flex size-11 items-center justify-center rounded-lg text-ink-2 transition-colors xl:size-8",
        unavailable
          ? "text-white/30"
          : tone === "danger"
            ? "hover:bg-halt/15 hover:text-halt-soft"
            : "hover:bg-white/8 hover:text-ink",
      )}
    >
      {icon}
    </motion.button>
  );
}

interface TenantRowProps {
  tenant: Tenant;
  canRestart: boolean;
  isRestarting: boolean;
  isMintingPortalLink: boolean;
  onOpenLogs: (tenant: Tenant) => void;
  onRestart: (tenant: Tenant) => void;
  onTerminate: (tenant: Tenant) => void;
  onCopyPortalLink: (tenant: Tenant) => void;
}

const TenantRow = memo(function TenantRow({
  tenant,
  canRestart,
  isRestarting,
  isMintingPortalLink,
  onOpenLogs,
  onRestart,
  onTerminate,
  onCopyPortalLink,
}: TenantRowProps) {
  const notify = useToast();
  const status = STATUS_META[tenant.status];
  const usage = tenant.usage;
  const host = tenant.url.replace(/^https?:\/\//, "");
  const skillCount = tenant.skills.length;

  async function copyCredentials() {
    const lines = [`Dashboard: ${tenant.url}`, `Username: ${tenant.dashboardUsername}`];
    if (tenant.secrets.password) lines.push(`Password: ${tenant.secrets.password}`);
    const copied = await copyToClipboard(lines.join("\n"));
    if (!copied) notify("Could not write to the clipboard.", "error");
    else if (tenant.secrets.password) notify(`Dashboard credentials for ${tenant.companyName} copied.`);
    else notify("URL and username copied. The hub only returns the password once, at onboarding.", "info");
  }

  async function copyApiKey() {
    if (!tenant.secrets.apiKey) return;
    const copied = await copyToClipboard(tenant.secrets.apiKey);
    notify(copied ? `Bearer API key for ${tenant.companyName} copied.` : "Could not write to the clipboard.", copied ? "success" : "error");
  }

  return (
    <motion.div
      layout="position"
      role="row"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -14, transition: { duration: 0.16 } }}
      transition={SPRING}
      className={cn(
        "grid grid-cols-1 gap-4 border-t border-white/6 px-4 py-4 transition-colors hover:bg-white/2 sm:grid-cols-2 xl:items-center xl:gap-5 xl:py-3",
        ROW_GRID,
      )}
    >
      <div role="cell" className="min-w-0 sm:col-span-2 xl:col-span-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-ink">{tenant.companyName}</span>
          <span className="shrink-0 rounded-md bg-white/6 px-1.5 py-0.5 text-[10.5px] text-ink-2">
            {tenant.tier === "enterprise" ? "Enterprise" : TIERS[tenant.tier].label}
          </span>
          {tenant.deployment === "client-vps" && (
            <span className="shrink-0 rounded-md border border-hyper/40 px-1.5 py-0.5 text-[10.5px] text-hyper-soft">VPS</span>
          )}
        </div>
        <a
          href={tenant.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex max-w-full items-center gap-1 rounded-md border border-white/8 bg-white/3 px-1.5 py-0.5 font-mono text-[11px] tracking-tight text-ink-2 transition-colors hover:border-signal/40 hover:text-signal"
        >
          <span className="truncate">{tenant.url.startsWith("https") ? "https://" : "http://"}{host}</span>
          <ExternalLink aria-hidden className="size-3 shrink-0" />
        </a>
      </div>

      <div role="cell" className="min-w-0">
        <CellLabel>Container health</CellLabel>
        <div className="flex items-center gap-2 text-xs">
          <StatusOrb tone={status.tone} pulse={tenant.status !== "halted"} />
          <span className={cn("font-medium", status.text)}>{status.label}</span>
          {tenant.status === "running" && tenant.upSince && (
            <span className="ml-auto font-mono tabular-nums text-ink-3" title="Time since provisioned or restarted">
              <Uptime since={tenant.upSince} />
            </span>
          )}
        </div>
        {usage ? (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <Meter
                value={usage.memoryGb}
                max={tenant.memoryLimitGb}
                label="Memory"
                valueText={`${usage.memoryGb.toFixed(1)}GB of ${tenant.memoryLimitGb.toFixed(1)}GB`}
              />
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-2">
                {usage.memoryGb.toFixed(1)}GB / {tenant.memoryLimitGb.toFixed(1)}GB
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Meter value={usage.cpuPct} max={100} label="CPU" valueText={`${Math.round(usage.cpuPct)} percent`} />
              <span className="w-[6.6rem] shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-2">
                {Math.round(usage.cpuPct)}% of {tenant.cpuLimit.toFixed(1)} vCPU
              </span>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-xs text-ink-3">
            {tenant.status === "running"
              ? `Limit ${tenant.memoryLimit} / ${tenant.cpuLimit} vCPU. Live usage not exposed.`
              : (tenant.statusDetail ?? `Limit ${tenant.memoryLimit} / ${tenant.cpuLimit} vCPU.`)}
          </p>
        )}
      </div>

      <div role="cell" className="min-w-0">
        <CellLabel>Loopback ports</CellLabel>
        <div className="flex flex-wrap gap-1.5 font-mono text-[11px] tabular-nums tracking-tight">
          <span className="rounded-md border border-white/8 bg-white/3 px-1.5 py-0.5 text-ink-2">
            <span className="text-ink-3">DASH</span> 127.0.0.1:{tenant.ports.dash ?? "--"}
          </span>
          <span className="rounded-md border border-white/8 bg-white/3 px-1.5 py-0.5 text-ink-2">
            <span className="text-ink-3">API</span> 127.0.0.1:{tenant.ports.api ?? "--"}
          </span>
        </div>
      </div>

      <div role="cell" className="min-w-0">
        <CellLabel>Mounted skills</CellLabel>
        <span
          title={tenant.skills.join(", ") || "No skills synced"}
          className="inline-flex items-center gap-1.5 rounded-md border border-hyper/30 bg-hyper/8 px-1.5 py-0.5 text-[11px] leading-snug text-hyper-soft"
        >
          <Layers aria-hidden className="size-3 shrink-0" />
          {skillCount} Agency Core {skillCount === 1 ? "Skill" : "Skills"} :ro
        </span>
      </div>

      <div role="cell" className="flex items-center gap-0.5 sm:col-span-2 xl:col-span-1 xl:justify-end">
        <RowAction
          label="Copy client portal link"
          icon={<Link2 aria-hidden className={cn("size-4", isMintingPortalLink && "animate-pulse")} />}
          onClick={() => onCopyPortalLink(tenant)}
          unavailableReason={isMintingPortalLink ? "Minting a link…" : null}
        />
        <RowAction
          label="Copy dashboard credentials"
          icon={<UserRoundCheck aria-hidden className="size-4" />}
          onClick={copyCredentials}
        />
        <RowAction
          label="Copy bearer API key"
          icon={<KeyRound aria-hidden className="size-4" />}
          onClick={copyApiKey}
          unavailableReason={tenant.secrets.apiKey ? null : "The hub returns the bearer key only at onboarding, so it cannot be copied here."}
        />
        <RowAction
          label="Open live terminal"
          icon={<SquareTerminal aria-hidden className="size-4" />}
          onClick={() => onOpenLogs(tenant)}
        />
        <RowAction
          label="Restart container"
          icon={<RotateCw aria-hidden className={cn("size-4", isRestarting && "animate-spin-slow")} />}
          onClick={() => onRestart(tenant)}
          unavailableReason={
            !canRestart
              ? "This hub has no restart route yet. Use docker restart on the host."
              : isRestarting
                ? "A restart is already in progress."
                : null
          }
        />
        <RowAction
          label="Terminate instance"
          tone="danger"
          icon={<Power aria-hidden className="size-4" />}
          onClick={() => onTerminate(tenant)}
        />
      </div>
    </motion.div>
  );
});

export function TenantTable({
  tenants,
  canRestart,
  restarting,
  mintingPortalLink,
  searchRef,
  onProvision,
  onOpenLogs,
  onRestart,
  onTerminate,
  onCopyPortalLink,
}: TenantTableProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [mode, setMode] = useState<ModeFilter>("all");

  const searchable = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!tenants) return [];
    if (!needle) return tenants;
    return tenants.filter((tenant) =>
      `${tenant.companyName} ${tenant.slug} ${tenant.url}`.toLowerCase().includes(needle),
    );
  }, [tenants, query]);

  const matchingMode = useMemo(
    () => (mode === "all" ? searchable : searchable.filter((tenant) => tenant.deployment === mode)),
    [searchable, mode],
  );

  const visible = useMemo(
    () => (status === "all" ? matchingMode : matchingMode.filter((tenant) => tenant.status === status)),
    [matchingMode, status],
  );

  const count = (value: StatusFilter) =>
    value === "all" ? matchingMode.length : matchingMode.filter((tenant) => tenant.status === value).length;

  const statusOption = (value: StatusFilter, label: string) => ({
    value,
    label: (
      <span className="flex items-center gap-1.5">
        {label}
        <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{count(value)}</span>
      </span>
    ),
  });

  const filtered = query.trim() !== "" || status !== "all" || mode !== "all";

  return (
    <section aria-label="Tenant instances" className="surface sheen mt-4 overflow-hidden rounded-3xl">
      <div className="relative flex flex-wrap items-center gap-3 p-4">
        <div className="relative min-w-[14rem] flex-1 xl:max-w-sm">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search tenants"
            placeholder="Search tenants"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="field pl-9 pr-16"
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-3 sm:block">
            Ctrl K
          </kbd>
        </div>
        <Segmented<StatusFilter>
          label="Filter by status"
          value={status}
          onChange={setStatus}
          className="max-w-full flex-wrap rounded-2xl"
          options={[
            statusOption("all", "All"),
            statusOption("running", "Running"),
            statusOption("provisioning", "Provisioning"),
            statusOption("halted", "Halted"),
          ]}
        />
        <Segmented<ModeFilter>
          label="Filter by deployment mode"
          value={mode}
          onChange={setMode}
          className="max-w-full flex-wrap rounded-2xl"
          options={[
            { value: "all", label: "All modes" },
            { value: "multi-tenant", label: "Multi-Tenant Host" },
            { value: "client-vps", label: "Client VPS" },
          ]}
        />
      </div>

      <div role="table" aria-label="Tenant instance matrix" className="relative">
        <div
          role="row"
          className={cn(
            "hidden gap-5 border-t border-white/6 px-4 py-2.5 font-mono text-[10.5px] uppercase tracking-wider text-ink-3 xl:grid",
            ROW_GRID,
          )}
        >
          <span role="columnheader">Tenant identity</span>
          <span role="columnheader">Container health</span>
          <span role="columnheader">Loopback ports</span>
          <span role="columnheader">Mounted skills</span>
          <span role="columnheader" className="w-[12.5rem] text-right">
            Quick actions
          </span>
        </div>

        {tenants === null ? (
          <div className="space-y-2 border-t border-white/6 p-4" aria-label="Loading tenants">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-16 animate-pulse rounded-xl bg-white/3" />
            ))}
          </div>
        ) : (
          <AnimatePresence initial={false} mode="popLayout">
            {visible.map((tenant) => (
              <TenantRow
                key={tenant.id}
                tenant={tenant}
                canRestart={canRestart}
                isRestarting={restarting.has(tenant.id)}
                isMintingPortalLink={mintingPortalLink.has(tenant.id)}
                onOpenLogs={onOpenLogs}
                onRestart={onRestart}
                onTerminate={onTerminate}
                onCopyPortalLink={onCopyPortalLink}
              />
            ))}
          </AnimatePresence>
        )}

        {tenants !== null && visible.length === 0 && (
          <div className="flex flex-col items-center gap-3 border-t border-white/6 px-4 py-14 text-center">
            <p className="text-sm text-ink-2">
              {filtered ? "No tenants match these filters." : "No tenants yet. Provision the first client."}
            </p>
            {filtered ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setStatus("all");
                  setMode("all");
                }}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/12 px-3 text-xs font-medium text-ink hover:border-white/25"
              >
                <X aria-hidden className="size-3.5" />
                Clear filters
              </button>
            ) : (
              <button
                type="button"
                onClick={onProvision}
                className="inline-flex min-h-10 items-center rounded-lg bg-signal px-3.5 text-[13px] font-semibold text-obsidian"
              >
                Provision client
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
