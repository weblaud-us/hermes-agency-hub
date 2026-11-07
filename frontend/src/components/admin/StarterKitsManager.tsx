"use client";

import { Building2, FileText, PackageCheck, RotateCcw, ShoppingBag, X } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Markdown } from "@/components/portal/Markdown";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toaster";
import { PERMISSIONS } from "@/lib/auth";
import type { LibrarySkill, OpsClient, StarterKit } from "@/lib/ops-api";
import { cn } from "@/lib/utils";

const GROUPS: { key: LibrarySkill["group"]; title: string; body: string }[] = [
  { key: "router", title: "Router", body: "Decides which specialist acts, and in which guardrail lane." },
  { key: "core", title: "Core specialists", body: "Available to every business model." },
  { key: "ecommerce", title: "E-commerce exclusive", body: "Only ever enabled for e-commerce clients." },
];

function KitCard({
  kit,
  library,
  canEdit,
  onSave,
  onReset,
}: {
  kit: StarterKit;
  library: LibrarySkill[];
  canEdit: boolean;
  onSave: (kit: StarterKit, changes: { description: string; skills: string[]; knowledgeChecklist: string[] }) => Promise<void>;
  onReset: (kit: StarterKit) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(kit.description);
  const [skills, setSkills] = useState(kit.skills);
  const [checklist, setChecklist] = useState(kit.knowledgeChecklist.join("\n"));
  const base = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSave(kit, {
      description: description.trim(),
      skills,
      knowledgeChecklist: checklist.split("\n").map((line) => line.trim()).filter(Boolean),
    });
    setEditing(false);
  }

  const ecommerce = kit.businessMode === "ecommerce";

  return (
    <section aria-label={kit.name} className="surface rounded-2xl p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">{kit.name}</h3>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium",
            ecommerce ? "border-gold/35 bg-gold/8 text-gold" : "border-hyper/35 bg-hyper/8 text-hyper-soft",
          )}
        >
          {ecommerce ? <ShoppingBag aria-hidden className="size-3" /> : <Building2 aria-hidden className="size-3" />}
          {ecommerce ? "E-Commerce" : "General"}
        </span>
        {kit.customised && <span className="rounded-md border border-white/12 px-1.5 py-0.5 text-[10.5px] text-ink-2">Edited</span>}
      </div>

      {editing ? (
        <form onSubmit={submit} className="mt-3 space-y-3">
          <div>
            <label htmlFor={`${base}-description`} className="mb-1 block text-xs text-ink-2">Description</label>
            <textarea id={`${base}-description`} rows={2} value={description} onChange={(event) => setDescription(event.target.value)} className="field" />
          </div>
          <fieldset>
            <legend className="mb-1 text-xs text-ink-2">Skills</legend>
            <div className="flex flex-wrap gap-1.5">
              {library.map((skill) => {
                const checked = skills.includes(skill.id);
                return (
                  <label
                    key={skill.id}
                    className={cn(
                      "inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border px-2 text-xs transition-colors",
                      checked ? "border-hyper/50 bg-hyper/8 text-ink" : "border-white/10 text-ink-2 hover:border-white/20",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => setSkills(event.target.checked ? [...skills, skill.id] : skills.filter((id) => id !== skill.id))}
                      className="size-3.5 accent-[var(--color-hyper)]"
                    />
                    {skill.id}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div>
            <label htmlFor={`${base}-checklist`} className="mb-1 block text-xs text-ink-2">Knowledge checklist, one per line</label>
            <textarea id={`${base}-checklist`} rows={4} value={checklist} onChange={(event) => setChecklist(event.target.value)} className="field" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="inline-flex min-h-10 items-center rounded-xl bg-signal px-3.5 text-sm font-semibold text-obsidian">Save kit</button>
            <button type="button" onClick={() => setEditing(false)} className="inline-flex min-h-10 items-center rounded-xl border border-white/12 px-3.5 text-sm font-medium text-ink hover:border-white/25">Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">{kit.description}</p>
          <p className="mt-3 text-xs font-medium text-ink-3">Skills</p>
          <p className="mt-1 font-mono text-[11px] leading-relaxed text-ink-2">{kit.skills.join(", ")}</p>
          <p className="mt-3 text-xs font-medium text-ink-3">Collect during onboarding</p>
          <ul className="mt-1 space-y-0.5 text-sm text-ink-2">
            {kit.knowledgeChecklist.map((line) => (
              <li key={line} className="flex items-start gap-2">
                <PackageCheck aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                {line}
              </li>
            ))}
          </ul>
          {canEdit && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => setEditing(true)} className="inline-flex min-h-10 items-center rounded-lg border border-white/12 px-3 text-xs font-medium text-ink hover:border-white/25">
                Edit kit
              </button>
              {kit.customised && (
                <button type="button" onClick={() => onReset(kit)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/12 px-3 text-xs font-medium text-ink-2 hover:border-white/25">
                  <RotateCcw aria-hidden className="size-3.5" />
                  Restore defaults
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function StarterKitsManager({ ops, permissions }: { ops: OpsClient; permissions: string[] }) {
  const notify = useToast();
  const [kits, setKits] = useState<StarterKit[] | null>(null);
  const [library, setLibrary] = useState<LibrarySkill[]>([]);
  const [inspecting, setInspecting] = useState<LibrarySkill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = permissions.includes(PERMISSIONS.kitsWrite);

  useEffect(() => {
    let cancelled = false;
    Promise.all([ops.kits(), ops.skills()]).then(
      ([nextKits, nextSkills]) => {
        if (cancelled) return;
        setKits(nextKits);
        setLibrary(nextSkills);
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Could not load the kits.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ops]);

  async function save(kit: StarterKit, changes: { description: string; skills: string[]; knowledgeChecklist: string[] }) {
    try {
      setKits(await ops.updateKit(kit.key, changes));
      notify(`${kit.name} updated. New clients on this kit get these changes.`);
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : "That did not save.", "error");
    }
  }

  async function reset(kit: StarterKit) {
    try {
      setKits(await ops.resetKit(kit.key));
      notify(`${kit.name} restored to its defaults.`, "info");
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : "That did not save.", "error");
    }
  }

  if (error) return <p role="alert" className="mt-4 text-sm text-halt-soft">{error}</p>;
  if (!kits) return <div aria-busy="true" aria-label="Loading the kits" className="mt-4 h-72 animate-pulse rounded-2xl bg-white/4" />;

  return (
    <section aria-label="Starter kits and agent skills" className="mt-4">
      <h2 className="text-lg font-semibold tracking-tight text-ink">Starter Kits</h2>
      <p className="mt-0.5 text-sm text-ink-2">Reusable setups for each industry. Choosing one in provisioning preselects its mode and skills.</p>
      <div className="mt-3 grid items-start gap-3 lg:grid-cols-2">
        {kits.map((kit) => (
          <KitCard key={kit.key} kit={kit} library={library} canEdit={canEdit} onSave={save} onReset={reset} />
        ))}
      </div>

      <h2 className="mt-8 text-lg font-semibold tracking-tight text-ink">Agent Skills</h2>
      <p className="mt-0.5 text-sm text-ink-2">The library every tenant draws from. Open one to read its SKILL.md.</p>
      <div className="mt-3 space-y-4">
        {[...GROUPS, ...(library.some((skill) => skill.group === "core") ? [] : [])].map((group) => {
          const rows = library.filter((skill) => skill.group === group.key);
          if (rows.length === 0) return null;
          return (
            <section key={group.key} aria-label={group.title}>
              <h3 className="text-sm font-semibold text-ink">{group.title}</h3>
              <p className="text-xs text-ink-3">{group.body}</p>
              <ul className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {rows.map((skill) => (
                  <li key={skill.id}>
                    <button
                      type="button"
                      onClick={() => setInspecting(skill)}
                      className="h-full w-full rounded-xl border border-white/8 bg-white/3 p-3 text-left transition-colors hover:border-white/20"
                    >
                      <span className="flex items-center gap-2 font-mono text-xs font-medium text-ink">
                        <FileText aria-hidden className="size-3.5 shrink-0 text-ink-3" />
                        {skill.id}
                      </span>
                      <span className="mt-1.5 line-clamp-3 block text-xs leading-relaxed text-ink-3">{skill.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <Dialog open={inspecting !== null} onClose={() => setInspecting(null)} title={inspecting?.id ?? "Skill"} placement="right">
        {inspecting && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-4">
              <h2 className="truncate font-mono text-sm font-semibold text-ink">{inspecting.id}/SKILL.md</h2>
              <button type="button" onClick={() => setInspecting(null)} aria-label="Close" className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-white/6 hover:text-ink">
                <X aria-hidden className="size-4" />
              </button>
            </div>
            <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <Markdown source={inspecting.markdown.replace(/^---[\s\S]*?---\s*/, "")} />
            </div>
          </div>
        )}
      </Dialog>
    </section>
  );
}
