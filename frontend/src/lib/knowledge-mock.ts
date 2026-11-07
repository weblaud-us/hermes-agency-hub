import { ApiError } from "@/lib/hub-types";
import type {
  AiPresetKey,
  AiPresetView,
  BusinessSetup,
  CatalogItem,
  CatalogItemInput,
  CatalogView,
  IntegrationsUpdate,
  IntegrationsView,
  KnowledgeClient,
  UsagePricing,
  UsageSummary,
} from "@/lib/knowledge-api";
import { estimateMonth } from "@/lib/knowledge-api";
import { delay } from "@/lib/utils";

/** Sample data for when no hub answers. Nothing here is saved anywhere but this page. */

const PRICING: Record<AiPresetKey, UsagePricing> = {
  ultra_low_cost: { input_per_mtok: 0.27, output_per_mtok: 1.1, per_image: 0.003, per_reel: 0.012 },
  balanced: { input_per_mtok: 0.15, output_per_mtok: 0.6, per_image: 0.04, per_reel: 0.16 },
  premium_reasoning: { input_per_mtok: 3, output_per_mtok: 15, per_image: 0.05, per_reel: 0.2 },
};

export const TYPICAL_MONTH = {
  messages_per_day: 40,
  image_posts_per_month: 12,
  reels_per_month: 4,
  input_tokens_per_message: 1500,
  output_tokens_per_message: 400,
};

const PRESET_COPY: Record<AiPresetKey, { label: string; summary: string }> = {
  ultra_low_cost: { label: "Ultra low cost", summary: "Quick, economical replies and simple branded visuals. Best for steady, everyday volume." },
  balanced: { label: "Balanced", summary: "Stronger writing and instruction following at a modest price. The sensible default." },
  premium_reasoning: { label: "Premium reasoning", summary: "The most careful answers for complicated sales and support conversations." },
};

function presets(selected: AiPresetKey | null): AiPresetView[] {
  return (Object.keys(PRESET_COPY) as AiPresetKey[]).map((key) => ({
    key,
    ...PRESET_COPY[key],
    est_monthly_usd: `about $${Math.round(estimateMonth(PRICING[key], TYPICAL_MONTH))} a month`,
    selected: key === selected,
    engines: null,
  }));
}

export function mockUsage(preset: AiPresetKey | null, staff = false): UsageSummary {
  const key = preset ?? "balanced";
  const pricing = PRICING[key];
  const input = 1_180_000;
  const output = 312_000;
  const images = 14;
  const text = (input * pricing.input_per_mtok + output * pricing.output_per_mtok) / 1_000_000;
  const imageCost = images * pricing.per_image;
  return {
    period: new Date().toISOString().slice(0, 7),
    preset: key,
    preset_label: PRESET_COPY[key].label,
    preset_selected: preset !== null,
    input_tokens: input,
    output_tokens: output,
    images_generated: images,
    reels_generated: null,
    cost_text_usd: text,
    cost_images_usd: imageCost,
    cost_reels_usd: null,
    cost_total_usd: text + imageCost,
    pricing: PRICING,
    engines: staff ? { model: "sample", images: "sample", video: "sample" } : null,
    calculator: TYPICAL_MONTH,
    assumptions: [
      "Sample figures. A live account shows the tokens your Coordinator really used this month.",
      "Prices are list prices per provider and are estimates. Your invoice is the source of truth.",
      "A reel is a short slideshow of 4 generated frames stitched together at no extra charge.",
    ],
  };
}

export function createMockKnowledge(subdomain: string, companyName: string, mode: "general" | "ecommerce"): KnowledgeClient {
  let setup: BusinessSetup & { updated_at: string | null } = {
    company_name: companyName,
    business_mode: mode,
    industry: mode === "ecommerce" ? "Fashion retail" : "Dental clinic",
    tagline: "",
    website_url: null,
    support_phone: "",
    business_hours: "Mon-Fri 9am-6pm",
    location_address: "",
    delivery_and_shipping_policy: "",
    return_and_refund_policy: "",
    tone_of_voice: "Warm and professional",
    brand_kit: { primary_color: "#00F5D4", accent_color: "#6366F1", logo_text: companyName.toUpperCase().slice(0, 24), logo_url: null, default_cta: "Message us to book or order now" },
    faqs: [],
    updated_at: null,
  };
  let items: CatalogItem[] = [];
  let next = 1;
  let preset: AiPresetKey | null = null;
  const telegram = { token: "", users: [] as string[] };
  let whatsapp = { token: "", phone: "", verify: "" };
  let meta = { page: "", ig: "", token: "" };

  const mask = (value: string) => ({ configured: Boolean(value), masked: value ? `••••${value.slice(-4)}` : null });
  const integrationsView = (): IntegrationsView => ({
    telegram: { bot_token: mask(telegram.token), allowed_users: telegram.users },
    whatsapp: {
      mode: whatsapp.token && whatsapp.phone && whatsapp.verify ? "cloud_api" : "none",
      qr_linked: false,
      access_token: mask(whatsapp.token),
      verify_token: mask(whatsapp.verify),
      phone_number_id: whatsapp.phone || null,
    },
    meta: { page_id: meta.page || null, ig_user_id: meta.ig || null, page_access_token: mask(meta.token), publishes_live: Boolean(meta.page && meta.token) },
    presets: presets(preset),
    preset_selected: preset !== null,
  });
  const catalogView = (): CatalogView => ({ business_mode: setup.business_mode, items: items.map((item) => ({ ...item })), updated_at: null, limit: 500 });
  const check = (item: CatalogItemInput) => {
    if (!item.name.trim()) throw new ApiError(422, "catalog_item_rejected", "Enter a name for this item.");
    if (!(item.price_usd >= 0)) throw new ApiError(422, "catalog_item_rejected", "Enter a price of zero or more.");
  };

  return {
    async businessSetup() {
      await delay(240);
      return { ...setup, memory_synced: setup.updated_at !== null, memory_lines_skipped: 0 };
    },
    async saveBusinessSetup(value) {
      await delay(520);
      if (!value.company_name.trim()) throw new ApiError(422, "business_field_rejected", "Enter your company name.");
      setup = { ...value, updated_at: new Date().toISOString() };
      return { ...setup, memory_synced: true, memory_lines_skipped: 0 };
    },
    async catalog() {
      await delay(220);
      return catalogView();
    },
    async addCatalogItem(item) {
      await delay(300);
      check(item);
      const created = { ...item, id: `mock-${subdomain}-${next++}` };
      items = [...items, created];
      return created;
    },
    async updateCatalogItem(id, item) {
      await delay(300);
      check(item);
      if (!items.some((row) => row.id === id)) throw new ApiError(404, "catalog_item_not_found", "That item has changed since this page loaded. Refresh and try again.");
      const updated = { ...item, id };
      items = items.map((row) => (row.id === id ? updated : row));
      return updated;
    },
    async deleteCatalogItem(id) {
      await delay(260);
      items = items.filter((row) => row.id !== id);
    },
    async importCatalog(rows, replace) {
      await delay(500);
      rows.forEach(check);
      const base = replace ? [] : items;
      let created = 0;
      let updated = 0;
      const merged = [...base];
      for (const row of rows) {
        const index = merged.findIndex((existing) => (row.sku ? existing.sku.toLowerCase() === row.sku.toLowerCase() : existing.kind === row.kind && existing.name.toLowerCase() === row.name.toLowerCase()));
        if (index >= 0) {
          merged[index] = { ...row, id: merged[index].id };
          updated += 1;
        } else {
          merged.push({ ...row, id: `mock-${subdomain}-${next++}` });
          created += 1;
        }
      }
      items = merged;
      return { created, updated, catalog: catalogView() };
    },
    async integrations() {
      await delay(240);
      return integrationsView();
    },
    async saveIntegrations(update: IntegrationsUpdate) {
      await delay(600);
      const changed: string[] = [];
      if (update.telegram?.bot_token !== undefined) {
        telegram.token = update.telegram.bot_token;
        changed.push("Telegram bot token");
      }
      if (update.telegram?.allowed_users) {
        telegram.users = update.telegram.allowed_users;
        changed.push("Telegram approved users");
      }
      if (update.whatsapp_cloud) {
        whatsapp = {
          token: update.whatsapp_cloud.access_token ?? whatsapp.token,
          phone: update.whatsapp_cloud.phone_number_id ?? whatsapp.phone,
          verify: update.whatsapp_cloud.verify_token ?? whatsapp.verify,
        };
        changed.push("WhatsApp Cloud API");
      }
      if (update.meta) {
        meta = { page: update.meta.page_id ?? meta.page, ig: update.meta.ig_user_id ?? meta.ig, token: update.meta.page_access_token ?? meta.token };
        changed.push("Facebook and Instagram");
      }
      if (update.ai_preset) {
        preset = update.ai_preset;
        changed.push("AI preset");
      }
      return {
        integrations: integrationsView(),
        changed,
        restart: changed.length ? (update.apply_now ? "applied" : "pending") : "unchanged",
        detail: "Saved in sample mode. A live account writes these to your Coordinator.",
      } as const;
    },
    async testIntegration(target) {
      await delay(700);
      const saved = target === "telegram" ? telegram.token : target === "meta" ? meta.token && meta.page : whatsapp.token && whatsapp.phone && whatsapp.verify;
      return saved
        ? { target, ok: true, detail: "Sample mode: nothing was contacted, but these values look complete." }
        : { target, ok: false, detail: "Save your credentials first." };
    },
    async usage() {
      await delay(300);
      return mockUsage(preset);
    },
  };
}
