"use client";

import { AnimatePresence, motion } from "motion/react";
import { Download, Package, Pencil, Plus, Trash2, Upload, X, CalendarClock } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toaster";
import {
  parseCatalogFile,
  usd,
  type BusinessModeName,
  type CatalogItem,
  type CatalogItemInput,
  type CatalogKind,
  type CatalogView,
} from "@/lib/knowledge-api";
import { SPRING } from "@/lib/motion";
import type { PortalClient } from "@/lib/portal-api";
import { cn } from "@/lib/utils";

const TEMPLATE_CSV = [
  "kind,name,sku,price_usd,stock_qty,sizes_or_variants,description,duration,booking_rules",
  'product,Linen Shirt,LS-001,39.90,12,S|M|L,Breathable everyday shirt,,',
  'service,Teeth Whitening,,199,,,Gentle in-clinic whitening,60 min,Book at least 48 hours ahead',
].join("\n");

const blank = (kind: CatalogKind): CatalogItemInput => ({
  kind,
  name: "",
  price_usd: 0,
  description: "",
  sku: "",
  sizes_or_variants: [],
  stock_qty: null,
  image_url: null,
  duration: "",
  booking_rules: "",
});

const wording = (mode: BusinessModeName) =>
  mode === "ecommerce"
    ? { plural: "Products", singular: "product", kind: "product" as CatalogKind }
    : { plural: "Service packages", singular: "service", kind: "service" as CatalogKind };

export function CatalogManager({ client, mode }: { client: PortalClient; mode: BusinessModeName }) {
  const notify = useToast();
  const words = wording(mode);
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CatalogItem | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function load() {
    try {
      setCatalog(await client.knowledge.catalog());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The catalog could not be loaded.");
    }
  }

  useEffect(() => {
    let cancelled = false;
    client.knowledge.catalog().then(
      (next) => {
        if (!cancelled) setCatalog(next);
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "The catalog could not be loaded.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  async function remove(item: CatalogItem) {
    try {
      await client.knowledge.deleteCatalogItem(item.id);
      setCatalog((current) => (current ? { ...current, items: current.items.filter((row) => row.id !== item.id) } : current));
      setConfirmDelete(null);
      notify(`${item.name} removed.`);
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : "That could not be removed.", "error");
    }
  }

  if (!catalog) {
    if (error) {
      return (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
          <p>{error}</p>
          <button type="button" onClick={load} className="min-h-10 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70">
            Try again
          </button>
        </div>
      );
    }
    return <div aria-busy="true" aria-label="Loading catalog" className="h-64 animate-pulse rounded-3xl bg-white/3" />;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">{words.plural}</h3>
          <p className="mt-0.5 font-mono text-xs tabular-nums text-ink-3">
            {catalog.items.length} of {catalog.limit}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setImporting(true)}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/12 px-3.5 text-sm font-medium text-ink transition-colors hover:border-white/25"
          >
            <Upload aria-hidden className="size-4" />
            Import CSV or JSON
          </button>
          <motion.button
            type="button"
            whileTap={{ scale: 0.97 }}
            transition={SPRING}
            onClick={() => setEditing("new")}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian"
          >
            <Plus aria-hidden className="size-4" />
            Add {words.singular}
          </motion.button>
        </div>
      </div>

      {catalog.items.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-white/12 p-6 text-center">
          {mode === "ecommerce" ? <Package aria-hidden className="mx-auto size-6 text-ink-3" /> : <CalendarClock aria-hidden className="mx-auto size-6 text-ink-3" />}
          <p className="mt-3 text-sm font-medium text-ink">No {words.plural.toLowerCase()} yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ink-3">
            Add what you sell, with real prices. Your Coordinator quotes only what is listed here, and the Social Autopilot
            builds each post around one of these.
          </p>
        </div>
      ) : (
        <ul className="mt-4 grid gap-2.5 lg:grid-cols-2">
          <AnimatePresence initial={false}>
            {catalog.items.map((item) => (
              <motion.li
                key={item.id}
                layout="position"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
                transition={SPRING}
                className="rounded-2xl border border-white/8 bg-white/3 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{item.name}</p>
                    <p className="mt-0.5 text-xs text-ink-3">{detailLine(item)}</p>
                  </div>
                  <p className="shrink-0 font-mono text-base font-semibold tabular-nums text-ink">{usd(item.price_usd)}</p>
                </div>
                {item.kind === "product" && <StockTag item={item} />}
                {item.description && <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-2">{item.description}</p>}
                <div className="mt-3 flex items-center justify-end gap-1.5">
                  {confirmDelete === item.id ? (
                    <>
                      <span className="mr-auto text-xs text-ink-2">Remove this {words.singular}?</span>
                      <button type="button" onClick={() => setConfirmDelete(null)} className="min-h-10 rounded-lg px-3 text-xs font-medium text-ink-2 hover:bg-white/6">
                        Keep
                      </button>
                      <button type="button" onClick={() => remove(item)} className="min-h-10 rounded-lg border border-halt/40 px-3 text-xs font-semibold text-halt-soft hover:border-halt/70">
                        Remove
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => setEditing(item)}
                        aria-label={`Edit ${item.name}`}
                        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-ink-2 hover:bg-white/6 hover:text-ink"
                      >
                        <Pencil aria-hidden className="size-3.5" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(item.id)}
                        aria-label={`Remove ${item.name}`}
                        className="inline-flex size-10 items-center justify-center rounded-lg text-ink-3 hover:bg-halt/10 hover:text-halt-soft"
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </button>
                    </>
                  )}
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? `Add ${words.singular}` : "Edit item"} placement="right">
        {editing !== null && (
          <ItemForm
            key={editing === "new" ? "new" : editing.id}
            client={client}
            item={editing === "new" ? null : editing}
            defaultKind={words.kind}
            onClose={() => setEditing(null)}
            onSaved={(saved) => {
              setCatalog((current) => {
                if (!current) return current;
                const exists = current.items.some((row) => row.id === saved.id);
                return { ...current, items: exists ? current.items.map((row) => (row.id === saved.id ? saved : row)) : [...current.items, saved] };
              });
              setEditing(null);
              notify(`${saved.name} saved. Your Coordinator uses it straight away.`);
            }}
          />
        )}
      </Dialog>

      <Dialog open={importing} onClose={() => setImporting(false)} title="Import catalog" className="sm:max-w-xl">
        {importing && (
          <ImportForm
            client={client}
            defaultKind={words.kind}
            onClose={() => setImporting(false)}
            onImported={(next, summary) => {
              setCatalog(next);
              setImporting(false);
              notify(summary);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function detailLine(item: CatalogItem): string {
  if (item.kind === "service") return [item.duration, item.booking_rules].filter(Boolean).join(" · ") || "Service";
  const bits = [item.sku, item.sizes_or_variants.length ? item.sizes_or_variants.join(", ") : ""].filter(Boolean);
  return bits.join(" · ") || "Product";
}

function StockTag({ item }: { item: CatalogItem }) {
  if (item.stock_qty === null) return null;
  const sold = item.stock_qty === 0;
  const low = item.stock_qty <= 10;
  return (
    <p
      className={cn(
        "mt-2 inline-flex min-h-6 items-center rounded-full border px-2 font-mono text-[10.5px] uppercase tracking-wider",
        sold ? "border-halt/35 bg-halt/10 text-halt-soft" : low ? "border-warn/30 bg-warn/10 text-warn" : "border-signal/25 bg-signal/8 text-signal",
      )}
    >
      {sold ? "Sold out" : `${item.stock_qty} in stock${low ? " · low" : ""}`}
    </p>
  );
}

// -------------------------------------------------------------------- add / edit
function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink-2">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-ink-3">{hint}</p>}
    </div>
  );
}

function ItemForm({
  client,
  item,
  defaultKind,
  onClose,
  onSaved,
}: {
  client: PortalClient;
  item: CatalogItem | null;
  defaultKind: CatalogKind;
  onClose: () => void;
  onSaved: (item: CatalogItem) => void;
}) {
  const base = useId();
  const [draft, setDraft] = useState<CatalogItemInput>(item ? { ...item } : blank(defaultKind));
  const [price, setPrice] = useState(item ? String(item.price_usd) : "");
  const [variants, setVariants] = useState(item ? item.sizes_or_variants.join(", ") : "");
  const [stock, setStock] = useState(item?.stock_qty != null ? String(item.stock_qty) : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<CatalogItemInput>) => setDraft((current) => ({ ...current, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const amount = Number(price);
    if (!draft.name.trim()) return setError("Enter a name.");
    if (!price.trim() || !Number.isFinite(amount) || amount < 0) return setError("Enter a price of zero or more, in US dollars.");
    if (stock.trim() && (!/^\d+$/.test(stock.trim()))) return setError("Stock is a whole number, or leave it empty if you do not track it.");
    setError(null);
    setSaving(true);
    const payload: CatalogItemInput = {
      ...draft,
      name: draft.name.trim(),
      price_usd: Math.round(amount * 100) / 100,
      sizes_or_variants: draft.kind === "product" ? variants.split(",").map((part) => part.trim()).filter(Boolean) : [],
      stock_qty: draft.kind === "product" && stock.trim() ? Number(stock) : null,
      image_url: draft.kind === "product" && draft.image_url?.trim() ? draft.image_url.trim() : null,
      sku: draft.kind === "product" ? draft.sku.trim() : "",
      duration: draft.kind === "service" ? draft.duration.trim() : "",
      booking_rules: draft.kind === "service" ? draft.booking_rules.trim() : "",
    };
    try {
      onSaved(item ? await client.knowledge.updateCatalogItem(item.id, payload) : await client.knowledge.addCatalogItem(payload));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That could not be saved.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-4">
        <h2 className="text-lg font-semibold tracking-tight text-ink">{item ? "Edit item" : "Add to catalog"}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-10 items-center justify-center rounded-lg text-ink-2 hover:bg-white/6 hover:text-ink">
          <X aria-hidden className="size-4" />
        </button>
      </div>

      <div className="thin-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <Segmented<CatalogKind>
          label="Type"
          value={draft.kind}
          onChange={(kind) => set({ kind })}
          options={[
            { value: "product", label: "Product" },
            { value: "service", label: "Service or package" },
          ]}
        />
        <Field id={`${base}-name`} label="Name">
          <input id={`${base}-name`} data-autofocus value={draft.name} maxLength={120} onChange={(event) => set({ name: event.target.value })} className="field" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${base}-price`} label="Price (USD)">
            <input id={`${base}-price`} inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} className="field font-mono" />
          </Field>
          {draft.kind === "product" ? (
            <Field id={`${base}-stock`} label="Stock on hand" hint="Leave empty if you do not track it. Sold-out items are never advertised.">
              <input id={`${base}-stock`} inputMode="numeric" value={stock} onChange={(event) => setStock(event.target.value)} className="field font-mono" />
            </Field>
          ) : (
            <Field id={`${base}-duration`} label="Duration" hint="For example 60 min">
              <input id={`${base}-duration`} value={draft.duration} maxLength={60} onChange={(event) => set({ duration: event.target.value })} className="field" />
            </Field>
          )}
        </div>
        {draft.kind === "product" ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${base}-sku`} label="SKU" hint="Letters, numbers and - _ . /">
                <input id={`${base}-sku`} value={draft.sku} maxLength={64} onChange={(event) => set({ sku: event.target.value })} className="field font-mono" />
              </Field>
              <Field id={`${base}-variants`} label="Sizes or variants" hint="Separate with commas">
                <input id={`${base}-variants`} value={variants} onChange={(event) => setVariants(event.target.value)} className="field" />
              </Field>
            </div>
            <Field id={`${base}-image`} label="Image address" hint="A web address starting with https://">
              <input id={`${base}-image`} inputMode="url" value={draft.image_url ?? ""} onChange={(event) => set({ image_url: event.target.value })} className="field" />
            </Field>
          </>
        ) : (
          <Field id={`${base}-rules`} label="Booking rules" hint="For example: book 48 hours ahead">
            <textarea id={`${base}-rules`} rows={2} value={draft.booking_rules} maxLength={300} onChange={(event) => set({ booking_rules: event.target.value })} className="field resize-none" />
          </Field>
        )}
        <Field id={`${base}-desc`} label="Description">
          <textarea id={`${base}-desc`} rows={3} value={draft.description} maxLength={400} onChange={(event) => set({ description: event.target.value })} className="field resize-none" />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-halt-soft">
            {error}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-white/8 px-5 py-3">
        <button type="button" onClick={onClose} className="min-h-11 rounded-xl px-4 text-sm font-medium text-ink-2 hover:bg-white/6">
          Cancel
        </button>
        <button type="submit" disabled={saving} className="min-h-11 rounded-xl bg-signal px-5 text-sm font-semibold text-obsidian disabled:opacity-50">
          {saving ? "Saving" : item ? "Save changes" : "Add to catalog"}
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------------ import
function ImportForm({
  client,
  defaultKind,
  onClose,
  onImported,
}: {
  client: PortalClient;
  defaultKind: CatalogKind;
  onClose: () => void;
  onImported: (catalog: CatalogView, summary: string) => void;
}) {
  const base = useId();
  const [text, setText] = useState("");
  const [replace, setReplace] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = text.trim() ? parseCatalogFile(text, defaultKind) : null;

  async function pick(file: File | undefined) {
    if (!file) return;
    if (file.size > 400_000) return setError("That file is too large. Keep it under 400 KB.");
    setError(null);
    setText(await file.text());
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([TEMPLATE_CSV], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "catalog-template.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function run() {
    if (!parsed || parsed.items.length === 0) return;
    if (replace && !confirmReplace) return setConfirmReplace(true);
    setBusy(true);
    setError(null);
    try {
      const result = await client.knowledge.importCatalog(parsed.items, replace);
      onImported(result.catalog, `Imported: ${result.created} added, ${result.updated} updated.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The import did not go through.");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-4">
        <h2 className="text-lg font-semibold tracking-tight text-ink">Import catalog</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-10 items-center justify-center rounded-lg text-ink-2 hover:bg-white/6 hover:text-ink">
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <div className="thin-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <p className="text-sm leading-relaxed text-ink-2">
          Upload a CSV or JSON file, or paste rows below. Needed columns: <span className="font-mono text-xs">name</span> and{" "}
          <span className="font-mono text-xs">price_usd</span>. Rows with the same SKU, or the same name, update the item instead of adding a copy.
        </p>
        <div className="flex flex-wrap gap-2">
          <label htmlFor={`${base}-file`} className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-white/12 px-3.5 text-sm font-medium text-ink hover:border-white/25">
            <Upload aria-hidden className="size-4" />
            Choose a file
          </label>
          <input id={`${base}-file`} type="file" accept=".csv,.json,text/csv,application/json" className="sr-only" onChange={(event) => pick(event.target.files?.[0])} />
          <button type="button" onClick={downloadTemplate} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3.5 text-sm font-medium text-ink-2 hover:bg-white/6 hover:text-ink">
            <Download aria-hidden className="size-4" />
            Download a template
          </button>
        </div>
        <div>
          <label htmlFor={`${base}-text`} className="mb-1 block text-xs font-medium text-ink-2">
            Or paste CSV or JSON
          </label>
          <textarea id={`${base}-text`} rows={7} value={text} onChange={(event) => { setText(event.target.value); setConfirmReplace(false); }} spellCheck={false} className="field resize-y font-mono text-xs" />
        </div>
        {parsed && (
          <p role="status" className={cn("rounded-xl border px-3 py-2 text-sm", parsed.items.length ? "border-signal/25 bg-signal/8 text-ink-2" : "border-warn/30 bg-warn/8 text-ink-2")}>
            {parsed.items.length
              ? `${parsed.items.length} row${parsed.items.length === 1 ? "" : "s"} ready${parsed.skipped ? `, ${parsed.skipped} skipped for a missing name or price` : ""}.`
              : "No usable rows found. Each row needs a name and a price."}
          </p>
        )}
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-ink-2">When items already exist</legend>
          {[
            { value: false, label: "Add new items and update matching ones" },
            { value: true, label: "Replace the whole catalog with this file" },
          ].map((option) => (
            <label key={String(option.value)} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-white/8 px-3 text-sm text-ink-2 has-checked:border-signal/40 has-checked:text-ink">
              <input type="radio" name={`${base}-mode`} checked={replace === option.value} onChange={() => { setReplace(option.value); setConfirmReplace(false); }} className="size-4 accent-[#00f5d4]" />
              {option.label}
            </label>
          ))}
        </fieldset>
        {confirmReplace && (
          <p role="alert" className="rounded-xl border border-warn/30 bg-warn/8 px-3 py-2 text-sm text-ink-2">
            This removes every item that is not in your file. Press Import again to confirm.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-halt-soft">
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-white/8 px-5 py-3">
        <button type="button" onClick={onClose} className="min-h-11 rounded-xl px-4 text-sm font-medium text-ink-2 hover:bg-white/6">
          Cancel
        </button>
        <button type="button" onClick={run} disabled={busy || !parsed || parsed.items.length === 0} className="min-h-11 rounded-xl bg-signal px-5 text-sm font-semibold text-obsidian disabled:opacity-40">
          {busy ? "Importing" : confirmReplace ? "Confirm and replace" : "Import"}
        </button>
      </div>
    </div>
  );
}
