import { shellQuote } from "./utils";

export const BRAND = "Hermes Agency Hub";

export const BASE_DOMAIN = process.env.NEXT_PUBLIC_BASE_DOMAIN || "agents.agency.com";

export type TierId = "starter" | "growth" | "enterprise";
/** The hub's plan enum. "Dedicated Enterprise" is sold on its `scale` plan. */
export type ApiPlan = "starter" | "growth" | "scale";

export interface Tier {
  id: TierId;
  label: string;
  apiPlan: ApiPlan;
  monthly: number;
  memory: string;
  memoryGb: number;
  cpus: string;
  conversations: number;
}

export const TIERS: Record<TierId, Tier> = {
  starter: {
    id: "starter",
    label: "Starter",
    apiPlan: "starter",
    monthly: 299,
    memory: "1GB",
    memoryGb: 1,
    cpus: "0.5",
    conversations: 1_000,
  },
  growth: {
    id: "growth",
    label: "Growth",
    apiPlan: "growth",
    monthly: 699,
    memory: "2GB",
    memoryGb: 2,
    cpus: "1.0",
    conversations: 10_000,
  },
  enterprise: {
    id: "enterprise",
    label: "Dedicated Enterprise",
    apiPlan: "scale",
    monthly: 1500,
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

export const LLM_MODELS = [
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
] as const;

export const SHARED_SKILLS = [
  { id: "ecommerce-lookup", label: "E-Commerce Order Lookup" },
  { id: "lead-qualification", label: "WhatsApp Lead Qualifier" },
  { id: "daily-executive-briefing", label: "Daily Executive Briefing" },
] as const;

export interface ProvisionForm {
  companyName: string;
  subdomain: string;
  tier: TierId;
  model: string;
  openRouterKey: string;
  sslEmail: string;
  skills: string[];
}

export type ProvisionField = "companyName" | "subdomain" | "openRouterKey" | "sslEmail";
export type FieldErrors = Partial<Record<ProvisionField, string>>;

const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPENROUTER_KEY_PATTERN = /^sk-or-v1-[A-Za-z0-9_-]{8,}$/;
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

  return errors;
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
