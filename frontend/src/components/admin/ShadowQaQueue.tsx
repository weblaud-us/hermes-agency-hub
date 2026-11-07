"use client";

import { AnimatePresence, motion } from "motion/react";
import { CircleCheck, CornerUpLeft, Flag, LoaderCircle, PencilLine, RotateCw, Send, Siren } from "lucide-react";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toaster";
import { SPRING } from "@/lib/motion";
import type { OpsClient, QaDecision, QaItem } from "@/lib/ops-api";
import type { ApprovalKind } from "@/lib/portal-api";
import { formatRelative } from "@/lib/portal-format";
import { ONBOARDING_STEPS } from "@/lib/provisioning";
import { cn } from "@/lib/utils";

type Filter = "all" | "review" | "fixes" | "escalated";

const KIND_LABEL: Record<ApprovalKind, string> = {
  social_post: "Social post",
  reel: "Reel",
  ad_boost: "Ad budget boost",
  partner_email: "Partner email",
  website_update: "Website update",
  courier_dispatch: "Courier dispatch",
  discount_offer: "Discount offer",
};

const STATUS_LABEL: Record<string, string> = {
  qa_review: "Needs review",
  qa_returned: "Returned by QA",
  changes_requested: "Owner asked for changes",
};

function matches(item: QaItem, filter: Filter): boolean {
  if (filter === "review") return item.status === "qa_review";
  if (filter === "fixes") return item.status === "qa_returned" || item.status === "changes_requested";
  if (filter === "escalated") return item.escalated;
  return true;
}

type Panel = "none" | "return" | "escalate" | "revise";

function QueueCard({ item, ops, onChanged }: { item: QaItem; ops: OpsClient; onChanged: () => void }) {
  const notify = useToast();
  const [panel, setPanel] = useState<Panel>("none");
  const [note, setNote] = useState("");
  const [title, setTitle] = useState(item.title);
  const [summary, setSummary] = useState(item.summary);
  const initialBody = typeof item.preview.body === "string" ? item.preview.body : null;
  const [body, setBody] = useState(initialBody ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = useId();

  async function run(action: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      notify(done);
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That did not save.");
      setBusy(false);
    }
  }

  function decide(decision: QaDecision, done: string) {
    return run(() => ops.qaDecide(item, decision, note.trim() || undefined), done);
  }

  function submitNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) {
      setError("Add a note for whoever picks this up.");
      return;
    }
    if (panel === "return") decide("return", `Returned: ${item.title}`);
    else decide("escalate", `Escalated: ${item.title}`);
  }

  function submitRevision(event: FormEvent) {
    event.preventDefault();
    if (title.trim().length < 2) {
      setError("Give it a title.");
      return;
    }
    run(
      () => ops.qaRevise(item, { title: title.trim(), summary: summary.trim(), body: initialBody === null ? null : body }),
      `Revised: ${title.trim()}`,
    );
  }

  const inReview = item.status === "qa_review";

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -14, transition: { duration: 0.14 } }}
      transition={SPRING}
      className={cn("surface rounded-2xl p-4", item.escalated && "border-halt/40")}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-ink">{item.companyName}</span>
        <span className="rounded-md border border-white/10 px-1.5 py-0.5 text-ink-2">
          Step {item.onboardingStage}: {ONBOARDING_STEPS[item.onboardingStage - 1]}
        </span>
        <span className="rounded-md bg-hyper/12 px-1.5 py-0.5 text-hyper-soft">{KIND_LABEL[item.kind]}</span>
        <span className="rounded-md border border-white/10 px-1.5 py-0.5 text-ink-2">{STATUS_LABEL[item.status] ?? item.status}</span>
        {item.escalated && (
          <span className="inline-flex items-center gap-1 rounded-md border border-halt/40 bg-halt/10 px-1.5 py-0.5 font-medium text-halt-soft">
            <Siren aria-hidden className="size-3" />
            Escalated
          </span>
        )}
        <span className="ml-auto text-ink-3">{formatRelative(item.createdAt)}</span>
      </div>

      <h3 className="mt-2.5 text-[15px] font-semibold text-ink">{item.title}</h3>
      {item.summary && <p className="mt-1 text-sm leading-relaxed text-ink-2">{item.summary}</p>}
      {initialBody && (
        <p className="mt-3 whitespace-pre-wrap wrap-break-word rounded-xl border border-white/7 bg-black/25 px-3 py-2.5 text-sm leading-relaxed text-ink">
          {initialBody}
        </p>
      )}
      {item.note && (
        <p className="mt-3 rounded-xl border border-warn/30 bg-warn/8 px-3 py-2 text-sm text-ink-2">
          <span className="font-medium text-warn">Note:</span> {item.note}
        </p>
      )}
      {item.sourceSkill && <p className="mt-2 font-mono text-[11px] text-ink-3">Drafted by {item.sourceSkill}</p>}

      {panel === "none" && (
        <div className="mt-3 flex flex-wrap gap-2">
          {inReview ? (
            <>
              <motion.button
                type="button"
                whileTap={{ scale: 0.97 }}
                transition={SPRING}
                disabled={busy}
                onClick={() => decide("forward", `Sent to the owner: ${item.title}`)}
                className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-signal px-3.5 text-sm font-semibold text-obsidian disabled:opacity-60"
              >
                {busy ? <LoaderCircle aria-hidden className="animate-spin-slow size-4" /> : <Send aria-hidden className="size-4" />}
                Forward to owner
              </motion.button>
              <button
                type="button"
                onClick={() => setPanel("return")}
                className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/12 px-3.5 text-sm font-medium text-ink hover:border-white/25"
              >
                <CornerUpLeft aria-hidden className="size-4" />
                Return with notes
              </button>
              <button
                type="button"
                onClick={() => setPanel("escalate")}
                className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-halt/30 px-3.5 text-sm font-medium text-halt-soft hover:border-halt/60"
              >
                <Flag aria-hidden className="size-4" />
                Escalate
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setPanel("revise")}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-signal px-3.5 text-sm font-semibold text-obsidian"
            >
              <PencilLine aria-hidden className="size-4" />
              Revise and resubmit
            </button>
          )}
        </div>
      )}

      {(panel === "return" || panel === "escalate") && (
        <form onSubmit={submitNote} className="mt-3">
          <label htmlFor={`${base}-note`} className="mb-1.5 block text-sm font-medium text-ink-2">
            {panel === "return" ? "What needs fixing?" : "Why does this need escalating?"}
          </label>
          <textarea id={`${base}-note`} autoFocus rows={2} value={note} onChange={(event) => setNote(event.target.value)} className="field" />
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className="inline-flex min-h-10 items-center rounded-xl bg-signal px-3.5 text-sm font-semibold text-obsidian disabled:opacity-60">
              {panel === "return" ? "Return" : "Escalate"}
            </button>
            <button type="button" onClick={() => setPanel("none")} className="inline-flex min-h-10 items-center rounded-xl border border-white/12 px-3.5 text-sm font-medium text-ink hover:border-white/25">
              Cancel
            </button>
          </div>
        </form>
      )}

      {panel === "revise" && (
        <form onSubmit={submitRevision} className="mt-3 space-y-3">
          <div>
            <label htmlFor={`${base}-title`} className="mb-1.5 block text-sm font-medium text-ink-2">Title</label>
            <input id={`${base}-title`} value={title} onChange={(event) => setTitle(event.target.value)} className="field" />
          </div>
          <div>
            <label htmlFor={`${base}-summary`} className="mb-1.5 block text-sm font-medium text-ink-2">Summary</label>
            <textarea id={`${base}-summary`} rows={2} value={summary} onChange={(event) => setSummary(event.target.value)} className="field" />
          </div>
          {initialBody !== null && (
            <div>
              <label htmlFor={`${base}-body`} className="mb-1.5 block text-sm font-medium text-ink-2">Draft text</label>
              <textarea id={`${base}-body`} rows={4} value={body} onChange={(event) => setBody(event.target.value)} className="field" />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className="inline-flex min-h-10 items-center rounded-xl bg-signal px-3.5 text-sm font-semibold text-obsidian disabled:opacity-60">
              Resubmit
            </button>
            <button type="button" onClick={() => setPanel("none")} className="inline-flex min-h-10 items-center rounded-xl border border-white/12 px-3.5 text-sm font-medium text-ink hover:border-white/25">
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-halt-soft">
          {error}
        </p>
      )}
    </motion.li>
  );
}

export function ShadowQaQueue({ ops }: { ops: OpsClient }) {
  const [items, setItems] = useState<QaItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    try {
      setItems(await ops.qaQueue());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load the queue.");
    }
  }, [ops]);

  useEffect(() => {
    let cancelled = false;
    ops.qaQueue().then(
      (next) => {
        if (!cancelled) {
          setItems(next);
          setError(null);
        }
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Could not load the queue.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ops]);

  const count = (value: Filter) => (items ?? []).filter((item) => matches(item, value)).length;
  const option = (value: Filter, label: string) => ({
    value,
    label: (
      <span className="flex items-center gap-1.5">
        {label}
        <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{count(value)}</span>
      </span>
    ),
  });
  const visible = (items ?? []).filter((item) => matches(item, filter));

  return (
    <section aria-label="Shadow-Week QA and escalation queue" className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-ink">Shadow-Week QA &amp; Escalation Queue</h2>
          <p className="mt-0.5 text-sm text-ink-2">AI drafts the team checks before they reach a business owner.</p>
        </div>
        <Segmented<Filter>
          label="Filter the queue"
          value={filter}
          onChange={setFilter}
          className="max-w-full flex-wrap rounded-2xl"
          options={[option("all", "All"), option("review", "Needs review"), option("fixes", "Needs fixes"), option("escalated", "Escalated")]}
        />
      </div>

      {error && !items && (
        <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
          <p>{error}</p>
          <button type="button" onClick={load} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70">
            <RotateCw aria-hidden className="size-3.5" />
            Try again
          </button>
        </div>
      )}

      {!items && !error && (
        <div aria-busy="true" aria-label="Loading the queue" className="mt-4 space-y-3">
          <div className="h-36 animate-pulse rounded-2xl bg-white/4" />
          <div className="h-36 animate-pulse rounded-2xl bg-white/4" />
        </div>
      )}

      {items && visible.length === 0 && (
        <div className="surface mt-4 rounded-2xl px-5 py-12 text-center">
          <CircleCheck aria-hidden className="mx-auto size-6 text-signal" />
          <p className="mt-3 text-sm font-semibold text-ink">{filter === "all" ? "The queue is clear" : "Nothing in this view"}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-2">
            New drafts land here until a client reaches Autonomous Live.
          </p>
        </div>
      )}

      {items && visible.length > 0 && (
        <ul className="relative mt-4 grid items-start gap-3 xl:grid-cols-2">
          <AnimatePresence initial={false} mode="popLayout">
            {visible.map((item) => (
              <QueueCard key={item.id} item={item} ops={ops} onChanged={load} />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
