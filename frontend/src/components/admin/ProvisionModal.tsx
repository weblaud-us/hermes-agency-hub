"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  CircleAlert,
  Eye,
  EyeOff,
  Link2,
  LoaderCircle,
  Rocket,
  ShieldCheck,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog } from "@/components/ui/Dialog";
import { SecretInput } from "@/components/ui/SecretInput";
import { Segmented } from "@/components/ui/Segmented";
import { ApiError, type HubClient, type OnboardResult } from "@/lib/api";
import { SPRING, riseIn, staggerContainer } from "@/lib/motion";
import {
  BASE_DOMAIN,
  LLM_MODELS,
  SHARED_SKILLS,
  TIERS,
  TIER_ORDER,
  buildInstallerCommand,
  provisionStages,
  validateProvisionForm,
  type ProvisionField,
  type ProvisionForm,
  type TierId,
} from "@/lib/provisioning";
import { cn, delay, slugify } from "@/lib/utils";

export type ProvisionTab = "cluster" | "installer";

interface ProvisionModalProps {
  open: boolean;
  hub: HubClient;
  initialTab: ProvisionTab;
  initialTier: TierId;
  onClose: () => void;
  onProvisioned: (result: OnboardResult) => void;
}

type Phase =
  | { name: "form" }
  | { name: "running"; stage: number }
  | { name: "failed"; stage: number; message: string; uncertain: boolean }
  | { name: "vault"; result: OnboardResult };

const STAGE_MS = 1050;

const FIELD_LABELS: Record<ProvisionField, string> = {
  companyName: "Company name",
  subdomain: "Subdomain",
  openRouterKey: "OpenRouter API key",
  sslEmail: "Admin SSL email",
};

// ------------------------------------------------------------------- form parts
function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink-2">
        {label}
      </label>
      {children}
      <AnimatePresence initial={false}>
        {error && (
          <motion.p
            id={`${id}-error`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.12 } }}
            transition={SPRING}
            className="overflow-hidden text-xs text-halt-soft"
          >
            <span className="flex items-start gap-1.5 pt-1.5">
              <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
              {error}
            </span>
          </motion.p>
        )}
      </AnimatePresence>
      {hint && !error && <p className="mt-1.5 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

function TierPicker({ value, onChange }: { value: TierId; onChange: (tier: TierId) => void }) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-ink-2">Package tier and resource preset</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {TIER_ORDER.map((id) => {
          const tier = TIERS[id];
          const selected = value === id;
          return (
            <label
              key={id}
              className={cn(
                "relative flex min-h-16 cursor-pointer flex-col justify-center rounded-xl border px-3 py-2 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal",
                selected ? "border-signal/50 bg-signal/7" : "border-white/10 hover:border-white/20",
              )}
            >
              <input
                type="radio"
                name={name}
                value={id}
                checked={selected}
                onChange={() => onChange(id)}
                className="sr-only"
              />
              <span className="text-sm font-semibold text-ink">{id === "enterprise" ? "Enterprise" : tier.label}</span>
              <span className="mt-0.5 font-mono text-[11px] tabular-nums text-ink-3">
                {tier.memory} / {tier.cpus} vCPU
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------- stepper screen
function StageRow({ index, total, text, state }: { index: number; total: number; text: string; state: "pending" | "active" | "done" | "failed" }) {
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: state === "pending" ? 0.42 : 1, y: 0 }}
      transition={SPRING}
      className="flex items-start gap-2.5 py-1.5"
    >
      <span className="mt-[3px] flex size-4 shrink-0 items-center justify-center">
        {state === "done" && <Check aria-hidden className="size-4 text-signal" />}
        {state === "active" && <LoaderCircle aria-hidden className="animate-spin-slow size-4 text-warn" />}
        {state === "failed" && <X aria-hidden className="size-4 text-halt" />}
        {state === "pending" && <span aria-hidden className="size-1.5 rounded-full bg-white/30" />}
      </span>
      <span className="min-w-0 wrap-break-word">
        <span className={cn("tabular-nums", state === "done" ? "text-signal" : state === "failed" ? "text-halt-soft" : state === "active" ? "text-warn" : "text-ink-3")}>
          [{String(index + 1).padStart(2, "0")}/{String(total).padStart(2, "0")}]
        </span>{" "}
        <span className={state === "pending" ? "text-ink-3" : "text-ink"}>{text}</span>
      </span>
    </motion.li>
  );
}

function ProvisionTerminal({
  slug,
  phase,
  live,
  onBack,
}: {
  slug: string;
  phase: Extract<Phase, { name: "running" | "failed" }>;
  live: boolean;
  onBack: () => void;
}) {
  const stages = provisionStages(slug);
  const failed = phase.name === "failed";
  const progress = failed ? phase.stage / stages.length : Math.min(1, (phase.stage + 0.5) / stages.length);

  return (
    <motion.div
      key="terminal"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10, transition: { duration: 0.14 } }}
      transition={SPRING}
      className="p-5 sm:p-7"
    >
      <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">
        {failed ? "Provisioning stopped" : `Provisioning ${slug}`}
      </h2>
      <div
        role="progressbar"
        aria-label="Provisioning progress"
        aria-valuemin={0}
        aria-valuemax={stages.length}
        aria-valuenow={phase.stage}
        className="mt-4 h-1 overflow-hidden rounded-full bg-white/10"
      >
        <motion.div
          className={cn("h-full origin-left rounded-full", failed ? "bg-halt" : "bg-signal")}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: progress }}
          transition={SPRING}
        />
      </div>
      <div className="mt-4 rounded-2xl border border-white/7 bg-black/45 px-4 py-3 font-mono text-xs leading-5">
        <ol>
          {stages.map((text, index) => {
            const state =
              index < phase.stage ? "done" : index === phase.stage ? (failed ? "failed" : "active") : "pending";
            return <StageRow key={index} index={index} total={stages.length} text={text} state={state} />;
          })}
        </ol>
      </div>

      {live && !failed && (
        <p className="mt-3 text-xs text-ink-3">
          The hub runs onboarding as one request, so these stages are paced rather than streamed. The result comes from
          the hub&apos;s response. First deployments can take minutes.
        </p>
      )}

      {failed && (
        <div role="alert" className="mt-4 rounded-2xl border border-halt/40 bg-halt/10 p-4 text-sm text-ink">
          <p className="flex items-start gap-2">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-halt" />
            <span className="min-w-0 wrap-break-word">{phase.message}</span>
          </p>
          {phase.uncertain && (
            <p className="mt-2 text-xs text-ink-2">
              The request did not finish, so the tenant may still have been created. Check the tenant list before
              retrying.
            </p>
          )}
          <button
            type="button"
            onClick={onBack}
            className="mt-3 inline-flex min-h-10 items-center rounded-lg border border-white/15 px-3 text-xs font-medium hover:border-white/30"
          >
            Back to the form
          </button>
        </div>
      )}
    </motion.div>
  );
}

// ------------------------------------------------------------------ vault screen
function VaultRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [revealed, setRevealed] = useState(!secret);
  return (
    <motion.div
      variants={riseIn}
      className="flex items-center gap-2 border-t border-white/7 px-4 py-3 first:border-t-0"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-ink-3">{label}</p>
        <p className="mt-0.5 break-all font-mono text-xs text-ink">{revealed ? value : "•".repeat(Math.min(24, value.length))}</p>
      </div>
      {secret && (
        <button
          type="button"
          onClick={() => setRevealed((current) => !current)}
          aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/4 text-ink-2 hover:border-white/20 hover:text-ink"
        >
          {revealed ? <EyeOff aria-hidden className="size-3.5" /> : <Eye aria-hidden className="size-3.5" />}
        </button>
      )}
      <CopyButton value={value} label={`Copy ${label}`} />
    </motion.div>
  );
}

type PortalLinkState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; url: string }
  | { status: "error"; message: string };

function VaultReveal({
  result,
  mock,
  hub,
  onDone,
}: {
  result: OnboardResult;
  mock: boolean;
  hub: HubClient;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [portalLink, setPortalLink] = useState<PortalLinkState>({ status: "idle" });
  const checkbox = useId();

  async function generatePortalLink() {
    setPortalLink({ status: "loading" });
    try {
      const { portalUrl } = await hub.portalLink(result.clientId);
      setPortalLink({ status: "done", url: portalUrl });
    } catch (error) {
      setPortalLink({
        status: "error",
        message: error instanceof Error ? error.message : "Could not mint a portal link.",
      });
    }
  }

  return (
    <motion.div
      key="vault"
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      exit={{ opacity: 0 }}
      className="p-5 sm:p-7"
    >
      <motion.div variants={riseIn} className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-signal/15 text-signal">
          <ShieldCheck aria-hidden className="size-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">{result.companyName} is provisioned</h2>
          <p className="text-sm text-ink-2">The hub shows this password once. Store it now.</p>
        </div>
      </motion.div>

      {mock && (
        <motion.p variants={riseIn} className="mt-4 rounded-xl border border-warn/30 bg-warn/8 px-3 py-2 text-xs text-ink-2">
          Mock telemetry: these credentials are simulated and open nothing.
        </motion.p>
      )}

      {result.warning && (
        <motion.div
          variants={riseIn}
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm text-ink"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
          <span className="min-w-0 wrap-break-word">
            The container started but is not healthy yet: {result.warning}
          </span>
        </motion.div>
      )}

      <motion.p variants={riseIn} className="mt-4 text-xs text-ink-3">
        These four sign in to the raw technical dashboard — keep them for yourself or a technical contact, never the
        client. For the business owner, generate a portal link below instead: a plain, white-labeled page with no
        credentials for them to lose.
      </motion.p>

      <motion.div
        variants={riseIn}
        className="surface sheen mt-3 overflow-hidden rounded-2xl shadow-[0_0_60px_-24px_var(--color-signal)]"
      >
        <motion.div variants={staggerContainer} className="relative">
          <VaultRow label="Dashboard URL" value={result.dashboardUrl} />
          <VaultRow label="Admin Username" value={result.dashboardUsername} />
          <VaultRow label="Generated Password" value={result.dashboardPassword} secret />
          <VaultRow label="Bearer API Key" value={result.apiKey} secret />
        </motion.div>
      </motion.div>

      <motion.p variants={riseIn} className="mt-3 font-mono text-[11px] text-ink-3">
        Skills synced: {result.syncedSkills.length ? result.syncedSkills.join(", ") : "none"}
      </motion.p>

      <motion.div variants={riseIn} className="mt-4 rounded-2xl border border-hyper/30 bg-hyper/6 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <Link2 aria-hidden className="size-4 shrink-0 text-hyper-soft" />
          Client portal link
        </p>
        <p className="mt-1 text-xs text-ink-2">
          Send this to {result.companyName}&apos;s business owner. It opens their portal signed in — nothing to type.
        </p>

        {portalLink.status === "idle" && (
          <button
            type="button"
            onClick={generatePortalLink}
            className="mt-3 inline-flex min-h-10 items-center rounded-xl border border-white/15 px-4 text-sm font-medium text-ink hover:border-white/30"
          >
            Generate portal link
          </button>
        )}
        {portalLink.status === "loading" && (
          <p className="mt-3 flex items-center gap-2 text-sm text-ink-2">
            <LoaderCircle aria-hidden className="animate-spin-slow size-4" />
            Minting a link…
          </p>
        )}
        {portalLink.status === "error" && (
          <div role="alert" className="mt-3 flex items-start gap-2 text-sm text-halt-soft">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 wrap-break-word">{portalLink.message}</span>
          </div>
        )}
        {portalLink.status === "done" && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2.5">
            <p className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{portalLink.url}</p>
            <CopyButton value={portalLink.url} label="Copy client portal link" />
          </div>
        )}
      </motion.div>

      <motion.div variants={riseIn} className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <label htmlFor={checkbox} className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-ink-2">
          <input
            id={checkbox}
            data-autofocus
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
            className="size-4 accent-[var(--color-signal)]"
          />
          I have stored these credentials
        </label>
        <button
          type="button"
          onClick={onDone}
          disabled={!saved}
          className="inline-flex min-h-11 items-center rounded-xl bg-signal px-5 text-sm font-semibold text-obsidian transition-colors hover:bg-[#3ff9e2] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Done
        </button>
      </motion.div>
    </motion.div>
  );
}

// ---------------------------------------------------------------- installer panel
function InstallerPanel({ command, ready }: { command: string; ready: boolean }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/8 bg-black/45">
      <div className="flex items-center justify-between gap-3 border-b border-white/7 px-4 py-2">
        <span className="flex items-center gap-2 font-mono text-[11px] text-ink-3">
          <TerminalSquare aria-hidden className="size-3.5" />
          client VPS shell
        </span>
        <CopyButton value={command} label="Copy install command" disabled={!ready} className="px-2.5">
          Copy
        </CopyButton>
      </div>
      <pre
        tabIndex={0}
        aria-label="Generated install command"
        className={cn(
          "thin-scroll overflow-x-auto px-4 py-3 font-mono text-xs leading-6 transition-opacity",
          ready ? "text-ink" : "text-ink-3 opacity-70",
        )}
      >
        {command}
      </pre>
      <p className="border-t border-white/7 px-4 py-2.5 text-xs text-ink-3">
        Run this from the folder holding install-client-hermes.sh. The script asks for the client&apos;s OpenRouter key on
        the server, so the secret never reaches shell history or this browser.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------------- modal
export function ProvisionModal({ open, hub, initialTab, initialTier, onClose, onProvisioned }: ProvisionModalProps) {
  const [tab, setTab] = useState<ProvisionTab>(initialTab);
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const [form, setForm] = useState<ProvisionForm>({
    companyName: "",
    subdomain: "",
    tier: initialTier,
    model: LLM_MODELS[0].id,
    openRouterKey: "",
    sslEmail: "",
    skills: SHARED_SKILLS.map((skill) => skill.id),
  });
  const [subdomainEdited, setSubdomainEdited] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<ProvisionField, boolean>>>({});
  const [summaryFields, setSummaryFields] = useState<ProvisionField[]>([]);
  const summaryRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const ids = {
    companyName: `${baseId}-company`,
    subdomain: `${baseId}-subdomain`,
    model: `${baseId}-model`,
    openRouterKey: `${baseId}-key`,
    sslEmail: `${baseId}-email`,
  };

  const isCluster = tab === "cluster";
  const errors = validateProvisionForm(form, { requireKey: isCluster });
  const valid = Object.keys(errors).length === 0;
  const live = hub.mode === "live";
  const command = buildInstallerCommand(
    {
      ...form,
      companyName: form.companyName || "Company Name",
      subdomain: form.subdomain || "company-slug",
      sslEmail: form.sslEmail || "ops@company.com",
    },
    BASE_DOMAIN,
  );

  useEffect(() => {
    if (summaryFields.length > 0) summaryRef.current?.focus();
  }, [summaryFields]);

  function update<K extends keyof ProvisionForm>(key: K, value: ProvisionForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function onCompanyChange(value: string) {
    setForm((current) => ({
      ...current,
      companyName: value,
      subdomain: subdomainEdited ? current.subdomain : slugify(value),
    }));
  }

  function fieldError(field: ProvisionField): string | undefined {
    return touched[field] ? errors[field] : undefined;
  }

  function fieldProps(field: ProvisionField) {
    const error = fieldError(field);
    return {
      id: ids[field],
      "aria-invalid": Boolean(error),
      "aria-describedby": error ? `${ids[field]}-error` : undefined,
      onBlur: () => setTouched((current) => ({ ...current, [field]: true })),
    };
  }

  function revealErrors(): boolean {
    if (valid) {
      setSummaryFields([]);
      return true;
    }
    setTouched({ companyName: true, subdomain: true, openRouterKey: true, sslEmail: true });
    setSummaryFields(Object.keys(errors) as ProvisionField[]);
    return false;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!isCluster || !revealErrors()) return;

    setPhase({ name: "running", stage: 0 });
    const tier = TIERS[form.tier];
    const outcome = hub
      .onboard({
        companyName: form.companyName.trim(),
        subdomain: form.subdomain,
        plan: tier.apiPlan,
        tier: form.tier,
        contactEmail: form.sslEmail.trim(),
        openRouterKey: form.openRouterKey.trim(),
        model: form.model,
        skills: form.skills,
      })
      .then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    const fail = (stage: number, error: unknown) => {
      const networkLost = error instanceof ApiError && error.status === 0;
      setPhase({
        name: "failed",
        stage,
        message: error instanceof Error ? error.message : "Provisioning failed.",
        uncertain: networkLost,
      });
    };

    const stageCount = provisionStages(form.subdomain).length;
    for (let stage = 1; stage < stageCount; stage += 1) {
      const early = await Promise.race([
        delay(STAGE_MS).then(() => null),
        outcome.then((settled) => (settled.ok ? null : settled)),
      ]);
      if (early) {
        fail(stage - 1, early.error);
        return;
      }
      setPhase({ name: "running", stage });
    }

    const settled = await outcome;
    if (!settled.ok) {
      fail(stageCount - 1, settled.error);
      return;
    }
    setPhase({ name: "running", stage: stageCount });
    await delay(420);
    setPhase({ name: "vault", result: settled.result });
    onProvisioned(settled.result);
  }

  const dismissable = phase.name === "form" || phase.name === "failed";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={dismissable}
      title="Provision a client"
      className="sm:max-w-3xl"
    >
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait" initial={false}>
          {phase.name === "form" && (
            <motion.form
              key="form"
              noValidate
              onSubmit={submit}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10, transition: { duration: 0.14 } }}
              transition={SPRING}
            >
              <div className="flex items-start justify-between gap-3 px-5 pt-5 sm:px-7 sm:pt-6">
                <div>
                  <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">1-Click Client Provisioning</h2>
                  <p className="mt-0.5 font-mono text-[11px] text-ink-3">
                    {isCluster ? "POST /api/v1/clients/onboard" : "generates sudo bash install-client-hermes.sh"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="-mr-1.5 inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-white/6 hover:text-ink"
                >
                  <X aria-hidden className="size-4" />
                </button>
              </div>

              <div className="px-5 pt-4 sm:px-7">
                <Segmented<ProvisionTab>
                  label="Deployment target"
                  value={tab}
                  onChange={(next) => {
                    setTab(next);
                    setSummaryFields([]);
                  }}
                  className="flex w-full rounded-2xl"
                  optionClassName="flex-1 rounded-xl py-2 text-center leading-snug"
                  options={[
                    { value: "cluster", label: "Deploy to Agency Multi-Tenant Cluster" },
                    { value: "installer", label: "Generate Client-Server One-Click Installer" },
                  ]}
                />
              </div>

              <div className="space-y-5 px-5 py-5 sm:px-7">
                {summaryFields.length > 0 && (
                  <div
                    ref={summaryRef}
                    tabIndex={-1}
                    role="alert"
                    className="rounded-xl border border-halt/40 bg-halt/10 px-4 py-3 text-sm text-ink outline-none"
                  >
                    <p className="font-medium">Fix these before continuing:</p>
                    <ul className="mt-1.5 space-y-1">
                      {summaryFields.map((field) => (
                        <li key={field}>
                          <a href={`#${ids[field]}`} className="text-halt-soft underline underline-offset-2">
                            {FIELD_LABELS[field]}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id={ids.companyName} label="Company name" error={fieldError("companyName")}>
                    <input
                      {...fieldProps("companyName")}
                      data-autofocus
                      value={form.companyName}
                      onChange={(event) => onCompanyChange(event.target.value)}
                      placeholder="Acme Trading Co"
                      autoComplete="off"
                      className="field"
                    />
                  </Field>
                  <Field
                    id={ids.subdomain}
                    label="Subdomain"
                    error={fieldError("subdomain")}
                    hint={
                      <span className="font-mono break-all">
                        https://{form.subdomain || "{slug}"}.{BASE_DOMAIN}
                      </span>
                    }
                  >
                    <input
                      {...fieldProps("subdomain")}
                      value={form.subdomain}
                      onChange={(event) => {
                        setSubdomainEdited(true);
                        update("subdomain", event.target.value.toLowerCase());
                      }}
                      placeholder="acme-trading-co"
                      autoComplete="off"
                      spellCheck={false}
                      className="field font-mono"
                    />
                  </Field>
                </div>

                <TierPicker value={form.tier} onChange={(tier) => update("tier", tier)} />
                {live && isCluster && (
                  <p className="-mt-3 text-xs text-ink-3">
                    The hub applies its own limits per plan. The tenant row shows what it actually set.
                  </p>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id={ids.model} label="Default LLM brain">
                    <select
                      id={ids.model}
                      value={form.model}
                      onChange={(event) => update("model", event.target.value)}
                      className="field font-mono text-xs"
                    >
                      {LLM_MODELS.map((model) => (
                        <option key={model.id} value={model.id} className="bg-[#101016]">
                          {model.id}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    id={ids.sslEmail}
                    label="Admin SSL email"
                    error={fieldError("sslEmail")}
                    hint="Certificate and contact notices go here."
                  >
                    <input
                      {...fieldProps("sslEmail")}
                      type="email"
                      value={form.sslEmail}
                      onChange={(event) => update("sslEmail", event.target.value)}
                      placeholder="ops@acme.com"
                      autoComplete="off"
                      className="field"
                    />
                  </Field>
                </div>

                {isCluster && (
                  <Field
                    id={ids.openRouterKey}
                    label="OpenRouter API key"
                    error={fieldError("openRouterKey")}
                    hint="Written only to the tenant's 0600 .env. The hub database keeps the last four characters."
                  >
                    <SecretInput
                      {...fieldProps("openRouterKey")}
                      secretName="API key"
                      value={form.openRouterKey}
                      onChange={(event) => update("openRouterKey", event.target.value)}
                      placeholder="sk-or-v1-..."
                    />
                  </Field>
                )}

                <fieldset>
                  <legend className="mb-1.5 text-sm font-medium text-ink-2">Pre-mount shared agency skills</legend>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {SHARED_SKILLS.map((skill) => {
                      const checked = form.skills.includes(skill.id);
                      return (
                        <label
                          key={skill.id}
                          className={cn(
                            "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-[13px] leading-snug transition-colors",
                            checked ? "border-hyper/50 bg-hyper/8 text-ink" : "border-white/10 text-ink-2 hover:border-white/20",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) =>
                              update(
                                "skills",
                                event.target.checked
                                  ? [...form.skills, skill.id]
                                  : form.skills.filter((id) => id !== skill.id),
                              )
                            }
                            className="size-4 shrink-0 accent-[var(--color-hyper)]"
                          />
                          {skill.label}
                        </label>
                      );
                    })}
                  </div>
                  {live && isCluster && (
                    <p className="mt-1.5 text-xs text-ink-3">
                      The hub syncs skills by plan today. Your selection is stored on the client&apos;s config, and the
                      next screen lists what was actually synced.
                    </p>
                  )}
                </fieldset>

                {!isCluster && <InstallerPanel command={command} ready={valid} />}
              </div>

              {isCluster && (
                <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-white/7 bg-[#0a0a10]/95 px-5 py-4 sm:px-7">
                  <button
                    type="button"
                    onClick={onClose}
                    className="inline-flex min-h-11 items-center rounded-xl border border-white/12 px-4 text-sm font-medium text-ink hover:border-white/25"
                  >
                    Cancel
                  </button>
                  <motion.button
                    type="submit"
                    whileTap={{ scale: 0.97 }}
                    transition={SPRING}
                    className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-signal px-5 text-sm font-semibold text-obsidian transition-colors hover:bg-[#3ff9e2]"
                  >
                    <Rocket aria-hidden className="size-4" />
                    Provision tenant
                  </motion.button>
                </div>
              )}
            </motion.form>
          )}

          {(phase.name === "running" || phase.name === "failed") && (
            <ProvisionTerminal
              key="terminal"
              slug={form.subdomain}
              phase={phase}
              live={live}
              onBack={() => setPhase({ name: "form" })}
            />
          )}

          {phase.name === "vault" && (
            <VaultReveal key="vault" result={phase.result} mock={!live} hub={hub} onDone={onClose} />
          )}
        </AnimatePresence>
      </div>
    </Dialog>
  );
}
