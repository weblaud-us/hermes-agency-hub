import { ApiError } from "./hub-types";
import type {
  ApprovalKind,
  GuardrailItem,
  OwnerDecision,
  PortalApproval,
  PortalClient,
  RoiReport,
  WorkspaceRecord,
} from "./portal-api";
import { delay } from "./utils";

type GrowthViews = Pick<
  PortalClient,
  "profile" | "roi" | "approvals" | "decideApproval" | "guardrails" | "setGuardrail" | "workspace"
>;

/** Sample figures for a preview with no hub behind it. The page labels them as samples. */
export function createGrowthMock(company: string, subdomain: string): GrowthViews {
  const ecommerce = !/dental|clinic|salon|beauty|restaurant|travel/.test(subdomain);
  const bd = /suvana|dhaka|bd/.test(subdomain) || subdomain === "suvana";
  const currency = bd ? "BDT" : "USD";
  const scale = bd ? 1 : 0.01;
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const item = (id: string, kind: ApprovalKind, title: string, summary: string, preview: Record<string, unknown>): PortalApproval => ({
    id,
    kind,
    status: "pending_owner",
    title,
    summary,
    preview,
    note: null,
    decidedAt: null,
    createdAt: new Date(now.getTime() - 3_600_000).toISOString(),
    decidedAutomatically: false,
  });

  let approvals: PortalApproval[] = [
    item("a1", "social_post", "New collection carousel", "Five-slide carousel for this week's launch.", {
      body: "Our new collection is here. Limited stock, order today.",
      channel: "instagram",
    }),
    item("a2", "ad_boost", "Boost the best-performing reel", "Raise the daily budget while it is converting.", {
      amount: 1500 * scale,
      per: "day",
      duration_days: 5,
    }),
    ecommerce
      ? item("a3", "courier_dispatch", "Dispatch 12 confirmed COD parcels", "All twelve customers confirmed this morning.", {
          courier: bd ? "Steadfast" : "DHL",
          parcels: 12,
          cod_total: 18450 * scale,
        })
      : item("a3", "website_update", "Update the services page", "Adds the new package and its opening offer.", {
          body: "New: Family Package, three visits per quarter.",
        }),
    item("a4", "discount_offer", "Weekend welcome offer", "A limited offer for first-time customers, to fill quiet days.", {
      body: "10% off for new customers who book before the end of the month.",
    }),
  ];

  const lane = (key: string, label: string, defaultLane: GuardrailItem["lane"], promotable = false): GuardrailItem => ({
    key,
    label,
    lane: defaultLane,
    defaultLane,
    promotable,
  });

  let guardrails: GuardrailItem[] = [
    lane("faq_replies", "Answer common questions", "automatic"),
    lane("lead_capture", "Capture and qualify new leads", "automatic"),
    ecommerce
      ? lane("order_status_replies", "Reply with order status", "automatic")
      : lane("appointment_reminders", "Send appointment reminders", "automatic"),
    lane("weekly_report", "Send the weekly report", "automatic"),
    lane("social_posts", "Publish social posts", "owner", true),
    lane("reels", "Publish reels", "owner", true),
    lane("partner_emails", "Send partner emails", "owner", true),
    lane("website_updates", "Update website packages", "owner", true),
    ...(ecommerce ? [lane("courier_dispatch", "Book courier parcels", "owner", true)] : []),
    lane("ad_boosts", "Raise ad budgets", "owner"),
    lane("refunds", "Issue refunds", "never"),
    lane("discount_offers", "Send discount offers to customers", "owner"),
    lane("price_changes", "Change list prices", "never"),
    lane("legal_commitments", "Sign contracts or make legal commitments", "never"),
    lane("payment_settings", "Change payment or payout details", "never"),
    lane("customer_data_export", "Share or export customer data", "never"),
  ];

  const record = (id: string, kind: WorkspaceRecord["kind"], title: string, status: string, detail: Record<string, unknown>): WorkspaceRecord => ({
    id,
    kind,
    title,
    status,
    detail,
    dueAt: kind === "appointment" || kind === "follow_up" ? new Date(now.getTime() + 86_400_000).toISOString() : null,
    updatedAt: now.toISOString(),
  });

  const records: WorkspaceRecord[] = ecommerce
    ? [
        record("w1", "order", "Order #4821, navy panjabi (M)", "awaiting_cod_confirmation", { customer: "R. Hasan", cod_amount: 1650 * scale, courier: "Pathao" }),
        record("w2", "order", "Order #4817, cotton saree", "in_transit", { customer: "N. Akter", cod_amount: 2450 * scale, courier: "Steadfast", tracking: "SF-20418837" }),
        record("w3", "order", "Order #4809, kids kurta set", "delivered", { customer: "T. Rahman", cod_amount: 980 * scale, courier: "RedX", tracking: "RX-77120" }),
        record("w4", "stock_alert", "Navy panjabi, size L", "low", { sku: "PNJ-NAVY-L", stock: 3, reorder_at: 10 }),
        record("w5", "stock_alert", "Cotton saree, olive", "low", { sku: "SAR-OLV", stock: 1, reorder_at: 5 }),
      ]
    : [
        record("w1", "appointment", "Scaling and polish, S. Ahmed", "confirmed", { contact: "S. Ahmed", service: "Scaling" }),
        record("w2", "appointment", "Consultation, F. Karim", "confirmed", { contact: "F. Karim", service: "Consultation" }),
        record("w3", "lead", "Braces enquiry, M. Islam", "qualified", { contact: "M. Islam", source: "whatsapp" }),
        record("w4", "lead", "Whitening enquiry, A. Noor", "new", { contact: "A. Noor", source: "messenger" }),
        record("w5", "follow_up", "Six-month recall, J. Das", "open", { contact: "J. Das" }),
      ];

  const roi = (): RoiReport => ({
    period,
    currency,
    businessMode: ecommerce ? "ecommerce" : "general",
    baseline: {
      monthlyInquiries: 420,
      conversionRate: 8,
      avgOrderOrProfitValue: 650 * scale,
      monthlyRetainerInvestment: 25000 * scale,
    },
    funnel: { totalInquiries: 610, qualifiedLeads: 214, confirmedOutcomes: 118, conversionRate: 19.34 },
    result: {
      baselineOutcomes: 33.6,
      currentOutcomes: 118,
      valuePerOutcome: 650 * scale,
      baselineGrossProfit: 21840 * scale,
      currentGrossProfit: 76700 * scale,
      incrementalGrossProfit: 54860 * scale,
      retainer: 25000 * scale,
      adSpend: 18000 * scale,
      totalInvestment: 43000 * scale,
      netValue: 11860 * scale,
      roiPercent: 27.58,
    },
    availablePeriods: [period],
  });

  return {
    async profile() {
      await delay(180);
      return {
        companyName: company,
        businessMode: ecommerce ? "ecommerce" : "general",
        nicheTemplate: ecommerce ? "ecommerce_store" : "dental_clinic",
        packageTier: "growth",
        region: bd ? "bd" : "global",
        currency,
        onboardingStage: 7,
        pendingApprovals: approvals.filter((row) => row.status === "pending_owner").length,
        isDemo: false,
      };
    },

    async roi() {
      await delay(240);
      return roi();
    },

    async approvals() {
      await delay(200);
      return approvals.map((row) => ({ ...row }));
    },

    async decideApproval(id: string, decision: OwnerDecision, note?: string) {
      await delay(220);
      const current = approvals.find((row) => row.id === id);
      if (!current) throw new ApiError(404, "approval_not_found", "That item no longer exists.");
      if (current.status !== "pending_owner") {
        throw new ApiError(409, "approval_invalid_transition", "This item has already been decided.");
      }
      const status = decision === "approve" ? "approved" : decision === "edit" ? "changes_requested" : "rejected";
      const updated: PortalApproval = { ...current, status, note: note ?? null, decidedAt: new Date().toISOString() };
      approvals = approvals.map((row) => (row.id === id ? updated : row));
      return { ...updated };
    },

    async guardrails() {
      await delay(160);
      return guardrails.map((row) => ({ ...row }));
    },

    async setGuardrail(key: string, target: "automatic" | "owner") {
      await delay(180);
      guardrails = guardrails.map((row) => (row.key === key && row.promotable ? { ...row, lane: target } : row));
      return guardrails.map((row) => ({ ...row }));
    },

    async workspace() {
      await delay(200);
      return { businessMode: ecommerce ? "ecommerce" : "general", records: records.map((row) => ({ ...row })) };
    },
  };
}
