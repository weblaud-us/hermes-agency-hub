import { ApiError } from "./hub-types";
import { createMockPortal } from "./portal-mock";

export { ApiError };

const BASE = "/portal-api";
const TOKEN_PREFIX = "coordinator.portal.";

// ------------------------------------------------------------------ domain types
export type AgentStatus = "online" | "degraded" | "offline";
export type ChannelName = "whatsapp" | "telegram" | "slack" | "web_widget";
export type ChannelStatus = "connected" | "connecting" | "action_needed" | "disconnected" | "not_configured";
export type ReportStatus = "success" | "failed" | "no_action";
export type JobStatus = "scheduled" | "paused" | "running" | "error";
export type ReconnectState = "refreshing" | "qr_pending" | "qr_ready" | "connected" | "failed";

export interface PortalOverview {
  companyName: string;
  agentStatus: AgentStatus;
  /** Null values mean the backend has no source for this figure yet. */
  uptimePercentage: number | null;
  tasksCompleted30d: number | null;
  tasksTrendPct: number | null;
  tasksDaily: number[];
  estimatedHoursSaved: number | null;
  avgResponseSeconds: number | null;
  learnedSkillCount: number;
  activeModelTier: string;
  connectedChannels: number;
  scheduledBriefings: number;
}

export interface AllowlistEntry {
  id: string;
  display: string;
}

export interface PortalChannel {
  channel: ChannelName;
  status: ChannelStatus;
  sessionVerified: boolean;
  maskedHandle: string | null;
  lastMessageAt: string | null;
  messages24h: number | null;
  allowlist: AllowlistEntry[];
  allowAll: boolean;
  voiceTranscription: boolean | null;
  attention: string | null;
}

export interface ChannelTestResult {
  ok: boolean;
  messageDelivered: boolean;
  latencyMs: number | null;
  detail: string;
}

export interface ReconnectResult {
  state: ReconnectState;
  /** Base64 PNG of a real pairing code. Null in sample mode, which draws a marked placeholder. */
  qrPngBase64: string | null;
  qrRefreshSeconds: number | null;
  detail: string;
}

export interface ReportMetric {
  label: string;
  value: number;
}

export interface CronReport {
  id: string;
  jobId: string;
  jobName: string;
  scheduleHuman: string;
  executedAt: string;
  durationMs: number | null;
  status: ReportStatus;
  summaryMarkdown: string;
  metrics: ReportMetric[];
}

export interface CronJob {
  id: string;
  jobName: string;
  scheduleHuman: string;
  status: JobStatus;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface CronFeed {
  jobs: CronJob[];
  reports: CronReport[];
}

export interface TriggerResult {
  queued: boolean;
  detail: string;
}

export interface AgencySkill {
  id: string;
  title: string;
  category: string;
  description: string;
  active: boolean;
}

export interface LearnedSkill {
  id: string;
  title: string;
  category: string;
  description: string;
  triggerConditions: string;
  workflowMarkdown: string;
  lastUsed: string | null;
  useCount: number;
  enabled: boolean;
}

export interface MemoryFact {
  id: string;
  text: string;
  category: string;
}

export interface BusinessMemory {
  facts: MemoryFact[];
  usedChars: number;
  limitChars: number;
}

export interface SkillsAndMemory {
  agencySkills: AgencySkill[];
  learnedSkills: LearnedSkill[];
  memory: BusinessMemory;
}

export type MemoryPatch =
  | { op: "append"; text: string }
  | { op: "replace"; id: string; text: string }
  | { op: "remove"; id: string };

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatReply {
  reply: string;
  durationMs: number;
}

export interface PortalClient {
  readonly mode: "live" | "mock";
  overview(): Promise<PortalOverview>;
  channels(): Promise<PortalChannel[]>;
  reconnectChannel(channel: ChannelName): Promise<ReconnectResult>;
  pairingStatus(): Promise<ReconnectResult>;
  testChannel(channel: ChannelName): Promise<ChannelTestResult>;
  updateAllowlist(channel: ChannelName, change: { add?: string[]; removeIds?: string[] }): Promise<PortalChannel[]>;
  cronFeed(): Promise<CronFeed>;
  triggerJob(jobId: string): Promise<TriggerResult>;
  skillsAndMemory(): Promise<SkillsAndMemory>;
  toggleSkill(skillId: string, enabled: boolean): Promise<LearnedSkill>;
  patchMemory(patch: MemoryPatch): Promise<BusinessMemory>;
  chat(messages: ChatTurn[]): Promise<ChatReply>;
}

// -------------------------------------------------------------------- wire shapes
interface OverviewWire {
  company_name: string;
  agent_status: AgentStatus;
  uptime_percentage: number | null;
  tasks_completed_30d: number | null;
  tasks_trend_pct: number | null;
  tasks_daily: number[];
  estimated_hours_saved: number | null;
  avg_response_seconds: number | null;
  learned_skill_count: number;
  active_model_tier: string;
  connected_channels: number;
  scheduled_briefings: number;
}

interface ChannelWire {
  channel: ChannelName;
  status: ChannelStatus;
  session_verified: boolean;
  masked_handle: string | null;
  last_message_at: string | null;
  messages_24h: number | null;
  allowlist: AllowlistEntry[];
  allow_all: boolean;
  voice_transcription: boolean | null;
  attention: string | null;
}

interface ReconnectWire {
  state: ReconnectState;
  qr_png_base64: string | null;
  qr_refresh_seconds: number | null;
  detail: string;
}

interface LearnedSkillWire {
  id: string;
  title: string;
  category: string;
  description: string;
  trigger_conditions: string;
  workflow_markdown: string;
  last_used: string | null;
  use_count: number;
  enabled: boolean;
}

interface MemoryWire {
  facts: MemoryFact[];
  used_chars: number;
  limit_chars: number;
}

interface CronWire {
  jobs: {
    id: string;
    job_name: string;
    schedule_human: string;
    status: JobStatus;
    next_run_at: string | null;
    last_run_at: string | null;
  }[];
  reports: {
    id: string;
    job_id: string;
    job_name: string;
    schedule_human: string;
    executed_at: string;
    duration_ms: number | null;
    status: ReportStatus;
    summary_markdown: string;
    metrics_json: ReportMetric[];
  }[];
}

const toChannel = (wire: ChannelWire): PortalChannel => ({
  channel: wire.channel,
  status: wire.status,
  sessionVerified: wire.session_verified,
  maskedHandle: wire.masked_handle,
  lastMessageAt: wire.last_message_at,
  messages24h: wire.messages_24h,
  allowlist: wire.allowlist,
  allowAll: wire.allow_all,
  voiceTranscription: wire.voice_transcription,
  attention: wire.attention,
});

const toReconnect = (wire: ReconnectWire): ReconnectResult => ({
  state: wire.state,
  qrPngBase64: wire.qr_png_base64,
  qrRefreshSeconds: wire.qr_refresh_seconds,
  detail: wire.detail,
});

const toLearned = (wire: LearnedSkillWire): LearnedSkill => ({
  id: wire.id,
  title: wire.title,
  category: wire.category,
  description: wire.description,
  triggerConditions: wire.trigger_conditions,
  workflowMarkdown: wire.workflow_markdown,
  lastUsed: wire.last_used,
  useCount: wire.use_count,
  enabled: wire.enabled,
});

const toMemory = (wire: MemoryWire): BusinessMemory => ({
  facts: wire.facts,
  usedChars: wire.used_chars,
  limitChars: wire.limit_chars,
});

const toOverview = (wire: OverviewWire): PortalOverview => ({
  companyName: wire.company_name,
  agentStatus: wire.agent_status,
  uptimePercentage: wire.uptime_percentage,
  tasksCompleted30d: wire.tasks_completed_30d,
  tasksTrendPct: wire.tasks_trend_pct,
  tasksDaily: wire.tasks_daily,
  estimatedHoursSaved: wire.estimated_hours_saved,
  avgResponseSeconds: wire.avg_response_seconds,
  learnedSkillCount: wire.learned_skill_count,
  activeModelTier: wire.active_model_tier,
  connectedChannels: wire.connected_channels,
  scheduledBriefings: wire.scheduled_briefings,
});

// ------------------------------------------------------------------------- request
const READ_TIMEOUT_MS = 20_000;

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token: string | null; timeoutMs?: number },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) headers["X-Client-Portal-Token"] = options.token;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${BASE}/${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    });
  } catch {
    throw new ApiError(0, "network_error", "Could not reach the portal. Check your connection.");
  }

  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return body as T;

  const payload = (body ?? {}) as { error?: string; detail?: unknown };
  throw new ApiError(
    response.status,
    payload.error ?? `http_${response.status}`,
    typeof payload.detail === "string" ? payload.detail : "That request could not be completed.",
  );
}

function createLivePortal(subdomain: string, token: string): PortalClient {
  const tenant = encodeURIComponent(subdomain);
  const get = <T,>(path: string) => request<T>(`${tenant}/${path}`, { token, timeoutMs: READ_TIMEOUT_MS });

  return {
    mode: "live",

    async overview() {
      return toOverview(await get<OverviewWire>("overview"));
    },

    async channels() {
      return (await get<{ channels: ChannelWire[] }>("channels")).channels.map(toChannel);
    },

    async reconnectChannel(channel) {
      return toReconnect(
        await request<ReconnectWire>(`${tenant}/channels/${channel}/reconnect`, { method: "POST", token }),
      );
    },

    async pairingStatus() {
      return toReconnect(await get<ReconnectWire>("channels/whatsapp/pairing"));
    },

    async testChannel(channel) {
      const body = await request<{ ok: boolean; message_delivered: boolean; latency_ms: number | null; detail: string }>(
        `${tenant}/channels/${channel}/test`,
        { method: "POST", token, timeoutMs: READ_TIMEOUT_MS },
      );
      return { ok: body.ok, messageDelivered: body.message_delivered, latencyMs: body.latency_ms, detail: body.detail };
    },

    async updateAllowlist(channel, change) {
      const body = await request<{ channels: ChannelWire[] }>(`${tenant}/channels/${channel}/allowlist`, {
        method: "PUT",
        token,
        body: { add: change.add ?? [], remove_ids: change.removeIds ?? [] },
      });
      return body.channels.map(toChannel);
    },

    async cronFeed() {
      const body = await get<CronWire>("cron-reports");
      return {
        jobs: body.jobs.map((job) => ({
          id: job.id,
          jobName: job.job_name,
          scheduleHuman: job.schedule_human,
          status: job.status,
          nextRunAt: job.next_run_at,
          lastRunAt: job.last_run_at,
        })),
        reports: body.reports.map((report) => ({
          id: report.id,
          jobId: report.job_id,
          jobName: report.job_name,
          scheduleHuman: report.schedule_human,
          executedAt: report.executed_at,
          durationMs: report.duration_ms,
          status: report.status,
          summaryMarkdown: report.summary_markdown,
          metrics: report.metrics_json,
        })),
      };
    },

    async triggerJob(jobId) {
      const body = await request<{ queued: boolean; detail: string }>(
        `${tenant}/cron-reports/${encodeURIComponent(jobId)}/trigger`,
        { method: "POST", token, timeoutMs: READ_TIMEOUT_MS },
      );
      return { queued: body.queued, detail: body.detail };
    },

    async skillsAndMemory() {
      const body = await get<{
        agency_verified_skills: AgencySkill[];
        learned_skills: LearnedSkillWire[];
        business_memory: MemoryWire;
      }>("skills-and-memory");
      return {
        agencySkills: body.agency_verified_skills,
        learnedSkills: body.learned_skills.map(toLearned),
        memory: toMemory(body.business_memory),
      };
    },

    async toggleSkill(skillId, enabled) {
      return toLearned(
        await request<LearnedSkillWire>(`${tenant}/skills/${encodeURIComponent(skillId)}`, {
          method: "PATCH",
          token,
          body: { enabled },
        }),
      );
    },

    async patchMemory(patch) {
      return toMemory(await request<MemoryWire>(`${tenant}/memory`, { method: "PATCH", token, body: patch }));
    },

    async chat(messages) {
      const body = await request<{ reply: string; duration_ms: number }>(`${tenant}/chat`, {
        method: "POST",
        token,
        body: { messages },
      });
      return { reply: body.reply, durationMs: body.duration_ms };
    },
  };
}

// ---------------------------------------------------------------------- connection
export type PortalConnection =
  | { mode: "live"; client: PortalClient }
  | { mode: "mock"; client: PortalClient }
  | { mode: "signin"; rejected: boolean };

export function loadToken(subdomain: string): string | null {
  try {
    return localStorage.getItem(`${TOKEN_PREFIX}${subdomain}`);
  } catch {
    return null;
  }
}

export function saveToken(subdomain: string, token: string | null): void {
  try {
    if (token) localStorage.setItem(`${TOKEN_PREFIX}${subdomain}`, token);
    else localStorage.removeItem(`${TOKEN_PREFIX}${subdomain}`);
  } catch {
    // Storage blocked: the session simply lasts until this page reloads.
  }
}

/** Reads and removes an access link's `#token=`, so it never lingers in the address bar or history. */
export function consumeLinkToken(): string | null {
  const match = /^#token=([A-Za-z0-9._-]+)$/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  return match[1];
}

/**
 * Decides once, at connect time, whether this page shows live or sample data.
 *
 * Sample data appears only when no backend answers at all. A backend that answers,
 * even to refuse a token, means a real account exists, and fake figures would be
 * read as real ones. Once live, a failed call surfaces as an error and never falls
 * back to samples.
 */
export async function connectPortal(subdomain: string, token: string | null): Promise<PortalConnection> {
  const probe = `${encodeURIComponent(subdomain)}/overview`;
  try {
    await request<OverviewWire>(probe, { token, timeoutMs: READ_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 0 || error.code === "portal_backend_unavailable") {
        return { mode: "mock", client: createMockPortal(subdomain) };
      }
      if (error.status === 401) {
        if (token) saveToken(subdomain, null);
        return { mode: "signin", rejected: Boolean(token) };
      }
      // Authenticated, but this read failed. Live, and the page reports the error.
      if (token) return { mode: "live", client: createLivePortal(subdomain, token) };
      return { mode: "signin", rejected: false };
    }
    throw error;
  }
  return token ? { mode: "live", client: createLivePortal(subdomain, token) } : { mode: "signin", rejected: false };
}
