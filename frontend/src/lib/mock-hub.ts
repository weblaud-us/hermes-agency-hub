import {
  ApiError,
  type DeploymentMode,
  type FleetHistory,
  type FleetSnapshot,
  type HubClient,
  type OnboardInput,
  type OnboardResult,
  type PortalLinkResult,
  type Tenant,
  type TenantHealth,
  type TenantStatus,
} from "./hub-types";
import { BASE_DOMAIN, TIERS, type TierId } from "./provisioning";
import { delay } from "./utils";

const HOST_MEMORY_GB = 32;
/** Hub, nginx and Postgres, on top of the tenant containers. */
const PLATFORM_OVERHEAD_GB = 2;
const DAY_MS = 86_400_000;

interface Seed {
  company: string;
  tier: TierId;
  mode?: DeploymentMode;
  status?: TenantStatus;
  detail?: string;
  memoryGb: number;
  cpuPct: number;
  uptimeDays: number;
  skills: number;
  retainer?: number;
}

const SEEDS: Seed[] = [
  { company: "Suvana", tier: "growth", memoryGb: 1.1, cpuPct: 42, uptimeDays: 47.3, skills: 6 },
  {
    company: "Kestrel Freight",
    tier: "enterprise",
    mode: "client-vps",
    memoryGb: 2.3,
    cpuPct: 58,
    uptimeDays: 92.1,
    skills: 8,
    retainer: 1560,
  },
  { company: "Orchid Dental Group", tier: "starter", memoryGb: 0.6, cpuPct: 24, uptimeDays: 18.6, skills: 3 },
  { company: "Lumen Home Goods", tier: "growth", memoryGb: 1.3, cpuPct: 51, uptimeDays: 33.9, skills: 6 },
  { company: "Harbor & Pine", tier: "growth", memoryGb: 1.0, cpuPct: 37, uptimeDays: 61.2, skills: 5 },
  { company: "Atlas Field Services", tier: "enterprise", mode: "client-vps", memoryGb: 2.1, cpuPct: 46, uptimeDays: 124.4, skills: 8 },
  { company: "Marigold Skincare", tier: "growth", memoryGb: 1.2, cpuPct: 44, uptimeDays: 12.8, skills: 6 },
  { company: "Quarry Lane Legal", tier: "enterprise", memoryGb: 2.0, cpuPct: 39, uptimeDays: 75.5, skills: 7 },
  { company: "Beacon Roofing", tier: "starter", memoryGb: 0.5, cpuPct: 19, uptimeDays: 9.2, skills: 2 },
  { company: "Tern Cycle Works", tier: "growth", memoryGb: 0.9, cpuPct: 31, uptimeDays: 27.7, skills: 5 },
  { company: "Fennel Meal Kits", tier: "starter", memoryGb: 0.7, cpuPct: 33, uptimeDays: 41.1, skills: 3 },
  { company: "Ridgeway Realty", tier: "enterprise", mode: "client-vps", memoryGb: 1.4, cpuPct: 28, uptimeDays: 53.6, skills: 7 },
  { company: "Cobalt Fitness", tier: "growth", memoryGb: 0.8, cpuPct: 26, uptimeDays: 6.4, skills: 4 },
  { company: "Sable Coffee Roasters", tier: "starter", memoryGb: 0.5, cpuPct: 17, uptimeDays: 22.3, skills: 2 },
  {
    company: "Juniper Telehealth",
    tier: "growth",
    status: "provisioning",
    detail: "Waiting for the first health probe.",
    memoryGb: 0,
    cpuPct: 0,
    uptimeDays: 0,
    skills: 6,
  },
  {
    company: "Verbena Florals",
    tier: "starter",
    status: "halted",
    detail: "Suspended: retainer payment lapsed.",
    memoryGb: 0,
    cpuPct: 0,
    uptimeDays: 0,
    skills: 3,
  },
];

function randomToken(bytes: number): string {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

function slugOf(company: string): string {
  return company
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function walk(start: number, count: number, spread: number): number[] {
  const out: number[] = [];
  let value = start;
  for (let i = 0; i < count; i += 1) {
    out.unshift(Number(value.toFixed(2)));
    value += (Math.random() - 0.5) * spread;
  }
  return out;
}

function push(series: number[], value: number): void {
  series.push(Number(value.toFixed(2)));
  if (series.length > 40) series.shift();
}

interface MockTenant extends Tenant {
  logBuffer: string[];
  restartCount: number;
}

const LOG_TEMPLATES = [
  (t: MockTenant) => `gateway  | POST /v1/chat/completions 200 ${40 + Math.floor(Math.random() * 180)}ms tenant=${t.slug}`,
  () => `agent    | tool_call lookup_order status=ok duration=${60 + Math.floor(Math.random() * 120)}ms`,
  () => `agent    | skill loaded from /opt/data/skills/agency_core (read-only)`,
  () => `memory   | MEMORY.md flushed +${1 + Math.floor(Math.random() * 3)} lines`,
  () => `cron     | job lead_triage fired, next run in 60s`,
  () => `dash     | GET /api/health 200 ${2 + Math.floor(Math.random() * 9)}ms`,
  () => `skills   | SKILL.md candidate scored ${(0.6 + Math.random() * 0.39).toFixed(2)}`,
];

const BOOT_LOG = [
  "[s6-init] making user provided files available at /var/run/s6/etc",
  "[stage2] remapping hermes to uid 10000 gid 10000",
  "[stage2] chown /opt/data complete",
  "[stage2] Setup complete",
  "gateway  | listening on 0.0.0.0:8642",
  "dash     | listening on 0.0.0.0:9119",
];

export function createMockHub(): HubClient {
  const now = Date.now();
  const tenants: MockTenant[] = SEEDS.map((seed, index) => {
    const tier = TIERS[seed.tier];
    const slug = slugOf(seed.company);
    const status = seed.status ?? "running";
    return {
      id: `mock-${slug}`,
      companyName: seed.company,
      slug,
      url: `https://${slug}.${BASE_DOMAIN}`,
      tier: seed.tier,
      status,
      statusDetail: seed.detail ?? null,
      deployment: seed.mode ?? "multi-tenant",
      upSince: status === "running" ? new Date(now - seed.uptimeDays * DAY_MS).toISOString() : null,
      memoryLimit: tier.memory,
      memoryLimitGb: tier.memoryGb,
      cpuLimit: Number(tier.cpus),
      usage: status === "running" ? { memoryGb: seed.memoryGb, cpuPct: seed.cpuPct } : null,
      ports: { dash: 9101 + index, api: 8601 + index },
      skills: Array.from({ length: seed.skills }, (_, i) => `agency-core-${i + 1}`),
      dashboardUsername: "admin",
      secrets: { password: randomToken(9), apiKey: `sk-${slug}-${randomToken(14)}` },
      monthlyRetainer: seed.retainer ?? tier.monthly,
      model: "anthropic/claude-sonnet-5.5",
      logBuffer: [...BOOT_LOG],
      restartCount: 0,
    };
  });

  let toolCalls = 42_890;
  let nextPortOffset = tenants.length;
  let drifted = false;

  const usedMemory = () =>
    tenants.reduce((sum, t) => sum + (t.usage?.memoryGb ?? 0), PLATFORM_OVERHEAD_GB);
  const running = () => tenants.filter((t) => t.status === "running");
  const mrr = () => running().reduce((sum, t) => sum + t.monthlyRetainer, 0);
  const cpu = () => {
    const live = running();
    return live.reduce((sum, t) => sum + (t.usage?.cpuPct ?? 0), 0) / Math.max(1, live.length);
  };

  const history: FleetHistory = {
    running: Array(40).fill(running().length),
    memory: walk(usedMemory(), 40, 0.35),
    toolCalls: walk(1790, 40, 240),
    mrr: Array(40).fill(mrr()),
  };

  function drift(): void {
    for (const tenant of running()) {
      if (!tenant.usage) continue;
      const cap = tenant.memoryLimitGb;
      const memoryStep = (Math.random() - 0.5) * 0.06;
      const cpuStep = (Math.random() - 0.5) * 7;
      tenant.usage = {
        memoryGb: Math.min(cap * 0.96, Math.max(0.2, tenant.usage.memoryGb + memoryStep)),
        cpuPct: Math.min(96, Math.max(4, tenant.usage.cpuPct + cpuStep)),
      };
    }
    const delta = Math.floor(Math.random() * 7);
    toolCalls += delta;
    push(history.toolCalls, 1500 + delta * 90);
    push(history.memory, usedMemory());
    push(history.running, running().length);
    push(history.mrr, mrr());
  }

  function find(tenantId: string): MockTenant {
    const tenant = tenants.find((t) => t.id === tenantId);
    if (!tenant) throw new ApiError(404, "client_not_found", "That tenant no longer exists.");
    return tenant;
  }

  return {
    mode: "mock",
    pollMs: 2000,
    logPollMs: 1200,
    canRestart: true,

    async fleet(): Promise<FleetSnapshot> {
      // The first snapshot stays on the seeded baseline; later polls drift it.
      if (drifted) drift();
      drifted = true;
      return {
        tenants: tenants.map((t) => ({ ...t })),
        metrics: {
          running: running().length,
          slots: Number(process.env.NEXT_PUBLIC_TENANT_SLOTS) || 20,
          memoryUsedGb: usedMemory(),
          memoryTotalGb: HOST_MEMORY_GB,
          cpuPct: cpu(),
          toolCalls24h: toolCalls,
          mrr: mrr(),
          mrrIsEstimate: false,
        },
        history: {
          running: [...history.running],
          memory: [...history.memory],
          toolCalls: [...history.toolCalls],
          mrr: [...history.mrr],
        },
        health: { ok: true, latencyMs: 12 + Math.floor(Math.random() * 14), docker: true },
      };
    },

    async onboard(input: OnboardInput): Promise<OnboardResult> {
      await delay(5200);
      if (tenants.some((t) => t.slug === input.subdomain)) {
        throw new ApiError(
          409,
          "client_conflict",
          `Subdomain '${input.subdomain}' is already taken by another tenant.`,
        );
      }
      const tier = TIERS[input.tier];
      const url = `https://${input.subdomain}.${BASE_DOMAIN}`;
      const password = randomToken(12);
      const apiKey = `sk-${input.subdomain}-${randomToken(18)}`;
      const offset = nextPortOffset;
      nextPortOffset += 1;
      const tenant: MockTenant = {
        id: `mock-${input.subdomain}-${randomToken(3)}`,
        companyName: input.companyName,
        slug: input.subdomain,
        url,
        tier: input.tier,
        status: "running",
        statusDetail: null,
        deployment: "multi-tenant",
        upSince: new Date().toISOString(),
        memoryLimit: tier.memory,
        memoryLimitGb: tier.memoryGb,
        cpuLimit: Number(tier.cpus),
        usage: { memoryGb: tier.memoryGb * 0.22, cpuPct: 12 },
        ports: { dash: 9101 + offset, api: 8601 + offset },
        skills: input.skills,
        dashboardUsername: "admin",
        secrets: { password, apiKey },
        monthlyRetainer: tier.monthly,
        model: input.model,
        logBuffer: [...BOOT_LOG],
        restartCount: 0,
      };
      tenants.unshift(tenant);
      return {
        clientId: tenant.id,
        companyName: tenant.companyName,
        dashboardUrl: url,
        dashboardUsername: "admin",
        dashboardPassword: password,
        apiBaseUrl: `${url}/v1`,
        apiKey,
        containerName: `hermes-client-${input.subdomain}`,
        ports: tenant.ports,
        syncedSkills: input.skills,
        warning: null,
      };
    },

    async portalLink(tenantId): Promise<PortalLinkResult> {
      await delay(500);
      const tenant = find(tenantId);
      const token = `mock.${randomToken(24)}`;
      return {
        token,
        portalUrl: `https://portal.${BASE_DOMAIN}/portal/${tenant.slug}#token=${token}`,
        expiresAt: new Date(now + 90 * DAY_MS).toISOString(),
      };
    },

    async teardown(tenantId) {
      await delay(900);
      const index = tenants.findIndex((t) => t.id === tenantId);
      if (index === -1) throw new ApiError(404, "client_not_found", "That tenant no longer exists.");
      const [removed] = tenants.splice(index, 1);
      return {
        containerRemoved: true,
        proxyRemoved: true,
        archivePath: `/srv/hermes-multi/archive/${removed.slug}-mock`,
      };
    },

    async restart(tenantId) {
      const tenant = find(tenantId);
      tenant.status = "provisioning";
      tenant.statusDetail = "Restarting container.";
      tenant.usage = null;
      tenant.logBuffer.push("[s6-init] received SIGTERM, restarting supervised services");
      await delay(2400);
      tenant.status = "running";
      tenant.statusDetail = null;
      tenant.upSince = new Date().toISOString();
      tenant.usage = { memoryGb: tenant.memoryLimitGb * 0.22, cpuPct: 14 };
      tenant.restartCount += 1;
      tenant.logBuffer.push(...BOOT_LOG);
    },

    async logs(tenantId, tail) {
      const tenant = find(tenantId);
      if (tenant.status === "running") {
        const template = LOG_TEMPLATES[Math.floor(Math.random() * LOG_TEMPLATES.length)];
        tenant.logBuffer.push(template(tenant));
      }
      if (tenant.logBuffer.length > 400) tenant.logBuffer.splice(0, 100);
      return tenant.logBuffer.slice(-tail);
    },

    async tenantHealth(tenantId): Promise<TenantHealth> {
      await delay(300);
      const tenant = find(tenantId);
      const up = tenant.status === "running";
      const probe = (url: string, latency: number) => ({
        url,
        reachable: up,
        status: up ? 200 : null,
        latencyMs: up ? latency : null,
        error: up ? null : "connection refused",
      });
      return {
        containerState: up ? "running" : tenant.status === "provisioning" ? "created" : "exited",
        containerHealth: up ? "healthy" : null,
        startedAt: tenant.upSince,
        restartCount: tenant.restartCount,
        healthy: up,
        dashboard: probe(`http://127.0.0.1:${tenant.ports.dash}/api/health`, 6 + Math.floor(Math.random() * 12)),
        api: probe(`http://127.0.0.1:${tenant.ports.api}/health`, 4 + Math.floor(Math.random() * 10)),
      };
    },
  };
}
