import { discardBody, refreshSession } from "./auth";
import { ApiError } from "./hub-types";
import { createLiveKnowledge, type KnowledgeClient, type UsageSummary } from "./knowledge-api";
import { createMockPortal } from "./portal-mock";

export { ApiError };
export type { UsageSummary };

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

// ------------------------------------------------------------------ growth views
export type BusinessMode = "general" | "ecommerce";
export type ApprovalKind =
  | "social_post"
  | "reel"
  | "ad_boost"
  | "partner_email"
  | "website_update"
  | "courier_dispatch"
  | "discount_offer";
export type ApprovalStatus =
  | "qa_review"
  | "qa_returned"
  | "pending_owner"
  | "approved"
  | "changes_requested"
  | "rejected";
export type OwnerDecision = "approve" | "edit" | "reject";
export type GuardrailLane = "automatic" | "owner" | "never";
export type WorkspaceKind = "appointment" | "lead" | "follow_up" | "order" | "stock_alert";

export interface PortalProfile {
  companyName: string;
  businessMode: BusinessMode;
  nicheTemplate: string;
  packageTier: string;
  region: "bd" | "global";
  currency: string;
  onboardingStage: number;
  pendingApprovals: number;
  isDemo: boolean;
}

export interface RoiBaseline {
  monthlyInquiries: number;
  conversionRate: number;
  avgOrderOrProfitValue: number;
  monthlyRetainerInvestment: number;
}

export interface RoiFunnel {
  totalInquiries: number;
  qualifiedLeads: number;
  confirmedOutcomes: number;
  conversionRate: number | null;
}

export interface RoiResult {
  baselineOutcomes: number;
  currentOutcomes: number;
  valuePerOutcome: number;
  baselineGrossProfit: number;
  currentGrossProfit: number;
  incrementalGrossProfit: number;
  retainer: number;
  adSpend: number;
  totalInvestment: number;
  netValue: number;
  roiPercent: number | null;
}

export interface RoiReport {
  period: string;
  currency: string;
  businessMode: BusinessMode;
  baseline: RoiBaseline | null;
  funnel: RoiFunnel | null;
  result: RoiResult | null;
  availablePeriods: string[];
}

export interface PortalApproval {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  title: string;
  summary: string;
  preview: Record<string, unknown>;
  note: string | null;
  decidedAt: string | null;
  createdAt: string | null;
  decidedAutomatically: boolean;
}

export interface GuardrailItem {
  key: string;
  label: string;
  lane: GuardrailLane;
  defaultLane: GuardrailLane;
  promotable: boolean;
}

export interface WorkspaceRecord {
  id: string;
  kind: WorkspaceKind;
  title: string;
  status: string;
  detail: Record<string, unknown>;
  dueAt: string | null;
  updatedAt: string | null;
}

export interface WorkspaceView {
  businessMode: BusinessMode;
  records: WorkspaceRecord[];
}

export interface BrandKit {
  primaryColor: string;
  accentColor: string;
  logoText: string;
  contactCta: string;
  websiteUrl: string | null;
}

export type SocialPostStatus = "awaiting_approval" | "published" | "failed" | "rejected";
export type SocialOutcome = "published" | "awaiting_owner" | "in_qa_review" | "failed";

export interface SocialPost {
  id: string;
  status: SocialPostStatus;
  headline: string;
  subtext: string;
  caption: string;
  hashtags: string[];
  platforms: string[];
  hasImage: boolean;
  /** Public https address of the visual: the same one Instagram is given to fetch. */
  imageUrl: string | null;
  visualEngine: string | null;
  /** `sandbox` is a recorded dry run: nothing reached Meta. */
  publishMode: "live" | "sandbox" | null;
  permalink: string | null;
  /** Null when unknown. Never a guess. */
  reach: number | null;
  commentsReplied: number;
  leadsCaptured: number;
  error: string | null;
  /** A sample row from the demo account. */
  demo: boolean;
  publishedAt: string | null;
  createdAt: string;
}

export interface SocialComment {
  id: string;
  postId: string;
  author: string;
  text: string;
  publicReply: string;
  /** Who took the conversation over, e.g. "Sales Rep" or "Order Desk". */
  handoffTo: string | null;
  dmText: string;
  live: boolean;
  /** An example of what the autopilot does with a comment, not a real customer. */
  sample: boolean;
  createdAt: string;
}

export interface SocialAutopilot {
  autopilotSocial: boolean;
  brandKit: BrandKit;
  /** False means sandbox mode: nothing is sent to Meta. */
  livePublishing: boolean;
  businessMode: BusinessMode;
  posts: SocialPost[];
  comments: SocialComment[];
}

export interface GenerateNowResult {
  outcome: SocialOutcome;
  message: string;
  post: SocialPost;
  comments: SocialComment[];
}

export interface SocialSettingsPatch {
  autopilotSocial?: boolean;
  brandKit?: BrandKit;
}

export interface RosterAgent {
  key: string;
  name: string;
  role: string;
  ecommerceOnly: boolean;
  active: boolean;
}

export interface Roster {
  businessMode: BusinessMode;
  rosters: Record<BusinessMode, RosterAgent[]>;
}

export type RecordKind = "lead" | "order";
export type RecordStatus = "new" | "booked" | "completed" | "pending" | "dispatched" | "delivered";
export type Qualification = "hot" | "warm";
export type CodStatus = "pending" | "collected" | "prepaid";

/** A captured lead or appointment, or an order, from the owner's own sheet. */
export interface WorkRecord {
  id: string;
  /** The short code the owner reads out to a customer, such as ORD-4F2A9C. */
  ref: string;
  kind: RecordKind;
  status: RecordStatus;
  customerName: string;
  contact: string;
  source: string;
  message: string;
  serviceRequested: string;
  preferredDate: string;
  qualification: Qualification;
  items: string;
  totalUsd: number;
  codStatus: CodStatus;
  courier: string;
  trackingNumber: string;
  dispatchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RecordInput = Partial<Omit<WorkRecord, "id" | "ref" | "dispatchedAt" | "createdAt" | "updatedAt">> & {
  kind: RecordKind;
  customerName: string;
};
export type RecordChanges = Partial<Omit<WorkRecord, "id" | "ref" | "kind" | "source" | "dispatchedAt" | "createdAt" | "updatedAt">>;

export interface PortalClient {
  readonly mode: "live" | "mock";
  /** Business setup, catalog, channel credentials and AI usage. */
  readonly knowledge: KnowledgeClient;
  profile(): Promise<PortalProfile>;
  roi(period?: string): Promise<RoiReport>;
  approvals(): Promise<PortalApproval[]>;
  decideApproval(id: string, decision: OwnerDecision, note?: string): Promise<PortalApproval>;
  guardrails(): Promise<GuardrailItem[]>;
  setGuardrail(key: string, lane: "automatic" | "owner"): Promise<GuardrailItem[]>;
  workspace(): Promise<WorkspaceView>;
  records(kind?: RecordKind): Promise<WorkRecord[]>;
  createRecord(input: RecordInput): Promise<WorkRecord>;
  updateRecord(id: string, changes: RecordChanges): Promise<WorkRecord>;
  roster(): Promise<Roster>;
  socialAutopilot(): Promise<SocialAutopilot>;
  updateSocialSettings(patch: SocialSettingsPatch): Promise<SocialAutopilot>;
  generateNow(): Promise<GenerateNowResult>;
  /** An object URL for the post's visual, or null when it has none. Revoke it when done. */
  socialMedia(postId: string): Promise<string | null>;
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

interface RoiWire {
  period: string;
  currency: string;
  business_mode: BusinessMode;
  baseline: {
    monthly_inquiries: number;
    conversion_rate: number;
    avg_order_or_profit_value: number;
    monthly_retainer_investment: number;
  } | null;
  funnel: {
    total_inquiries: number;
    qualified_leads: number;
    confirmed_outcomes: number;
    conversion_rate: number | null;
  } | null;
  result: {
    baseline_outcomes: number;
    current_outcomes: number;
    value_per_outcome: number;
    baseline_gross_profit: number;
    current_gross_profit: number;
    incremental_gross_profit: number;
    retainer: number;
    ad_spend: number;
    total_investment: number;
    net_value: number;
    roi_percent: number | null;
  } | null;
  available_periods: string[];
}

interface ApprovalWire {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  title: string;
  summary: string;
  preview: Record<string, unknown>;
  note: string | null;
  decided_at: string | null;
  created_at: string | null;
  decided_automatically: boolean;
}

interface GuardrailWire {
  key: string;
  label: string;
  lane: GuardrailLane;
  default_lane: GuardrailLane;
  promotable: boolean;
}

export const toRoi = (wire: RoiWire): RoiReport => ({
  period: wire.period,
  currency: wire.currency,
  businessMode: wire.business_mode,
  baseline: wire.baseline && {
    monthlyInquiries: wire.baseline.monthly_inquiries,
    conversionRate: wire.baseline.conversion_rate,
    avgOrderOrProfitValue: wire.baseline.avg_order_or_profit_value,
    monthlyRetainerInvestment: wire.baseline.monthly_retainer_investment,
  },
  funnel: wire.funnel && {
    totalInquiries: wire.funnel.total_inquiries,
    qualifiedLeads: wire.funnel.qualified_leads,
    confirmedOutcomes: wire.funnel.confirmed_outcomes,
    conversionRate: wire.funnel.conversion_rate,
  },
  result: wire.result && {
    baselineOutcomes: wire.result.baseline_outcomes,
    currentOutcomes: wire.result.current_outcomes,
    valuePerOutcome: wire.result.value_per_outcome,
    baselineGrossProfit: wire.result.baseline_gross_profit,
    currentGrossProfit: wire.result.current_gross_profit,
    incrementalGrossProfit: wire.result.incremental_gross_profit,
    retainer: wire.result.retainer,
    adSpend: wire.result.ad_spend,
    totalInvestment: wire.result.total_investment,
    netValue: wire.result.net_value,
    roiPercent: wire.result.roi_percent,
  },
  availablePeriods: wire.available_periods,
});

export type { RoiWire };

const toApproval = (wire: ApprovalWire): PortalApproval => ({
  id: wire.id,
  kind: wire.kind,
  status: wire.status,
  title: wire.title,
  summary: wire.summary,
  preview: wire.preview,
  note: wire.note,
  decidedAt: wire.decided_at,
  createdAt: wire.created_at,
  decidedAutomatically: wire.decided_automatically,
});

interface BrandKitWire {
  primary_color: string;
  accent_color: string;
  logo_text: string;
  contact_cta: string;
  website_url: string | null;
}

interface SocialPostWire {
  id: string;
  status: SocialPostStatus;
  headline: string;
  subtext: string;
  caption: string;
  hashtags: string[];
  platforms: string[];
  has_image: boolean;
  image_url: string | null;
  visual_engine: string | null;
  publish_mode: "live" | "sandbox" | null;
  permalink: string | null;
  reach: number | null;
  comments_replied: number;
  leads_captured: number;
  error: string | null;
  demo: boolean;
  published_at: string | null;
  created_at: string;
}

interface SocialCommentWire {
  id: string;
  post_id: string;
  author: string;
  text: string;
  public_reply: string;
  handoff_to: string | null;
  dm_text: string;
  live: boolean;
  sample: boolean;
  created_at: string;
}

interface SocialWire {
  autopilot_social: boolean;
  brand_kit: BrandKitWire;
  live_publishing: boolean;
  business_mode: BusinessMode;
  posts: SocialPostWire[];
  comments: SocialCommentWire[];
}

interface RecordWire {
  id: string;
  ref: string;
  kind: RecordKind;
  status: RecordStatus;
  customer_name: string;
  contact: string;
  source: string;
  message: string;
  service_requested: string;
  preferred_date: string;
  qualification: Qualification;
  items: string;
  total_usd: number;
  cod_status: CodStatus;
  courier: string;
  tracking_number: string;
  dispatched_at: string | null;
  created_at: string;
  updated_at: string;
}

const toRecord = (wire: RecordWire): WorkRecord => ({
  id: wire.id,
  ref: wire.ref,
  kind: wire.kind,
  status: wire.status,
  customerName: wire.customer_name,
  contact: wire.contact,
  source: wire.source,
  message: wire.message,
  serviceRequested: wire.service_requested,
  preferredDate: wire.preferred_date,
  qualification: wire.qualification,
  items: wire.items,
  totalUsd: wire.total_usd,
  codStatus: wire.cod_status,
  courier: wire.courier,
  trackingNumber: wire.tracking_number,
  dispatchedAt: wire.dispatched_at,
  createdAt: wire.created_at,
  updatedAt: wire.updated_at,
});

/** The wire names, for the fields a record form or an inline edit can send. */
const RECORD_FIELDS: Record<string, string> = {
  kind: "kind",
  status: "status",
  customerName: "customer_name",
  contact: "contact",
  source: "source",
  message: "message",
  serviceRequested: "service_requested",
  preferredDate: "preferred_date",
  qualification: "qualification",
  items: "items",
  totalUsd: "total_usd",
  codStatus: "cod_status",
  courier: "courier",
  trackingNumber: "tracking_number",
};

function recordBody(fields: object): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && key in RECORD_FIELDS) body[RECORD_FIELDS[key]] = value;
  }
  return body;
}

const toBrandKit = (wire: BrandKitWire): BrandKit => ({
  primaryColor: wire.primary_color,
  accentColor: wire.accent_color,
  logoText: wire.logo_text,
  contactCta: wire.contact_cta,
  websiteUrl: wire.website_url,
});

const toSocialPost = (wire: SocialPostWire): SocialPost => ({
  id: wire.id,
  status: wire.status,
  headline: wire.headline,
  subtext: wire.subtext,
  caption: wire.caption,
  hashtags: wire.hashtags,
  platforms: wire.platforms,
  hasImage: wire.has_image,
  imageUrl: wire.image_url,
  visualEngine: wire.visual_engine,
  publishMode: wire.publish_mode,
  permalink: wire.permalink,
  reach: wire.reach,
  commentsReplied: wire.comments_replied,
  leadsCaptured: wire.leads_captured,
  error: wire.error,
  demo: wire.demo,
  publishedAt: wire.published_at,
  createdAt: wire.created_at,
});

const toSocialComment = (wire: SocialCommentWire): SocialComment => ({
  id: wire.id,
  postId: wire.post_id,
  author: wire.author,
  text: wire.text,
  publicReply: wire.public_reply,
  handoffTo: wire.handoff_to,
  dmText: wire.dm_text,
  live: wire.live,
  sample: wire.sample,
  createdAt: wire.created_at,
});

const toSocial = (wire: SocialWire): SocialAutopilot => ({
  autopilotSocial: wire.autopilot_social,
  brandKit: toBrandKit(wire.brand_kit),
  livePublishing: wire.live_publishing,
  businessMode: wire.business_mode,
  posts: wire.posts.map(toSocialPost),
  comments: wire.comments.map(toSocialComment),
});

const toGuardrail = (wire: GuardrailWire): GuardrailItem => ({
  key: wire.key,
  label: wire.label,
  lane: wire.lane,
  defaultLane: wire.default_lane,
  promotable: wire.promotable,
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

  const send = () =>
    fetch(`${BASE}/${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    });

  let response: Response;
  try {
    response = await send();
    // Only a session can renew. A rejected access link is simply rejected.
    if (response.status === 401 && !options.token && (await refreshSession())) {
      await discardBody(response);
      response = await send();
    }
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

function createLivePortal(subdomain: string, token: string | null): PortalClient {
  const tenant = encodeURIComponent(subdomain);
  const get = <T,>(path: string) => request<T>(`${tenant}/${path}`, { token, timeoutMs: READ_TIMEOUT_MS });
  const send = <T,>(path: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}) =>
    request<T>(`${tenant}/${path}`, { token, timeoutMs: READ_TIMEOUT_MS, ...options });

  return {
    mode: "live",
    knowledge: createLiveKnowledge((path, options) => send(path, options)),

    async profile() {
      const body = await get<{
        company_name: string;
        business_mode: BusinessMode;
        niche_template: string;
        package_tier: string;
        region_preset: "bd" | "global";
        currency: string;
        onboarding_stage: number;
        pending_approvals: number;
        is_demo: boolean;
      }>("profile");
      return {
        companyName: body.company_name,
        businessMode: body.business_mode,
        nicheTemplate: body.niche_template,
        packageTier: body.package_tier,
        region: body.region_preset,
        currency: body.currency,
        onboardingStage: body.onboarding_stage,
        pendingApprovals: body.pending_approvals,
        isDemo: body.is_demo,
      };
    },

    async roi(period) {
      const query = period ? `?period=${encodeURIComponent(period)}` : "";
      return toRoi(await get<RoiWire>(`roi${query}`));
    },

    async approvals() {
      return (await get<ApprovalWire[]>("approvals")).map(toApproval);
    },

    async decideApproval(id, decision, note) {
      return toApproval(
        await request<ApprovalWire>(`${tenant}/approvals/${encodeURIComponent(id)}/decide`, {
          method: "POST",
          token,
          body: { decision, note: note ?? null },
          timeoutMs: READ_TIMEOUT_MS,
        }),
      );
    },

    async guardrails() {
      return (await get<GuardrailWire[]>("guardrails")).map(toGuardrail);
    },

    async setGuardrail(key, lane) {
      const body = await request<GuardrailWire[]>(`${tenant}/guardrails/${encodeURIComponent(key)}`, {
        method: "PUT",
        token,
        body: { lane },
        timeoutMs: READ_TIMEOUT_MS,
      });
      return body.map(toGuardrail);
    },

    async workspace() {
      const body = await get<{
        business_mode: BusinessMode;
        records: {
          id: string;
          kind: WorkspaceKind;
          title: string;
          status: string;
          detail: Record<string, unknown>;
          due_at: string | null;
          updated_at: string | null;
        }[];
      }>("workspace");
      return {
        businessMode: body.business_mode,
        records: body.records.map((record) => ({
          id: record.id,
          kind: record.kind,
          title: record.title,
          status: record.status,
          detail: record.detail,
          dueAt: record.due_at,
          updatedAt: record.updated_at,
        })),
      };
    },

    async records(kind) {
      const body = await get<{ records: RecordWire[] }>(kind ? `records?kind=${kind}` : "records");
      return body.records.map(toRecord);
    },

    async createRecord(input) {
      return toRecord(await send<RecordWire>("records", { method: "POST", body: recordBody(input) }));
    },

    async updateRecord(id, changes) {
      return toRecord(
        await send<RecordWire>(`records/${encodeURIComponent(id)}`, { method: "PATCH", body: recordBody(changes) }),
      );
    },

    async roster() {
      const body = await get<{
        business_mode: BusinessMode;
        rosters: Record<BusinessMode, { key: string; name: string; role: string; ecommerce_only: boolean; active: boolean }[]>;
      }>("roster");
      const agents = (mode: BusinessMode): RosterAgent[] =>
        (body.rosters[mode] ?? []).map((agent) => ({
          key: agent.key,
          name: agent.name,
          role: agent.role,
          ecommerceOnly: agent.ecommerce_only,
          active: agent.active,
        }));
      return { businessMode: body.business_mode, rosters: { general: agents("general"), ecommerce: agents("ecommerce") } };
    },

    async socialAutopilot() {
      return toSocial(await get<SocialWire>("social-autopilot"));
    },

    async updateSocialSettings(patch) {
      const body: Record<string, unknown> = {};
      if (patch.autopilotSocial !== undefined) body.autopilot_social = patch.autopilotSocial;
      if (patch.brandKit) {
        body.brand_kit = {
          primary_color: patch.brandKit.primaryColor,
          accent_color: patch.brandKit.accentColor,
          logo_text: patch.brandKit.logoText,
          contact_cta: patch.brandKit.contactCta,
          website_url: patch.brandKit.websiteUrl || null,
        };
      }
      return toSocial(
        await request<SocialWire>(`${tenant}/social-autopilot/settings`, {
          method: "PATCH",
          token,
          body,
          timeoutMs: READ_TIMEOUT_MS,
        }),
      );
    },

    async generateNow() {
      // Drawing the visual and calling the publisher takes a few seconds.
      const body = await request<{
        outcome: SocialOutcome;
        message: string;
        post: SocialPostWire;
        comments: SocialCommentWire[];
      }>(`${tenant}/social-autopilot/generate-now`, { method: "POST", token, timeoutMs: 120_000 });
      return {
        outcome: body.outcome,
        message: body.message,
        post: toSocialPost(body.post),
        comments: body.comments.map(toSocialComment),
      };
    },

    async socialMedia(postId) {
      const headers: Record<string, string> = {};
      if (token) headers["X-Client-Portal-Token"] = token;
      const url = `${BASE}/${tenant}/social-autopilot/media/${encodeURIComponent(postId)}`;
      try {
        let response = await fetch(url, { headers, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
        if (response.status === 401 && !token && (await refreshSession())) {
          await discardBody(response);
          response = await fetch(url, { headers, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
        }
        if (!response.ok) {
          await discardBody(response);
          return null;
        }
        return URL.createObjectURL(await response.blob());
      } catch {
        return null;
      }
    },

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

/**
 * One tenant's usage for the agency console. Signed in as staff there is no access link,
 * so the session cookie is the credential, as on any portal page opened by the team.
 */
export function loadUsageAsStaff(subdomain: string): Promise<UsageSummary> {
  return createLoadKnowledge(subdomain).usage();
}

function createLoadKnowledge(subdomain: string): KnowledgeClient {
  const tenant = encodeURIComponent(subdomain);
  return createLiveKnowledge((path, options = {}) =>
    request(`${tenant}/${path}`, { token: null, timeoutMs: READ_TIMEOUT_MS, ...options }),
  );
}

// ---------------------------------------------------------------------- connection
export type PortalConnection =
  | { mode: "live"; client: PortalClient }
  | { mode: "mock"; client: PortalClient }
  | { mode: "signin"; rejected: boolean }
  /** Signed in, but this is not a business this account may see. */
  | { mode: "forbidden" };

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
 * even to refuse a credential, means a real account exists, and fake figures would
 * be read as real ones. Once live, a failed call surfaces as an error and never
 * falls back to samples.
 *
 * With no access link the session cookie is the credential, so a 200 with no token
 * still means live.
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
        if (!token) return { mode: "signin", rejected: false };
        // The saved link is dead, but this person may also have a session.
        saveToken(subdomain, null);
        const fallback = await connectPortal(subdomain, null);
        return fallback.mode === "signin" ? { mode: "signin", rejected: true } : fallback;
      }
      if (error.status === 403) return { mode: "forbidden" };
      // Authenticated, but this read failed. Live, and the page reports the error.
      return { mode: "live", client: createLivePortal(subdomain, token) };
    }
    throw error;
  }
  return { mode: "live", client: createLivePortal(subdomain, token) };
}
