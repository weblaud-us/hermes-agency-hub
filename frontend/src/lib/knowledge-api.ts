/**
 * Business setup, catalog, channel credentials and usage.
 *
 * These types mirror the hub's JSON one to one (snake_case), so there is no mapping
 * layer to drift. A stored credential never appears here: the hub sends a mask and a
 * `configured` flag, and the form can only ever send a new value.
 */

export type BusinessModeName = "general" | "ecommerce";
export type CatalogKind = "product" | "service";
export type AiPresetKey = "ultra_low_cost" | "balanced" | "premium_reasoning";
export type IntegrationTarget = "telegram" | "whatsapp_cloud" | "meta";

export interface BrandKitSetup {
  primary_color: string;
  accent_color: string;
  logo_text: string;
  logo_url: string | null;
  default_cta: string;
}

export interface Faq {
  question: string;
  answer: string;
}

export interface BusinessSetup {
  company_name: string;
  business_mode: BusinessModeName;
  industry: string;
  tagline: string;
  website_url: string | null;
  support_phone: string;
  business_hours: string;
  location_address: string;
  delivery_and_shipping_policy: string;
  return_and_refund_policy: string;
  tone_of_voice: string;
  brand_kit: BrandKitSetup;
  faqs: Faq[];
}

export interface BusinessSetupView extends BusinessSetup {
  updated_at: string | null;
  memory_synced: boolean;
  memory_lines_skipped: number;
}

export interface CatalogItemInput {
  kind: CatalogKind;
  name: string;
  price_usd: number;
  description: string;
  sku: string;
  sizes_or_variants: string[];
  stock_qty: number | null;
  image_url: string | null;
  duration: string;
  booking_rules: string;
}

export interface CatalogItem extends CatalogItemInput {
  id: string;
}

export interface CatalogView {
  business_mode: BusinessModeName;
  items: CatalogItem[];
  updated_at: string | null;
  limit: number;
}

export interface CatalogImportResult {
  created: number;
  updated: number;
  catalog: CatalogView;
}

export interface SecretStatus {
  configured: boolean;
  masked: string | null;
}

export interface AiPresetView {
  key: AiPresetKey;
  label: string;
  summary: string;
  est_monthly_usd: string;
  selected: boolean;
  /** Only the agency team receives engine names. */
  engines: Record<string, string> | null;
}

export interface IntegrationsView {
  telegram: { bot_token: SecretStatus; allowed_users: string[] };
  whatsapp: {
    mode: "none" | "qr" | "cloud_api";
    qr_linked: boolean;
    access_token: SecretStatus;
    verify_token: SecretStatus;
    phone_number_id: string | null;
  };
  meta: { page_id: string | null; ig_user_id: string | null; page_access_token: SecretStatus; publishes_live: boolean };
  presets: AiPresetView[];
  preset_selected: boolean;
}

/** Within a section, omitted leaves a value alone and an empty string removes it. */
export interface IntegrationsUpdate {
  telegram?: { bot_token?: string; allowed_users?: string[] };
  whatsapp_cloud?: { access_token?: string; phone_number_id?: string; verify_token?: string };
  meta?: { page_id?: string; ig_user_id?: string; page_access_token?: string };
  ai_preset?: AiPresetKey;
  apply_now?: boolean;
}

export interface IntegrationsSaveResult {
  integrations: IntegrationsView;
  changed: string[];
  restart: "applied" | "pending" | "unchanged";
  detail: string;
}

export interface IntegrationTestResult {
  target: IntegrationTarget;
  ok: boolean;
  detail: string;
}

export interface UsagePricing {
  input_per_mtok: number;
  output_per_mtok: number;
  per_image: number;
  per_reel: number;
}

export interface CalculatorInputs {
  messages_per_day: number;
  image_posts_per_month: number;
  reels_per_month: number;
  input_tokens_per_message: number;
  output_tokens_per_message: number;
}

export interface UsageSummary {
  period: string;
  preset: AiPresetKey;
  preset_label: string;
  preset_selected: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  images_generated: number;
  reels_generated: number | null;
  cost_text_usd: number | null;
  cost_images_usd: number;
  cost_reels_usd: number | null;
  cost_total_usd: number | null;
  pricing: Record<AiPresetKey, UsagePricing>;
  engines: Record<string, string> | null;
  calculator: CalculatorInputs;
  assumptions: string[];
}

export interface KnowledgeClient {
  businessSetup(): Promise<BusinessSetupView>;
  saveBusinessSetup(setup: BusinessSetup): Promise<BusinessSetupView>;
  catalog(): Promise<CatalogView>;
  addCatalogItem(item: CatalogItemInput): Promise<CatalogItem>;
  updateCatalogItem(id: string, item: CatalogItemInput): Promise<CatalogItem>;
  deleteCatalogItem(id: string): Promise<void>;
  importCatalog(items: CatalogItemInput[], replace: boolean): Promise<CatalogImportResult>;
  integrations(): Promise<IntegrationsView>;
  saveIntegrations(update: IntegrationsUpdate): Promise<IntegrationsSaveResult>;
  testIntegration(target: IntegrationTarget): Promise<IntegrationTestResult>;
  usage(): Promise<UsageSummary>;
}

export type Send = <T>(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }) => Promise<T>;

const WRITE_TIMEOUT_MS = 45_000;

export function createLiveKnowledge(send: Send): KnowledgeClient {
  return {
    businessSetup: () => send("business-setup"),
    saveBusinessSetup: (setup) => send("business-setup", { method: "PUT", body: setup, timeoutMs: WRITE_TIMEOUT_MS }),
    catalog: () => send("catalog"),
    addCatalogItem: (item) => send("catalog/items", { method: "POST", body: item }),
    updateCatalogItem: (id, item) => send(`catalog/items/${encodeURIComponent(id)}`, { method: "PUT", body: item }),
    async deleteCatalogItem(id) {
      await send(`catalog/items/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    importCatalog: (items, replace) =>
      send("catalog/import", { method: "POST", body: { items, replace }, timeoutMs: WRITE_TIMEOUT_MS }),
    integrations: () => send("integrations"),
    saveIntegrations: (update) => send("integrations", { method: "PUT", body: update, timeoutMs: WRITE_TIMEOUT_MS }),
    testIntegration: (target) => send(`integrations/${target}/test`, { method: "POST", timeoutMs: WRITE_TIMEOUT_MS }),
    usage: () => send("usage"),
  };
}

// ----------------------------------------------------------------------- the maths
/** Estimated dollars for one month, from a preset's price list. Mirrors the hub's own estimate. */
export function estimateMonth(pricing: UsagePricing, scenario: CalculatorInputs): number {
  const messages = scenario.messages_per_day * 30;
  const text =
    (messages * scenario.input_tokens_per_message * pricing.input_per_mtok +
      messages * scenario.output_tokens_per_message * pricing.output_per_mtok) /
    1_000_000;
  return text + scenario.image_posts_per_month * pricing.per_image + scenario.reels_per_month * pricing.per_reel;
}

export const usd = (value: number, digits = 2) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);

/** One catalog row from a CSV or JSON file. Unknown columns are ignored, bad rows are reported. */
export function parseCatalogFile(text: string, kind: CatalogKind): { items: CatalogItemInput[]; skipped: number } {
  const trimmed = text.trim();
  const rows: Record<string, unknown>[] = trimmed.startsWith("[") || trimmed.startsWith("{") ? parseJsonRows(trimmed) : parseCsvRows(trimmed);
  const items: CatalogItemInput[] = [];
  let skipped = 0;
  for (const row of rows) {
    const item = toItem(row, kind);
    if (item) items.push(item);
    else skipped += 1;
  }
  return { items, skipped };
}

function parseJsonRows(text: string): Record<string, unknown>[] {
  try {
    const data: unknown = JSON.parse(text);
    const list = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : [];
    return list.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  } catch {
    return [];
  }
}

/** Handles quoted fields, escaped quotes and commas inside quotes. */
function parseCsvRows(text: string): Record<string, unknown>[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      field = "";
      if (record.some((cell) => cell.trim())) records.push(record);
      record = [];
    } else field += char;
  }
  record.push(field);
  if (record.some((cell) => cell.trim())) records.push(record);
  if (records.length < 2) return [];
  const header = records[0].map((cell) => cell.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  return records.slice(1).map((cells) => Object.fromEntries(header.map((name, column) => [name, cells[column]?.trim() ?? ""])));
}

function toItem(row: Record<string, unknown>, fallbackKind: CatalogKind): CatalogItemInput | null {
  const text = (...keys: string[]) => {
    for (const key of keys) {
      const value = row[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number") return String(value);
    }
    return "";
  };
  const name = text("name", "title", "product", "service");
  const price = Number(text("price_usd", "price", "amount").replace(/[^0-9.]/g, ""));
  if (!name || !Number.isFinite(price) || price < 0 || !text("price_usd", "price", "amount")) return null;
  const rawKind = text("kind", "type").toLowerCase();
  const kind: CatalogKind = rawKind === "product" || rawKind === "service" ? rawKind : fallbackKind;
  const stock = text("stock_qty", "stock", "quantity");
  const variants = row.sizes_or_variants ?? row.sizes ?? row.variants;
  return {
    kind,
    name,
    price_usd: Math.round(price * 100) / 100,
    description: text("description", "details"),
    sku: text("sku", "code"),
    sizes_or_variants: Array.isArray(variants)
      ? variants.map(String).filter(Boolean)
      : typeof variants === "string"
        ? variants.split(/[|;/]/).map((part) => part.trim()).filter(Boolean)
        : [],
    stock_qty: stock !== "" && Number.isFinite(Number(stock)) && Number(stock) >= 0 ? Math.floor(Number(stock)) : null,
    image_url: text("image_url", "image") || null,
    duration: text("duration"),
    booking_rules: text("booking_rules", "rules"),
  };
}
