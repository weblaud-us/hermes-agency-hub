"use client";

import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import {
  Check,
  GitCommitHorizontal,
  Lock,
  RotateCcw,
  Server,
  ShieldCheck,
  Waypoints,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SectionHeading } from "@/components/landing/SectionHeading";
import { Meter } from "@/components/ui/Meter";
import { Segmented } from "@/components/ui/Segmented";
import { SpotlightCard } from "@/components/ui/SpotlightCard";
import { Switch } from "@/components/ui/Switch";
import { SPRING, riseIn, staggerContainer } from "@/lib/motion";
import { cn } from "@/lib/utils";

function CardHeading({ title, body }: { title: string; body: string }) {
  return (
    <div className="mb-5">
      <h3 className="text-lg font-semibold tracking-[-0.02em] text-ink">{title}</h3>
      <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-ink-2">{body}</p>
    </div>
  );
}

// ------------------------------------------------------- card 1: cron & task matrix
interface MatrixJob {
  id: string;
  name: string;
  cron: string;
  /** Run positions on the 24h lane, as hours. */
  lane: number[];
  continuous?: boolean;
  samples: number[];
}

const MATRIX_JOBS: MatrixJob[] = [
  {
    id: "sku",
    name: "Daily SKU Velocity Audit",
    cron: "0 2 * * *",
    lane: [2],
    samples: [820, 760, 910, 880, 940, 790, 860, 1020, 870, 830, 905, 840, 780, 890, 950, 860],
  },
  {
    id: "triage",
    name: "60s Lead Triage",
    cron: "* * * * *",
    lane: [],
    continuous: true,
    samples: [140, 118, 162, 134, 98, 176, 121, 143, 109, 152, 128, 137, 166, 112, 149, 126],
  },
  {
    id: "digest",
    name: "PR & Deployment Digest",
    cron: "0 9 * * 1-5",
    lane: [9],
    samples: [420, 380, 510, 465, 395, 440, 520, 405, 470, 430, 385, 455, 495, 410, 445, 400],
  },
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function CronMatrixCard() {
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root, { amount: 0.2 });
  const reduced = useReducedMotion();
  const [enabled, setEnabled] = useState<Record<string, boolean>>({ sku: true, triage: true, digest: true });
  const [samples, setSamples] = useState(() =>
    Object.fromEntries(MATRIX_JOBS.map((job) => [job.id, job.samples])),
  );
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!inView) return;
    const timer = setInterval(() => {
      const active = MATRIX_JOBS.filter((job) => enabledRef.current[job.id]);
      if (active.length === 0) return;
      const job = active[Math.floor(Math.random() * active.length)];
      setSamples((current) => {
        const series = current[job.id];
        const anchor = median(job.samples);
        const value = Math.round(anchor * (0.8 + Math.random() * 0.42));
        return { ...current, [job.id]: [...series.slice(1), value] };
      });
    }, 1300);
    return () => clearInterval(timer);
  }, [inView]);

  return (
    <SpotlightCard variants={riseIn} className="p-5 sm:p-7 lg:col-span-7">
      <div ref={root}>
        <CardHeading
          title="Autonomous Cron & Task Matrix"
          body="Each job runs on the tenant's own schedule. Pause one without touching the others, and watch execution latency as it runs."
        />
        <div className="mb-2 hidden grid-cols-[minmax(0,1fr)_7.5rem_2.5rem] gap-4 px-1 font-mono text-[10.5px] uppercase tracking-wider text-ink-3 sm:grid">
          <span>Job and 24h lane (UTC)</span>
          <span>Latency</span>
          <span className="text-right">On</span>
        </div>
        <ul className="divide-y divide-white/6">
          {MATRIX_JOBS.map((job) => {
            const on = enabled[job.id];
            const series = samples[job.id];
            const peak = Math.max(...series);
            return (
              <li
                key={job.id}
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-x-4 gap-y-3 px-1 py-4 transition-opacity duration-200 sm:grid-cols-[minmax(0,1fr)_7.5rem_2.5rem]",
                  !on && "opacity-55",
                )}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                    <span className="text-sm font-medium text-ink">{job.name}</span>
                    <code className="font-mono text-xs tracking-tight text-ink-3">{job.cron}</code>
                  </div>
                  <div className="relative mt-2.5 h-2 overflow-hidden rounded-full bg-white/5">
                    {job.continuous ? (
                      <div className="absolute inset-0 bg-[repeating-linear-gradient(90deg,rgb(0_245_212/0.55)_0_2px,transparent_2px_5px)]" />
                    ) : (
                      job.lane.map((hour) => (
                        <span
                          key={hour}
                          className="absolute inset-y-0 w-2 rounded-full bg-signal"
                          style={{ left: `${(hour / 24) * 100}%` }}
                        />
                      ))
                    )}
                    {on && !reduced && inView && (
                      <motion.span
                        aria-hidden
                        className="absolute inset-y-0 left-0 w-full"
                        initial={{ x: "-4%" }}
                        animate={{ x: "100%" }}
                        transition={{ duration: 14, ease: "linear", repeat: Infinity }}
                      >
                        <span className="absolute inset-y-0 left-0 w-px bg-white/80" />
                      </motion.span>
                    )}
                  </div>
                </div>

                <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto">
                  <div className="flex h-7 items-end gap-0.5" role="img" aria-label={`${job.name} latency, median ${median(series)} milliseconds`}>
                    {series.map((value, index) => (
                      <motion.span
                        key={index}
                        title={`${value} ms`}
                        className="min-w-0 flex-1 origin-bottom rounded-t-xs bg-hyper-soft/80"
                        style={{ height: "100%" }}
                        initial={false}
                        animate={{ scaleY: Math.max(0.08, value / peak) }}
                        transition={SPRING}
                      />
                    ))}
                  </div>
                  <p className="mt-1 font-mono text-[11px] tabular-nums text-ink-3">median {median(series)}ms</p>
                </div>

                <div className="col-start-2 row-start-1 flex justify-end sm:col-start-3">
                  <Switch
                    checked={on}
                    label={`${job.name} schedule`}
                    onChange={(checked) => setEnabled((current) => ({ ...current, [job.id]: checked }))}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </SpotlightCard>
  );
}

// ---------------------------------------------------- card 2: self-authoring diff
type DiffFile = "memory" | "skill";

interface DiffLine {
  kind: "context" | "add";
  text: string;
}

const MEMORY_DIFF: DiffLine[] = [
  { kind: "context", text: "## Fulfilment rules" },
  { kind: "context", text: "- Standard orders ship next business day." },
  { kind: "add", text: "- Orders over $500 ship signature-required." },
  { kind: "add", text: "- Source: ops reply in thread #4821." },
];

const SKILL_DIFF: DiffLine[] = [
  { kind: "add", text: "---" },
  { kind: "add", text: "name: high_value_order_check" },
  { kind: "add", text: "description: Flag orders over $500" },
  { kind: "add", text: "  for signature-required shipping." },
  { kind: "add", text: "---" },
  { kind: "add", text: "1. Look up the order total." },
  { kind: "add", text: "2. If over 500, require a signature." },
  { kind: "add", text: "3. Tell the customer why." },
];

const TOTAL_STEPS = MEMORY_DIFF.length + SKILL_DIFF.length + 1;

function DiffViewerCard() {
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root, { once: true, amount: 0.35 });
  const [step, setStep] = useState(0);
  const [manualFile, setManualFile] = useState<DiffFile | null>(null);

  useEffect(() => {
    if (!inView || step >= TOTAL_STEPS) return;
    const timer = setTimeout(() => setStep((current) => current + 1), 520);
    return () => clearTimeout(timer);
  }, [inView, step]);

  const autoFile: DiffFile = step > MEMORY_DIFF.length ? "skill" : "memory";
  const file = manualFile ?? autoFile;
  const lines = file === "memory" ? MEMORY_DIFF : SKILL_DIFF;
  const revealed = file === "memory" ? step : step - MEMORY_DIFF.length;
  const committed = step >= TOTAL_STEPS;

  function replay() {
    setManualFile(null);
    setStep(0);
  }

  return (
    <SpotlightCard variants={riseIn} className="flex flex-col p-5 sm:p-7 lg:col-span-5" glow="99 102 241">
      <div ref={root} className="flex h-full flex-col">
        <CardHeading
          title="Self-Authoring SKILL.md & MEMORY.md"
          body="Corrected once, the agent records the rule, then turns it into a reusable skill."
        />
        <div className="flex flex-1 flex-col overflow-hidden rounded-2xl border border-white/7 bg-black/30">
          <div className="flex items-center justify-between gap-2 border-b border-white/7 px-2 py-2">
            <Segmented<DiffFile>
              label="Diff file"
              value={file}
              onChange={setManualFile}
              className="border-0 bg-transparent p-0"
              optionClassName="font-mono"
              options={[
                { value: "memory", label: "MEMORY.md" },
                { value: "skill", label: "SKILL.md" },
              ]}
            />
            <button
              type="button"
              onClick={replay}
              aria-label="Replay the learning sequence"
              className="inline-flex size-9 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-white/6 hover:text-ink"
            >
              <RotateCcw aria-hidden className="size-3.5" />
            </button>
          </div>
          <div className="min-h-54 flex-1 px-3 py-3 font-mono text-xs leading-6">
            {lines.map((line, index) =>
              index < revealed ? (
                <motion.div
                  key={`${file}-${index}`}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={SPRING}
                  className={cn(
                    "flex gap-2 rounded px-1.5",
                    line.kind === "add" ? "bg-signal/9 text-ink" : "text-ink-3",
                  )}
                >
                  <span aria-hidden className={line.kind === "add" ? "text-signal" : "text-ink-3"}>
                    {line.kind === "add" ? "+" : " "}
                  </span>
                  <span className="min-w-0 wrap-break-word">{line.text}</span>
                </motion.div>
              ) : null,
            )}
            {!committed && revealed >= 0 && revealed < lines.length && (
              <span aria-hidden className="animate-caret ml-1.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-signal" />
            )}
          </div>
          <div className="flex min-h-11 items-center gap-2 border-t border-white/7 px-3 py-2 font-mono text-[11px]">
            <AnimatePresence mode="wait" initial={false}>
              {committed ? (
                <motion.span
                  key="done"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.1 } }}
                  transition={SPRING}
                  className="flex min-w-0 items-center gap-2 text-signal"
                >
                  <GitCommitHorizontal aria-hidden className="size-4 shrink-0" />
                  <span className="truncate">committed skills/high_value_order_check</span>
                </motion.span>
              ) : (
                <motion.span key="working" exit={{ opacity: 0, transition: { duration: 0.1 } }} className="text-ink-3">
                  agent is writing...
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </SpotlightCard>
  );
}

// ---------------------------------------------------- card 3: dual deployment modes
type DeployMode = "cloud" | "vps";

function CloudDiagram() {
  return (
    <div className="rounded-2xl border border-white/7 bg-black/25 p-3">
      <p className="mb-2.5 font-mono text-[11px] text-ink-3">agency host</p>
      <div className="grid grid-cols-3 gap-2">
        {["tenant_a", "tenant_b", "tenant_c"].map((tenant) => (
          <div key={tenant} className="rounded-xl border border-signal/25 bg-signal/5 px-2 py-2.5 text-center">
            <Waypoints aria-hidden className="mx-auto size-3.5 text-signal" />
            <p className="mt-1.5 truncate font-mono text-[11px] text-ink-2">{tenant}</p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 justify-items-center gap-2" aria-hidden>
        <span className="h-3 w-px bg-white/20" />
        <span className="h-3 w-px bg-white/20" />
        <span className="h-3 w-px bg-white/20" />
      </div>
      <div className="rounded-xl border border-hyper/35 bg-hyper/8 px-3 py-2 text-center font-mono text-[11px] text-hyper-soft">
        shared skills volume :ro
      </div>
    </div>
  );
}

function VpsDiagram() {
  return (
    <div className="rounded-2xl border border-white/7 bg-black/25 p-3">
      <p className="mb-2.5 font-mono text-[11px] text-ink-3">client VPS</p>
      <div className="flex items-stretch gap-2">
        <div className="flex flex-1 flex-col justify-center rounded-xl border border-signal/25 bg-signal/5 p-3 text-center">
          <Server aria-hidden className="mx-auto size-4 text-signal" />
          <p className="mt-1.5 font-mono text-[11px] text-ink-2">one tenant, one machine</p>
        </div>
        <div className="flex w-[38%] flex-col justify-center rounded-xl border border-hyper/35 bg-hyper/8 p-3 text-center">
          <Lock aria-hidden className="mx-auto size-4 text-hyper-soft" />
          <p className="mt-1.5 font-mono text-[11px] text-hyper-soft">automated SSL</p>
        </div>
      </div>
    </div>
  );
}

const DEPLOY_FACTS: Record<DeployMode, string[]> = {
  cloud: ["Isolated Docker container per client", "Shared read-only skill library", "One console for the whole fleet"],
  vps: ["Isolated hardware for one client", "Generated one-click install command", "Client's data stays on their server"],
};

function DeploymentCard() {
  const [mode, setMode] = useState<DeployMode>("cloud");
  return (
    <SpotlightCard variants={riseIn} className="p-5 sm:p-7 lg:col-span-5" glow="99 102 241">
      <CardHeading
        title="Dual Deployment Modes"
        body="Run clients on your cluster, or hand them their own server."
      />
      <Segmented<DeployMode>
        label="Deployment mode"
        value={mode}
        onChange={setMode}
        className="mb-4 flex w-full"
        optionClassName="flex-1 text-center"
        options={[
          { value: "cloud", label: "Multi-Tenant Agency Cloud" },
          { value: "vps", label: "Dedicated Client VPS" },
        ]}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={mode}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
          transition={SPRING}
        >
          {mode === "cloud" ? <CloudDiagram /> : <VpsDiagram />}
          <ul className="mt-4 space-y-2">
            {DEPLOY_FACTS[mode].map((fact) => (
              <li key={fact} className="flex items-start gap-2 text-sm text-ink-2">
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-signal" />
                {fact}
              </li>
            ))}
          </ul>
        </motion.div>
      </AnimatePresence>
    </SpotlightCard>
  );
}

// ---------------------------------------------------- card 4: zero-trust guardrails
const GUARDRAILS = [
  {
    id: "caps",
    directive: "cap_drop: ALL",
    detail: "cap_add: CHOWN SETUID SETGID FOWNER DAC_OVERRIDE",
    why: "Starts from zero Linux capabilities and adds back only the five the init system needs. NET_RAW, NET_ADMIN, SYS_ADMIN and SYS_PTRACE stay dropped.",
  },
  {
    id: "privs",
    directive: "no-new-privileges:true",
    detail: "security_opt",
    why: "A process inside the container cannot gain extra rights through setuid binaries, even if it finds one.",
  },
  {
    id: "loopback",
    directive: "127.0.0.1:<port>",
    detail: "loopback port binding",
    why: "Tenant ports publish on the host's loopback only. Public traffic has to pass through the reverse proxy, so no container is directly exposed.",
  },
  {
    id: "limits",
    directive: "2GB RAM / 1.0 vCPU",
    detail: "hard container caps, pids_limit 200",
    why: "Docker enforces memory, CPU and process limits per tenant, so one busy agent cannot starve its neighbours.",
  },
];

function GuardrailsCard() {
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root, { amount: 0.25 });
  const [selected, setSelected] = useState("caps");
  const [memory, setMemory] = useState(1.1);
  const [cpu, setCpu] = useState(0.42);

  useEffect(() => {
    if (!inView) return;
    const timer = setInterval(() => {
      setMemory((value) => Math.min(1.7, Math.max(0.8, value + (Math.random() - 0.5) * 0.14)));
      setCpu((value) => Math.min(0.8, Math.max(0.15, value + (Math.random() - 0.5) * 0.12)));
    }, 1500);
    return () => clearInterval(timer);
  }, [inView]);

  const active = GUARDRAILS.find((rail) => rail.id === selected) ?? GUARDRAILS[0];

  return (
    <SpotlightCard id="security" variants={riseIn} className="p-5 sm:p-7 lg:col-span-7">
      <div ref={root}>
        <CardHeading
          title="Zero-Trust Container Guardrails"
          body="Every tenant starts inside the same hardened envelope. Select a directive to see what it stops."
        />
        <div className="grid gap-5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <ul className="space-y-2">
            {GUARDRAILS.map((rail) => {
              const isActive = rail.id === selected;
              return (
                <li key={rail.id}>
                  <button
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => setSelected(rail.id)}
                    className={cn(
                      "relative flex min-h-14 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors duration-200",
                      isActive ? "border-signal/40 bg-signal/6" : "border-white/7 hover:border-white/15",
                    )}
                  >
                    <ShieldCheck aria-hidden className={cn("size-4 shrink-0", isActive ? "text-signal" : "text-ink-3")} />
                    <span className="min-w-0">
                      <code className="block font-mono text-xs font-medium tracking-tight text-ink">{rail.directive}</code>
                      <span className="block font-mono text-[11px] leading-snug tracking-tight text-ink-3">{rail.detail}</span>
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10.5px] uppercase tracking-wider text-signal">enforced</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-col justify-between gap-5 rounded-2xl border border-white/7 bg-black/25 p-4">
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={active.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                transition={SPRING}
                className="text-sm leading-relaxed text-ink-2"
              >
                {active.why}
              </motion.p>
            </AnimatePresence>
            <div className="space-y-3">
              <p className="font-mono text-[10.5px] uppercase tracking-wider text-ink-3">Example tenant (simulated)</p>
              <div>
                <div className="mb-1.5 flex justify-between font-mono text-xs tabular-nums text-ink-2">
                  <span>memory</span>
                  <span>{memory.toFixed(1)}GB / 2.0GB</span>
                </div>
                <Meter value={memory} max={2} label="Memory" valueText={`${memory.toFixed(1)}GB of 2.0GB`} />
              </div>
              <div>
                <div className="mb-1.5 flex justify-between font-mono text-xs tabular-nums text-ink-2">
                  <span>cpu</span>
                  <span>{cpu.toFixed(2)} / 1.0 vCPU</span>
                </div>
                <Meter value={cpu} max={1} label="CPU" valueText={`${cpu.toFixed(2)} of 1.0 vCPU`} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </SpotlightCard>
  );
}

// ------------------------------------------------------------------------ section
export function BentoFeatures() {
  return (
    <section id="architecture" className="mx-auto max-w-7xl px-4 py-24 sm:px-6">
      <SectionHeading eyebrow="Architecture" title="One control plane. An isolated agent per client.">
        Every tenant gets its own container, memory and schedule inside the same hardened envelope, so adding a client
        never means adding risk to the others.
      </SectionHeading>
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.08 }}
        className="grid grid-cols-1 gap-4 lg:grid-cols-12"
      >
        <CronMatrixCard />
        <DiffViewerCard />
        <DeploymentCard />
        <GuardrailsCard />
      </motion.div>
    </section>
  );
}
