"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  CircleCheck,
  Clapperboard,
  Globe,
  Hand,
  Lock,
  Mail,
  Megaphone,
  PackageCheck,
  PencilLine,
  RotateCw,
  Send,
  ShieldBan,
  Tag,
  UserCheck,
  Workflow,
  Image as ImageIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toaster";
import { ApiError } from "@/lib/hub-types";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages";
import { SPRING } from "@/lib/motion";
import type { ApprovalKind, GuardrailItem, GuardrailLane, OwnerDecision, PortalApproval, PortalClient } from "@/lib/portal-api";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<ApprovalKind, ReactNode> = {
  social_post: <ImageIcon aria-hidden className="size-4" />,
  reel: <Clapperboard aria-hidden className="size-4" />,
  ad_boost: <Megaphone aria-hidden className="size-4" />,
  partner_email: <Mail aria-hidden className="size-4" />,
  website_update: <Globe aria-hidden className="size-4" />,
  courier_dispatch: <PackageCheck aria-hidden className="size-4" />,
  discount_offer: <Tag aria-hidden className="size-4" />,
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function Preview({ item, currency }: { item: PortalApproval; currency: string }) {
  const { t, money, number } = useI18n();
  const { preview } = item;
  const body = typeof preview.body === "string" ? preview.body : null;
  const amount = num(preview.amount);
  const parcels = num(preview.parcels);
  const cod = num(preview.cod_total);
  const courier = typeof preview.courier === "string" ? preview.courier : null;

  if (!body && amount === null && parcels === null) return null;
  return (
    <div className="mt-3 rounded-xl border border-white/7 bg-black/25 px-3 py-2.5 text-sm leading-relaxed text-ink">
      {body && <p className="whitespace-pre-wrap wrap-break-word">{body}</p>}
      {amount !== null && (
        <p className="font-medium">
          {t("approvals.previewAmount", {
            amount: money(amount, currency),
            per: typeof preview.per === "string" ? preview.per : "day",
            days: number(num(preview.duration_days) ?? 1),
          })}
        </p>
      )}
      {parcels !== null && (
        <p className="font-medium">{t("approvals.previewParcels", { parcels: number(parcels), courier: courier ?? "" })}</p>
      )}
      {cod !== null && <p className="mt-0.5 text-ink-2">{t("approvals.previewCod", { amount: money(cod, currency) })}</p>}
    </div>
  );
}

function PendingCard({
  item,
  currency,
  onDecide,
}: {
  item: PortalApproval;
  currency: string;
  onDecide: (item: PortalApproval, decision: OwnerDecision, note?: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState(false);
  const noteId = useId();

  function submitEdit(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) {
      setNoteError(true);
      return;
    }
    onDecide(item, "edit", note.trim());
  }

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.14 } }}
      transition={SPRING}
      className="surface rounded-2xl p-4"
    >
      <p className="flex items-center gap-2 text-xs font-medium text-ink-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-hyper/15 text-hyper-soft">{KIND_ICON[item.kind]}</span>
        {t(`kind.${item.kind}` as MessageKey)}
      </p>
      <h4 className="mt-2 text-[15px] font-semibold text-ink">{item.title}</h4>
      {item.summary && <p className="mt-1 text-sm leading-relaxed text-ink-2">{item.summary}</p>}
      <Preview item={item} currency={currency} />

      <AnimatePresence initial={false} mode="wait">
        {editing ? (
          <motion.form
            key="edit"
            onSubmit={submitEdit}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={SPRING}
            className="mt-3"
          >
            <label htmlFor={noteId} className="mb-1.5 block text-sm font-medium text-ink-2">
              {t("approvals.editLabel")}
            </label>
            <textarea
              id={noteId}
              rows={2}
              autoFocus
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setNoteError(false);
              }}
              placeholder={t("approvals.editPlaceholder")}
              aria-invalid={noteError}
              className="field"
            />
            {noteError && (
              <p role="alert" className="mt-1.5 text-xs text-halt-soft">
                {t("approvals.editRequired")}
              </p>
            )}
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button type="submit" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian">
                <Send aria-hidden className="size-4" />
                {t("approvals.editSend")}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="inline-flex min-h-11 items-center rounded-xl border border-white/12 px-4 text-sm font-medium text-ink hover:border-white/25"
              >
                {t("common.cancel")}
              </button>
            </div>
          </motion.form>
        ) : (
          <motion.div
            key="actions"
            initial={false}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            className="mt-3 flex flex-wrap gap-2"
          >
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              transition={SPRING}
              onClick={() => onDecide(item, "approve")}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian transition-colors hover:bg-[#3ff9e2] sm:flex-none"
            >
              <Check aria-hidden className="size-4" />
              {t("approvals.approve")}
            </motion.button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/12 px-4 text-sm font-medium text-ink transition-colors hover:border-white/25"
            >
              <PencilLine aria-hidden className="size-4" />
              {t("approvals.edit")}
            </button>
            <button
              type="button"
              onClick={() => onDecide(item, "reject")}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-halt/30 px-4 text-sm font-medium text-halt-soft transition-colors hover:border-halt/60"
            >
              <Hand aria-hidden className="size-4" />
              {t("approvals.reject")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function HistoryRow({ item }: { item: PortalApproval }) {
  const { t, date } = useI18n();
  const label =
    item.status === "approved"
      ? item.decidedAutomatically
        ? t("approvals.statusAuto")
        : t("approvals.statusApproved")
      : item.status === "rejected"
        ? t("approvals.statusRejected")
        : t("approvals.statusChanges");
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/6 py-2.5 text-sm first:border-t-0">
      <span className="text-ink-3">{KIND_ICON[item.kind]}</span>
      <span className="min-w-0 flex-1 text-ink-2">{item.title}</span>
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {item.decidedAt && <span className="text-xs tabular-nums text-ink-3">{date(item.decidedAt)}</span>}
      {item.note && <p className="w-full text-xs text-ink-3">{t("approvals.yourNote", { note: item.note })}</p>}
    </li>
  );
}

const LANES: { lane: GuardrailLane; title: MessageKey; body: MessageKey; icon: ReactNode; accent: string }[] = [
  { lane: "automatic", title: "lanes.automatic", body: "lanes.automaticBody", icon: <Workflow aria-hidden className="size-4" />, accent: "text-signal" },
  { lane: "owner", title: "lanes.owner", body: "lanes.ownerBody", icon: <UserCheck aria-hidden className="size-4" />, accent: "text-hyper-soft" },
  { lane: "never", title: "lanes.never", body: "lanes.neverBody", icon: <ShieldBan aria-hidden className="size-4" />, accent: "text-halt-soft" },
];

function Guardrails({ items, onToggle }: { items: GuardrailItem[]; onToggle: (item: GuardrailItem, automatic: boolean) => void }) {
  const { t } = useI18n();
  const labelOf = (item: GuardrailItem) => t(`guard.${item.key}` as MessageKey) || item.label;
  return (
    <section aria-label={t("lanes.title")} className="mt-8">
      <h3 className="text-base font-semibold tracking-tight text-ink">{t("lanes.title")}</h3>
      <p className="mt-1 text-sm text-ink-2">{t("lanes.body")}</p>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {LANES.map(({ lane, title, body, icon, accent }) => (
          <div key={lane} className="surface rounded-2xl p-4">
            <p className={cn("flex items-center gap-2 text-sm font-semibold", accent)}>
              {icon}
              {t(title)}
            </p>
            <p className="mt-1 text-xs text-ink-3">{t(body)}</p>
            <ul className="mt-3">
              <AnimatePresence initial={false} mode="popLayout">
                {items
                  .filter((item) => item.lane === lane)
                  .map((item) => (
                    <motion.li
                      key={item.key}
                      layout="position"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, transition: { duration: 0.1 } }}
                      transition={SPRING}
                      className="flex min-h-11 items-center justify-between gap-3 border-t border-white/6 py-1.5 text-sm text-ink-2"
                    >
                      <span className="min-w-0">{labelOf(item)}</span>
                      {item.promotable ? (
                        <Switch
                          checked={item.lane === "automatic"}
                          onChange={(automatic) => onToggle(item, automatic)}
                          label={t("lanes.toggle", { item: labelOf(item) })}
                        />
                      ) : (
                        lane !== "automatic" && (
                          <span title={t("lanes.locked")} className="shrink-0 text-ink-3">
                            <Lock aria-hidden className="size-3.5" />
                            <span className="sr-only">{t("lanes.locked")}</span>
                          </span>
                        )
                      )}
                    </motion.li>
                  ))}
              </AnimatePresence>
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ApprovalCenter({
  client,
  currency,
  onChanged,
}: {
  client: PortalClient;
  currency: string;
  onChanged?: () => void;
}) {
  const { t, number } = useI18n();
  const notify = useToast();
  const [items, setItems] = useState<PortalApproval[] | null>(null);
  const [guardrails, setGuardrails] = useState<GuardrailItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextItems, nextGuardrails] = await Promise.all([client.approvals(), client.guardrails()]);
      setItems(nextItems);
      setGuardrails(nextGuardrails);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("approvals.loadError"));
    }
  }, [client, t]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.approvals(), client.guardrails()]).then(
      ([nextItems, nextGuardrails]) => {
        if (cancelled) return;
        setItems(nextItems);
        setGuardrails(nextGuardrails);
        setError(null);
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : t("approvals.loadError"));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, t]);

  async function decide(item: PortalApproval, decision: OwnerDecision, note?: string) {
    const before = items;
    // Applied at once, so one tap feels like one tap. A failure puts it back.
    const optimistic: PortalApproval = {
      ...item,
      status: decision === "approve" ? "approved" : decision === "edit" ? "changes_requested" : "rejected",
      note: note ?? null,
      decidedAt: new Date().toISOString(),
    };
    setItems((current) => current?.map((row) => (row.id === item.id ? optimistic : row)) ?? null);
    try {
      const saved = await client.decideApproval(item.id, decision, note);
      setItems((current) => current?.map((row) => (row.id === item.id ? saved : row)) ?? null);
      notify(
        decision === "approve" ? t("approvals.approved") : decision === "edit" ? t("approvals.sentBack") : t("approvals.rejected"),
        decision === "approve" ? "success" : "info",
      );
      onChanged?.();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        notify(t("approvals.conflict"), "info");
        load();
        onChanged?.();
        return;
      }
      setItems(before);
      notify(failure instanceof Error ? failure.message : t("approvals.error"), "error");
    }
  }

  async function toggle(item: GuardrailItem, automatic: boolean) {
    const lane = automatic ? "automatic" : "owner";
    const before = guardrails;
    const label = t(`guard.${item.key}` as MessageKey);
    setGuardrails((current) => current?.map((row) => (row.key === item.key ? { ...row, lane } : row)) ?? null);
    try {
      setGuardrails(await client.setGuardrail(item.key, lane));
      notify(automatic ? t("lanes.nowAutomatic", { item: label }) : t("lanes.nowOwner", { item: label }), "info");
    } catch (failure) {
      setGuardrails(before);
      notify(failure instanceof Error ? failure.message : t("lanes.error"), "error");
    }
  }

  if (error && !items) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
        <p>{error}</p>
        <button type="button" onClick={load} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70">
          <RotateCw aria-hidden className="size-3.5" />
          {t("common.retry")}
        </button>
      </div>
    );
  }

  if (!items || !guardrails) {
    return (
      <div aria-busy="true" aria-label={t("common.loading")} className="space-y-3">
        <div className="h-44 animate-pulse rounded-2xl bg-white/4" />
        <div className="h-44 animate-pulse rounded-2xl bg-white/4" />
      </div>
    );
  }

  const pending = items.filter((item) => item.status === "pending_owner");
  const decided = items.filter((item) => item.status !== "pending_owner").slice(0, 12);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight text-ink">{t("approvals.title")}</h2>
        {pending.length > 0 && (
          <p role="status" className="rounded-full border border-hyper/35 bg-hyper/8 px-2.5 py-1 text-xs font-medium text-hyper-soft">
            {t("approvals.pendingCount", { count: number(pending.length) })}
          </p>
        )}
      </div>

      {pending.length === 0 ? (
        <div className="surface mt-4 rounded-2xl px-5 py-10 text-center">
          <CircleCheck aria-hidden className="mx-auto size-6 text-signal" />
          <p className="mt-3 text-sm font-semibold text-ink">{t("approvals.emptyTitle")}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-2">{t("approvals.emptyBody")}</p>
        </div>
      ) : (
        <ul className="relative mt-4 grid items-start gap-3 lg:grid-cols-2">
          <AnimatePresence initial={false} mode="popLayout">
            {pending.map((item) => (
              <PendingCard key={item.id} item={item} currency={currency} onDecide={decide} />
            ))}
          </AnimatePresence>
        </ul>
      )}

      <Guardrails items={guardrails} onToggle={toggle} />

      <section aria-label={t("approvals.history")} className="mt-8">
        <h3 className="text-base font-semibold tracking-tight text-ink">{t("approvals.history")}</h3>
        {decided.length === 0 ? (
          <p className="mt-2 text-sm text-ink-3">{t("approvals.historyEmpty")}</p>
        ) : (
          <ul className="surface mt-3 rounded-2xl px-4 py-1.5">
            {decided.map((item) => (
              <HistoryRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
