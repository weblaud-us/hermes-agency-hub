import { request } from "./api";
import type { BaselineMetrics } from "./hub-types";
import { toRoi, type ApprovalKind, type ApprovalStatus, type RoiReport, type RoiWire } from "./portal-api";
import type { BusinessMode, NicheTemplate, PackageTier, RegionPreset } from "./provisioning";

const TIMEOUT_MS = 20_000;

// ------------------------------------------------------------------ domain types
export interface QaItem {
  id: string;
  clientId: string;
  clientSlug: string;
  companyName: string;
  onboardingStage: number;
  kind: ApprovalKind;
  status: ApprovalStatus;
  title: string;
  summary: string;
  preview: Record<string, unknown>;
  sourceSkill: string | null;
  escalated: boolean;
  note: string | null;
  createdAt: string | null;
}

export type QaDecision = "forward" | "return" | "escalate";

export type ProspectStage = "new" | "qualified" | "contacted" | "video_audit_sent" | "meeting" | "proposal" | "won";
export type AuditProgress = "not_started" | "recording" | "sent" | "viewed";

export const SCORE_SIGNALS = ["noWebsite", "irregularSocial", "slowReply", "repeatHighValueSales", "accessibleOwner"] as const;
export type ScoreSignal = (typeof SCORE_SIGNALS)[number];

export interface OnboardingDraft {
  companyName: string;
  contactEmail: string | null;
  businessMode: BusinessMode;
  nicheTemplate: NicheTemplate;
  packageTier: PackageTier;
  region: RegionPreset;
  currency: string | null;
  baseline: BaselineMetrics | null;
  notes: string;
}

export interface Prospect extends Record<ScoreSignal, boolean> {
  id: string;
  businessName: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  niche: string | null;
  stage: ProspectStage;
  assignee: string | null;
  auditProgress: AuditProgress;
  auditUrl: string | null;
  nextFollowUp: string | null;
  notes: string;
  priorityScore: number;
  draft: OnboardingDraft | null;
}

export type ProspectChanges = Partial<Omit<Prospect, "id" | "priorityScore" | "draft">>;

export interface Pipeline {
  target: number;
  items: Prospect[];
}

export interface StandupMetric {
  key: string;
  label: string;
  target: number;
  done: number;
}

export interface StandupMember {
  key: string;
  name: string;
  focus: string;
  metrics: StandupMetric[];
  completionPercent: number;
}

export interface StandupDay {
  day: string;
  members: StandupMember[];
}

export interface StarterKit {
  key: string;
  name: string;
  businessMode: BusinessMode;
  description: string;
  skills: string[];
  knowledgeChecklist: string[];
  customised: boolean;
}

export interface LibrarySkill {
  id: string;
  description: string;
  group: "router" | "core" | "ecommerce";
  markdown: string;
}

export interface RoiEntry {
  totalInquiries: number;
  qualifiedLeads: number;
  confirmedOutcomes: number;
  adSpend: number;
}

export interface ClientPatch {
  onboardingStage?: number;
  baseline?: BaselineMetrics;
}

export interface OpsClient {
  qaQueue(): Promise<QaItem[]>;
  qaDecide(item: QaItem, decision: QaDecision, note?: string): Promise<void>;
  qaRevise(item: QaItem, changes: { title: string; summary: string; body: string | null }): Promise<void>;
  pipeline(): Promise<Pipeline>;
  createProspect(businessName: string): Promise<Prospect>;
  updateProspect(id: string, changes: ProspectChanges): Promise<Prospect>;
  deleteProspect(id: string): Promise<void>;
  saveDraft(id: string, draft: OnboardingDraft): Promise<Prospect>;
  drafts(): Promise<Prospect[]>;
  standup(day: string): Promise<StandupDay>;
  setStandup(day: string, member: string, metric: string, done: number): Promise<StandupDay>;
  kits(): Promise<StarterKit[]>;
  updateKit(key: string, changes: { description?: string; skills?: string[]; knowledgeChecklist?: string[] }): Promise<StarterKit[]>;
  resetKit(key: string): Promise<StarterKit[]>;
  skills(): Promise<LibrarySkill[]>;
  roi(clientId: string, period?: string): Promise<RoiReport>;
  saveRoi(clientId: string, period: string, entry: RoiEntry): Promise<RoiReport>;
  updateClient(clientId: string, patch: ClientPatch): Promise<void>;
}

// -------------------------------------------------------------------- wire shapes
interface QaWire {
  id: string;
  client_id: string;
  client_slug: string;
  company_name: string;
  onboarding_stage: number;
  kind: ApprovalKind;
  status: ApprovalStatus;
  title: string;
  summary: string;
  preview: Record<string, unknown>;
  source_skill: string | null;
  escalated: boolean;
  note: string | null;
  created_at: string | null;
}

interface DraftWire {
  company_name: string;
  contact_email: string | null;
  business_mode: BusinessMode;
  niche_template: NicheTemplate;
  package_tier: PackageTier;
  region_preset: RegionPreset;
  currency: string | null;
  baseline_metrics: BaselineWire | null;
  notes: string;
}

interface BaselineWire {
  monthly_inquiries: number;
  conversion_rate: number;
  avg_order_or_profit_value: number;
  monthly_retainer_investment: number;
}

interface ProspectWire {
  id: string;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  niche: string | null;
  stage: ProspectStage;
  no_website: boolean;
  irregular_social: boolean;
  slow_reply: boolean;
  repeat_high_value_sales: boolean;
  accessible_owner: boolean;
  assignee: string | null;
  audit_progress: AuditProgress;
  audit_url: string | null;
  next_follow_up: string | null;
  notes: string;
  priority_score: number;
  onboarding_draft: DraftWire | null;
}

interface StandupWire {
  day: string;
  members: { key: string; name: string; focus: string; metrics: StandupMetric[]; completion_percent: number }[];
}

interface KitWire {
  key: string;
  name: string;
  business_mode: BusinessMode;
  description: string;
  skills: string[];
  knowledge_checklist: string[];
  customised: boolean;
}

const baselineToWire = (baseline: BaselineMetrics): BaselineWire => ({
  monthly_inquiries: baseline.monthlyInquiries,
  conversion_rate: baseline.conversionRate,
  avg_order_or_profit_value: baseline.avgOrderOrProfitValue,
  monthly_retainer_investment: baseline.monthlyRetainerInvestment,
});

const toDraft = (wire: DraftWire): OnboardingDraft => ({
  companyName: wire.company_name,
  contactEmail: wire.contact_email,
  businessMode: wire.business_mode,
  nicheTemplate: wire.niche_template,
  packageTier: wire.package_tier,
  region: wire.region_preset,
  currency: wire.currency,
  baseline: wire.baseline_metrics && {
    monthlyInquiries: wire.baseline_metrics.monthly_inquiries,
    conversionRate: wire.baseline_metrics.conversion_rate,
    avgOrderOrProfitValue: wire.baseline_metrics.avg_order_or_profit_value,
    monthlyRetainerInvestment: wire.baseline_metrics.monthly_retainer_investment,
  },
  notes: wire.notes,
});

const toProspect = (wire: ProspectWire): Prospect => ({
  id: wire.id,
  businessName: wire.business_name,
  contactName: wire.contact_name,
  phone: wire.phone,
  email: wire.email,
  niche: wire.niche,
  stage: wire.stage,
  noWebsite: wire.no_website,
  irregularSocial: wire.irregular_social,
  slowReply: wire.slow_reply,
  repeatHighValueSales: wire.repeat_high_value_sales,
  accessibleOwner: wire.accessible_owner,
  assignee: wire.assignee,
  auditProgress: wire.audit_progress,
  auditUrl: wire.audit_url,
  nextFollowUp: wire.next_follow_up,
  notes: wire.notes,
  priorityScore: wire.priority_score,
  draft: wire.onboarding_draft ? toDraft(wire.onboarding_draft) : null,
});

const PROSPECT_FIELDS: Record<keyof ProspectChanges, string> = {
  businessName: "business_name",
  contactName: "contact_name",
  phone: "phone",
  email: "email",
  niche: "niche",
  stage: "stage",
  noWebsite: "no_website",
  irregularSocial: "irregular_social",
  slowReply: "slow_reply",
  repeatHighValueSales: "repeat_high_value_sales",
  accessibleOwner: "accessible_owner",
  assignee: "assignee",
  auditProgress: "audit_progress",
  auditUrl: "audit_url",
  nextFollowUp: "next_follow_up",
  notes: "notes",
};

const toStandup = (wire: StandupWire): StandupDay => ({
  day: wire.day,
  members: wire.members.map((member) => ({
    key: member.key,
    name: member.name,
    focus: member.focus,
    metrics: member.metrics,
    completionPercent: member.completion_percent,
  })),
});

const toKit = (wire: KitWire): StarterKit => ({
  key: wire.key,
  name: wire.name,
  businessMode: wire.business_mode,
  description: wire.description,
  skills: wire.skills,
  knowledgeChecklist: wire.knowledge_checklist,
  customised: wire.customised,
});

// --------------------------------------------------------------------- live client
export function createLiveOps(): OpsClient {
  const send = <T,>(path: string, method = "GET", body?: unknown) =>
    request<T>(path, { method, body, timeoutMs: TIMEOUT_MS });
  const id = encodeURIComponent;

  return {
    async qaQueue() {
      const rows = await send<QaWire[]>("/qa/queue");
      return rows.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        clientSlug: row.client_slug,
        companyName: row.company_name,
        onboardingStage: row.onboarding_stage,
        kind: row.kind,
        status: row.status,
        title: row.title,
        summary: row.summary,
        preview: row.preview,
        sourceSkill: row.source_skill,
        escalated: row.escalated,
        note: row.note,
        createdAt: row.created_at,
      }));
    },

    async qaDecide(item, decision, note) {
      await send(`/clients/${id(item.clientId)}/approvals/${id(item.id)}/qa`, "POST", { decision, note: note ?? null });
    },

    async qaRevise(item, changes) {
      const preview = changes.body === null ? item.preview : { ...item.preview, body: changes.body };
      await send(`/clients/${id(item.clientId)}/approvals/${id(item.id)}/revise`, "POST", {
        title: changes.title,
        summary: changes.summary,
        preview,
      });
    },

    async pipeline() {
      const body = await send<{ target: number; items: ProspectWire[] }>("/crm/prospects");
      return { target: body.target, items: body.items.map(toProspect) };
    },

    async createProspect(businessName) {
      return toProspect(await send<ProspectWire>("/crm/prospects", "POST", { business_name: businessName }));
    },

    async updateProspect(prospectId, changes) {
      const body: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(changes)) {
        body[PROSPECT_FIELDS[field as keyof ProspectChanges]] = value;
      }
      return toProspect(await send<ProspectWire>(`/crm/prospects/${id(prospectId)}`, "PATCH", body));
    },

    async deleteProspect(prospectId) {
      await send(`/crm/prospects/${id(prospectId)}`, "DELETE");
    },

    async saveDraft(prospectId, draft) {
      return toProspect(
        await send<ProspectWire>(`/crm/prospects/${id(prospectId)}/draft`, "PUT", {
          company_name: draft.companyName,
          contact_email: draft.contactEmail || null,
          business_mode: draft.businessMode,
          niche_template: draft.nicheTemplate,
          package_tier: draft.packageTier,
          region_preset: draft.region,
          currency: draft.currency,
          baseline_metrics: draft.baseline ? baselineToWire(draft.baseline) : null,
          notes: draft.notes,
        }),
      );
    },

    async drafts() {
      return (await send<ProspectWire[]>("/crm/drafts")).map(toProspect);
    },

    async standup(day) {
      return toStandup(await send<StandupWire>(`/crm/standup?day=${id(day)}`));
    },

    async setStandup(day, member, metric, done) {
      return toStandup(await send<StandupWire>(`/crm/standup/${id(day)}/${id(member)}/${id(metric)}`, "PUT", { done }));
    },

    async kits() {
      return (await send<KitWire[]>("/kits")).map(toKit);
    },

    async updateKit(key, changes) {
      const rows = await send<KitWire[]>(`/kits/${id(key)}`, "PATCH", {
        description: changes.description,
        skills: changes.skills,
        knowledge_checklist: changes.knowledgeChecklist,
      });
      return rows.map(toKit);
    },

    async resetKit(key) {
      return (await send<KitWire[]>(`/kits/${id(key)}/customisation`, "DELETE")).map(toKit);
    },

    async skills() {
      return send<LibrarySkill[]>("/skills");
    },

    async roi(clientId, period) {
      const query = period ? `?period=${id(period)}` : "";
      return toRoi(await send<RoiWire>(`/clients/${id(clientId)}/roi${query}`));
    },

    async saveRoi(clientId, period, entry) {
      return toRoi(
        await send<RoiWire>(`/clients/${id(clientId)}/roi/${id(period)}`, "PUT", {
          total_inquiries: entry.totalInquiries,
          qualified_leads: entry.qualifiedLeads,
          confirmed_outcomes: entry.confirmedOutcomes,
          ad_spend: entry.adSpend,
        }),
      );
    },

    async updateClient(clientId, patch) {
      await send(`/clients/${id(clientId)}`, "PATCH", {
        ...(patch.onboardingStage !== undefined ? { onboarding_stage: patch.onboardingStage } : {}),
        ...(patch.baseline ? { baseline_metrics: baselineToWire(patch.baseline) } : {}),
      });
    },
  };
}

/** Today in the agency's timezone. Bangladesh has no daylight saving. */
export function agencyToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date());
}

export function agencyPeriod(): string {
  return agencyToday().slice(0, 7);
}
