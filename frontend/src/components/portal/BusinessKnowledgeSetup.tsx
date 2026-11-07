"use client";

import { AnimatePresence, motion } from "motion/react";
import { BookOpenCheck, CircleAlert, MessageCircleQuestion, Palette, Plus, RotateCw, Store, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { CatalogManager } from "@/components/portal/CatalogManager";
import { Segmented } from "@/components/ui/Segmented";
import { SpotlightCard } from "@/components/ui/SpotlightCard";
import { useToast } from "@/components/ui/Toaster";
import type { BrandKitSetup, BusinessModeName, BusinessSetup, BusinessSetupView, Faq } from "@/lib/knowledge-api";
import { SPRING } from "@/lib/motion";
import type { PortalClient } from "@/lib/portal-api";
import { cn } from "@/lib/utils";

export type KnowledgeView = "profile" | "catalog" | "brand" | "faq";
type View = KnowledgeView;

const HEX = /^#[0-9A-Fa-f]{6}$/;
const PHONE = /^\+?[0-9][0-9 ()\-.]{4,38}$/;
const URL_OK = /^https?:\/\/[^\s<>"']+$/i;
const MAX_FAQS = 40;

const FAQ_IDEAS = [
  "What are your opening hours?",
  "Where are you located?",
  "How can I pay?",
  "Do you offer delivery?",
  "What is your refund policy?",
  "How do I book or order?",
];

/** The form's own shape: text fields stay strings so an empty box is never `null`. */
type Draft = Omit<BusinessSetup, "website_url" | "brand_kit"> & {
  website_url: string;
  brand_kit: Omit<BrandKitSetup, "logo_url"> & { logo_url: string };
};

const toDraft = (setup: BusinessSetup): Draft => ({
  ...setup,
  website_url: setup.website_url ?? "",
  brand_kit: { ...setup.brand_kit, logo_url: setup.brand_kit.logo_url ?? "" },
  faqs: setup.faqs.map((faq) => ({ ...faq })),
});

const toSetup = (draft: Draft): BusinessSetup => ({
  ...draft,
  company_name: draft.company_name.trim(),
  website_url: draft.website_url.trim() || null,
  brand_kit: { ...draft.brand_kit, logo_url: draft.brand_kit.logo_url.trim() || null },
  faqs: draft.faqs.filter((faq) => faq.question.trim() && faq.answer.trim()).map((faq) => ({ question: faq.question.trim(), answer: faq.answer.trim() })),
});

function validate(draft: Draft): { view: View; message: string } | null {
  if (!draft.company_name.trim()) return { view: "profile", message: "Enter your company name." };
  if (draft.website_url.trim() && !URL_OK.test(draft.website_url.trim())) return { view: "profile", message: "The website must start with http:// or https://." };
  if (draft.support_phone.trim() && !PHONE.test(draft.support_phone.trim())) return { view: "profile", message: "Enter the phone number with digits only, for example +1 555 010 0199." };
  if (!HEX.test(draft.brand_kit.primary_color) || !HEX.test(draft.brand_kit.accent_color)) return { view: "brand", message: "Colors are written as #RRGGBB, for example #00F5D4." };
  if (draft.brand_kit.logo_url.trim() && !URL_OK.test(draft.brand_kit.logo_url.trim())) return { view: "brand", message: "The logo address must start with http:// or https://." };
  const half = draft.faqs.find((faq) => Boolean(faq.question.trim()) !== Boolean(faq.answer.trim()));
  if (half) return { view: "faq", message: "Each question needs an answer, and each answer a question. Fill in or remove the unfinished one." };
  return null;
}

/** A deep link into one section. The nonce makes asking for the same section twice still count. */
export interface KnowledgeViewRequest {
  view: KnowledgeView;
  nonce: number;
}

export function BusinessKnowledgeSetup({
  client,
  onChanged,
  requestedView,
}: {
  client: PortalClient;
  onChanged?: () => void;
  requestedView?: KnowledgeViewRequest;
}) {
  const notify = useToast();
  const [saved, setSaved] = useState<BusinessSetupView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>(requestedView?.view ?? "profile");
  const [seenRequest, setSeenRequest] = useState(requestedView?.nonce ?? 0);
  if (requestedView && requestedView.nonce !== seenRequest) {
    setSeenRequest(requestedView.nonce);
    setView(requestedView.view);
  }
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const adopt = useCallback((next: BusinessSetupView) => {
    setSaved(next);
    setDraft(toDraft(next));
  }, []);

  const load = useCallback(async () => {
    try {
      adopt(await client.knowledge.businessSetup());
      setLoadError(null);
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : "Your business setup could not be loaded.");
    }
  }, [client, adopt]);

  useEffect(() => {
    let cancelled = false;
    client.knowledge.businessSetup().then(
      (next) => {
        if (!cancelled) adopt(next);
      },
      (failure: unknown) => {
        if (!cancelled) setLoadError(failure instanceof Error ? failure.message : "Your business setup could not be loaded.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, adopt]);

  const dirty = useMemo(() => {
    if (!saved || !draft) return false;
    return JSON.stringify(toSetup(draft)) !== JSON.stringify(toSetup(toDraft(saved)));
  }, [saved, draft]);

  // Closing the tab with unsaved work is the one way to lose it.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (!saved || !draft) {
    if (loadError) {
      return (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
          <p>{loadError}</p>
          <button type="button" onClick={load} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70">
            <RotateCw aria-hidden className="size-3.5" />
            Try again
          </button>
        </div>
      );
    }
    return <div aria-busy="true" aria-label="Loading business setup" className="h-96 animate-pulse rounded-3xl bg-white/3" />;
  }

  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setProblem(null);
  };
  const setKit = (patch: Partial<Draft["brand_kit"]>) => set({ brand_kit: { ...draft.brand_kit, ...patch } });

  async function save() {
    if (!draft) return;
    const invalid = validate(draft);
    if (invalid) {
      setView(invalid.view);
      setProblem(invalid.message);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const result = await client.knowledge.saveBusinessSetup(toSetup(draft));
      adopt(result);
      notify("Saved. Your Coordinator now knows this.");
      onChanged?.();
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : "That could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-ink">
            <BookOpenCheck aria-hidden className="size-5 text-signal" />
            Business Setup & Catalog
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">
            Tell your Coordinator how your business works. What you save here becomes part of its memory and instructions, so it is used in every
            conversation, scheduled briefing and social post.
          </p>
        </div>
      </div>

      <div className="mt-5">
        <Segmented<View>
          label="Business setup sections"
          value={view}
          onChange={setView}
          className="max-w-full flex-wrap rounded-2xl"
          optionClassName="min-h-11 px-3 sm:px-4"
          options={[
            { value: "profile", label: <Tab icon={<Store aria-hidden className="size-3.5" />}>Profile & policies</Tab> },
            { value: "catalog", label: <Tab icon={<BookOpenCheck aria-hidden className="size-3.5" />}>{saved.business_mode === "ecommerce" ? "Products" : "Services"}</Tab> },
            { value: "brand", label: <Tab icon={<Palette aria-hidden className="size-3.5" />}>Brand kit</Tab> },
            { value: "faq", label: <Tab icon={<MessageCircleQuestion aria-hidden className="size-3.5" />}>{`FAQ training${draft.faqs.length ? ` (${draft.faqs.length})` : ""}`}</Tab> },
          ]}
        />
      </div>

      <motion.div key={view} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING} className="mt-4">
        {view === "profile" && <ProfileForm draft={draft} set={set} />}
        {view === "catalog" && (
          <SpotlightCard className="rounded-3xl p-5 sm:p-6">
            <CatalogManager client={client} mode={saved.business_mode} />
          </SpotlightCard>
        )}
        {view === "brand" && <BrandStudio draft={draft} setKit={setKit} />}
        {view === "faq" && <FaqMatrix faqs={draft.faqs} onChange={(faqs) => set({ faqs })} />}
      </motion.div>

      {view !== "catalog" && (
        <div className="sticky bottom-3 z-10 mt-5">
          <div className="surface sheen flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
            <div className="min-w-0 flex-1 text-xs leading-relaxed" aria-live="polite">
              {problem ? (
                <p role="alert" className="flex items-start gap-1.5 text-halt-soft">
                  <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  {problem}
                </p>
              ) : dirty ? (
                <p className="text-warn">You have unsaved changes.</p>
              ) : (
                <SyncNote saved={saved} />
              )}
            </div>
            {dirty && (
              <button
                type="button"
                onClick={() => {
                  setDraft(toDraft(saved));
                  setProblem(null);
                }}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-ink-2 hover:bg-white/6 hover:text-ink"
              >
                <Undo2 aria-hidden className="size-4" />
                Discard
              </button>
            )}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              transition={SPRING}
              onClick={save}
              disabled={saving || !dirty}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-signal px-5 text-sm font-semibold text-obsidian disabled:opacity-40"
            >
              {saving ? "Syncing" : "Save & sync to Coordinator"}
            </motion.button>
          </div>
        </div>
      )}
    </div>
  );
}

function Tab({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="hidden sm:block">{icon}</span>
      {children}
    </span>
  );
}

function SyncNote({ saved }: { saved: BusinessSetupView }) {
  if (!saved.updated_at) return <p className="text-ink-3">Nothing saved yet. Fill in what you know and press Save.</p>;
  const when = new Date(saved.updated_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  if (saved.memory_lines_skipped > 0) {
    return (
      <p className="text-warn">
        Saved {when}. Business memory is full, so {saved.memory_lines_skipped} short summary line{saved.memory_lines_skipped === 1 ? " was" : "s were"} left out of
        it. Your Coordinator still receives the complete details.
      </p>
    );
  }
  return <p className="text-ink-3">Synced to your Coordinator {when}.</p>;
}

// --------------------------------------------------------------------- shared bits
function Field({ id, label, hint, count, children }: { id: string; label: string; hint?: string; count?: [number, number]; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-ink-2">
          {label}
        </label>
        {count && (
          <span className={cn("font-mono text-[11px] tabular-nums", count[0] > count[1] * 0.9 ? "text-warn" : "text-ink-3")}>
            {count[0]}/{count[1]}
          </span>
        )}
      </div>
      {children}
      {hint && <p className="mt-1 text-[11px] leading-snug text-ink-3">{hint}</p>}
    </div>
  );
}

// ------------------------------------------------------------------------ profile
function ProfileForm({ draft, set }: { draft: Draft; set: (patch: Partial<Draft>) => void }) {
  const base = useId();
  const mode: BusinessModeName = draft.business_mode;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <SpotlightCard className="rounded-3xl p-5 sm:p-6">
        <h3 className="text-sm font-semibold text-ink">About the business</h3>
        <div className="mt-4 space-y-4">
          <Field id={`${base}-name`} label="Company name" count={[draft.company_name.length, 120]}>
            <input id={`${base}-name`} value={draft.company_name} maxLength={120} onChange={(event) => set({ company_name: event.target.value })} className="field" />
          </Field>
          <div>
            <p id={`${base}-mode`} className="mb-1 text-xs font-medium text-ink-2">
              Business type
            </p>
            <Segmented<BusinessModeName>
              label="Business type"
              value={mode}
              onChange={(business_mode) => set({ business_mode })}
              optionClassName="min-h-11 px-4"
              options={[
                { value: "general", label: "Services and bookings" },
                { value: "ecommerce", label: "Online store" },
              ]}
            />
            <p className="mt-1 text-[11px] text-ink-3">Decides whether your catalog lists products with stock, or services with durations.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`${base}-industry`} label="Industry" count={[draft.industry.length, 120]}>
              <input id={`${base}-industry`} value={draft.industry} maxLength={120} onChange={(event) => set({ industry: event.target.value })} placeholder="Dental clinic" className="field" />
            </Field>
            <Field id={`${base}-phone`} label="Support phone">
              <input id={`${base}-phone`} inputMode="tel" value={draft.support_phone} maxLength={40} onChange={(event) => set({ support_phone: event.target.value })} placeholder="+1 555 010 0199" className="field font-mono" />
            </Field>
          </div>
          <Field id={`${base}-tagline`} label="Tagline" count={[draft.tagline.length, 160]}>
            <input id={`${base}-tagline`} value={draft.tagline} maxLength={160} onChange={(event) => set({ tagline: event.target.value })} className="field" />
          </Field>
          <Field id={`${base}-site`} label="Website">
            <input id={`${base}-site`} inputMode="url" value={draft.website_url} maxLength={300} onChange={(event) => set({ website_url: event.target.value })} placeholder="https://" className="field" />
          </Field>
          <Field id={`${base}-hours`} label="Business hours" count={[draft.business_hours.length, 300]}>
            <input id={`${base}-hours`} value={draft.business_hours} maxLength={300} onChange={(event) => set({ business_hours: event.target.value })} placeholder="Mon-Fri 9am-6pm, Sat 9am-1pm" className="field" />
          </Field>
          <Field id={`${base}-loc`} label="Location" count={[draft.location_address.length, 300]}>
            <input id={`${base}-loc`} value={draft.location_address} maxLength={300} onChange={(event) => set({ location_address: event.target.value })} className="field" />
          </Field>
        </div>
      </SpotlightCard>

      <SpotlightCard className="rounded-3xl p-5 sm:p-6" glow="99 102 241">
        <h3 className="text-sm font-semibold text-ink">Policies and voice</h3>
        <p className="mt-1 text-xs text-ink-3">Write facts, not instructions. Your Coordinator repeats these to customers.</p>
        <div className="mt-4 space-y-4">
          <Field id={`${base}-delivery`} label="Delivery and shipping" count={[draft.delivery_and_shipping_policy.length, 600]} hint="Fees, areas, how long it takes.">
            <textarea id={`${base}-delivery`} rows={4} value={draft.delivery_and_shipping_policy} maxLength={600} onChange={(event) => set({ delivery_and_shipping_policy: event.target.value })} className="field resize-y" />
          </Field>
          <Field id={`${base}-returns`} label="Returns and refunds" count={[draft.return_and_refund_policy.length, 600]} hint="What can be returned, by when, and how refunds are paid.">
            <textarea id={`${base}-returns`} rows={4} value={draft.return_and_refund_policy} maxLength={600} onChange={(event) => set({ return_and_refund_policy: event.target.value })} className="field resize-y" />
          </Field>
          <Field id={`${base}-tone`} label="Tone of voice" count={[draft.tone_of_voice.length, 300]} hint="For example: warm, calm and reassuring.">
            <input id={`${base}-tone`} value={draft.tone_of_voice} maxLength={300} onChange={(event) => set({ tone_of_voice: event.target.value })} className="field" />
          </Field>
        </div>
      </SpotlightCard>
    </div>
  );
}

// -------------------------------------------------------------------- brand studio
/** Black or white, whichever reads better on a colour. */
function inkFor(hex: string): string {
  if (!HEX.test(hex)) return "#050508";
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#050508" : "#ffffff";
}

function ColorField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  const valid = HEX.test(value);
  return (
    <div>
      <label htmlFor={`${id}-hex`} className="mb-1 block text-xs font-medium text-ink-2">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={valid ? value.toLowerCase() : "#000000"}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="size-11 shrink-0 cursor-pointer rounded-xl border border-white/12 bg-transparent p-1"
        />
        <input
          id={`${id}-hex`}
          value={value}
          maxLength={7}
          spellCheck={false}
          aria-invalid={!valid}
          onChange={(event) => onChange(event.target.value.startsWith("#") ? event.target.value : `#${event.target.value}`)}
          className={cn("field font-mono uppercase", !valid && "border-halt/60")}
        />
      </div>
    </div>
  );
}

function BrandStudio({ draft, setKit }: { draft: Draft; setKit: (patch: Partial<Draft["brand_kit"]>) => void }) {
  const base = useId();
  const kit = draft.brand_kit;
  const primary = HEX.test(kit.primary_color) ? kit.primary_color : "#00F5D4";
  const accent = HEX.test(kit.accent_color) ? kit.accent_color : "#6366F1";
  const badge = (kit.logo_text.trim() || draft.company_name || "BRAND").toUpperCase().slice(0, 18);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <SpotlightCard className="rounded-3xl p-5 sm:p-6">
        <h3 className="text-sm font-semibold text-ink">Brand kit studio</h3>
        <p className="mt-1 text-xs text-ink-3">The Social Autopilot stamps these onto every post it makes, so the type stays crisp and the brand never drifts.</p>
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <ColorField id={`${base}-primary`} label="Primary color" value={kit.primary_color} onChange={(primary_color) => setKit({ primary_color })} />
            <ColorField id={`${base}-accent`} label="Accent color" value={kit.accent_color} onChange={(accent_color) => setKit({ accent_color })} />
          </div>
          <Field id={`${base}-logo`} label="Logo text" count={[kit.logo_text.length, 24]} hint="Printed in the corner badge. Leave empty to use your company name.">
            <input id={`${base}-logo`} value={kit.logo_text} maxLength={24} onChange={(event) => setKit({ logo_text: event.target.value })} className="field" />
          </Field>
          <Field id={`${base}-logourl`} label="Logo address (optional)" hint="Kept with your profile. Posts use the logo text above.">
            <input id={`${base}-logourl`} inputMode="url" value={kit.logo_url} maxLength={300} onChange={(event) => setKit({ logo_url: event.target.value })} placeholder="https://" className="field" />
          </Field>
          <Field id={`${base}-cta`} label="Default post call to action" count={[kit.default_cta.length, 80]}>
            <input id={`${base}-cta`} value={kit.default_cta} maxLength={80} onChange={(event) => setKit({ default_cta: event.target.value })} className="field" />
          </Field>
        </div>
      </SpotlightCard>

      <SpotlightCard className="rounded-3xl p-5 sm:p-6" glow="99 102 241">
        <h3 className="text-sm font-semibold text-ink">Preview</h3>
        <div
          role="img"
          aria-label={`Preview of a post in your colors with the badge ${badge}`}
          className="relative mt-3 flex aspect-square w-full flex-col justify-between overflow-hidden rounded-2xl p-5"
          style={{ background: `linear-gradient(135deg, ${primary}33, #050508 55%, ${accent}55)` }}
        >
          <span className="w-fit rounded-full px-3 py-1 font-mono text-[11px] font-semibold tracking-wider" style={{ background: primary, color: inkFor(primary) }}>
            {badge}
          </span>
          <div>
            <p className="text-2xl font-semibold leading-tight tracking-tight text-white">Your featured offer</p>
            <span className="mt-3 inline-block rounded-full px-3 py-1 font-mono text-sm font-semibold" style={{ background: accent, color: inkFor(accent) }}>
              $49 · 45 min
            </span>
          </div>
          <span className="w-fit rounded-xl px-3.5 py-2 text-xs font-semibold" style={{ background: primary, color: inkFor(primary) }}>
            {kit.default_cta.trim() || "Message us to book or order now"}
          </span>
        </div>
        <p className="mt-2 text-[11px] leading-snug text-ink-3">A simplified preview. The real post is rendered at 1080 by 1080 with your offer and price.</p>
      </SpotlightCard>
    </div>
  );
}

// ----------------------------------------------------------------------- faq matrix
function FaqMatrix({ faqs, onChange }: { faqs: Faq[]; onChange: (faqs: Faq[]) => void }) {
  const base = useId();
  const have = new Set(faqs.map((faq) => faq.question.trim().toLowerCase()));
  const ideas = FAQ_IDEAS.filter((idea) => !have.has(idea.toLowerCase()));
  const update = (index: number, patch: Partial<Faq>) => onChange(faqs.map((faq, position) => (position === index ? { ...faq, ...patch } : faq)));
  const full = faqs.length >= MAX_FAQS;

  return (
    <SpotlightCard className="rounded-3xl p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <h3 className="text-sm font-semibold text-ink">FAQ training</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            Add the questions customers ask most, with the answer you want given. Your Sales Rep uses these as written, so it never has to guess.
          </p>
        </div>
        <button
          type="button"
          disabled={full}
          onClick={() => onChange([...faqs, { question: "", answer: "" }])}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian disabled:opacity-40"
        >
          <Plus aria-hidden className="size-4" />
          Add a question
        </button>
      </div>

      {ideas.length > 0 && !full && (
        <div className="mt-4">
          <p className="text-[11px] text-ink-3">Common questions to start from</p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {ideas.map((idea) => (
              <li key={idea}>
                <button
                  type="button"
                  onClick={() => onChange([...faqs, { question: idea, answer: "" }])}
                  className="inline-flex min-h-9 items-center gap-1 rounded-full border border-white/10 px-3 text-xs text-ink-2 transition-colors hover:border-signal/40 hover:text-ink"
                >
                  <Plus aria-hidden className="size-3" />
                  {idea}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {faqs.length === 0 ? (
        <p className="mt-5 rounded-2xl border border-dashed border-white/12 p-5 text-center text-xs text-ink-3">No questions yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          <AnimatePresence initial={false}>
            {faqs.map((faq, index) => (
              <motion.li
                key={index}
                layout="position"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.14 } }}
                transition={SPRING}
                className="rounded-2xl border border-white/8 bg-white/3 p-4"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1 space-y-3">
                    <Field id={`${base}-q${index}`} label={`Question ${index + 1}`} count={[faq.question.length, 200]}>
                      <input id={`${base}-q${index}`} value={faq.question} maxLength={200} onChange={(event) => update(index, { question: event.target.value })} className="field" />
                    </Field>
                    <Field id={`${base}-a${index}`} label="Answer" count={[faq.answer.length, 600]}>
                      <textarea id={`${base}-a${index}`} rows={3} value={faq.answer} maxLength={600} onChange={(event) => update(index, { answer: event.target.value })} className="field resize-y" />
                    </Field>
                  </div>
                  <button
                    type="button"
                    onClick={() => onChange(faqs.filter((_, position) => position !== index))}
                    aria-label={`Remove question ${index + 1}`}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-3 hover:bg-halt/10 hover:text-halt-soft"
                  >
                    <Trash2 aria-hidden className="size-4" />
                  </button>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      <p className="mt-3 font-mono text-[11px] tabular-nums text-ink-3">
        {faqs.length} of {MAX_FAQS} questions
      </p>
    </SpotlightCard>
  );
}
