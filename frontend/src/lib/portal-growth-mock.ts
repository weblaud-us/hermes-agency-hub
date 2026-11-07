import { ApiError } from "./hub-types";
import type {
  ApprovalKind,
  GuardrailItem,
  OwnerDecision,
  PortalApproval,
  PortalClient,
  RoiReport,
  RecordChanges,
  RecordInput,
  WorkRecord,
  WorkspaceRecord,
} from "./portal-api";
import { delay } from "./utils";

type GrowthViews = Pick<
  PortalClient,
  "profile" | "roi" | "approvals" | "decideApproval" | "guardrails" | "setGuardrail" | "workspace" | "records" | "createRecord" | "updateRecord"
>;

/** Sample figures for a preview with no hub behind it. The page labels them as samples. */
export function createGrowthMock(company: string, subdomain: string): GrowthViews {
  const ecommerce = !/dental|clinic|salon|beauty|restaurant|travel/.test(subdomain);
  const currency = "USD";
  const scale = 0.01;
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
          courier: "DHL",
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

  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const sample = (fields: Partial<WorkRecord> & Pick<WorkRecord, "id" | "ref" | "kind" | "status" | "customerName">, hours: number): WorkRecord => ({
    contact: "",
    source: "manual",
    message: "",
    serviceRequested: "",
    preferredDate: "",
    qualification: "warm",
    items: "",
    totalUsd: 0,
    codStatus: "pending",
    courier: "",
    trackingNumber: "",
    dispatchedAt: null,
    createdAt: hoursAgo(hours),
    updatedAt: hoursAgo(hours),
    ...fields,
  });
  let sheet: WorkRecord[] = ecommerce
    ? [
        sample({ id: "mock-order-0001", ref: "ORD-4F2A9C", kind: "order", status: "pending", customerName: "R. Hall", contact: "+1 555 010 0142", items: "Navy shirt, size M x1", totalUsd: 38, codStatus: "pending" }, 2),
        sample({ id: "mock-order-0002", ref: "ORD-71B3E0", kind: "order", status: "dispatched", customerName: "N. Adams", contact: "+1 555 010 0177", items: "Linen dress, olive, size S x1", totalUsd: 64.5, codStatus: "pending", courier: "DHL", trackingNumber: "DH-20418837", dispatchedAt: hoursAgo(20) }, 30),
        sample({ id: "mock-order-0003", ref: "ORD-C90D12", kind: "order", status: "delivered", customerName: "T. Reed", contact: "@treed", items: "Kids set x2", totalUsd: 52, codStatus: "collected", courier: "FedEx", trackingNumber: "FX-77120" }, 70),
        sample({ id: "mock-lead-0001", ref: "LEAD-0A11B2", kind: "lead", status: "new", customerName: "Imani C.", contact: "instagram:1790", source: "instagram_comment", message: "Do you still have the navy one in medium?", qualification: "hot" }, 1),
      ]
    : [
        sample({ id: "mock-lead-0001", ref: "LEAD-5C21D8", kind: "lead", status: "booked", customerName: "S. Ahmed", contact: "+1 555 010 0199", serviceRequested: "Scaling and polish", preferredDate: "Next Tuesday", qualification: "hot", source: "whatsapp" }, 26),
        sample({ id: "mock-lead-0002", ref: "LEAD-8E02F4", kind: "lead", status: "new", customerName: "M. Islam", contact: "+1 555 010 0123", serviceRequested: "Braces consultation", preferredDate: "This week", qualification: "hot", source: "facebook_comment", message: "How much are braces and can I book for Friday?" }, 3),
        sample({ id: "mock-lead-0003", ref: "LEAD-19AB77", kind: "lead", status: "new", customerName: "A. Noor", contact: "messenger:4410", serviceRequested: "Whitening", qualification: "warm", source: "messenger" }, 8),
        sample({ id: "mock-lead-0004", ref: "LEAD-D43C05", kind: "lead", status: "completed", customerName: "F. Karim", contact: "+1 555 010 0150", serviceRequested: "Consultation", preferredDate: "Last Monday", qualification: "warm" }, 90),
      ];

  const records: WorkspaceRecord[] = ecommerce
    ? [
        record("w1", "order", "Order #4821, navy shirt (M)", "awaiting_cod_confirmation", { customer: "R. Hall", cod_amount: 1650 * scale, courier: "UPS" }),
        record("w2", "order", "Order #4817, linen dress", "in_transit", { customer: "N. Adams", cod_amount: 2450 * scale, courier: "DHL", tracking: "DH-20418837" }),
        record("w3", "order", "Order #4809, kids set", "delivered", { customer: "T. Reed", cod_amount: 980 * scale, courier: "FedEx", tracking: "FX-77120" }),
        record("w4", "stock_alert", "Navy shirt, size L", "low", { sku: "SHT-NAVY-L", stock: 3, reorder_at: 10 }),
        record("w5", "stock_alert", "Linen dress, olive", "low", { sku: "DRS-OLV", stock: 1, reorder_at: 5 }),
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
        region: "global",
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

    async records(kind) {
      await delay(160);
      return sheet.filter((row) => !kind || row.kind === kind).map((row) => ({ ...row }));
    },

    async createRecord(input: RecordInput) {
      await delay(160);
      const stamp = new Date().toISOString();
      const row: WorkRecord = {
        id: `mock-record-${sheet.length + 1}-${Date.now()}`.slice(0, 16),
        ref: `${input.kind === "order" ? "ORD" : "LEAD"}-${String(Math.floor(Math.random() * 0xffffff)).padStart(6, "0").toUpperCase()}`,
        kind: input.kind,
        status: input.status ?? (input.kind === "order" ? "pending" : "new"),
        customerName: input.customerName,
        contact: input.contact ?? "",
        source: input.source ?? "manual",
        message: input.message ?? "",
        serviceRequested: input.serviceRequested ?? "",
        preferredDate: input.preferredDate ?? "",
        qualification: input.qualification ?? "warm",
        items: input.items ?? "",
        totalUsd: input.totalUsd ?? 0,
        codStatus: input.codStatus ?? "pending",
        courier: input.courier ?? "",
        trackingNumber: input.trackingNumber ?? "",
        dispatchedAt: null,
        createdAt: stamp,
        updatedAt: stamp,
      };
      sheet = [row, ...sheet];
      return { ...row };
    },

    async updateRecord(id: string, changes: RecordChanges) {
      await delay(160);
      const current = sheet.find((row) => row.id === id);
      if (!current) throw new ApiError(404, "record_not_found", "That record no longer exists.");
      const stamp = new Date().toISOString();
      const next: WorkRecord = {
        ...current,
        ...changes,
        updatedAt: stamp,
        dispatchedAt: changes.status === "dispatched" && current.status !== "dispatched" ? stamp : current.dispatchedAt,
      };
      sheet = sheet.map((row) => (row.id === id ? next : row));
      return { ...next };
    },

    async workspace() {
      await delay(200);
      return { businessMode: ecommerce ? "ecommerce" : "general", records: records.map((row) => ({ ...row })) };
    },
  };
}
