"use client";

import { AnimatePresence, motion } from "motion/react";
import { ExternalLink, FilePlus2, Minus, Plus, RotateCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Meter } from "@/components/ui/Meter";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toaster";
import { PERMISSIONS } from "@/lib/auth";
import type { BaselineMetrics } from "@/lib/hub-types";
import { SPRING } from "@/lib/motion";
import {
  agencyToday,
  SCORE_SIGNALS,
  type AuditProgress,
  type OnboardingDraft,
  type OpsClient,
  type Pipeline,
  type Prospect,
  type ProspectChanges,
  type ProspectStage,
  type ScoreSignal,
  type StandupDay,
} from "@/lib/ops-api";
import { NICHE_OPTIONS, type BusinessMode, type NicheTemplate, type PackageTier, type RegionPreset } from "@/lib/provisioning";
import { cn } from "@/lib/utils";

type View = "pipeline" | "audits" | "standup";

const STAGES: { value: ProspectStage; label: string }[] = [
  { value: "new", label: "New" },
  { value: "qualified", label: "Qualified" },
  { value: "contacted", label: "Contacted" },
  { value: "video_audit_sent", label: "Video Audit Sent" },
  { value: "meeting", label: "Meeting" },
  { value: "proposal", label: "Proposal" },
  { value: "won", label: "Won" },
];

const SIGNAL_LABELS: Record<ScoreSignal, string> = {
  noWebsite: "No website",
  irregularSocial: "Irregular social",
  slowReply: "Slow reply",
  repeatHighValueSales: "Repeat high-value sales",
  accessibleOwner: "Accessible owner",
};

const AUDIT_LABELS: Record<AuditProgress, string> = {
  not_started: "Not started",
  recording: "Recording",
  sent: "Sent",
  viewed: "Viewed",
};

const TEAM = [
  { key: "sakib", name: "Sakib" },
  { key: "jubayed", name: "Jubayed" },
  { key: "ishtiaq", name: "Ishtiaq" },
];

/** Dots plus the number, so the score is readable without relying on colour. */
function ScoreBadge({ score }: { score: number }) {
  return (
    <span className="inline-flex items-center gap-1.5" role="img" aria-label={`Priority ${score} of 5`}>
      <span aria-hidden className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((dot) => (
          <span key={dot} className={cn("size-1.5 rounded-full", dot <= score ? (score >= 4 ? "bg-signal" : "bg-hyper-soft") : "bg-white/12")} />
        ))}
      </span>
      <span aria-hidden className="font-mono text-[11px] font-semibold tabular-nums text-ink-2">{score}/5</span>
    </span>
  );
}

// ------------------------------------------------------------------------ board
function ProspectCard({ prospect, onOpen }: { prospect: Prospect; onOpen: (prospect: Prospect) => void }) {
  return (
    <motion.li layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.12 } }} transition={SPRING}>
      <button
        type="button"
        onClick={() => onOpen(prospect)}
        className="w-full rounded-xl border border-white/8 bg-white/3 p-3 text-left transition-colors hover:border-white/20"
      >
        <span className="block text-sm font-medium text-ink">{prospect.businessName}</span>
        <span className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          <ScoreBadge score={prospect.priorityScore} />
          {prospect.assignee && <span className="text-[11px] capitalize text-ink-3">{prospect.assignee}</span>}
        </span>
        {prospect.draft && <span className="mt-1.5 block text-[11px] font-medium text-signal">Onboarding draft ready</span>}
      </button>
    </motion.li>
  );
}

function PipelineBoard({ pipeline, onOpen }: { pipeline: Pipeline; onOpen: (prospect: Prospect) => void }) {
  return (
    <div className="thin-scroll mt-4 overflow-x-auto pb-2">
      <div className="grid min-w-[72rem] grid-cols-7 items-start gap-2">
        {STAGES.map((stage) => {
          const rows = pipeline.items.filter((row) => row.stage === stage.value);
          return (
            <section key={stage.value} aria-label={stage.label} className="surface rounded-2xl p-2.5">
              <h3 className="flex items-center justify-between px-1 text-xs font-semibold text-ink-2">
                {stage.label}
                <span className="font-mono tabular-nums text-ink-3">{rows.length}</span>
              </h3>
              <ul className="relative mt-2 space-y-2">
                <AnimatePresence initial={false} mode="popLayout">
                  {rows.map((row) => (
                    <ProspectCard key={row.id} prospect={row} onOpen={onOpen} />
                  ))}
                </AnimatePresence>
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- audit tracker
function AuditTracker({ pipeline, onChange, onOpen }: { pipeline: Pipeline; onChange: (prospect: Prospect, changes: ProspectChanges) => void; onOpen: (prospect: Prospect) => void }) {
  if (pipeline.items.length === 0) {
    return <p className="surface mt-4 rounded-2xl px-5 py-10 text-center text-sm text-ink-2">Add a prospect to start tracking audits.</p>;
  }
  return (
    <div className="surface mt-4 overflow-hidden rounded-2xl">
      <div className="thin-scroll overflow-x-auto">
        <table className="w-full min-w-[42rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-3">
              <th scope="col" className="px-4 py-2.5 font-medium">Prospect</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Priority</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Pipeline stage</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Audit</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Link</th>
            </tr>
          </thead>
          <tbody>
            {pipeline.items.map((row) => (
              <tr key={row.id} className="border-t border-white/6">
                <th scope="row" className="px-4 py-2 text-left font-normal">
                  <button type="button" onClick={() => onOpen(row)} className="min-h-9 text-left font-medium text-ink hover:underline">
                    {row.businessName}
                  </button>
                </th>
                <td className="px-4 py-2"><ScoreBadge score={row.priorityScore} /></td>
                <td className="px-4 py-2 text-ink-2">{STAGES.find((stage) => stage.value === row.stage)?.label}</td>
                <td className="px-4 py-2">
                  <select
                    aria-label={`Audit progress for ${row.businessName}`}
                    value={row.auditProgress}
                    onChange={(event) => onChange(row, { auditProgress: event.target.value as AuditProgress })}
                    className="field min-h-9 w-auto py-1 text-xs"
                  >
                    {(Object.keys(AUDIT_LABELS) as AuditProgress[]).map((value) => (
                      <option key={value} value={value} className="bg-[#101016]">{AUDIT_LABELS[value]}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2">
                  {row.auditUrl ? (
                    <a href={row.auditUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1 text-xs text-ink-2 hover:text-signal">
                      Open <ExternalLink aria-hidden className="size-3" />
                    </a>
                  ) : (
                    <span className="text-xs text-ink-3">None</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- stand-up
function StandupTracker({ ops }: { ops: OpsClient }) {
  const notify = useToast();
  const [day, setDay] = useState<StandupDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(agencyToday);

  useEffect(() => {
    let cancelled = false;
    ops.standup(date).then(
      (next) => {
        if (!cancelled) {
          setDay(next);
          setError(null);
        }
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Could not load the stand-up.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ops, date]);

  async function change(member: string, metric: string, done: number) {
    if (!day) return;
    const before = day;
    setDay({
      ...day,
      members: day.members.map((row) =>
        row.key !== member
          ? row
          : { ...row, metrics: row.metrics.map((item) => (item.key === metric ? { ...item, done } : item)) },
      ),
    });
    try {
      setDay(await ops.setStandup(date, member, metric, done));
    } catch (failure) {
      setDay(before);
      notify(failure instanceof Error ? failure.message : "That did not save.", "error");
    }
  }

  if (error && !day) return <p role="alert" className="mt-4 text-sm text-halt-soft">{error}</p>;
  if (!day) return <div aria-busy="true" aria-label="Loading the stand-up" className="mt-4 h-56 animate-pulse rounded-2xl bg-white/4" />;

  return (
    <div className="mt-4">
      <label className="inline-flex items-center gap-2 text-xs text-ink-3">
        Day
        <input type="date" value={date} onChange={(event) => event.target.value && setDate(event.target.value)} className="field min-h-10 w-auto py-1.5 text-xs [color-scheme:dark]" />
      </label>
      <div className="mt-3 grid items-start gap-3 lg:grid-cols-3">
        {day.members.map((member) => (
          <section key={member.key} aria-label={member.name} className="surface rounded-2xl p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink">{member.name}</h3>
              <span className="font-mono text-sm font-semibold tabular-nums text-ink">{member.completionPercent}%</span>
            </div>
            <p className="text-xs text-ink-3">{member.focus}</p>
            <Meter
              value={member.completionPercent}
              max={100}
              label={`${member.name}'s daily completion`}
              valueText={`${member.completionPercent} percent`}
              className="mt-2.5 h-1.5"
            />
            <ul className="mt-3 space-y-2">
              {member.metrics.map((metric) => (
                <li key={metric.key} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 text-sm text-ink-2">{metric.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Remove one from ${metric.label}`}
                      onClick={() => change(member.key, metric.key, Math.max(0, metric.done - 1))}
                      className="inline-flex size-9 items-center justify-center rounded-lg border border-white/10 text-ink-2 hover:border-white/25"
                    >
                      <Minus aria-hidden className="size-3.5" />
                    </button>
                    <span className="w-14 text-center font-mono text-sm tabular-nums text-ink">
                      {metric.done}<span className="text-ink-3">/{metric.target}</span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Add one to ${metric.label}`}
                      onClick={() => change(member.key, metric.key, metric.done + 1)}
                      className="inline-flex size-9 items-center justify-center rounded-lg border border-white/10 text-ink-2 hover:border-white/25"
                    >
                      <Plus aria-hidden className="size-3.5" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------- drawer
function emptyDraft(prospect: Prospect): OnboardingDraft {
  const option = NICHE_OPTIONS.find((row) => row.value === prospect.niche);
  return {
    companyName: prospect.businessName,
    contactEmail: prospect.email,
    businessMode: option?.mode ?? "general",
    nicheTemplate: option?.value ?? "custom",
    packageTier: "presence",
    region: "bd",
    currency: null,
    baseline: null,
    notes: "",
  };
}

function DraftForm({ prospect, ops, onSaved }: { prospect: Prospect; ops: OpsClient; onSaved: (next: Prospect) => void }) {
  const notify = useToast();
  const [draft, setDraft] = useState<OnboardingDraft>(() => prospect.draft ?? emptyDraft(prospect));
  const [baseline, setBaseline] = useState(() => ({
    inquiries: prospect.draft?.baseline ? String(prospect.draft.baseline.monthlyInquiries) : "",
    conversion: prospect.draft?.baseline ? String(prospect.draft.baseline.conversionRate) : "",
    value: prospect.draft?.baseline ? String(prospect.draft.baseline.avgOrderOrProfitValue) : "",
    retainer: prospect.draft?.baseline ? String(prospect.draft.baseline.monthlyRetainerInvestment) : "",
  }));
  const [error, setError] = useState<string | null>(null);
  const base = useId();

  async function save(event: FormEvent) {
    event.preventDefault();
    const raw = [baseline.inquiries, baseline.conversion, baseline.value, baseline.retainer];
    let metrics: BaselineMetrics | null = null;
    if (raw.some((value) => value.trim())) {
      const numbers = raw.map(Number);
      if (raw.some((value) => !value.trim()) || numbers.some((value) => !Number.isFinite(value) || value < 0) || numbers[1] > 100) {
        setError("Fill in all four baseline figures with valid numbers, or leave them all blank.");
        return;
      }
      metrics = {
        monthlyInquiries: Math.round(numbers[0]),
        conversionRate: numbers[1],
        avgOrderOrProfitValue: numbers[2],
        monthlyRetainerInvestment: numbers[3],
      };
    }
    setError(null);
    try {
      const next = await ops.saveDraft(prospect.id, { ...draft, baseline: metrics });
      onSaved(next);
      notify("Onboarding draft saved. An admin can now provision from it.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That did not save.");
    }
  }

  return (
    <form onSubmit={save} className="space-y-3 border-t border-white/8 pt-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <FilePlus2 aria-hidden className="size-4 text-signal" />
        Client onboarding draft
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${base}-name`} className="mb-1 block text-xs text-ink-2">Company name</label>
          <input id={`${base}-name`} value={draft.companyName} onChange={(event) => setDraft({ ...draft, companyName: event.target.value })} className="field" />
        </div>
        <div>
          <label htmlFor={`${base}-email`} className="mb-1 block text-xs text-ink-2">Owner email</label>
          <input id={`${base}-email`} type="email" value={draft.contactEmail ?? ""} onChange={(event) => setDraft({ ...draft, contactEmail: event.target.value })} className="field" />
        </div>
        <div>
          <label htmlFor={`${base}-mode`} className="mb-1 block text-xs text-ink-2">Business mode</label>
          <select id={`${base}-mode`} value={draft.businessMode} onChange={(event) => setDraft({ ...draft, businessMode: event.target.value as BusinessMode })} className="field">
            <option value="general" className="bg-[#101016]">General Business</option>
            <option value="ecommerce" className="bg-[#101016]">E-Commerce</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${base}-niche`} className="mb-1 block text-xs text-ink-2">Starter kit</label>
          <select id={`${base}-niche`} value={draft.nicheTemplate} onChange={(event) => setDraft({ ...draft, nicheTemplate: event.target.value as NicheTemplate })} className="field">
            {NICHE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value} className="bg-[#101016]">{option.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${base}-tier`} className="mb-1 block text-xs text-ink-2">Package</label>
          <select id={`${base}-tier`} value={draft.packageTier} onChange={(event) => setDraft({ ...draft, packageTier: event.target.value as PackageTier })} className="field">
            <option value="presence" className="bg-[#101016]">Presence</option>
            <option value="growth" className="bg-[#101016]">Growth</option>
            <option value="scale" className="bg-[#101016]">Scale</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${base}-region`} className="mb-1 block text-xs text-ink-2">Region</label>
          <select id={`${base}-region`} value={draft.region} onChange={(event) => setDraft({ ...draft, region: event.target.value as RegionPreset, currency: null })} className="field">
            <option value="bd" className="bg-[#101016]">Bangladesh ৳</option>
            <option value="global" className="bg-[#101016]">Global $</option>
          </select>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        {(
          [
            ["inquiries", "Monthly inquiries"],
            ["conversion", "Conversion %"],
            ["value", "Profit per sale"],
            ["retainer", "Retainer"],
          ] as const
        ).map(([key, label]) => (
          <div key={key}>
            <label htmlFor={`${base}-${key}`} className="mb-1 block text-xs text-ink-2">{label}</label>
            <input id={`${base}-${key}`} inputMode="decimal" value={baseline[key]} onChange={(event) => setBaseline({ ...baseline, [key]: event.target.value })} className="field font-mono" />
          </div>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-halt-soft">{error}</p>}
      <button type="submit" className="inline-flex min-h-10 items-center rounded-xl border border-signal/40 px-3.5 text-sm font-semibold text-signal hover:border-signal/70">
        Save draft
      </button>
    </form>
  );
}

function ProspectDrawer({
  prospect,
  ops,
  canDraft,
  onClose,
  onUpdated,
  onDeleted,
}: {
  prospect: Prospect | null;
  ops: OpsClient;
  canDraft: boolean;
  onClose: () => void;
  onUpdated: (next: Prospect) => void;
  onDeleted: (id: string) => void;
}) {
  return (
    <Dialog open={prospect !== null} onClose={onClose} title={prospect?.businessName ?? "Prospect"} placement="right">
      {prospect && <ProspectDetail key={prospect.id} prospect={prospect} ops={ops} canDraft={canDraft} onClose={onClose} onUpdated={onUpdated} onDeleted={onDeleted} />}
    </Dialog>
  );
}

function ProspectDetail({
  prospect,
  ops,
  canDraft,
  onClose,
  onUpdated,
  onDeleted,
}: {
  prospect: Prospect;
  ops: OpsClient;
  canDraft: boolean;
  onClose: () => void;
  onUpdated: (next: Prospect) => void;
  onDeleted: (id: string) => void;
}) {
  const notify = useToast();
  const [notes, setNotes] = useState(prospect.notes);
  const [auditUrl, setAuditUrl] = useState(prospect.auditUrl ?? "");
  const [contactName, setContactName] = useState(prospect.contactName ?? "");
  const [phone, setPhone] = useState(prospect.phone ?? "");
  const [email, setEmail] = useState(prospect.email ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const base = useId();

  async function patch(changes: ProspectChanges) {
    try {
      onUpdated(await ops.updateProspect(prospect.id, changes));
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : "That did not save.", "error");
    }
  }

  async function remove() {
    try {
      await ops.deleteProspect(prospect.id);
      onDeleted(prospect.id);
      notify(`${prospect.businessName} removed.`, "info");
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : "That did not save.", "error");
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-white/8 px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-tight text-ink">{prospect.businessName}</h2>
          <div className="mt-1"><ScoreBadge score={prospect.priorityScore} /></div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-white/6 hover:text-ink">
          <X aria-hidden className="size-4" />
        </button>
      </div>

      <div className="thin-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <section aria-label="Priority score calculator">
          <h3 className="text-sm font-semibold text-ink">Priority score</h3>
          <p className="mt-0.5 text-xs text-ink-3">Each signal that applies adds one point, on a scale of 1 to 5.</p>
          <ul className="mt-2">
            {SCORE_SIGNALS.map((signal) => (
              <li key={signal} className="flex min-h-11 items-center justify-between gap-3 border-t border-white/6 text-sm text-ink-2">
                {SIGNAL_LABELS[signal]}
                <Switch checked={prospect[signal]} onChange={(checked) => patch({ [signal]: checked })} label={SIGNAL_LABELS[signal]} />
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Pipeline" className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${base}-stage`} className="mb-1 block text-xs text-ink-2">Stage</label>
            <select id={`${base}-stage`} value={prospect.stage} onChange={(event) => patch({ stage: event.target.value as ProspectStage })} className="field">
              {STAGES.map((stage) => (
                <option key={stage.value} value={stage.value} className="bg-[#101016]">{stage.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${base}-assignee`} className="mb-1 block text-xs text-ink-2">Assigned to</label>
            <select id={`${base}-assignee`} value={prospect.assignee ?? ""} onChange={(event) => patch({ assignee: event.target.value || null })} className="field">
              <option value="" className="bg-[#101016]">Nobody</option>
              {TEAM.map((member) => (
                <option key={member.key} value={member.key} className="bg-[#101016]">{member.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${base}-niche`} className="mb-1 block text-xs text-ink-2">Industry</label>
            <select id={`${base}-niche`} value={prospect.niche ?? "custom"} onChange={(event) => patch({ niche: event.target.value })} className="field">
              {NICHE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="bg-[#101016]">{option.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${base}-followup`} className="mb-1 block text-xs text-ink-2">Next follow-up</label>
            <input id={`${base}-followup`} type="date" value={prospect.nextFollowUp ?? ""} onChange={(event) => patch({ nextFollowUp: event.target.value || null })} className="field [color-scheme:dark]" />
          </div>
        </section>

        <section aria-label="Contact" className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor={`${base}-contact`} className="mb-1 block text-xs text-ink-2">Contact name</label>
            <input id={`${base}-contact`} value={contactName} onChange={(event) => setContactName(event.target.value)} onBlur={() => contactName !== (prospect.contactName ?? "") && patch({ contactName: contactName || null })} className="field" />
          </div>
          <div>
            <label htmlFor={`${base}-phone`} className="mb-1 block text-xs text-ink-2">Phone</label>
            <input id={`${base}-phone`} value={phone} onChange={(event) => setPhone(event.target.value)} onBlur={() => phone !== (prospect.phone ?? "") && patch({ phone: phone || null })} className="field" />
          </div>
          <div>
            <label htmlFor={`${base}-mail`} className="mb-1 block text-xs text-ink-2">Email</label>
            <input id={`${base}-mail`} type="email" value={email} onChange={(event) => setEmail(event.target.value)} onBlur={() => email !== (prospect.email ?? "") && patch({ email: email || null })} className="field" />
          </div>
        </section>

        <section aria-label="Video audit" className="grid gap-3 sm:grid-cols-[auto_1fr]">
          <div>
            <label htmlFor={`${base}-audit`} className="mb-1 block text-xs text-ink-2">Video audit</label>
            <select id={`${base}-audit`} value={prospect.auditProgress} onChange={(event) => patch({ auditProgress: event.target.value as AuditProgress })} className="field">
              {(Object.keys(AUDIT_LABELS) as AuditProgress[]).map((value) => (
                <option key={value} value={value} className="bg-[#101016]">{AUDIT_LABELS[value]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${base}-url`} className="mb-1 block text-xs text-ink-2">Audit link</label>
            <input id={`${base}-url`} type="url" placeholder="https://" value={auditUrl} onChange={(event) => setAuditUrl(event.target.value)} onBlur={() => auditUrl !== (prospect.auditUrl ?? "") && patch({ auditUrl: auditUrl || null })} className="field" />
          </div>
        </section>

        <section aria-label="Notes">
          <label htmlFor={`${base}-notes`} className="mb-1 block text-xs text-ink-2">Notes</label>
          <textarea id={`${base}-notes`} rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} onBlur={() => notes !== prospect.notes && patch({ notes })} className="field" />
        </section>

        {canDraft && <DraftForm prospect={prospect} ops={ops} onSaved={onUpdated} />}

        <div className="border-t border-white/8 pt-4">
          {confirmDelete ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
              Remove {prospect.businessName} from the pipeline?
              <button type="button" onClick={remove} className="inline-flex min-h-10 items-center rounded-lg bg-halt px-3 text-xs font-semibold text-white">Remove</button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="inline-flex min-h-10 items-center rounded-lg border border-white/12 px-3 text-xs font-medium text-ink">Keep</button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-halt/30 px-3 text-xs font-medium text-halt-soft hover:border-halt/60">
              <Trash2 aria-hidden className="size-3.5" />
              Remove prospect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------- root
export function ProspectCrm({ ops, permissions }: { ops: OpsClient; permissions: string[] }) {
  const notify = useToast();
  const [view, setView] = useState<View>("pipeline");
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const canDraft = permissions.includes(PERMISSIONS.drafts);
  const canStandup = permissions.includes(PERMISSIONS.standup);
  const inputId = useId();

  const load = useCallback(async () => {
    try {
      setPipeline(await ops.pipeline());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load the pipeline.");
    }
  }, [ops]);

  useEffect(() => {
    let cancelled = false;
    ops.pipeline().then(
      (next) => {
        if (!cancelled) {
          setPipeline(next);
          setError(null);
        }
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Could not load the pipeline.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ops]);

  function replace(next: Prospect) {
    setPipeline((current) =>
      current && {
        ...current,
        items: current.items
          .map((row) => (row.id === next.id ? next : row))
          .sort((a, b) => b.priorityScore - a.priorityScore),
      },
    );
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (name.length < 2) return;
    try {
      const created = await ops.createProspect(name);
      setPipeline((current) => current && { ...current, items: [created, ...current.items] });
      setNewName("");
      setSelectedId(created.id);
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : "That did not save.", "error");
    }
  }

  async function quickChange(prospect: Prospect, changes: ProspectChanges) {
    try {
      replace(await ops.updateProspect(prospect.id, changes));
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : "That did not save.", "error");
    }
  }

  const selected = pipeline?.items.find((row) => row.id === selectedId) ?? null;
  const active = pipeline ? pipeline.items.filter((row) => row.stage !== "won").length : 0;

  return (
    <section aria-label="Prospect CRM" className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold tracking-tight text-ink">Prospect CRM &amp; Daily Accountability</h2>
          {pipeline && (
            <div className="mt-2 flex max-w-sm items-center gap-3">
              <Meter value={active} max={pipeline.target} label="Prospects in the pipeline" valueText={`${active} of ${pipeline.target}`} className="h-1.5" />
              <span className="shrink-0 font-mono text-xs tabular-nums text-ink-2">{active} / {pipeline.target}</span>
            </div>
          )}
        </div>
        <Segmented<View>
          label="CRM views"
          value={view}
          onChange={setView}
          className="max-w-full flex-wrap rounded-2xl"
          options={[
            { value: "pipeline", label: "Pipeline" },
            { value: "audits", label: "Audit Tracker" },
            ...(canStandup ? [{ value: "standup" as const, label: "Daily Stand-up" }] : []),
          ]}
        />
      </div>

      {view !== "standup" && (
        <form onSubmit={add} className="mt-4 flex max-w-xl gap-2">
          <label htmlFor={inputId} className="sr-only">Business name of the new prospect</label>
          <input id={inputId} value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Add a prospect by business name" className="field" />
          <button type="submit" disabled={newName.trim().length < 2} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian disabled:opacity-40">
            <Plus aria-hidden className="size-4" />
            Add
          </button>
        </form>
      )}

      {error && !pipeline && view !== "standup" && (
        <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
          <p>{error}</p>
          <button type="button" onClick={load} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70">
            <RotateCw aria-hidden className="size-3.5" />
            Try again
          </button>
        </div>
      )}
      {!pipeline && !error && view !== "standup" && <div aria-busy="true" aria-label="Loading the pipeline" className="mt-4 h-72 animate-pulse rounded-2xl bg-white/4" />}

      {pipeline && view === "pipeline" && <PipelineBoard pipeline={pipeline} onOpen={(row) => setSelectedId(row.id)} />}
      {pipeline && view === "audits" && <AuditTracker pipeline={pipeline} onChange={quickChange} onOpen={(row) => setSelectedId(row.id)} />}
      {view === "standup" && canStandup && <StandupTracker ops={ops} />}

      <ProspectDrawer
        prospect={selected}
        ops={ops}
        canDraft={canDraft}
        onClose={() => setSelectedId(null)}
        onUpdated={replace}
        onDeleted={(id) => {
          setPipeline((current) => current && { ...current, items: current.items.filter((row) => row.id !== id) });
          setSelectedId(null);
        }}
      />
    </section>
  );
}
