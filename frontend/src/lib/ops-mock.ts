import { ApiError } from "./hub-types";
import type {
  LibrarySkill,
  OnboardingDraft,
  OpsClient,
  Prospect,
  QaItem,
  StandupDay,
  StarterKit,
} from "./ops-api";
import { agencyPeriod } from "./ops-api";
import type { RoiReport } from "./portal-api";
import { delay } from "./utils";

/** Sample operations data for the console's preview. Nothing here is saved. */

const STANDUP = [
  {
    key: "sakib",
    name: "Sakib",
    focus: "Growth & Audits",
    metrics: [
      { key: "video_audits", label: "Video audits sent", target: 5 },
      { key: "growth_reviews", label: "Client growth reviews", target: 3 },
    ],
  },
  {
    key: "jubayed",
    name: "Jubayed",
    focus: "Leads & Follow-ups",
    metrics: [
      { key: "new_leads", label: "New leads", target: 15 },
      { key: "follow_ups", label: "Follow-ups", target: 10 },
    ],
  },
  {
    key: "ishtiaq",
    name: "Ishtiaq",
    focus: "Demos & Closing",
    metrics: [
      { key: "demos", label: "Demos run", target: 3 },
      { key: "closing_calls", label: "Closing calls", target: 2 },
    ],
  },
];

const score = (prospect: Prospect) =>
  Math.max(
    1,
    [prospect.noWebsite, prospect.irregularSocial, prospect.slowReply, prospect.repeatHighValueSales, prospect.accessibleOwner].filter(Boolean)
      .length,
  );

function prospect(id: string, businessName: string, fields: Partial<Prospect>): Prospect {
  const base: Prospect = {
    id,
    businessName,
    contactName: null,
    phone: null,
    email: null,
    niche: null,
    stage: "new",
    noWebsite: false,
    irregularSocial: false,
    slowReply: false,
    repeatHighValueSales: false,
    accessibleOwner: false,
    assignee: null,
    auditProgress: "not_started",
    auditUrl: null,
    nextFollowUp: null,
    notes: "",
    priorityScore: 1,
    draft: null,
    ...fields,
  };
  return { ...base, priorityScore: score(base) };
}

export function createMockOps(): OpsClient {
  let items: QaItem[] = [
    {
      id: "q1",
      clientId: "mock-suvana",
      clientSlug: "suvana",
      companyName: "Suvana",
      onboardingStage: 6,
      kind: "reel",
      status: "qa_review",
      title: "Behind the stitching reel",
      summary: "First cut of the workshop reel.",
      preview: { body: "Hook: One panjabi, forty hours of hands.", duration_seconds: 28 },
      sourceSkill: "video-reel-editor",
      escalated: false,
      note: null,
      createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    },
    {
      id: "q2",
      clientId: "mock-suvana",
      clientSlug: "suvana",
      companyName: "Suvana",
      onboardingStage: 6,
      kind: "partner_email",
      status: "qa_review",
      title: "Wholesale enquiry reply",
      summary: "Draft reply to a boutique asking about bulk pricing.",
      preview: { body: "Thank you for reaching out. We would be glad to share our wholesale terms." },
      sourceSkill: "email-outreach-assistant",
      escalated: true,
      note: "Pricing mentioned. Needs a second look.",
      createdAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    },
    {
      id: "q3",
      clientId: "mock-marigold-skincare",
      clientSlug: "marigold-skincare",
      companyName: "Marigold Skincare",
      onboardingStage: 6,
      kind: "social_post",
      status: "qa_returned",
      title: "Serum launch carousel",
      summary: "Caption needs the ingredient list corrected.",
      preview: { body: "Glow from within with our new vitamin C serum." },
      sourceSkill: "social-media-autopilot",
      escalated: false,
      note: "Claims 20% vitamin C; the label says 15%.",
      createdAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
    },
  ];

  let prospects: Prospect[] = [
    prospect("p1", "Nokshi Threads", { niche: "ecommerce_store", stage: "proposal", noWebsite: true, irregularSocial: true, slowReply: true, repeatHighValueSales: true, accessibleOwner: true, assignee: "ishtiaq", auditProgress: "viewed" }),
    prospect("p2", "Smile Care Dental", { niche: "dental_clinic", stage: "video_audit_sent", noWebsite: true, slowReply: true, accessibleOwner: true, assignee: "sakib", auditProgress: "sent" }),
    prospect("p3", "Glow Beauty Lounge", { niche: "beauty_salon", stage: "qualified", irregularSocial: true, repeatHighValueSales: true, accessibleOwner: true, assignee: "jubayed" }),
    prospect("p4", "Kacchi House", { niche: "restaurant", stage: "new", noWebsite: true, irregularSocial: true, assignee: "jubayed" }),
    prospect("p5", "Skyline Tours", { niche: "travel_agency", stage: "contacted", slowReply: true, assignee: "jubayed", auditProgress: "recording" }),
  ];

  const standupDays = new Map<string, Map<string, number>>();
  const standupView = (day: string): StandupDay => {
    const done = standupDays.get(day) ?? new Map<string, number>();
    return {
      day,
      members: STANDUP.map((member) => {
        const metrics = member.metrics.map((metric) => ({ ...metric, done: done.get(`${member.key}/${metric.key}`) ?? 0 }));
        const target = metrics.reduce((sum, metric) => sum + metric.target, 0);
        const achieved = metrics.reduce((sum, metric) => sum + Math.min(metric.done, metric.target), 0);
        return { key: member.key, name: member.name, focus: member.focus, metrics, completionPercent: Math.round((achieved / target) * 100) };
      }),
    };
  };

  const defaultKits: StarterKit[] = [
    { key: "dental_clinic", name: "Dental Clinic", businessMode: "general", description: "Appointment booking, treatment enquiries and recall reminders.", skills: ["ai-employee-orchestrator", "social-media-autopilot", "designer-brand-studio", "roi-weekly-reporter", "sales-rep-inbox", "email-outreach-assistant", "lead-qualification"], knowledgeChecklist: ["Treatment list and price ranges", "Doctor schedule", "Clinic location and parking", "Emergency policy"], customised: false },
    { key: "beauty_salon", name: "Beauty Salon", businessMode: "general", description: "Service bookings, packages and before-and-after social content.", skills: ["ai-employee-orchestrator", "social-media-autopilot", "designer-brand-studio", "roi-weekly-reporter", "video-reel-editor", "sales-rep-inbox", "lead-qualification"], knowledgeChecklist: ["Service menu and durations", "Stylist availability", "Package offers", "Cancellation policy"], customised: false },
    { key: "restaurant", name: "Restaurant", businessMode: "general", description: "Table reservations, menu questions and daily specials.", skills: ["ai-employee-orchestrator", "social-media-autopilot", "designer-brand-studio", "roi-weekly-reporter", "video-reel-editor", "web-seo-manager", "lead-qualification"], knowledgeChecklist: ["Menu with allergens", "Opening hours", "Reservation rules", "Delivery areas"], customised: false },
    { key: "ecommerce_store", name: "E-Commerce Clothing", businessMode: "ecommerce", description: "Catalog answers, COD confirmation, courier booking and stock alerts.", skills: ["ai-employee-orchestrator", "social-media-autopilot", "designer-brand-studio", "roi-weekly-reporter", "video-reel-editor", "ads-growth-manager", "sales-rep-inbox", "order-desk-ecommerce", "catalog-keeper-ecommerce", "ecommerce-lookup"], knowledgeChecklist: ["Product catalog with sizes", "Delivery charges by area", "Courier accounts", "Return and exchange policy"], customised: false },
  ];
  let kits = defaultKits.map((kit) => ({ ...kit }));

  const skill = (id: string, group: LibrarySkill["group"], description: string): LibrarySkill => ({
    id,
    group,
    description,
    markdown: `# ${id}\n\nSample preview. A live hub shows the full SKILL.md from the agency library.\n\n${description}`,
  });
  const library: LibrarySkill[] = [
    skill("ai-employee-orchestrator", "router", "Decide which specialist should handle a request and which guardrail lane applies."),
    skill("designer-brand-studio", "core", "Produce on-brand graphics, banners and product visuals."),
    skill("video-reel-editor", "core", "Plan and edit short vertical videos and reels."),
    skill("social-media-autopilot", "core", "Plan the content calendar, write captions and handle comments."),
    skill("sales-rep-inbox", "core", "Reply to enquiries fast, qualify them and follow up."),
    skill("ads-growth-manager", "core", "Propose campaigns and budgets for the owner to approve."),
    skill("email-outreach-assistant", "core", "Draft and organise email in the business's voice."),
    skill("web-seo-manager", "core", "Keep website content and packages accurate."),
    skill("roi-weekly-reporter", "core", "Report results against the baseline in plain language."),
    skill("order-desk-ecommerce", "ecommerce", "Verify COD orders, prepare courier bookings and track parcels."),
    skill("catalog-keeper-ecommerce", "ecommerce", "Keep SKUs and stock accurate and warn before anything sells out."),
  ];

  const entries = new Map<string, { inquiries: number; qualified: number; confirmed: number; adSpend: number }>();
  const report = (clientId: string): RoiReport => {
    const period = agencyPeriod();
    const entry = entries.get(clientId);
    return {
      period,
      currency: "BDT",
      businessMode: "ecommerce",
      baseline: null,
      funnel: entry
        ? {
            totalInquiries: entry.inquiries,
            qualifiedLeads: entry.qualified,
            confirmedOutcomes: entry.confirmed,
            conversionRate: entry.inquiries ? Math.round((entry.confirmed / entry.inquiries) * 10_000) / 100 : null,
          }
        : null,
      result: null,
      availablePeriods: entry ? [period] : [],
    };
  };

  const findProspect = (id: string) => {
    const found = prospects.find((row) => row.id === id);
    if (!found) throw new ApiError(404, "not_found", "No such prospect.");
    return found;
  };
  const replaceProspect = (next: Prospect) => {
    const scored = { ...next, priorityScore: score(next) };
    prospects = prospects.map((row) => (row.id === next.id ? scored : row));
    return { ...scored };
  };

  return {
    async qaQueue() {
      await delay(200);
      return [...items].sort((a, b) => Number(b.escalated) - Number(a.escalated));
    },

    async qaDecide(item, decision, note) {
      await delay(200);
      if (decision === "forward") items = items.filter((row) => row.id !== item.id);
      else if (decision === "return") items = items.map((row) => (row.id === item.id ? { ...row, status: "qa_returned", note: note ?? null, escalated: false } : row));
      else items = items.map((row) => (row.id === item.id ? { ...row, escalated: true, note: note ?? null } : row));
    },

    async qaRevise(item, changes) {
      await delay(200);
      items = items.map((row) =>
        row.id === item.id
          ? {
              ...row,
              title: changes.title,
              summary: changes.summary,
              preview: changes.body === null ? row.preview : { ...row.preview, body: changes.body },
              status: "qa_review",
              note: null,
            }
          : row,
      );
    },

    async pipeline() {
      await delay(200);
      return { target: 100, items: [...prospects].sort((a, b) => b.priorityScore - a.priorityScore) };
    },

    async createProspect(businessName) {
      await delay(160);
      const created = prospect(`p-${Date.now()}`, businessName, {});
      prospects = [created, ...prospects];
      return { ...created };
    },

    async updateProspect(id, changes) {
      await delay(120);
      return replaceProspect({ ...findProspect(id), ...changes });
    },

    async deleteProspect(id) {
      await delay(120);
      prospects = prospects.filter((row) => row.id !== id);
    },

    async saveDraft(id, draft: OnboardingDraft) {
      await delay(160);
      return replaceProspect({ ...findProspect(id), draft });
    },

    async drafts() {
      await delay(120);
      return prospects.filter((row) => row.draft);
    },

    async standup(day) {
      await delay(150);
      return standupView(day);
    },

    async setStandup(day, member, metric, done) {
      await delay(80);
      const map = standupDays.get(day) ?? new Map<string, number>();
      map.set(`${member}/${metric}`, done);
      standupDays.set(day, map);
      return standupView(day);
    },

    async kits() {
      await delay(160);
      return kits.map((kit) => ({ ...kit }));
    },

    async updateKit(key, changes) {
      await delay(160);
      kits = kits.map((kit) => (kit.key === key ? { ...kit, ...changes, customised: true } : kit));
      return kits.map((kit) => ({ ...kit }));
    },

    async resetKit(key) {
      await delay(160);
      const original = defaultKits.find((kit) => kit.key === key);
      kits = kits.map((kit) => (kit.key === key && original ? { ...original } : kit));
      return kits.map((kit) => ({ ...kit }));
    },

    async skills() {
      await delay(160);
      return library;
    },

    async roi(clientId) {
      await delay(150);
      return report(clientId);
    },

    async saveRoi(clientId, _period, entry) {
      await delay(150);
      entries.set(clientId, {
        inquiries: entry.totalInquiries,
        qualified: entry.qualifiedLeads,
        confirmed: entry.confirmedOutcomes,
        adSpend: entry.adSpend,
      });
      return report(clientId);
    },

    async updateClient() {
      await delay(120);
    },
  };
}
