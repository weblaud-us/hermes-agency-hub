import {
  ApiError,
  type FleetHistory,
  type FleetSnapshot,
  type HubClient,
  type HubHealth,
  type OnboardInput,
  type OnboardResult,
  type PortalLinkResult,
  type ServiceProbe,
  type Tenant,
  type TenantHealth,
  type TenantStatus,
} from "./hub-types";
import { discardBody, fetchMe, PERMISSIONS, refreshSession, type SessionUser } from "./auth";
import { createMockHub } from "./mock-hub";
import { createLiveOps, type OpsClient } from "./ops-api";
import { createMockOps } from "./ops-mock";
import {
  PACKAGE_FOR_TIER,
  TIERS,
  tierFromPlan,
  type ApiPlan,
  type BusinessMode,
  type NicheTemplate,
  type PackageTier,
  type RegionPreset,
} from "./provisioning";

export * from "./hub-types";

/** Same-origin: the website forwards to the hub, carrying the session cookie. */
const BASE = "/hub-api";
const TENANT_SLOTS = Number(process.env.NEXT_PUBLIC_TENANT_SLOTS) || 20;

// ------------------------------------------------------------- hub wire shapes
type SubscriptionStatus = "pending" | "provisioning" | "active" | "suspended" | "failed" | "archived";

interface ClientRead {
  id: string;
  company_name: string;
  slug: string;
  url: string;
  plan: ApiPlan;
  subscription_status: SubscriptionStatus;
  status_detail: string | null;
  container_port_dash: number | null;
  container_port_api: number | null;
  cpu_limit: number;
  memory_limit: string;
  dashboard_username: string;
  config: Record<string, unknown>;
  synced_skills: string[];
  provisioned_at: string | null;
  business_mode: BusinessMode;
  niche_template: NicheTemplate;
  package_tier: PackageTier;
  region_preset: RegionPreset;
  currency: string;
  onboarding_stage: number;
  baseline_metrics_json: {
    monthly_inquiries: number;
    conversion_rate: number;
    avg_order_or_profit_value: number;
    monthly_retainer_investment: number;
  } | null;
  autopilot_social: boolean;
  brand_kit_json: { primary_color?: string } | null;
}

interface ClientList {
  items: ClientRead[];
  total: number;
}

interface HubStats {
  running_containers: number;
}

interface OnboardResponse {
  client_id: string;
  company_name: string;
  dashboard_url: string;
  dashboard_username: string;
  dashboard_password: string;
  api_base_url: string;
  api_key: string;
  container_name: string | null;
  container_port_dash: number | null;
  container_port_api: number | null;
  synced_skills: string[];
  warning: string | null;
}

interface PortalTokenResponse {
  token: string;
  expires_at: string;
  portal_url: string;
}

interface TeardownResponse {
  container_removed: boolean;
  proxy_removed: boolean;
  archive_path: string | null;
}

interface PortProbe {
  url: string;
  reachable: boolean;
  status: number | null;
  latency_ms: number | null;
  error: string | null;
}

interface ClientHealth {
  container_state: string;
  container_health: string | null;
  started_at: string | null;
  restart_count: number;
  healthy: boolean;
  dashboard: PortProbe | null;
  api: PortProbe | null;
}

// --------------------------------------------------------------------- request
const READ_TIMEOUT_MS = 12_000;
/** Each tenant-health call makes the hub probe two services over HTTP. */
const HEALTH_TIMEOUT_MS = 30_000;

/** The hub answers `{error, detail}`, or FastAPI's `{detail}` for 401 and 422. */
function errorFromBody(status: number, body: unknown): ApiError {
  const payload = (body ?? {}) as { error?: string; detail?: unknown };
  const detail = payload.detail;
  let message = `The hub returned HTTP ${status}.`;
  if (typeof detail === "string") {
    message = detail;
  } else if (Array.isArray(detail)) {
    message = detail
      .map((item: { loc?: unknown[]; msg?: string }) => {
        const field = item.loc?.[item.loc.length - 1];
        return field ? `${field}: ${item.msg}` : item.msg;
      })
      .join("; ");
  }
  return new ApiError(status, payload.error ?? `http_${status}`, message);
}

export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const send = () =>
    fetch(`${BASE}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    });

  let response: Response;
  try {
    response = await send();
    // An access token is short-lived by design, so an expiry mid-page is routine.
    if (response.status === 401 && (await refreshSession())) {
      await discardBody(response);
      response = await send();
    }
  } catch {
    throw new ApiError(0, "network_error", "Could not reach the hub.");
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw errorFromBody(response.status, body);
  return body as T;
}

// --------------------------------------------------------------------- mapping
function statusOf(status: SubscriptionStatus): TenantStatus {
  if (status === "active") return "running";
  if (status === "pending" || status === "provisioning") return "provisioning";
  return "halted";
}

/** The hub stores UTC, but a timestamp read back without an offset would parse as local time. */
function hubTimestamp(value: string | null): string | null {
  if (!value) return null;
  return /(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;
}

/** Parses Docker-style sizes such as "2g" or "512m" into gigabytes. */
function memoryToGb(limit: string): number {
  const match = /^([\d.]+)\s*([kmgt]?)/i.exec(limit.trim());
  if (!match) return 0;
  const value = Number(match[1]);
  const scale: Record<string, number> = { k: 1 / 1_048_576, m: 1 / 1024, g: 1, t: 1024, "": 1 / 1_073_741_824 };
  return value * scale[match[2].toLowerCase()];
}

function tenantFromClient(
  client: ClientRead,
  secrets: Tenant["secrets"] | undefined,
): Tenant {
  const tier = tierFromPlan(client.plan);
  return {
    id: client.id,
    companyName: client.company_name,
    slug: client.slug,
    url: client.url,
    tier,
    status: statusOf(client.subscription_status),
    statusDetail: client.status_detail,
    deployment: client.config?.deployment_mode === "client_vps" ? "client-vps" : "multi-tenant",
    upSince: hubTimestamp(client.provisioned_at),
    memoryLimit: client.memory_limit,
    memoryLimitGb: memoryToGb(client.memory_limit),
    cpuLimit: client.cpu_limit,
    usage: null,
    ports: { dash: client.container_port_dash, api: client.container_port_api },
    skills: client.synced_skills,
    dashboardUsername: client.dashboard_username,
    secrets: secrets ?? { password: null, apiKey: null },
    monthlyRetainer: TIERS[tier].monthly,
    model: typeof client.config?.model === "string" ? client.config.model : null,
    businessMode: client.business_mode,
    nicheTemplate: client.niche_template,
    packageTier: client.package_tier,
    region: client.region_preset,
    currency: client.currency,
    onboardingStage: client.onboarding_stage,
    baseline: client.baseline_metrics_json
      ? {
          monthlyInquiries: client.baseline_metrics_json.monthly_inquiries,
          conversionRate: client.baseline_metrics_json.conversion_rate,
          avgOrderOrProfitValue: client.baseline_metrics_json.avg_order_or_profit_value,
          monthlyRetainerInvestment: client.baseline_metrics_json.monthly_retainer_investment,
        }
      : null,
    autopilotSocial: client.autopilot_social,
    brandPrimary: client.brand_kit_json?.primary_color ?? null,
  };
}

function probeFromWire(probe: PortProbe | null): ServiceProbe | null {
  if (!probe) return null;
  return {
    url: probe.url,
    reachable: probe.reachable,
    status: probe.status,
    latencyMs: probe.latency_ms,
    error: probe.error,
  };
}

async function probeHub(): Promise<HubHealth> {
  const started = performance.now();
  const body = await request<{ status: string; docker: boolean }>("/healthz", { timeoutMs: 6000 });
  return {
    ok: body.status === "ok",
    latencyMs: Math.round(performance.now() - started),
    docker: body.docker,
  };
}

// ------------------------------------------------------------------- live client
function createLiveHub(): HubClient {
  /**
   * The hub returns a tenant's password and bearer key once, at onboarding. Held
   * in memory so the row actions work for the rest of this page session, and
   * deliberately lost on reload.
   */
  const sessionSecrets = new Map<string, Tenant["secrets"]>();
  const history: FleetHistory = { running: [], memory: [], toolCalls: [], mrr: [] };

  const record = (series: number[], value: number) => {
    series.push(value);
    if (series.length > 40) series.shift();
  };

  return {
    mode: "live",
    pollMs: 15_000,
    logPollMs: 3000,
    canRestart: false,

    async fleet(): Promise<FleetSnapshot> {
      const [health, list, stats] = await Promise.all([
        probeHub(),
        request<ClientList>(`/clients?limit=200`, { timeoutMs: READ_TIMEOUT_MS }),
        // Stats also ask Docker. A daemon outage should not blank the tenant list.
        request<HubStats>(`/clients/stats`, { timeoutMs: READ_TIMEOUT_MS }).catch(
          () => null,
        ),
      ]);

      const tenants = list.items
        .filter((client) => client.subscription_status !== "archived")
        .map((client) => tenantFromClient(client, sessionSecrets.get(client.id)));
      const active = tenants.filter((tenant) => tenant.status === "running");
      const running = stats?.running_containers ?? active.length;
      const mrr = active.reduce((sum, tenant) => sum + tenant.monthlyRetainer, 0);

      record(history.running, running);
      record(history.mrr, mrr);

      return {
        tenants,
        metrics: {
          running,
          slots: TENANT_SLOTS,
          memoryUsedGb: null,
          memoryTotalGb: null,
          cpuPct: null,
          toolCalls24h: null,
          mrr,
          mrrIsEstimate: true,
        },
        history: {
          running: [...history.running],
          memory: [],
          toolCalls: [],
          mrr: [...history.mrr],
        },
        health,
      };
    },

    async onboard(input: OnboardInput): Promise<OnboardResult> {
      // No timeout: onboarding is synchronous and includes the tenant health probe.
      const body = await request<OnboardResponse>(`/clients/onboard`, {
        method: "POST",
        body: {
          company_name: input.companyName,
          subdomain: input.subdomain,
          openrouter_api_key: input.openRouterKey,
          contact_email: input.contactEmail,
          package_tier: PACKAGE_FOR_TIER[input.tier],
          business_mode: input.businessMode,
          niche_template: input.nicheTemplate,
          region_preset: input.region,
          currency: input.currency,
          baseline_metrics: input.baseline
            ? {
                monthly_inquiries: input.baseline.monthlyInquiries,
                conversion_rate: input.baseline.conversionRate,
                avg_order_or_profit_value: input.baseline.avgOrderOrProfitValue,
                monthly_retainer_investment: input.baseline.monthlyRetainerInvestment,
              }
            : null,
          autopilot_social: input.autopilotSocial,
          brand_kit: {
            primary_color: input.brandPrimary,
            logo_text: input.companyName.trim().toUpperCase().slice(0, 24),
          },
          config: { model: input.model, requested_skills: input.skills },
        },
      });
      sessionSecrets.set(body.client_id, {
        password: body.dashboard_password,
        apiKey: body.api_key,
      });
      return {
        clientId: body.client_id,
        companyName: body.company_name,
        dashboardUrl: body.dashboard_url,
        dashboardUsername: body.dashboard_username,
        dashboardPassword: body.dashboard_password,
        apiBaseUrl: body.api_base_url,
        apiKey: body.api_key,
        containerName: body.container_name,
        ports: { dash: body.container_port_dash, api: body.container_port_api },
        syncedSkills: body.synced_skills,
        warning: body.warning,
      };
    },

    async portalLink(tenantId): Promise<PortalLinkResult> {
      // No revoke_existing: minting a new link must never invalidate one the
      // business owner may already have open or saved.
      const body = await request<PortalTokenResponse>(
        `/clients/${encodeURIComponent(tenantId)}/portal-token`,
        { method: "POST", body: {}, timeoutMs: READ_TIMEOUT_MS },
      );
      return { token: body.token, portalUrl: body.portal_url, expiresAt: hubTimestamp(body.expires_at) ?? body.expires_at };
    },

    async teardown(tenantId) {
      const body = await request<TeardownResponse>(
        `/clients/${encodeURIComponent(tenantId)}?archive=true`,
        { method: "DELETE" },
      );
      sessionSecrets.delete(tenantId);
      return {
        containerRemoved: body.container_removed,
        proxyRemoved: body.proxy_removed,
        archivePath: body.archive_path,
      };
    },

    async restart() {
      throw new ApiError(405, "not_supported", "This hub has no restart route yet.");
    },

    async logs(tenantId, tail) {
      const body = await request<{ lines: string[] }>(
        `/clients/${encodeURIComponent(tenantId)}/logs?tail=${tail}`,
        { timeoutMs: READ_TIMEOUT_MS },
      );
      return body.lines;
    },

    async tenantHealth(tenantId): Promise<TenantHealth> {
      const body = await request<ClientHealth>(
        `/clients/${encodeURIComponent(tenantId)}/health`,
        { timeoutMs: HEALTH_TIMEOUT_MS },
      );
      return {
        containerState: body.container_state,
        containerHealth: body.container_health,
        startedAt: hubTimestamp(body.started_at),
        restartCount: body.restart_count,
        healthy: body.healthy,
        dashboard: probeFromWire(body.dashboard),
        api: probeFromWire(body.api),
      };
    },
  };
}

// -------------------------------------------------------------------- connection
export type HubConnection =
  | { mode: "live"; hub: HubClient; ops: OpsClient; user: SessionUser }
  | { mode: "mock"; hub: HubClient; ops: OpsClient; user: SessionUser }
  | { mode: "signin" };

/** Everything is open in the sample console, which has nothing real behind it. */
const PREVIEW_USER: SessionUser = {
  id: "preview",
  email: "preview@weblaud.com",
  fullName: "Preview",
  role: "SUPER_ADMIN",
  clientId: null,
  clientSlug: null,
  permissions: Object.values(PERMISSIONS),
};

/**
 * Decides once, at connect time, whether the console is live or on sample data.
 * Sample data appears only when the hub cannot answer at all. Once live, a failed
 * call surfaces as an error, so a dropped connection can never produce fake credentials.
 */
export async function connectHub(): Promise<HubConnection> {
  let user: SessionUser | null;
  try {
    user = await fetchMe();
  } catch {
    return { mode: "mock", hub: createMockHub(), ops: createMockOps(), user: PREVIEW_USER };
  }
  if (!user) return { mode: "signin" };
  return { mode: "live", hub: createLiveHub(), ops: createLiveOps(), user };
}
