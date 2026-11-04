import type { ApiPlan, TierId } from "./provisioning";

export type TenantStatus = "running" | "provisioning" | "halted";
export type DeploymentMode = "multi-tenant" | "client-vps";

export interface Tenant {
  id: string;
  companyName: string;
  slug: string;
  url: string;
  tier: TierId;
  status: TenantStatus;
  statusDetail: string | null;
  deployment: DeploymentMode;
  /** When the current run began. The hub reports its provisioning time. */
  upSince: string | null;
  memoryLimit: string;
  memoryLimitGb: number;
  cpuLimit: number;
  /** Null when the hub does not report per-container usage. */
  usage: { memoryGb: number; cpuPct: number } | null;
  ports: { dash: number | null; api: number | null };
  skills: string[];
  dashboardUsername: string;
  /** Known only for mock tenants or ones onboarded in this browser session. */
  secrets: { password: string | null; apiKey: string | null };
  monthlyRetainer: number;
  model: string | null;
}

export interface HubHealth {
  ok: boolean;
  latencyMs: number | null;
  docker: boolean | null;
}

export interface FleetMetrics {
  running: number;
  slots: number;
  /** Null values mean the hub has no source for this metric. */
  memoryUsedGb: number | null;
  memoryTotalGb: number | null;
  cpuPct: number | null;
  toolCalls24h: number | null;
  mrr: number;
  mrrIsEstimate: boolean;
}

export interface FleetHistory {
  running: number[];
  memory: number[];
  toolCalls: number[];
  mrr: number[];
}

export interface FleetSnapshot {
  tenants: Tenant[];
  metrics: FleetMetrics;
  history: FleetHistory;
  health: HubHealth;
}

export interface OnboardInput {
  companyName: string;
  subdomain: string;
  plan: ApiPlan;
  tier: TierId;
  contactEmail: string;
  openRouterKey: string;
  model: string;
  skills: string[];
}

export interface OnboardResult {
  clientId: string;
  companyName: string;
  dashboardUrl: string;
  dashboardUsername: string;
  dashboardPassword: string;
  apiBaseUrl: string;
  apiKey: string;
  containerName: string | null;
  ports: { dash: number | null; api: number | null };
  syncedSkills: string[];
  warning: string | null;
}

export interface PortalLinkResult {
  token: string;
  portalUrl: string;
  expiresAt: string;
}

export interface TeardownResult {
  containerRemoved: boolean;
  proxyRemoved: boolean;
  archivePath: string | null;
}

export interface ServiceProbe {
  url: string;
  reachable: boolean;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface TenantHealth {
  containerState: string;
  containerHealth: string | null;
  startedAt: string | null;
  restartCount: number;
  healthy: boolean;
  dashboard: ServiceProbe | null;
  api: ServiceProbe | null;
}

export interface HubClient {
  readonly mode: "mock" | "live";
  readonly pollMs: number;
  readonly logPollMs: number;
  /** The hub API has no restart route yet, so this is false when live. */
  readonly canRestart: boolean;
  fleet(): Promise<FleetSnapshot>;
  onboard(input: OnboardInput): Promise<OnboardResult>;
  /** Mints a fresh client-portal link for the business owner. Safe to call repeatedly. */
  portalLink(tenantId: string): Promise<PortalLinkResult>;
  teardown(tenantId: string): Promise<TeardownResult>;
  restart(tenantId: string): Promise<void>;
  logs(tenantId: string, tail: number): Promise<string[]>;
  tenantHealth(tenantId: string): Promise<TenantHealth>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
