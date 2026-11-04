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
import { createMockHub } from "./mock-hub";
import { TIERS, tierFromPlan, type ApiPlan } from "./provisioning";

export * from "./hub-types";

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");
const API_PREFIX = "/api/v1";
const TENANT_SLOTS = Number(process.env.NEXT_PUBLIC_TENANT_SLOTS) || 20;
const ADMIN_KEY_STORAGE = "hermes.admin-key";

export const HUB_URL = API_URL;

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

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; key?: string; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.key) headers["X-API-Key"] = options.key;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    });
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
  const body = await request<{ status: string; docker: boolean }>("/healthz", { timeoutMs: 4000 });
  return {
    ok: body.status === "ok",
    latencyMs: Math.round(performance.now() - started),
    docker: body.docker,
  };
}

// ------------------------------------------------------------------- live client
function createLiveHub(key: string): HubClient {
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
        request<ClientList>(`${API_PREFIX}/clients?limit=200`, { key, timeoutMs: READ_TIMEOUT_MS }),
        // Stats also ask Docker. A daemon outage should not blank the tenant list.
        request<HubStats>(`${API_PREFIX}/clients/stats`, { key, timeoutMs: READ_TIMEOUT_MS }).catch(
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
      const body = await request<OnboardResponse>(`${API_PREFIX}/clients/onboard`, {
        method: "POST",
        key,
        body: {
          company_name: input.companyName,
          subdomain: input.subdomain,
          openrouter_api_key: input.openRouterKey,
          contact_email: input.contactEmail,
          plan: input.plan,
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
        `${API_PREFIX}/clients/${encodeURIComponent(tenantId)}/portal-token`,
        { method: "POST", key, body: {}, timeoutMs: READ_TIMEOUT_MS },
      );
      return { token: body.token, portalUrl: body.portal_url, expiresAt: hubTimestamp(body.expires_at) ?? body.expires_at };
    },

    async teardown(tenantId) {
      const body = await request<TeardownResponse>(
        `${API_PREFIX}/clients/${encodeURIComponent(tenantId)}?archive=true`,
        { method: "DELETE", key },
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
        `${API_PREFIX}/clients/${encodeURIComponent(tenantId)}/logs?tail=${tail}`,
        { key, timeoutMs: READ_TIMEOUT_MS },
      );
      return body.lines;
    },

    async tenantHealth(tenantId): Promise<TenantHealth> {
      const body = await request<ClientHealth>(
        `${API_PREFIX}/clients/${encodeURIComponent(tenantId)}/health`,
        { key, timeoutMs: HEALTH_TIMEOUT_MS },
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
export type MockReason = "no-url" | "offline" | "no-key" | "key-rejected";

export type HubConnection =
  | { hub: HubClient; mode: "live" }
  | { hub: HubClient; mode: "mock"; reason: MockReason };

export function loadAdminKey(): string | null {
  try {
    return sessionStorage.getItem(ADMIN_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function saveAdminKey(key: string | null): void {
  try {
    if (key) sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
    else sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  } catch {
    // Storage blocked: the key simply lasts until this page reloads.
  }
}

/**
 * Decides once, at connect time, whether the console is live or on mock data.
 * Mock is only ever a starting state: once live, a failed call surfaces as an
 * error, so a dropped connection can never produce fake credentials.
 */
export async function connectHub(key: string | null): Promise<HubConnection> {
  const mock = (reason: MockReason): HubConnection => ({ hub: createMockHub(), mode: "mock", reason });

  if (!API_URL) return mock("no-url");
  try {
    await probeHub();
  } catch {
    return mock("offline");
  }
  if (!key) return mock("no-key");

  try {
    await request<ClientList>(`${API_PREFIX}/clients?limit=1`, { key, timeoutMs: READ_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      saveAdminKey(null);
      return mock("key-rejected");
    }
    return mock("offline");
  }
  saveAdminKey(key);
  return { hub: createLiveHub(key), mode: "live" };
}
