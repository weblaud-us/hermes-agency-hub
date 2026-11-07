import type { BaselineMetrics } from "./hub-types";
import { shellQuote } from "./utils";

export const BRAND = "Weblaud";
export const TAGLINE = "One Partner. One Growth System.";

export const BASE_DOMAIN = process.env.NEXT_PUBLIC_BASE_DOMAIN || "agents.agency.com";

export type TierId = "starter" | "growth" | "enterprise";
/** The hub's plan enum, which sets a tenant's resources. */
export type ApiPlan = "starter" | "growth" | "scale";
/** What Weblaud sells. Each package maps onto one plan. */
export type PackageTier = "presence" | "growth" | "scale";
export type BusinessMode = "general" | "ecommerce";
export type RegionPreset = "bd" | "global";
export type NicheTemplate =
  | "dental_clinic"
  | "beauty_salon"
  | "restaurant"
  | "travel_agency"
  | "ecommerce_store"
  | "custom";

export interface Tier {
  id: TierId;
  label: string;
  /** What Weblaud sells it as, e.g. "Weblaud Presence". */
  name: string;
  apiPlan: ApiPlan;
  monthly: number;
  /** One-time onboarding fee, in USD. */
  setup: number;
  memory: string;
  memoryGb: number;
  cpus: string;
  conversations: number;
}

export const TIERS: Record<TierId, Tier> = {
  starter: {
    id: "starter",
    label: "Presence",
    name: "Weblaud Presence",
    apiPlan: "starter",
    monthly: 299,
    setup: 499,
    memory: "1GB",
    memoryGb: 1,
    cpus: "0.5",
    conversations: 1_000,
  },
  growth: {
    id: "growth",
    label: "Growth",
    name: "Weblaud Growth",
    apiPlan: "growth",
    monthly: 599,
    setup: 999,
    memory: "2GB",
    memoryGb: 2,
    cpus: "1.0",
    conversations: 10_000,
  },
  enterprise: {
    id: "enterprise",
    label: "Scale",
    name: "Weblaud Scale",
    apiPlan: "scale",
    monthly: 999,
    setup: 1999,
    memory: "4GB",
    memoryGb: 4,
    cpus: "2.0",
    conversations: 100_000,
  },
};

export const TIER_ORDER: TierId[] = ["starter", "growth", "enterprise"];

export function tierFromPlan(plan: ApiPlan): TierId {
  return plan === "scale" ? "enterprise" : plan;
}

export const PACKAGE_FOR_TIER: Record<TierId, PackageTier> = {
  starter: "presence",
  growth: "growth",
  enterprise: "scale",
};

export const TIER_FOR_PACKAGE: Record<PackageTier, TierId> = {
  presence: "starter",
  growth: "growth",
  scale: "enterprise",
};

export const NICHE_OPTIONS: { value: NicheTemplate; label: string; mode: BusinessMode }[] = [
  { value: "dental_clinic", label: "Dental Clinic", mode: "general" },
  { value: "beauty_salon", label: "Beauty Salon & Spa", mode: "general" },
  { value: "restaurant", label: "Restaurant", mode: "general" },
  { value: "travel_agency", label: "Travel Agency", mode: "general" },
  { value: "ecommerce_store", label: "E-Commerce Brand", mode: "ecommerce" },
  { value: "custom", label: "Custom", mode: "general" },
];

export const REGION_CURRENCIES: Record<RegionPreset, string[]> = {
  bd: ["BDT"],
  global: ["USD", "EUR", "GBP"],
};

export const CURRENCY_SYMBOLS: Record<string, string> = { BDT: "৳", USD: "$", EUR: "€", GBP: "£" };

export const ONBOARDING_STEPS = [
  "Discovery",
  "Knowledge Base",
  "Connect Channels",
  "Brand Kit",
  "Spin Up Instance",
  "Shadow Week QA",
  "Autonomous Live",
] as const;

export const SHADOW_WEEK_STAGE = 6;

export const LLM_MODELS = [
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
] as const;

/** The agency library. `ecommerceOnly` skills are only ever given to e-commerce clients. */
export const SHARED_SKILLS: { id: string; label: string; ecommerceOnly?: boolean }[] = [
  { id: "designer-brand-studio", label: "Designer" },
  { id: "video-reel-editor", label: "Video Editor" },
  { id: "social-media-autopilot", label: "Social Media Autopilot" },
  { id: "sales-rep-inbox", label: "Sales Rep" },
  { id: "ads-growth-manager", label: "Ads Manager" },
  { id: "email-outreach-assistant", label: "Email Assistant" },
  { id: "web-seo-manager", label: "Web Manager" },
  { id: "roi-weekly-reporter", label: "Reporter" },
  { id: "order-desk-ecommerce", label: "Order Desk", ecommerceOnly: true },
  { id: "catalog-keeper-ecommerce", label: "Catalog Keeper", ecommerceOnly: true },
];

export interface ProvisionForm {
  companyName: string;
  subdomain: string;
  tier: TierId;
  model: string;
  openRouterKey: string;
  sslEmail: string;
  skills: string[];
  businessMode: BusinessMode;
  nicheTemplate: NicheTemplate;
  region: RegionPreset;
  currency: string;
  /** Kept as typed. All blank means "no baseline yet", which the hub allows. */
  baselineInquiries: string;
  baselineConversion: string;
  baselineValue: string;
  baselineRetainer: string;
  /** Hex, with the leading #. The primary colour of the client's brand kit. */
  brandPrimary: string;
  /** On: the social autopilot publishes by itself. Off: the owner approves each post. */
  autopilotSocial: boolean;
}

export type ProvisionField =
  | "companyName"
  | "subdomain"
  | "openRouterKey"
  | "sslEmail"
  | "baseline"
  | "brandPrimary";
export type FieldErrors = Partial<Record<ProvisionField, string>>;

const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPENROUTER_KEY_PATTERN = /^sk-or-v1-[A-Za-z0-9_-]{8,}$/;
export const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
export const DEFAULT_BRAND_PRIMARY = "#00F5D4";
/** Same set as RESERVED_SLUGS in backend/src/clients/service.py. */
const RESERVED_SUBDOMAINS = new Set([
  "www",
  "api",
  "admin",
  "app",
  "hub",
  "traefik",
  "static",
  "mail",
  "dashboard",
  "status",
]);

export function validateProvisionForm(
  form: ProvisionForm,
  { requireKey }: { requireKey: boolean },
): FieldErrors {
  const errors: FieldErrors = {};
  const company = form.companyName.trim();
  if (company.length < 2) errors.companyName = "Enter the company name (at least 2 characters).";
  else if (company.length > 200) errors.companyName = "Keep the company name under 200 characters.";

  if (!form.subdomain) errors.subdomain = "Enter a subdomain.";
  else if (!SUBDOMAIN_PATTERN.test(form.subdomain))
    errors.subdomain = "Use lowercase letters, numbers and inner hyphens only.";
  else if (RESERVED_SUBDOMAINS.has(form.subdomain))
    errors.subdomain = `"${form.subdomain}" is reserved by the hub. Choose another.`;

  if (requireKey && !OPENROUTER_KEY_PATTERN.test(form.openRouterKey.trim()))
    errors.openRouterKey = "OpenRouter keys start with sk-or-v1- followed by the key.";

  if (!EMAIL_PATTERN.test(form.sslEmail.trim()))
    errors.sslEmail = "Enter a valid email address for certificate notices.";

  if (!HEX_COLOR_PATTERN.test(form.brandPrimary.trim()))
    errors.brandPrimary = "Use a six-digit hex colour such as #00F5D4.";

  const baseline = [form.baselineInquiries, form.baselineConversion, form.baselineValue, form.baselineRetainer];
  if (baseline.some((value) => value.trim() !== "")) {
    const numbers = baseline.map(Number);
    if (baseline.some((value) => value.trim() === "") || numbers.some((value) => !Number.isFinite(value) || value < 0)) {
      errors.baseline = "Fill in all four baseline figures, or leave them all blank to add them later.";
    } else if (numbers[1] > 100) {
      errors.baseline = "Conversion rate is a percentage, so it cannot be above 100.";
    }
  }

  return errors;
}

/** The form's baseline as figures, or null when it was left blank. */
export function baselineFromForm(form: ProvisionForm): BaselineMetrics | null {
  if (form.baselineInquiries.trim() === "") return null;
  return {
    monthlyInquiries: Math.round(Number(form.baselineInquiries)),
    conversionRate: Number(form.baselineConversion),
    avgOrderOrProfitValue: Number(form.baselineValue),
    monthlyRetainerInvestment: Number(form.baselineRetainer),
  };
}

/**
 * The OpenRouter key is left out on purpose: install-client-hermes.sh prompts
 * for it on the VPS, which keeps the secret out of shell history and `ps`.
 */
export function buildInstallerCommand(form: ProvisionForm, baseDomain: string): string {
  const tier = TIERS[form.tier];
  const flags: [string, string][] = [
    ["--company", form.companyName.trim()],
    ["--slug", form.subdomain],
    ["--domain", `${form.subdomain}.${baseDomain}`],
    ["--tier", tier.apiPlan],
    ["--memory", tier.memory.toLowerCase()],
    ["--cpus", tier.cpus],
    ["--model", form.model],
    ["--ssl-email", form.sslEmail.trim()],
  ];
  if (form.skills.length > 0) flags.push(["--skills", form.skills.join(",")]);

  const lines = flags.map(([flag, value]) => `  ${flag} ${shellQuote(value)}`);
  return `sudo bash install-client-hermes.sh \\\n${lines.join(" \\\n")}`;
}

export function provisionStages(slug: string): string[] {
  return [
    `Allocating isolated tenant volume /srv/hermes-multi/tenants/${slug} (UID 10000:10000)...`,
    "Injecting hardened .env (chmod 600), SOUL.md, and config.yaml...",
    "Mounting /opt/data/skills/agency_core:ro and starting nousresearch/hermes-agent:latest...",
    "Binding localhost loopback ports & verifying /v1/health probe...",
    "Writing Nginx WebSocket proxy block & issuing Let's Encrypt SSL certificate...",
  ];
}
