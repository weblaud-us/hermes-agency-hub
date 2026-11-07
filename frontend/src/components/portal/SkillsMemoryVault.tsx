"use client";

import { AnimatePresence, motion } from "motion/react";
import { BookOpenCheck, Check, Lock, Pencil, Plus, RotateCw, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { Markdown } from "@/components/portal/Markdown";
import { Dialog } from "@/components/ui/Dialog";
import { Meter } from "@/components/ui/Meter";
import { Segmented } from "@/components/ui/Segmented";
import { SpotlightCard } from "@/components/ui/SpotlightCard";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toaster";
import type { BusinessMemory, LearnedSkill, MemoryFact, PortalClient, SkillsAndMemory } from "@/lib/portal-api";
import { useI18n } from "@/lib/i18n";
import { riseIn, SPRING, staggerContainer } from "@/lib/motion";
import { cn } from "@/lib/utils";

type VaultTab = "skills" | "memory";

// ----------------------------------------------------------------------- skills
function SkillDrawerBody({
  skill,
  onToggle,
  onClose,
}: {
  skill: LearnedSkill;
  onToggle: (enabled: boolean) => void;
  onClose: () => void;
}) {
  const { t, number, relative } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-white/7 px-5 py-4">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-wider text-hyper-soft">{skill.category}</p>
          <h2 className="mt-1 text-base font-semibold leading-snug text-ink">{skill.title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("vault.closeSkill")}
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-white/6 hover:text-ink"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      <div className="flex items-center justify-between gap-3 border-b border-white/7 px-5 py-3">
        <p className="font-mono text-xs tabular-nums text-ink-3">
          {t("vault.used", { count: number(skill.useCount), when: relative(skill.lastUsed) })}
        </p>
        <label className="inline-flex items-center gap-2 text-xs text-ink-2">
          {skill.enabled ? t("vault.on") : t("vault.off")}
          <Switch checked={skill.enabled} onChange={onToggle} label={t("vault.skillEnabled", { skill: skill.title })} />
        </label>
      </div>

      <div className="thin-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {skill.description && <p className="text-sm leading-relaxed text-ink-2">{skill.description}</p>}
        <section>
          <h3 className="text-xs font-medium text-ink-3">{t("vault.whenRuns")}</h3>
          <div className="mt-2 rounded-xl border border-hyper/25 bg-hyper/8 p-3">
            <Markdown source={skill.triggerConditions || t("vault.triggerDefault")} />
          </div>
        </section>
        <section>
          <h3 className="text-xs font-medium text-ink-3">{t("vault.sop")}</h3>
          <div className="mt-2 rounded-xl border border-white/7 bg-black/25 p-4">
            <Markdown source={skill.workflowMarkdown} className="font-mono text-[13px]" />
          </div>
        </section>
      </div>
    </div>
  );
}

function SkillsLibrary({
  data,
  onToggle,
  onInspect,
}: {
  data: SkillsAndMemory;
  onToggle: (skill: LearnedSkill, enabled: boolean) => void;
  onInspect: (skill: LearnedSkill) => void;
}) {
  const { t, number, relative } = useI18n();
  return (
    <div className="space-y-6">
      <section aria-labelledby="agency-core-heading">
        <h3 id="agency-core-heading" className="flex items-center gap-2 text-sm font-semibold text-ink">
          <ShieldCheck aria-hidden className="size-4 text-gold" />
          {t("vault.coreTitle")}
        </h3>
        <p className="mt-1 text-xs text-ink-3">{t("vault.coreBody")}</p>
        <motion.ul
          variants={staggerContainer}
          initial="hidden"
          animate="show"
          className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        >
          {data.agencySkills.map((skill) => (
            <motion.li key={skill.id} variants={riseIn}>
              <SpotlightCard className="h-full rounded-2xl p-4" glow="245 210 122">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex min-h-6 items-center gap-1 rounded-full border border-gold/30 bg-gold/10 px-2 font-mono text-[11px] text-gold">
                    <Lock aria-hidden className="size-3" />
                    {t("vault.verified")}
                  </span>
                  <span className="font-mono text-[11px] text-signal">{skill.active ? t("vault.active") : t("vault.paused")}</span>
                </div>
                <h4 className="mt-3 text-sm font-semibold leading-snug text-ink">{skill.title}</h4>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{skill.description}</p>
                <p className="mt-3 font-mono text-[11px] text-hyper-soft">{skill.category}</p>
              </SpotlightCard>
            </motion.li>
          ))}
        </motion.ul>
        {data.agencySkills.length === 0 && <p className="mt-3 text-sm text-ink-3">{t("vault.coreEmpty")}</p>}
      </section>

      <section aria-labelledby="learned-heading">
        <h3 id="learned-heading" className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Sparkles aria-hidden className="size-4 text-signal" />
          {t("vault.learnedTitle")}
        </h3>
        <p className="mt-1 text-xs text-ink-3">{t("vault.learnedBody")}</p>
        {data.learnedSkills.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-white/7 bg-white/2 p-6 text-center text-sm text-ink-2">
            {t("vault.learnedEmpty")}
          </div>
        ) : (
          <ul className="mt-3 grid gap-3 md:grid-cols-2">
            {data.learnedSkills.map((skill) => (
              <li key={skill.id}>
                <SpotlightCard className={cn("h-full rounded-2xl p-4 transition-opacity", !skill.enabled && "opacity-70")}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold leading-snug text-ink">{skill.title}</h4>
                      <p className="mt-0.5 font-mono text-[11px] text-hyper-soft">{skill.category}</p>
                    </div>
                    <Switch
                      checked={skill.enabled}
                      onChange={(enabled) => onToggle(skill, enabled)}
                      label={t("vault.skillEnabled", { skill: skill.title })}
                    />
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-ink-2">{skill.description}</p>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <p className="font-mono text-[11px] tabular-nums text-ink-3">
                      {t("vault.uses", { count: number(skill.useCount), when: relative(skill.lastUsed) })}
                    </p>
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.96 }}
                      transition={SPRING}
                      onClick={() => onInspect(skill)}
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/12 px-3 text-xs font-medium text-ink transition-colors hover:border-white/25"
                    >
                      <BookOpenCheck aria-hidden className="size-3.5" />
                      {t("vault.viewSop")}
                    </motion.button>
                  </div>
                </SpotlightCard>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ----------------------------------------------------------------------- memory
function FactCard({
  ref,
  fact,
  pending,
  onReplace,
  onRemove,
}: {
  /** AnimatePresence's popLayout measures an exiting child through this. */
  ref?: React.Ref<HTMLLIElement>;
  fact: MemoryFact;
  pending: boolean;
  onReplace: (text: string) => Promise<string | null>;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(fact.text);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fieldId = useId();
  const errorId = useId();

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (!next || saving) return;
    if (next === fact.text) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    const message = await onReplace(next);
    setSaving(false);
    if (message) setError(message);
    else setEditing(false);
  }

  return (
    <motion.li
      ref={ref}
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: pending ? 0.6 : 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.14 } }}
      transition={SPRING}
      className="rounded-2xl border border-white/7 bg-white/2 p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-hyper-soft">{pending ? t("vault.saving") : fact.category}</span>
        {!editing && !pending && (
          <div className="-my-1 -mr-1 flex items-center">
            {confirming ? (
              <>
                <button
                  type="button"
                  onClick={onRemove}
                  className="inline-flex min-h-9 items-center rounded-lg px-2.5 text-xs font-medium text-halt-soft hover:bg-halt/12"
                >
                  {t("vault.remove")}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="inline-flex min-h-9 items-center rounded-lg px-2.5 text-xs text-ink-2 hover:bg-white/6"
                >
                  {t("vault.keep")}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(fact.text);
                    setError(null);
                    setEditing(true);
                  }}
                  aria-label={t("vault.editItem", { text: fact.text })}
                  className="inline-flex size-9 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-white/6 hover:text-ink"
                >
                  <Pencil aria-hidden className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  aria-label={t("vault.removeItem", { text: fact.text })}
                  className="inline-flex size-9 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-halt/12 hover:text-halt-soft"
                >
                  <Trash2 aria-hidden className="size-3.5" />
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <form onSubmit={save} className="mt-2">
          <label htmlFor={fieldId} className="sr-only">
            {t("vault.editRule")}
          </label>
          <textarea
            id={fieldId}
            rows={3}
            value={draft}
            autoFocus
            maxLength={400}
            onChange={(event) => setDraft(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            className="field thin-scroll resize-none"
          />
          {error && (
            <p id={errorId} role="alert" className="mt-2 text-xs text-halt-soft">
              {error}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="inline-flex min-h-10 items-center rounded-lg px-3 text-xs text-ink-2 hover:bg-white/6"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={saving || !draft.trim()}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-signal px-3 text-xs font-semibold text-obsidian disabled:opacity-50"
            >
              <Check aria-hidden className="size-3.5" />
              {saving ? t("vault.saving") : t("common.save")}
            </button>
          </div>
        </form>
      ) : (
        <p className="mt-2 text-sm leading-relaxed text-ink">{fact.text}</p>
      )}
    </motion.li>
  );
}

function MemoryEditor({
  memory,
  pendingIds,
  onAdd,
  onReplace,
  onRemove,
}: {
  memory: BusinessMemory;
  pendingIds: Set<string>;
  onAdd: (text: string) => Promise<string | null>;
  onReplace: (id: string, text: string) => Promise<string | null>;
  onRemove: (id: string) => void;
}) {
  const { t, number } = useI18n();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const errorId = useId();
  const helpId = useId();

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setDraft("");
    const message = await onAdd(text);
    setBusy(false);
    if (message) {
      // Rejected: hand the text back so nothing the owner typed is lost.
      setDraft(text);
      setError(message);
    }
  }

  return (
    <div className="space-y-4">
      <SpotlightCard className="rounded-2xl p-4 sm:p-5">
        <form onSubmit={add}>
          <label htmlFor={inputId} className="text-sm font-semibold text-ink">
            {t("vault.addRuleTitle")}
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              id={inputId}
              value={draft}
              maxLength={400}
              placeholder={t("vault.rulePlaceholder")}
              onChange={(event) => setDraft(event.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? `${errorId} ${helpId}` : helpId}
              className="field min-w-0 flex-1"
            />
            <motion.button
              type="submit"
              whileTap={{ scale: 0.97 }}
              transition={SPRING}
              disabled={!draft.trim() || busy}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus aria-hidden className="size-4" />
              {t("vault.addRule")}
            </motion.button>
          </div>
          {error && (
            <p id={errorId} role="alert" className="mt-2 text-sm text-halt-soft">
              {error}
            </p>
          )}
          <p id={helpId} className="mt-2 text-xs leading-relaxed text-ink-3">
            {t("vault.ruleHelp")}
          </p>
        </form>
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between gap-3 font-mono text-[11px] tabular-nums text-ink-3">
            <span>{t("vault.capacity")}</span>
            <span>
              {t("vault.characters", { used: number(memory.usedChars), limit: number(memory.limitChars) })}
            </span>
          </div>
          <Meter
            value={memory.usedChars}
            max={memory.limitChars}
            label={t("vault.capacity")}
            valueText={t("vault.charactersUsed", { used: number(memory.usedChars), limit: number(memory.limitChars) })}
          />
        </div>
      </SpotlightCard>

      {memory.facts.length === 0 ? (
        <div className="rounded-2xl border border-white/7 bg-white/2 p-6 text-center text-sm text-ink-2">
          {t("vault.memoryEmpty")}
        </div>
      ) : (
        <ul className="relative grid gap-3 md:grid-cols-2">
          <AnimatePresence mode="popLayout" initial={false}>
            {memory.facts.map((fact) => (
              <FactCard
                key={fact.id}
                fact={fact}
                pending={pendingIds.has(fact.id)}
                onReplace={(text) => onReplace(fact.id, text)}
                onRemove={() => onRemove(fact.id)}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------- vault
export function SkillsMemoryVault({ client, onChanged }: { client: PortalClient; onChanged: () => void }) {
  const { t } = useI18n();
  const notify = useToast();
  const [tab, setTab] = useState<VaultTab>("skills");
  const [data, setData] = useState<SkillsAndMemory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setData(await client.skillsAndMemory());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("vault.loadError"));
    }
  }, [client, t]);

  useEffect(() => {
    let cancelled = false;
    client
      .skillsAndMemory()
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : t("vault.loadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [client, t]);

  function setFacts(update: (memory: BusinessMemory) => BusinessMemory) {
    setData((current) => (current ? { ...current, memory: update(current.memory) } : current));
  }

  function setPending(id: string, on: boolean) {
    setPendingIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function toggleSkill(skill: LearnedSkill, enabled: boolean) {
    const apply = (value: boolean) =>
      setData((current) =>
        current
          ? {
              ...current,
              learnedSkills: current.learnedSkills.map((item) =>
                item.id === skill.id ? { ...item, enabled: value } : item,
              ),
            }
          : current,
      );
    apply(enabled);
    try {
      await client.toggleSkill(skill.id, enabled);
      notify(enabled ? t("vault.isOn", { skill: skill.title }) : t("vault.isOff", { skill: skill.title }));
      onChanged();
    } catch (failure) {
      apply(!enabled);
      notify(failure instanceof Error ? failure.message : t("ch.saveFailed"), "error");
    }
  }

  async function addRule(text: string): Promise<string | null> {
    const pendingId = `pending-${crypto.randomUUID()}`;
    const previous = data?.memory ?? null;
    setPending(pendingId, true);
    setFacts((memory) => ({ ...memory, facts: [...memory.facts, { id: pendingId, text, category: "New" }] }));
    try {
      const next = await client.patchMemory({ op: "append", text });
      setFacts(() => next);
      return null;
    } catch (failure) {
      if (previous) setFacts(() => previous);
      return failure instanceof Error ? failure.message : t("vault.ruleFailed");
    } finally {
      setPending(pendingId, false);
    }
  }

  async function replaceRule(id: string, text: string): Promise<string | null> {
    try {
      const next = await client.patchMemory({ op: "replace", id, text });
      setFacts(() => next);
      return null;
    } catch (failure) {
      return failure instanceof Error ? failure.message : t("ch.saveFailed");
    }
  }

  async function removeRule(id: string) {
    const previous = data?.memory ?? null;
    setFacts((memory) => ({ ...memory, facts: memory.facts.filter((fact) => fact.id !== id) }));
    try {
      const next = await client.patchMemory({ op: "remove", id });
      setFacts(() => next);
    } catch (failure) {
      if (previous) setFacts(() => previous);
      notify(failure instanceof Error ? failure.message : t("vault.removeFailed"), "error");
    }
  }

  if (!data) {
    if (error) {
      return (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
          <p>{error}</p>
          <button
            type="button"
            onClick={load}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70"
          >
            <RotateCw aria-hidden className="size-3.5" />
            {t("common.retry")}
          </button>
        </div>
      );
    }
    return <div aria-busy="true" aria-label={t("common.loading")} className="h-96 animate-pulse rounded-3xl bg-white/3" />;
  }

  const inspected = data.learnedSkills.find((skill) => skill.id === inspecting) ?? null;

  return (
    <div>
      <Segmented
        options={[
          {
            value: "skills" as const,
            label: (
              <span className="whitespace-nowrap">
                <span className="hidden sm:inline">{t("vault.skillsTabPrefix")}</span>
                {t("vault.skillsTab")}
              </span>
            ),
          },
          {
            value: "memory" as const,
            label: (
              <span className="whitespace-nowrap">
                <span className="hidden sm:inline">{t("vault.memoryTabPrefix")}</span>
                {t("vault.memoryTab")}
              </span>
            ),
          },
        ]}
        value={tab}
        onChange={setTab}
        label={t("vault.sections")}
        optionClassName="px-3 sm:px-4"
      />
      <div className="mt-4">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            role="tabpanel"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={SPRING}
          >
            {tab === "skills" ? (
              <SkillsLibrary data={data} onToggle={toggleSkill} onInspect={(skill) => setInspecting(skill.id)} />
            ) : (
              <MemoryEditor
                memory={data.memory}
                pendingIds={pendingIds}
                onAdd={addRule}
                onReplace={replaceRule}
                onRemove={removeRule}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <Dialog open={inspected !== null} onClose={() => setInspecting(null)} title={t("vault.skillDetails")} placement="right">
        {inspected && (
          <SkillDrawerBody
            key={inspected.id}
            skill={inspected}
            onToggle={(enabled) => void toggleSkill(inspected, enabled)}
            onClose={() => setInspecting(null)}
          />
        )}
      </Dialog>
    </div>
  );
}
