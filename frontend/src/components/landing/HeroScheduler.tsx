"use client";

import {
  AnimatePresence,
  motion,
  useInView,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import {
  ArrowRight,
  BookMarked,
  Cpu,
  Database,
  FileCode2,
  MessageCircle,
  Mic,
  Pause,
  Play,
  ShoppingBag,
  Sunrise,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
} from "react";
import { StatusOrb } from "@/components/ui/StatusOrb";
import { SPRING, riseIn, staggerContainer } from "@/lib/motion";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------ graph model
type NodeId =
  | "whatsapp"
  | "telegram"
  | "orders"
  | "crm"
  | "memory"
  | "skills"
  | "briefing"
  | "mcp"
  | "core";

interface GraphNode {
  id: Exclude<NodeId, "core">;
  label: string;
  meta: string;
  icon: LucideIcon;
  feeds?: NodeId[];
}

const INPUTS: GraphNode[] = [
  { id: "whatsapp", label: "WhatsApp Gateway", meta: "inbound messages", icon: MessageCircle, feeds: ["memory", "skills"] },
  { id: "telegram", label: "Telegram Voice Notes", meta: "voice to transcript", icon: Mic, feeds: ["memory", "briefing"] },
  { id: "orders", label: "E-Commerce Orders", meta: "shopify webhook", icon: ShoppingBag, feeds: ["skills", "mcp"] },
  { id: "crm", label: "CRM Webhooks", meta: "deal.updated", icon: Webhook, feeds: ["memory", "mcp"] },
];

const OUTPUTS: GraphNode[] = [
  { id: "memory", label: "MEMORY.md Vault", meta: "persistent per tenant", icon: BookMarked },
  { id: "skills", label: "SKILL.md Library", meta: "auto-generated", icon: FileCode2 },
  { id: "briefing", label: "Morning Cron Briefing", meta: "08:00 UTC", icon: Sunrise },
  { id: "mcp", label: "MCP Inspector", meta: "postgres / mongodb", icon: Database },
];

interface Layout {
  width: number;
  height: number;
  /** Node centre in viewBox units. */
  nodes: Record<Exclude<NodeId, "core">, { x: number; y: number }>;
  core: { x: number; y: number };
  routeIn: (from: { x: number; y: number }) => string;
  routeOut: (to: { x: number; y: number }) => string;
  nodeWidthClass: string;
  /** Two-up phone layout: no room for the meta line, so labels wrap instead. */
  compact: boolean;
}

const WIDE: Layout = {
  width: 960,
  height: 440,
  nodes: {
    whatsapp: { x: 118, y: 64 },
    telegram: { x: 118, y: 168 },
    orders: { x: 118, y: 272 },
    crm: { x: 118, y: 376 },
    memory: { x: 842, y: 64 },
    skills: { x: 842, y: 168 },
    briefing: { x: 842, y: 272 },
    mcp: { x: 842, y: 376 },
  },
  core: { x: 480, y: 220 },
  routeIn: ({ x, y }) => `M ${x + 108} ${y} C ${x + 228} ${y}, 345 220, 416 220`,
  routeOut: ({ x, y }) => `M 544 220 C 615 220, ${x - 228} ${y}, ${x - 108} ${y}`,
  nodeWidthClass: "w-[22.5%]",
  compact: false,
};

const NARROW: Layout = {
  width: 360,
  height: 590,
  nodes: {
    whatsapp: { x: 91, y: 38 },
    telegram: { x: 269, y: 38 },
    orders: { x: 91, y: 110 },
    crm: { x: 269, y: 110 },
    memory: { x: 91, y: 480 },
    skills: { x: 269, y: 480 },
    briefing: { x: 91, y: 552 },
    mcp: { x: 269, y: 552 },
  },
  core: { x: 180, y: 295 },
  routeIn: ({ x, y }) => `M ${x} ${y + 30} C ${x} ${y + 95}, 180 170, 180 233`,
  routeOut: ({ x, y }) => `M 180 357 C 180 420, ${x} ${y - 95}, ${x} ${y - 30}`,
  nodeWidthClass: "w-[47.5%]",
  compact: true,
};

function linkedTo(node: NodeId): Set<NodeId> {
  if (node === "core") return new Set<NodeId>([...INPUTS, ...OUTPUTS].map((n) => n.id));
  const input = INPUTS.find((n) => n.id === node);
  if (input) return new Set<NodeId>([input.id, ...(input.feeds ?? [])]);
  const feeders = INPUTS.filter((n) => n.feeds?.includes(node)).map((n) => n.id);
  return new Set<NodeId>([node, ...feeders]);
}

function routeSummary(node: NodeId): string {
  if (node === "core") return "core engine -> every channel, memory and skill route";
  const input = INPUTS.find((n) => n.id === node);
  if (input) {
    const targets = (input.feeds ?? []).map((id) => OUTPUTS.find((o) => o.id === id)?.label);
    return `${input.label} -> core engine -> ${targets.join(" + ")}`;
  }
  const output = OUTPUTS.find((n) => n.id === node);
  const sources = INPUTS.filter((n) => n.feeds?.includes(node)).map((n) => n.label);
  return `${sources.join(" + ")} -> core engine -> ${output?.label}`;
}

// ---------------------------------------------------------------- cron timeline
const WINDOW_START = 7 * 3600 + 59 * 60;
const WINDOW_SPAN = 600;
const SIM_START = 8 * 3600 + 2;
const SIM_STEP = 5;

interface CronJob {
  id: string;
  name: string;
  cron: string;
  runs: number[];
  span: number;
  tenant: string;
  skill: string;
  from: NodeId;
  to: NodeId;
}

const everyFrom = (start: number, every: number) => {
  const runs: number[] = [];
  for (let t = start; t < WINDOW_START + WINDOW_SPAN; t += every) runs.push(t);
  return runs;
};

const JOBS: CronJob[] = [
  {
    id: "briefing",
    name: "Morning Briefing",
    cron: "0 8 * * *",
    runs: [8 * 3600],
    span: 30,
    tenant: "tenant_suvana",
    skill: "daily_executive_briefing",
    from: "crm",
    to: "briefing",
  },
  {
    id: "triage",
    name: "60s Lead Triage",
    cron: "* * * * *",
    runs: everyFrom(WINDOW_START, 60),
    span: 12,
    tenant: "tenant_kestrel",
    skill: "lead_qualification",
    from: "whatsapp",
    to: "memory",
  },
  {
    id: "recon",
    name: "Order Reconciliation",
    cron: "*/3 * * * *",
    runs: everyFrom(8 * 3600, 180),
    span: 22,
    tenant: "tenant_suvana",
    skill: "order_reconciliation",
    from: "orders",
    to: "mcp",
  },
  {
    id: "digest",
    name: "PR & Deploy Digest",
    cron: "6 8 * * 1-5",
    runs: [8 * 3600 + 360],
    span: 26,
    tenant: "tenant_quarry",
    skill: "pr_deployment_digest",
    from: "telegram",
    to: "skills",
  },
];

interface TickerLine {
  id: number;
  time: string;
  text: string;
  channel: NodeId;
}

const clock = (seconds: number) => {
  const s = ((seconds % 86400) + 86400) % 86400;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

const INITIAL_LINES: TickerLine[] = [
  { id: 1, time: "07:59:41", text: "tenant_kestrel -> executed skill: lead_qualification (88ms)", channel: "whatsapp" },
  { id: 2, time: "07:59:48", text: "tenant_orchid -> committed MEMORY.md (+3 lines, 41ms)", channel: "memory" },
  { id: 3, time: "07:59:55", text: "tenant_lumen -> transcribed voice note (1.8s audio, 310ms)", channel: "telegram" },
  { id: 4, time: "08:00:00", text: "tenant_suvana -> cron fired: daily_executive_briefing (0 8 * * *)", channel: "briefing" },
  { id: 5, time: "08:00:02", text: "tenant_suvana -> executed skill: order_reconciliation (142ms)", channel: "orders" },
];

const AMBIENT: { tenant: string; text: (ms: number) => string; channel: NodeId }[] = [
  { tenant: "tenant_orchid", text: (ms) => `committed MEMORY.md (+2 lines, ${ms}ms)`, channel: "memory" },
  { tenant: "tenant_lumen", text: (ms) => `executed skill: ecommerce_lookup (${ms}ms)`, channel: "orders" },
  { tenant: "tenant_harbor", text: (ms) => `authored SKILL.md: refund_triage (${ms}ms)`, channel: "skills" },
  { tenant: "tenant_marigold", text: (ms) => `transcribed voice note (2.4s audio, ${ms}ms)`, channel: "telegram" },
  { tenant: "tenant_atlas", text: (ms) => `crm webhook routed: deal.updated (${ms}ms)`, channel: "crm" },
  { tenant: "tenant_tern", text: (ms) => `mcp query: postgres.orders (${ms}ms)`, channel: "mcp" },
  { tenant: "tenant_kestrel", text: (ms) => `whatsapp reply sent (${ms}ms)`, channel: "whatsapp" },
];

// --------------------------------------------------------------------- graph
interface Burst {
  id: number;
  from: NodeId;
  to: NodeId;
}

const subscribeWide = (notify: () => void) => {
  const query = window.matchMedia("(min-width: 1024px)");
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};

function useIsWide(): boolean | null {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia("(min-width: 1024px)").matches,
    () => null,
  );
}

function Route({
  d,
  index,
  color,
  dimmed,
  lit,
  animated,
}: {
  d: string;
  index: number;
  color: string;
  dimmed: boolean;
  lit: boolean;
  animated: boolean;
}) {
  const duration = 2.6 + (index % 4) * 0.35;
  const delay = index * 0.27;
  const packet = {
    initial: { strokeDashoffset: 1 },
    animate: { strokeDashoffset: 0 },
    transition: { duration, delay, ease: "linear" as const, repeat: Infinity },
  };
  return (
    <g style={{ opacity: dimmed ? 0.14 : 1, transition: "opacity 220ms" }}>
      <motion.path
        d={d}
        fill="none"
        stroke={lit ? color : "rgb(255 255 255 / 0.13)"}
        strokeWidth={lit ? 1.6 : 1.1}
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 1.1, delay: 0.25 + index * 0.05, ease: "easeInOut" }}
      />
      {animated && !dimmed && (
        <>
          <motion.path
            d={d}
            pathLength={1}
            fill="none"
            stroke={color}
            strokeOpacity={0.26}
            strokeWidth={7}
            strokeLinecap="round"
            strokeDasharray="0.03 1"
            {...packet}
          />
          <motion.path
            d={d}
            pathLength={1}
            fill="none"
            stroke={color}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeDasharray="0.03 1"
            {...packet}
          />
        </>
      )}
    </g>
  );
}

function CoreRings({ x, y, animated }: { x: number; y: number; animated: boolean }) {
  return (
    <g>
      {[68, 90, 112].map((r, index) => (
        <motion.circle
          key={r}
          cx={x}
          cy={y}
          r={r}
          fill="none"
          stroke={index === 1 ? "var(--color-hyper)" : "var(--color-signal)"}
          strokeWidth={1}
          initial={{ opacity: 0.32 }}
          animate={animated ? { opacity: [0.34, 0.08, 0.34], r: [r, r + 5, r] } : { opacity: 0.22 }}
          transition={
            animated
              ? { duration: 3.6, delay: index * 0.5, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.2 }
          }
        />
      ))}
    </g>
  );
}

function NodeCard({
  node,
  layout,
  state,
  onHover,
  onPick,
}: {
  node: GraphNode;
  layout: Layout;
  state: "idle" | "lit" | "dim" | "picked";
  onHover: (id: NodeId | null) => void;
  onPick: (id: NodeId) => void;
}) {
  const position = layout.nodes[node.id];
  const Icon = node.icon;
  return (
    <motion.button
      type="button"
      aria-pressed={state === "picked"}
      onPointerEnter={(event) => event.pointerType === "mouse" && onHover(node.id)}
      onPointerLeave={(event) => event.pointerType === "mouse" && onHover(null)}
      onFocus={() => onHover(node.id)}
      onBlur={() => onHover(null)}
      onClick={() => onPick(node.id)}
      whileHover={{ scale: 1.025 }}
      whileTap={{ scale: 0.98 }}
      transition={SPRING}
      style={{
        left: `${(position.x / layout.width) * 100}%`,
        top: `${(position.y / layout.height) * 100}%`,
        translateX: "-50%",
        translateY: "-50%",
      }}
      className={cn(
        "absolute flex min-h-13.5 items-center gap-2.5 rounded-2xl border bg-[#0c0c13]/90 px-2.5 py-2 text-left transition-[opacity,border-color,box-shadow] duration-200",
        layout.nodeWidthClass,
        state === "dim" ? "border-white/5 opacity-45" : "border-white/9",
        (state === "lit" || state === "picked") &&
          "border-signal/50 shadow-[0_0_24px_-6px_rgb(0_245_212/0.5)]",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-xl bg-white/5 text-ink-2 transition-colors",
          (state === "lit" || state === "picked") && "bg-signal/15 text-signal",
        )}
      >
        <Icon aria-hidden className="size-4" />
      </span>
      <span className="min-w-0">
        <span className={cn("block text-xs font-semibold text-ink", layout.compact ? "leading-tight" : "truncate")}>
          {node.label}
        </span>
        {!layout.compact && <span className="block truncate font-mono text-[10.5px] text-ink-3">{node.meta}</span>}
      </span>
    </motion.button>
  );
}

function Graph({
  layout,
  className,
  animated,
  focus,
  picked,
  bursts,
  onHover,
  onPick,
  onBurstDone,
}: {
  layout: Layout;
  className: string;
  animated: boolean;
  focus: NodeId | null;
  picked: NodeId | null;
  bursts: Burst[];
  onHover: (id: NodeId | null) => void;
  onPick: (id: NodeId) => void;
  onBurstDone: (id: number) => void;
}) {
  const linked = useMemo(() => (focus ? linkedTo(focus) : null), [focus]);
  const gradientId = useId().replace(/[^a-zA-Z0-9]/g, "");

  const nodeState = (id: NodeId) => {
    if (picked === id) return "picked" as const;
    if (!linked) return "idle" as const;
    return linked.has(id) ? ("lit" as const) : ("dim" as const);
  };

  const routePath = (id: NodeId): string | null => {
    if (id === "core") return null;
    const position = layout.nodes[id];
    return INPUTS.some((n) => n.id === id) ? layout.routeIn(position) : layout.routeOut(position);
  };

  return (
    <div
      className={cn("relative w-full", className)}
      style={{ aspectRatio: `${layout.width} / ${layout.height}` }}
    >
      <svg
        aria-hidden
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="absolute inset-0 size-full overflow-visible"
      >
        <defs>
          <radialGradient id={gradientId}>
            <stop offset="0" stopColor="var(--color-signal)" stopOpacity="0.3" />
            <stop offset="0.55" stopColor="var(--color-hyper)" stopOpacity="0.16" />
            <stop offset="1" stopColor="var(--color-hyper)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx={layout.core.x} cy={layout.core.y} r={150} fill={`url(#${gradientId})`} />
        {INPUTS.map((node, index) => (
          <Route
            key={node.id}
            d={layout.routeIn(layout.nodes[node.id])}
            index={index}
            color="var(--color-signal)"
            dimmed={!!linked && !linked.has(node.id)}
            lit={!!linked && linked.has(node.id)}
            animated={animated}
          />
        ))}
        {OUTPUTS.map((node, index) => (
          <Route
            key={node.id}
            d={layout.routeOut(layout.nodes[node.id])}
            index={index + 4}
            color="var(--color-hyper-soft)"
            dimmed={!!linked && !linked.has(node.id)}
            lit={!!linked && linked.has(node.id)}
            animated={animated}
          />
        ))}
        <CoreRings x={layout.core.x} y={layout.core.y} animated={animated} />
        {bursts.flatMap((burst) => {
          const first = routePath(burst.from);
          const second = routePath(burst.to);
          return [first, second].map(
            (d, leg) =>
              d && (
                <motion.path
                  key={`${burst.id}-${leg}`}
                  d={d}
                  pathLength={1}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeDasharray="0.07 1.07"
                  initial={{ strokeDashoffset: 0.07, opacity: 1 }}
                  animate={{ strokeDashoffset: -1, opacity: [1, 1, 0] }}
                  transition={{ duration: 0.75, delay: leg * 0.55, ease: "easeInOut" }}
                  onAnimationComplete={leg === 1 ? () => onBurstDone(burst.id) : undefined}
                />
              ),
          );
        })}
      </svg>

      {INPUTS.concat(OUTPUTS).map((node) => (
        <NodeCard
          key={node.id}
          node={node}
          layout={layout}
          state={nodeState(node.id)}
          onHover={onHover}
          onPick={onPick}
        />
      ))}

      <motion.button
        type="button"
        aria-pressed={picked === "core"}
        onPointerEnter={(event) => event.pointerType === "mouse" && onHover("core")}
        onPointerLeave={(event) => event.pointerType === "mouse" && onHover(null)}
        onFocus={() => onHover("core")}
        onBlur={() => onHover(null)}
        onClick={() => onPick("core")}
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        transition={SPRING}
        style={{
          left: `${(layout.core.x / layout.width) * 100}%`,
          top: `${(layout.core.y / layout.height) * 100}%`,
          translateX: "-50%",
          translateY: "-50%",
        }}
        className="absolute flex aspect-square w-27 flex-col items-center justify-center rounded-full border border-signal/40 bg-[#0a0a11] text-center shadow-[0_0_50px_-8px_rgb(0_245_212/0.55)] lg:w-[13.5%]"
      >
        <Cpu aria-hidden className="mb-1 size-5 text-signal" />
        <span className="px-2 text-[10.5px] font-semibold leading-tight text-ink">Core Autonomous Engine</span>
      </motion.button>
    </div>
  );
}

// ------------------------------------------------------------------- timeline
function Timeline({
  sim,
  onRun,
}: {
  sim: number;
  onRun: (job: CronJob) => void;
}) {
  const position = ((sim - WINDOW_START) / WINDOW_SPAN) * 100;
  const left = (seconds: number) => `${((seconds - WINDOW_START) / WINDOW_SPAN) * 100}%`;
  const ticks = [0, 120, 240, 360, 480, 600];

  return (
    <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 sm:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
      <div>
        <div className="flex h-5 items-center px-2 font-mono text-[10.5px] uppercase tracking-wider text-ink-3">
          Tap to run
        </div>
        {JOBS.map((job) => (
          <button
            key={job.id}
            type="button"
            onClick={() => onRun(job)}
            aria-label={`Run ${job.name} now`}
            className="group flex h-11 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-white/5 sm:h-9"
          >
            <Play aria-hidden className="size-3 shrink-0 text-ink-3 transition-colors group-hover:text-signal" />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium text-ink">{job.name}</span>
              <span className="block truncate font-mono text-[10.5px] text-ink-3 sm:hidden">{job.cron}</span>
            </span>
            <span className="ml-auto hidden shrink-0 font-mono text-[10.5px] text-ink-3 sm:block">{job.cron}</span>
          </button>
        ))}
      </div>

      <div className="relative min-w-0">
        <div className="relative h-5">
          {ticks.map((tick, index) => (
            <span
              key={tick}
              className={cn(
                "absolute top-0.5 font-mono text-[10.5px] tabular-nums text-ink-3",
                index % 2 === 1 && "max-sm:hidden",
                index === 0 ? "translate-x-0" : index === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
              )}
              style={{ left: `${(tick / WINDOW_SPAN) * 100}%` }}
            >
              {clock(WINDOW_START + tick).slice(0, 5)}
            </span>
          ))}
        </div>
        {JOBS.map((job) => (
          <div key={job.id} className="flex h-11 items-center sm:h-9">
            <div className="relative h-5 w-full overflow-hidden rounded-md bg-white/3">
              {job.runs.map((run) => {
                const running = sim >= run && sim <= run + job.span;
                const past = sim > run + job.span;
                return (
                  <span
                    key={run}
                    title={`${job.name} at ${clock(run)} UTC`}
                    className={cn(
                      "absolute inset-y-0.75 min-w-0.75 rounded-[3px] transition-colors duration-300",
                      running ? "bg-signal" : past ? "bg-hyper/55" : "bg-white/20",
                    )}
                    style={{ left: left(run), width: `${(job.span / WINDOW_SPAN) * 100}%` }}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 top-5 overflow-hidden">
          <motion.div
            className="absolute inset-y-0 left-0 w-full"
            initial={false}
            animate={{ x: `${position}%` }}
            transition={{ duration: position < 2 ? 0 : 1, ease: "linear" }}
          >
            <span className="absolute inset-y-0 left-0 w-px bg-signal shadow-[0_0_8px_var(--color-signal)]" />
          </motion.div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- showcase
function SchedulerShowcase() {
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root, { amount: 0.1 });
  const reduced = useReducedMotion() ?? false;
  const isWide = useIsWide();

  const [paused, setPaused] = useState(false);
  const [sim, setSim] = useState(SIM_START);
  const simRef = useRef(SIM_START);
  const [lines, setLines] = useState<TickerLine[]>(INITIAL_LINES);
  const [hovered, setHovered] = useState<NodeId | null>(null);
  const [picked, setPicked] = useState<NodeId | null>(null);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const nextId = useRef(100);

  const running = inView && !paused;
  const animatedPackets = running && !reduced;
  const focus = hovered ?? picked;

  const appendLine = useCallback((line: Omit<TickerLine, "id">) => {
    const id = nextId.current;
    nextId.current += 1;
    setLines((current) => [...current.slice(-4), { ...line, id }]);
  }, []);

  const fireBurst = useCallback((job: CronJob) => {
    const id = nextId.current;
    nextId.current += 1;
    setBursts((active) => [...active.slice(-3), { id, from: job.from, to: job.to }]);
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const current = simRef.current;
      const next = current + SIM_STEP > WINDOW_START + WINDOW_SPAN ? WINDOW_START + 30 : current + SIM_STEP;
      simRef.current = next;
      setSim(next);

      for (const job of JOBS) {
        const fired = job.runs.find((run) => run > current && run <= next);
        if (fired === undefined) continue;
        const ms = 60 + Math.floor(Math.random() * 180);
        appendLine({ time: clock(fired), text: `${job.tenant} -> executed skill: ${job.skill} (${ms}ms)`, channel: job.from });
        fireBurst(job);
      }
      if (Math.random() < 0.55) {
        const event = AMBIENT[Math.floor(Math.random() * AMBIENT.length)];
        const ms = 30 + Math.floor(Math.random() * 280);
        appendLine({ time: clock(next), text: `${event.tenant} -> ${event.text(ms)}`, channel: event.channel });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [running, appendLine, fireBurst]);

  function runJob(job: CronJob) {
    const ms = 60 + Math.floor(Math.random() * 180);
    appendLine({ time: clock(sim), text: `${job.tenant} -> manual run: ${job.skill} (${ms}ms)`, channel: job.from });
    fireBurst(job);
    setPicked(job.to);
  }

  const onPick = useCallback((id: NodeId) => setPicked((current) => (current === id ? null : id)), []);
  const onBurstDone = useCallback(
    (id: number) => setBursts((active) => active.filter((burst) => burst.id !== id)),
    [],
  );

  const linked = focus ? linkedTo(focus) : null;

  // Pointer tilt for depth. Skipped for touch and reduced motion.
  const tiltX = useMotionValue(0);
  const tiltY = useMotionValue(0);
  const springX = useSpring(tiltX, { stiffness: 120, damping: 20, mass: 0.6 });
  const springY = useSpring(tiltY, { stiffness: 120, damping: 20, mass: 0.6 });
  const rotateY = useTransform(springX, [-0.5, 0.5], [-2.4, 2.4]);
  const rotateX = useTransform(springY, [-0.5, 0.5], [2, -2]);

  function tilt(event: PointerEvent<HTMLDivElement>) {
    if (reduced || event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    tiltX.set((event.clientX - rect.left) / rect.width - 0.5);
    tiltY.set((event.clientY - rect.top) / rect.height - 0.5);
  }

  function resetTilt() {
    tiltX.set(0);
    tiltY.set(0);
  }

  return (
    <div className="perspective-[1600px]" ref={root}>
      <motion.div
        onPointerMove={tilt}
        onPointerLeave={resetTilt}
        style={{ rotateX, rotateY }}
        className="surface sheen overflow-hidden rounded-[28px] shadow-[0_40px_120px_-40px_rgb(99_102_241/0.45)]"
      >
        <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-white/7 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <StatusOrb tone={paused ? "muted" : "signal"} pulse={!paused} />
            <h2 className="text-sm font-semibold text-ink">Agent Scheduler</h2>
            <span className="rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10.5px] text-ink-3">
              simulated data
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs tabular-nums text-ink-2">{clock(sim)} UTC</span>
            <button
              type="button"
              onClick={() => setPaused((value) => !value)}
              aria-label={paused ? "Resume the simulation" : "Pause the simulation"}
              className="inline-flex size-9 items-center justify-center rounded-lg border border-white/10 text-ink-2 transition-colors hover:border-white/25 hover:text-ink"
            >
              {paused ? <Play aria-hidden className="size-3.5" /> : <Pause aria-hidden className="size-3.5" />}
            </button>
          </div>
        </div>

        <div className="relative px-3 pb-2 pt-5 sm:px-6">
          <div className="mx-auto max-w-md lg:max-w-none">
            <Graph
              layout={WIDE}
              className="hidden lg:block"
              animated={animatedPackets && isWide === true}
              focus={focus}
              picked={picked}
              bursts={isWide === true ? bursts : []}
              onHover={setHovered}
              onPick={onPick}
              onBurstDone={onBurstDone}
            />
            <Graph
              layout={NARROW}
              className="lg:hidden"
              animated={animatedPackets && isWide === false}
              focus={focus}
              picked={picked}
              bursts={isWide === false ? bursts : []}
              onHover={setHovered}
              onPick={onPick}
              onBurstDone={onBurstDone}
            />
          </div>
          <p className="mt-3 flex min-h-5 items-center justify-center text-center font-mono text-[11px] text-ink-3">
            {focus ? routeSummary(focus) : "Hover or tap a node to trace its route"}
          </p>
        </div>

        <div className="relative border-t border-white/7 px-4 py-4 sm:px-6">
          <Timeline sim={sim} onRun={runJob} />
        </div>

        <div
          role="log"
          aria-label="Simulated agent executions"
          aria-live="off"
          className="relative h-33 overflow-hidden border-t border-white/7 bg-black/35 px-4 py-3 font-mono text-[11px] tabular-nums leading-6 sm:px-6 sm:text-xs"
        >
          <AnimatePresence initial={false} mode="popLayout">
            {lines.map((line) => (
              <motion.div
                key={line.id}
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: linked && !linked.has(line.channel) ? 0.35 : 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                transition={SPRING}
                className="truncate"
              >
                <span className="text-ink-3">[{line.time}]</span>{" "}
                <span className={cn(linked?.has(line.channel) ? "text-signal" : "text-ink-2")}>{line.text}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

// ----------------------------------------------------------------------- hero
export function HeroScheduler() {
  return (
    <section id="scheduler" className="relative mx-auto max-w-7xl px-4 pb-24 pt-32 sm:px-6 sm:pt-40">
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="mx-auto mb-14 flex max-w-4xl flex-col items-center text-center"
      >
        <motion.div
          variants={riseIn}
          className="inline-flex items-center gap-2 rounded-full border border-signal/30 bg-signal/7 px-3 py-1.5 font-mono text-[10.5px] tracking-wide text-signal shadow-[0_0_24px_-6px_rgb(0_245_212/0.5)] sm:text-[11px]"
        >
          <StatusOrb tone="signal" />
          AUTONOMOUS AI OPERATIONS ENGINE v2.4 • MULTI-TENANT READY
        </motion.div>
        <motion.h1
          variants={riseIn}
          className="text-gradient mt-7 text-balance pb-1 text-[2.5rem] font-semibold leading-[1.06] tracking-[-0.03em] sm:text-6xl lg:text-7xl"
        >
          Deploy Self-Improving AI Operations Agents Across Every Client Workflow.
        </motion.h1>
        <motion.p variants={riseIn} className="mt-6 max-w-2xl text-pretty text-base leading-relaxed text-ink-2 sm:text-lg">
          Give each client an isolated agent that works their channels, remembers what it learns and writes its own
          playbooks. Provision one in a click and keep it on schedule from a single console.
        </motion.p>
        <motion.div variants={riseIn} className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/admin?provision=cluster"
            className="inline-flex min-h-12 items-center gap-2 rounded-full bg-signal px-6 text-sm font-semibold text-obsidian shadow-[0_0_34px_-6px_rgb(0_245_212/0.7)] transition-colors hover:bg-[#3ff9e2]"
          >
            Deploy Client Agent
            <ArrowRight aria-hidden className="size-4" />
          </Link>
          <Link
            href="/admin"
            className="inline-flex min-h-12 items-center rounded-full border border-white/12 bg-white/4 px-6 text-sm font-medium text-ink transition-colors hover:border-white/25 hover:bg-white/7"
          >
            Launch Agency Console
          </Link>
        </motion.div>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 34 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SPRING, delay: 0.3 }}>
        <SchedulerShowcase />
      </motion.div>
    </section>
  );
}
