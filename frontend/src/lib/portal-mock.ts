import type {
  AgencySkill,
  BusinessMemory,
  ChannelName,
  ChatTurn,
  CronFeed,
  CronJob,
  CronReport,
  LearnedSkill,
  MemoryFact,
  MemoryPatch,
  PortalChannel,
  PortalClient,
  PortalOverview,
  ReconnectResult,
} from "./portal-api";
import { ApiError } from "./hub-types";
import { createMockKnowledge } from "./knowledge-mock";
import { createGrowthMock } from "./portal-growth-mock";
import { createSocialMock } from "./portal-social-mock";
import { delay } from "./utils";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MEMORY_LIMIT = 2200;
const QR_SECONDS = 20;
/** How long sample re-linking takes to "complete", so the waiting state can be seen. */
const SAMPLE_PAIRING_MS = 9000;

interface SkillSeed {
  id: string;
  title: string;
  category: string;
  description: string;
  trigger: string;
  steps: string[];
  usedDaysAgo: number;
  uses: number;
  enabled?: boolean;
}

interface ReportSeed {
  markdown: string;
  metrics: [string, number][];
  durationMs: number;
}

interface JobSeed {
  id: string;
  name: string;
  schedule: string;
  /** Local hour and minute of the next run. */
  at: [number, number];
  everyDays: number;
  report: ReportSeed;
}

interface Profile {
  company: string;
  actions: number;
  trendPct: number;
  hours: number;
  responseSeconds: number;
  uptime: number;
  tier: string;
  whatsapp: { handle: string; volume: number; staff: [string, string][] };
  telegram: { handle: string; volume: number; ids: [string, string][] };
  webhook: { handle: string; volume: number };
  agencySkills: Omit<AgencySkill, "active">[];
  skills: SkillSeed[];
  memory: [string, string][];
  jobs: JobSeed[];
  reply: (question: string) => string;
}

const SUVANA: Profile = {
  company: "Suvana",
  actions: 1420,
  trendPct: 18,
  hours: 64.5,
  responseSeconds: 4.2,
  uptime: 99.98,
  tier: "Reasoning Tier v3.5",
  whatsapp: {
    handle: "+880 17XX-XXXXXX",
    volume: 312,
    staff: [
      ["staff-1", "+880 17XX-XXX204"],
      ["staff-2", "+880 18XX-XXX917"],
      ["staff-3", "+880 19XX-XXX552"],
    ],
  },
  telegram: {
    handle: "@SuvanaSupportBot",
    volume: 46,
    ids: [
      ["tg-1", "ID XXXX7766"],
      ["tg-2", "ID XXXX1042"],
    ],
  },
  webhook: { handle: "shop.suvana.example", volume: 128 },
  agencySkills: [
    { id: "storefront-order-lookup", title: "Storefront Order Lookup", category: "Commerce", description: "Finds any order by number or phone and answers status questions directly." },
    { id: "multi-courier-tracking", title: "Multi-Courier Tracking", category: "Logistics", description: "Tracks parcels across every courier you use and flags stalled shipments." },
    { id: "lead-qualification-matrix", title: "Lead Qualification Matrix", category: "Sales", description: "Scores new enquiries by intent and urgency so serious buyers get answered first." },
    { id: "inventory-velocity", title: "Inventory Velocity Analysis", category: "Operations", description: "Watches sell-through by SKU and warns before a fast mover runs out." },
  ],
  skills: [
    { id: "custom-exchange-policy", title: "Custom Exchange Policy Handler", category: "Customer Care", description: "Handles size and colour exchanges under your 7-day rule.", trigger: "A customer asks to swap an item within 7 days of delivery.", steps: ["Confirm the order number and delivery date.", "Check the replacement size is in stock.", "Offer a free swap inside Dhaka, or 70 BDT courier cost outside.", "Create the exchange note and share a pickup window."], usedDaysAgo: 0, uses: 214 },
    { id: "friday-flash-sale-hold", title: "Friday Flash-Sale Stock Hold", category: "Operations", description: "Reserves flash-sale stock for 2 hours after a customer commits.", trigger: "A customer confirms an item during a Friday flash sale.", steps: ["Mark the SKU as held for 2 hours.", "Send the payment link and the hold expiry time.", "Release the stock automatically if payment does not arrive."], usedDaysAgo: 3, uses: 96 },
    { id: "cod-risk-check", title: "Cash-on-Delivery Risk Check", category: "Orders", description: "Asks for a confirmation call on large first-time cash orders.", trigger: "A first-time customer places a cash order above 5,000 BDT.", steps: ["Compare the phone number with past orders.", "Ask the customer to confirm the address by message.", "Flag the order for staff review if there is no reply in 2 hours."], usedDaysAgo: 1, uses: 141 },
    { id: "vip-early-access", title: "VIP Early Access Replies", category: "Sales", description: "Gives repeat buyers the new-collection preview before launch.", trigger: "A customer with 5 or more past orders asks about a new collection.", steps: ["Confirm they are on the VIP list.", "Share the preview album.", "Offer to hold a size until launch day."], usedDaysAgo: 2, uses: 58 },
    { id: "bulk-corporate-enquiry", title: "Corporate Gifting Enquiries", category: "Sales", description: "Collects what the sales team needs for a bulk quote.", trigger: "Someone asks about 10 or more pieces, or corporate gifting.", steps: ["Ask for quantity, delivery date and budget.", "Share the corporate catalogue.", "Escalate to the store manager with a summary."], usedDaysAgo: 5, uses: 23 },
    { id: "size-guide-advisor", title: "Size Guide Advisor", category: "Customer Care", description: "Recommends a size from height and fit preference.", trigger: "A customer asks which size to buy.", steps: ["Ask for height and preferred fit.", "Match against the size chart.", "Recommend one size and mention the exchange rule."], usedDaysAgo: 0, uses: 302 },
    { id: "courier-delay-apology", title: "Courier Delay Follow-Up", category: "Logistics", description: "Contacts customers before they have to ask about a late parcel.", trigger: "A shipment has not moved for 3 business days.", steps: ["Open an enquiry with the courier.", "Message the customer with the revised estimate.", "Offer a 5% voucher if the delay passes 7 days."], usedDaysAgo: 1, uses: 67 },
    { id: "payment-proof-matching", title: "bKash Payment Matching", category: "Orders", description: "Matches payment screenshots against open orders.", trigger: "A customer sends a payment screenshot or transaction ID.", steps: ["Read the transaction ID and the amount.", "Match it to an open order.", "Confirm the order, or ask for the missing difference."], usedDaysAgo: 0, uses: 188 },
    { id: "restock-waitlist", title: "Restock Waitlist", category: "Sales", description: "Takes names for sold-out items and notifies them on restock.", trigger: "A customer asks about a sold-out item.", steps: ["Add the customer to the waitlist for that SKU and size.", "Notify the list when stock arrives, oldest request first."], usedDaysAgo: 4, uses: 74 },
    { id: "wholesale-price-guard", title: "Wholesale Price Guard", category: "Operations", description: "Keeps wholesale rates away from retail conversations.", trigger: "A retail customer asks for wholesale pricing.", steps: ["Explain the wholesale minimum of 20 pieces.", "Offer current retail promotions instead."], usedDaysAgo: 6, uses: 31 },
    { id: "eid-rush-hours", title: "Eid Rush Reply Timing", category: "Customer Care", description: "Sets honest delivery expectations in the two weeks before Eid.", trigger: "An order is placed within 14 days of Eid.", steps: ["Add 48 hours to the delivery estimate.", "Tell the customer the last safe order date."], usedDaysAgo: 12, uses: 45 },
    { id: "review-request", title: "Post-Delivery Review Request", category: "Sales", description: "Asks for a review three days after a happy delivery.", trigger: "An order has been delivered for 3 days with no complaint.", steps: ["Send one friendly review request.", "Never ask the same customer twice in 30 days."], usedDaysAgo: 0, uses: 126 },
  ],
  memory: [
    ["mem-1", "Delivery inside Dhaka takes 24-48h (70 BDT); outside Dhaka takes 3-5 days (130 BDT)."],
    ["mem-2", "Exchanges are accepted within 7 days of delivery if the tag is still attached."],
    ["mem-3", "Friday flash sales run 8pm to 10pm, and stock holds last 2 hours."],
    ["mem-4", "Wholesale pricing starts at 20 pieces per design."],
    ["mem-5", "VIP customers are anyone with 5 or more completed orders."],
    ["mem-6", "The store is closed on Friday mornings until 2pm."],
  ],
  jobs: [
    {
      id: "daily-sku-velocity",
      name: "Daily Order & SKU Velocity Briefing",
      schedule: "Every day at 8:00 AM",
      at: [8, 0],
      everyDays: 1,
      report: {
        durationMs: 1180,
        metrics: [["Orders Verified", 42], ["Low-Stock Alerts", 3], ["VIP Inquiries Flagged", 2]],
        markdown: `## Yesterday at a glance

**42 Orders Verified** against payment, totalling 186,400 BDT. That is up 12% on the same day last week.

### Fastest moving

| SKU | Sold | Left | Days of cover |
| --- | --- | --- | --- |
| Jamdani Saree, Indigo | 14 | 6 | 1.4 |
| Linen Kurti, Sand (M) | 11 | 9 | 2.2 |
| Silk Scarf, Rust | 9 | 31 | 9.6 |

### Needs your attention

- **3 Low-Stock Alerts**: Jamdani Indigo, Linen Sand (M) and Cotton Panjabi White (L) run out before Thursday.
- **2 VIP Inquiries Flagged**: both ask about the Eid preview and are waiting for a personal reply.
- One courier parcel has not moved for 3 days. The customer has already been told.

### Recommendation

Reorder Jamdani Indigo today. At this pace you sell out by tomorrow evening, and the supplier needs 6 days.`,
      },
    },
    {
      id: "lead-escalation",
      name: "Unanswered Lead Escalation Digest",
      schedule: "Every day at 9:00 PM",
      at: [21, 0],
      everyDays: 1,
      report: {
        durationMs: 860,
        metrics: [["Leads Reviewed", 57], ["Escalated to Staff", 4]],
        markdown: `## Evening digest

**57 Leads Reviewed** today. 53 were answered automatically and **4 Escalated to Staff** because they need a human decision.

### Waiting for you

1. **Corporate gifting, 80 pieces.** Asked for a discount above the standard tier.
2. **Refund dispute.** The customer says the delivered colour differs from the photo.
3. **Press enquiry.** A lifestyle magazine would like product images.
4. **Wholesale request.** A new reseller in Chattogram, below your 20-piece minimum.

No lead has waited longer than 6 hours.`,
      },
    },
    {
      id: "weekly-restock",
      name: "Weekly Supplier Restock Forecast",
      schedule: "Every Sunday at 9:00 AM",
      at: [9, 0],
      everyDays: 7,
      report: {
        durationMs: 2340,
        metrics: [["SKUs Forecast", 128], ["Reorders Recommended", 9]],
        markdown: `## Next two weeks

**128 SKUs Forecast** from the last 60 days of sales, adjusted for the Eid run-up. **9 Reorders Recommended**.

### Place this week

| Supplier | Items | Est. cost | Lead time |
| --- | --- | --- | --- |
| Mirpur Weavers | 4 | 212,000 BDT | 6 days |
| Narayanganj Mills | 3 | 96,500 BDT | 4 days |
| Gulshan Trims | 2 | 18,200 BDT | 2 days |

> Forecasts are estimates. Confirm quantities before you place an order.`,
      },
    },
  ],
  reply: (question) => {
    if (/deliver|ship/i.test(question)) return "Delivery inside Dhaka takes 24-48 hours at 70 BDT. Outside Dhaka it takes 3-5 days at 130 BDT. I quote these on every order enquiry.";
    if (/exchange|return|refund/i.test(question)) return "Customers can exchange within 7 days of delivery if the tag is still attached. I handle the swap myself and only escalate disputes to your team.";
    if (/stock|inventory|sku/i.test(question)) return "Three items are running low: Jamdani Indigo, Linen Sand (M) and Cotton Panjabi White (L). Jamdani Indigo is the urgent one, with about 1.4 days of cover left.";
    return "I can look up orders, check stock, draft customer replies and run your briefings. What would you like me to check?";
  },
};

const APEX_DENTAL: Profile = {
  company: "Apex Dental",
  actions: 684,
  trendPct: 9,
  hours: 31,
  responseSeconds: 6.8,
  uptime: 99.95,
  tier: "Balanced Tier v3.5",
  whatsapp: {
    handle: "+1 55XX-XXXXXX",
    volume: 94,
    staff: [
      ["staff-1", "+1 55XX-XXX214"],
      ["staff-2", "+1 55XX-XXX880"],
    ],
  },
  telegram: { handle: "@ApexFrontDeskBot", volume: 12, ids: [["tg-1", "ID XXXX3391"]] },
  webhook: { handle: "booking.apexdental.example", volume: 57 },
  agencySkills: [
    { id: "appointment-booking", title: "Appointment Booking Desk", category: "Scheduling", description: "Books, moves and confirms appointments against your live calendar." },
    { id: "lead-qualification-matrix", title: "Lead Qualification Matrix", category: "Front Desk", description: "Separates urgent cases and new patients from general questions." },
    { id: "recall-reminders", title: "Recall Reminders", category: "Retention", description: "Reminds patients when a cleaning or check-up is due." },
  ],
  skills: [
    { id: "emergency-triage", title: "Emergency Triage Script", category: "Front Desk", description: "Routes pain and swelling reports to the on-call dentist.", trigger: "A patient reports severe pain, swelling or trauma.", steps: ["Ask where it hurts and for how long.", "Offer the next emergency slot.", "Page the on-call dentist if it is out of hours."], usedDaysAgo: 0, uses: 38 },
    { id: "insurance-precheck", title: "Insurance Pre-Check", category: "Billing", description: "Collects plan details before a first visit.", trigger: "A new patient books a first appointment.", steps: ["Ask for the insurer and member ID.", "Note the plan on the booking.", "Flag anything out of network for the billing team."], usedDaysAgo: 1, uses: 112 },
    { id: "no-show-recovery", title: "No-Show Recovery", category: "Scheduling", description: "Rebooks missed appointments the same day.", trigger: "A patient misses an appointment by 15 minutes.", steps: ["Send one friendly message.", "Offer the next two open slots."], usedDaysAgo: 2, uses: 64 },
    { id: "post-op-checkin", title: "Post-Treatment Check-In", category: "Care", description: "Checks on patients 24 hours after a procedure.", trigger: "A patient had an extraction or implant yesterday.", steps: ["Ask how they are feeling.", "Share aftercare instructions.", "Escalate any report of heavy bleeding or fever."], usedDaysAgo: 0, uses: 49, enabled: false },
  ],
  memory: [
    ["mem-1", "New patient exams are 95 USD and include X-rays."],
    ["mem-2", "Open Monday to Saturday, 8am to 6pm."],
    ["mem-3", "Patients need 24 hours notice to cancel without a fee."],
    ["mem-4", "Dr. Rahman handles implants and Dr. Chen handles orthodontics."],
  ],
  jobs: [
    {
      id: "morning-schedule",
      name: "Morning Schedule Briefing",
      schedule: "Weekdays at 7:30 AM",
      at: [7, 30],
      everyDays: 1,
      report: {
        durationMs: 940,
        metrics: [["Appointments Today", 26], ["Unconfirmed", 3]],
        markdown: `## Today

**26 Appointments Today**, with **3 Unconfirmed**. I have sent a second reminder to each of them.

- Two new patients have not finished their insurance details.
- The 2:30 PM slot opened up and has been offered to the waitlist.`,
      },
    },
    {
      id: "recall-digest",
      name: "Weekly Recall Digest",
      schedule: "Every Monday at 9:00 AM",
      at: [9, 0],
      everyDays: 7,
      report: {
        durationMs: 1620,
        metrics: [["Recalls Sent", 74], ["Rebooked", 21]],
        markdown: `## Recall results

**74 Recalls Sent** last week and **21 Rebooked**, a 28% return rate. 11 patients asked to be called back by staff.`,
      },
    },
  ],
  reply: (question) => {
    if (/price|cost|fee/i.test(question)) return "New patient exams are 95 USD and include X-rays. I can quote other treatments once your price list is in my memory.";
    if (/open|hour/i.test(question)) return "You are open Monday to Saturday, 8am to 6pm, and that is what I tell patients.";
    return "I can check today's schedule, follow up with unconfirmed patients or draft a reply. What do you need?";
  },
};

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function profileFor(subdomain: string): Profile {
  if (subdomain === "suvana") return SUVANA;
  if (subdomain === "apex-dental") return APEX_DENTAL;
  return { ...SUVANA, company: titleFromSlug(subdomain) || "Your Business" };
}

/** A believable month of activity that sums to the headline figure, without Math.random. */
function dailySeries(total: number, trendPct: number): number[] {
  const weights = Array.from({ length: 30 }, (_, index) => {
    const growth = 1 + (trendPct / 100) * (index / 29);
    const weekly = 1 + 0.18 * Math.sin((index / 7) * Math.PI * 2);
    const texture = 1 + 0.07 * Math.sin(index * 2.4);
    return growth * weekly * texture;
  });
  const scale = total / weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => Math.round(weight * scale));
}

function nextOccurrence(at: [number, number], everyDays: number, now: Date): Date {
  const next = new Date(now);
  next.setHours(at[0], at[1], 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  if (everyDays === 7) next.setDate(next.getDate() + ((7 - next.getDay()) % 7));
  return next;
}

function factCategory(text: string): string {
  if (/\b(return|exchange|refund|polic|warranty|cancel)/i.test(text)) return "Policies";
  if (/\b(deliver|shipping|courier|dispatch)/i.test(text)) return "Delivery";
  if (/\b(price|pricing|discount|cost|fee|BDT|USD)/i.test(text)) return "Pricing";
  if (/\b(customer|VIP|patient|client|member)/i.test(text)) return "Customers";
  if (/\b(open|closed|holiday|business hours)/i.test(text)) return "Hours";
  return "Operations";
}

function toSkill(seed: SkillSeed): LearnedSkill {
  return {
    id: seed.id,
    title: seed.title,
    category: seed.category,
    description: seed.description,
    triggerConditions: seed.trigger,
    workflowMarkdown: `## When this applies\n\n${seed.trigger}\n\n## Steps\n\n${seed.steps
      .map((step, index) => `${index + 1}. ${step}`)
      .join("\n")}`,
    lastUsed: new Date(Date.now() - seed.usedDaysAgo * DAY - 2 * HOUR).toISOString(),
    useCount: seed.uses,
    enabled: seed.enabled ?? true,
  };
}

function refuse(message: string, code: string): never {
  throw new ApiError(422, code, message);
}

/** Mirrors the backend's screen, so sample mode shows the same rejection as a live account. */
function screenRule(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (cleaned.length < 3) refuse("Write the rule as a short sentence.", "memory_rule_rejected");
  if (cleaned.length > 400) refuse("Keep each rule under 400 characters.", "memory_rule_rejected");
  if (/[<>`§]/.test(cleaned)) refuse("Rules are plain text. Remove any formatting or angle brackets.", "memory_rule_rejected");
  if (/\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|system|your|all)\b.{0,30}\b(instructions?|rules?|prompts?)\b|\byou (are|must) now\b|\bsystem prompt\b/i.test(cleaned)) {
    refuse(
      "That reads like an instruction to the Coordinator rather than a fact about your business. Describe the policy, price or procedure instead.",
      "memory_rule_rejected",
    );
  }
  return cleaned;
}

export function createMockPortal(subdomain: string): PortalClient {
  const profile = profileFor(subdomain);
  const now = new Date();

  const daily = dailySeries(profile.actions, profile.trendPct);
  let skills = profile.skills.map(toSkill);
  let facts: MemoryFact[] = profile.memory.map(([id, text]) => ({ id, text, category: factCategory(text) }));
  let staff = profile.whatsapp.staff.map(([id, display]) => ({ id, display }));
  let telegramIds = profile.telegram.ids.map(([id, display]) => ({ id, display }));
  let whatsappStatus: PortalChannel["status"] = "connected";
  let pairingStartedAt: number | null = null;
  let nextEntry = 1;

  const jobs: CronJob[] = profile.jobs.map((job) => ({
    id: job.id,
    jobName: job.name,
    scheduleHuman: job.schedule,
    status: "scheduled",
    nextRunAt: nextOccurrence(job.at, job.everyDays, now).toISOString(),
    lastRunAt: null,
  }));

  const reports: CronReport[] = [];
  profile.jobs.forEach((job) => {
    const next = nextOccurrence(job.at, job.everyDays, now);
    for (let run = 1; run <= 3; run += 1) {
      const executed = new Date(next.getTime() - run * job.everyDays * DAY);
      reports.push({
        id: `${job.id}-${run}`,
        jobId: job.id,
        jobName: job.name,
        scheduleHuman: job.schedule,
        executedAt: executed.toISOString(),
        durationMs: job.report.durationMs + (run - 1) * 37,
        status: "success",
        summaryMarkdown: job.report.markdown,
        metrics: job.report.metrics.map(([label, value]) => ({ label, value })),
      });
    }
    const target = jobs.find((item) => item.id === job.id);
    if (target) target.lastRunAt = reports[reports.length - 3].executedAt;
  });

  const memoryView = (): BusinessMemory => ({
    facts: facts.map((fact) => ({ ...fact })),
    usedChars: facts.map((fact) => fact.text).join("\n§\n").length,
    limitChars: MEMORY_LIMIT,
  });

  const channelList = (): PortalChannel[] => {
    const lastMessage = new Date(Date.now() - 4 * 60_000).toISOString();
    return [
      {
        channel: "whatsapp",
        status: whatsappStatus,
        sessionVerified: whatsappStatus === "connected",
        maskedHandle: profile.whatsapp.handle,
        lastMessageAt: lastMessage,
        messages24h: profile.whatsapp.volume,
        allowlist: staff,
        allowAll: false,
        voiceTranscription: null,
        attention: null,
      },
      {
        channel: "telegram",
        status: "connected",
        sessionVerified: true,
        maskedHandle: profile.telegram.handle,
        lastMessageAt: new Date(Date.now() - 38 * 60_000).toISOString(),
        messages24h: profile.telegram.volume,
        allowlist: telegramIds,
        allowAll: false,
        voiceTranscription: true,
        attention: null,
      },
      {
        channel: "web_widget",
        status: "connected",
        sessionVerified: true,
        maskedHandle: profile.webhook.handle,
        lastMessageAt: new Date(Date.now() - 12 * 60_000).toISOString(),
        messages24h: profile.webhook.volume,
        allowlist: [],
        allowAll: false,
        voiceTranscription: null,
        attention: null,
      },
    ];
  };

  const pairingView = (): ReconnectResult => {
    if (pairingStartedAt === null) {
      return { state: "failed", qrPngBase64: null, qrRefreshSeconds: null, detail: "No re-link is in progress." };
    }
    const elapsed = Date.now() - pairingStartedAt;
    if (elapsed < SAMPLE_PAIRING_MS) {
      return {
        state: "qr_ready",
        qrPngBase64: null,
        qrRefreshSeconds: Math.max(0, QR_SECONDS - Math.floor(elapsed / 1000)),
        detail: "On your phone, open WhatsApp, go to Linked Devices, and scan this code.",
      };
    }
    whatsappStatus = "connected";
    pairingStartedAt = null;
    return {
      state: "connected",
      qrPngBase64: null,
      qrRefreshSeconds: null,
      detail: "WhatsApp is linked. Your Coordinator is reconnecting now.",
    };
  };

  return {
    mode: "mock",
    knowledge: createMockKnowledge(
      subdomain,
      profile.company,
      /dental|clinic|salon|beauty|restaurant|travel/.test(subdomain) ? "general" : "ecommerce",
    ),
    ...createGrowthMock(profile.company, subdomain),
    ...createSocialMock(profile.company, subdomain),

    async overview(): Promise<PortalOverview> {
      await delay(260);
      return {
        companyName: profile.company,
        agentStatus: "online",
        uptimePercentage: profile.uptime,
        tasksCompleted30d: profile.actions,
        tasksTrendPct: profile.trendPct,
        tasksDaily: daily,
        estimatedHoursSaved: profile.hours,
        avgResponseSeconds: profile.responseSeconds,
        learnedSkillCount: skills.filter((skill) => skill.enabled).length,
        activeModelTier: profile.tier,
        connectedChannels: channelList().filter((channel) => channel.status === "connected").length,
        scheduledBriefings: jobs.length,
      };
    },

    async channels() {
      await delay(220);
      return channelList();
    },

    async reconnectChannel(channel: ChannelName) {
      await delay(500);
      if (channel === "whatsapp") {
        pairingStartedAt = Date.now();
        return pairingView();
      }
      return {
        state: "refreshing",
        qrPngBase64: null,
        qrRefreshSeconds: null,
        detail: "Your Coordinator is reconnecting. This usually takes under a minute.",
      };
    },

    async pairingStatus() {
      await delay(120);
      return pairingView();
    },

    async testChannel(channel: ChannelName) {
      await delay(650);
      return {
        ok: true,
        messageDelivered: false,
        latencyMs: 40 + channel.length * 3,
        detail: "Sample result. A live account checks the real connection.",
      };
    },

    async updateAllowlist(channel: ChannelName, change) {
      await delay(320);
      const removing = new Set(change.removeIds ?? []);
      const added = (change.add ?? []).map((raw) => {
        const digits = raw.replace(/\D/g, "");
        if (digits.length < 5) refuse("Enter a valid number or ID.", "allowlist_invalid_entry");
        nextEntry += 1;
        return channel === "telegram"
          ? { id: `new-${nextEntry}`, display: `ID XXXX${digits.slice(-4)}` }
          : { id: `new-${nextEntry}`, display: `+${digits.slice(0, 3)} ${digits.slice(3, 5)}XX-XXX${digits.slice(-3)}` };
      });
      if (channel === "telegram") telegramIds = [...telegramIds.filter((entry) => !removing.has(entry.id)), ...added];
      else staff = [...staff.filter((entry) => !removing.has(entry.id)), ...added];
      return channelList();
    },

    async cronFeed(): Promise<CronFeed> {
      await delay(240);
      return {
        jobs: jobs.map((job) => ({ ...job })),
        reports: [...reports].sort((a, b) => b.executedAt.localeCompare(a.executedAt)),
      };
    },

    async triggerJob(jobId: string) {
      await delay(450);
      const seed = profile.jobs.find((job) => job.id === jobId);
      const job = jobs.find((item) => item.id === jobId);
      if (!seed || !job) throw new ApiError(404, "report_job_not_found", "That briefing no longer exists.");
      const executedAt = new Date().toISOString();
      nextEntry += 1;
      reports.push({
        id: `${jobId}-manual-${nextEntry}`,
        jobId,
        jobName: seed.name,
        scheduleHuman: seed.schedule,
        executedAt,
        durationMs: seed.report.durationMs + 120,
        status: "success",
        summaryMarkdown: seed.report.markdown,
        metrics: seed.report.metrics.map(([label, value]) => ({ label, value })),
      });
      job.lastRunAt = executedAt;
      return { queued: true, detail: "Sample briefing generated. A live account runs it on your Coordinator." };
    },

    async skillsAndMemory() {
      await delay(260);
      return {
        agencySkills: profile.agencySkills.map((skill) => ({ ...skill, active: true })),
        learnedSkills: skills.map((skill) => ({ ...skill })),
        memory: memoryView(),
      };
    },

    async toggleSkill(skillId: string, enabled: boolean) {
      await delay(280);
      skills = skills.map((skill) => (skill.id === skillId ? { ...skill, enabled } : skill));
      const updated = skills.find((skill) => skill.id === skillId);
      if (!updated) throw new ApiError(404, "skill_not_found", "That skill is no longer available.");
      return { ...updated };
    },

    async patchMemory(patch: MemoryPatch) {
      await delay(360);
      if (patch.op === "remove") {
        facts = facts.filter((fact) => fact.id !== patch.id);
        return memoryView();
      }
      const text = screenRule(patch.text);
      const projected =
        patch.op === "append"
          ? [...facts, { id: "projected", text, category: "" }]
          : facts.map((fact) => (fact.id === patch.id ? { ...fact, text } : fact));
      if (projected.map((fact) => fact.text).join("\n§\n").length > MEMORY_LIMIT) {
        throw new ApiError(409, "memory_full", "Business memory is full. Remove an entry you no longer need, then add this one.");
      }
      if (patch.op === "append") {
        nextEntry += 1;
        facts = [...facts, { id: `mem-new-${nextEntry}`, text, category: factCategory(text) }];
      } else {
        facts = facts.map((fact) => (fact.id === patch.id ? { ...fact, text, category: factCategory(text) } : fact));
      }
      return memoryView();
    },

    async chat(messages: ChatTurn[]) {
      const started = Date.now();
      await delay(900);
      const question = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
      return { reply: profile.reply(question), durationMs: Date.now() - started };
    },
  };
}
