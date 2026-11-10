"use client";

import { motion } from "motion/react";
import {
  CheckCircle2,
  Globe2,
  Hash,
  KeyRound,
  Mic,
  Share2,
  Sparkles,
  Plus,
  QrCode,
  RotateCw,
  Send,
  ShieldAlert,
  Smartphone,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChannelConnectDrawer, type ConnectTarget } from "@/components/portal/ChannelConnectDrawer";
import { ScannerFrame, SimulateScanButton } from "@/components/portal/WhatsAppQr";
import { Dialog } from "@/components/ui/Dialog";
import { SpotlightCard } from "@/components/ui/SpotlightCard";
import { StatusOrb, type OrbTone } from "@/components/ui/StatusOrb";
import { useToast } from "@/components/ui/Toaster";
import type { ChannelName, ChannelStatus, ChannelTestResult, PortalChannel, PortalClient, ReconnectResult } from "@/lib/portal-api";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

const CHANNEL_META: Record<ChannelName, { title: MessageKey; short: MessageKey; tiny: MessageKey; icon: LucideIcon; allowLabel: MessageKey; allowHint: string }> = {
  whatsapp: {
    title: "ch.whatsappTitle",
    short: "ch.whatsappShort",
    tiny: "ch.whatsappTiny",
    icon: Smartphone,
    allowLabel: "ch.whatsappAllow",
    allowHint: "+8801712345678",
  },
  telegram: {
    title: "ch.telegramTitle",
    short: "ch.telegramShort",
    tiny: "ch.telegramTiny",
    icon: Send,
    allowLabel: "ch.telegramAllow",
    allowHint: "123456789",
  },
  slack: { title: "ch.slackTitle", short: "ch.slackShort", tiny: "ch.slackShort", icon: Hash, allowLabel: "ch.slackAllow", allowHint: "U0123ABCD" },
  web_widget: { title: "ch.webTitle", short: "ch.webTitle", tiny: "ch.webTiny", icon: Globe2, allowLabel: "ch.webTitle", allowHint: "" },
};

const STATUS_META: Record<ChannelStatus, { tone: OrbTone; label: MessageKey; className: string; stroke: string }> = {
  connected: { tone: "signal", label: "ch.statusConnected", className: "border-signal/30 bg-signal/10 text-signal", stroke: "var(--color-signal)" },
  connecting: { tone: "muted", label: "ch.statusConnecting", className: "border-hyper/40 bg-hyper/12 text-hyper-soft", stroke: "var(--color-hyper)" },
  action_needed: { tone: "warn", label: "ch.statusAction", className: "border-warn/35 bg-warn/10 text-warn", stroke: "var(--color-warn)" },
  disconnected: { tone: "halt", label: "ch.statusDisconnected", className: "border-halt/35 bg-halt/10 text-halt-soft", stroke: "var(--color-halt)" },
  not_configured: { tone: "muted", label: "ch.statusNotSetUp", className: "border-white/12 bg-white/4 text-ink-3", stroke: "rgb(255 255 255 / 0.2)" },
};

/** Faster, busier dashes for busier channels, so the diagram reflects real traffic. */
function flowFor(volume: number | null): { pulses: number; duration: number } {
  const messages = volume ?? 0;
  if (messages >= 200) return { pulses: 3, duration: 2.2 };
  if (messages >= 50) return { pulses: 2, duration: 2.8 };
  return { pulses: 1, duration: 3.6 };
}

function StatusBadge({ channel }: { channel: PortalChannel }) {
  const { t } = useI18n();
  const meta = STATUS_META[channel.status];
  return (
    <span className={cn("inline-flex min-h-7 items-center gap-2 whitespace-nowrap rounded-full border px-2.5 font-mono text-[11px]", meta.className)}>
      <StatusOrb tone={meta.tone} pulse={channel.status === "connected"} />
      {t(meta.label)}
      {channel.sessionVerified && <span className="text-ink-2">• {t("ch.sessionVerified")}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------- the bridge
function GatewayBridge({
  channels,
  active,
  onActivate,
}: {
  channels: PortalChannel[];
  active: ChannelName | null;
  onActivate: (channel: ChannelName | null) => void;
}) {
  const { t, number } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // Real pixel coordinates rather than a stretched viewBox: a non-uniformly scaled
  // SVG distorts its strokes, and dash lengths along a normalised path go wrong.
  useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const total = channels.reduce((sum, channel) => sum + (channel.messages24h ?? 0), 0);
  const summary = channels
    .map((channel) => `${t(CHANNEL_META[channel.channel].short)}: ${t(STATUS_META[channel.status].label)}`)
    .join(", ");

  return (
    <SpotlightCard className="overflow-hidden p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{t("ch.bridge")}</h2>
        <p className="font-mono text-xs tabular-nums text-ink-3">{t("ch.messages24", { count: number(total) })}</p>
      </div>

      <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(28px,0.6fr)_auto] items-stretch sm:grid-cols-[minmax(0,240px)_minmax(80px,1fr)_auto]">
        <ul className="flex flex-col justify-around gap-3">
          {channels.map((channel) => {
            const meta = CHANNEL_META[channel.channel];
            const Icon = meta.icon;
            return (
              <li key={channel.channel}>
                <div
                  onPointerEnter={() => onActivate(channel.channel)}
                  onPointerLeave={() => onActivate(null)}
                  className={cn(
                    "flex min-h-14 items-center gap-2.5 rounded-xl border bg-white/3 px-2.5 py-2 transition-colors",
                    active === channel.channel ? "border-white/25" : "border-white/8",
                  )}
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-ink-2" />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-ink">
                      <span className="sm:hidden">{t(meta.tiny)}</span>
                      <span className="hidden sm:inline">{t(meta.short)}</span>
                    </p>
                    <p className="truncate font-mono text-[11px] tabular-nums text-ink-3">
                      {channel.messages24h != null ? `${number(channel.messages24h)} / 24h` : t(STATUS_META[channel.status].label)}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        <div ref={frame} className="relative min-h-44">
          {size.width > 0 && (
            <svg
              role="img"
              aria-label={t("ch.flowLabel", { summary })}
              width={size.width}
              height={size.height}
              viewBox={`0 0 ${size.width} ${size.height}`}
              className="absolute inset-0"
            >
              {channels.map((channel, index) => {
                const startY = ((index + 0.5) / channels.length) * size.height;
                const endY = size.height / 2;
                const middle = size.width / 2;
                const path = `M0 ${startY} C${middle} ${startY} ${middle} ${endY} ${size.width} ${endY}`;
                const meta = STATUS_META[channel.status];
                const live = channel.status === "connected";
                const { pulses, duration } = flowFor(channel.messages24h);
                const emphasised = active === null || active === channel.channel;
                return (
                  <g key={channel.channel} style={{ opacity: emphasised ? 1 : 0.3, transition: "opacity 200ms" }}>
                    <path
                      d={path}
                      fill="none"
                      stroke={live ? "rgb(255 255 255 / 0.1)" : meta.stroke}
                      strokeWidth="1.5"
                      strokeDasharray={live ? undefined : "4 6"}
                      strokeOpacity={live ? 1 : 0.55}
                    />
                    {live &&
                      Array.from({ length: pulses }, (_, pulse) => (
                        <path
                          key={pulse}
                          d={path}
                          fill="none"
                          pathLength={1}
                          stroke={meta.stroke}
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          className="bridge-flow"
                          style={
                            {
                              "--flow-duration": `${duration}s`,
                              "--flow-delay": `${-(pulse * duration) / pulses}s`,
                            } as React.CSSProperties
                          }
                        />
                      ))}
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        <div className="flex items-center">
          <div className="beam-ring relative flex w-24 flex-col items-center gap-2 rounded-2xl border border-white/10 bg-[#0a0a10] px-2 py-4 text-center sm:w-36 sm:px-3 sm:py-5">
            <span className="relative flex size-9 items-center justify-center rounded-full bg-signal/12">
              <StatusOrb tone="signal" className="size-2.5" />
            </span>
            <p className="text-xs font-semibold leading-tight text-ink">{t("ch.central")}</p>
          </div>
        </div>
      </div>
    </SpotlightCard>
  );
}

// ------------------------------------------------------------------ approved lists
function AllowlistEditor({
  channel,
  onUpdate,
}: {
  channel: PortalChannel;
  onUpdate: (change: { add?: string[]; removeIds?: string[] }) => Promise<string | null>;
}) {
  const { t } = useI18n();
  const meta = CHANNEL_META[channel.channel];
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();

  async function apply(change: { add?: string[]; removeIds?: string[] }) {
    setBusy(true);
    setError(null);
    const message = await onUpdate(change);
    setBusy(false);
    if (message) setError(message);
    return !message;
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const entry = value.trim();
    if (!entry || busy) return;
    if (await apply({ add: [entry] })) setValue("");
  }

  if (channel.allowAll) {
    return (
      <div className="mt-4 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/8 p-3 text-xs leading-relaxed text-ink-2">
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
        <p>{t("ch.allowAll")}</p>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-white/7 pt-4">
      <h4 className="text-xs font-medium text-ink-2">{t(meta.allowLabel)}</h4>
      {channel.allowlist.length === 0 ? (
        <p className="mt-2 text-xs text-ink-3">{t("ch.allowEmpty")}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {channel.allowlist.map((entry) => (
            <li key={entry.id} className="flex min-h-9 items-center justify-between gap-2 rounded-lg bg-white/3 pl-3 pr-1">
              <span className="truncate font-mono text-xs tabular-nums text-ink-2">{entry.display}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void apply({ removeIds: [entry.id] })}
                aria-label={t("ch.remove", { item: entry.display })}
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-halt/12 hover:text-halt-soft disabled:opacity-40"
              >
                <Trash2 aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="mt-2 flex gap-2">
        <label htmlFor={inputId} className="sr-only">
          {t("ch.addTo", { list: t(meta.allowLabel) })}
        </label>
        <input
          id={inputId}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={meta.allowHint}
          inputMode={channel.channel === "slack" ? "text" : "tel"}
          autoComplete="off"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className="field min-w-0 font-mono text-xs"
        />
        <motion.button
          type="submit"
          whileTap={{ scale: 0.95 }}
          transition={SPRING}
          disabled={!value.trim() || busy}
          aria-label={t("ch.addTo", { list: t(meta.allowLabel) })}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-white/12 text-ink-2 transition-colors hover:border-white/25 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus aria-hidden className="size-4" />
        </motion.button>
      </form>
      {error && (
        <p id={errorId} role="alert" className="mt-2 text-xs text-halt-soft">
          {error}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the link dialog
const PAIRING_POLL_MS = 3000;

function LinkDialogBody({
  client,
  channel,
  onClose,
  onChanged,
}: {
  client: PortalClient;
  channel: PortalChannel;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, number } = useI18n();
  const meta = CHANNEL_META[channel.channel];
  // A live session holds its link open, so only a broken one can start a new pairing.
  // Sample mode has no session to collide with, and this is how the flow gets previewed.
  const relinks = channel.channel === "whatsapp" && (channel.status !== "connected" || client.mode === "mock");
  const [test, setTest] = useState<ChannelTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<ReconnectResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const waiting = result?.state === "qr_pending" || result?.state === "qr_ready";

  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await client.pairingStatus();
        if (!cancelled) {
          setResult(next);
          if (next.state === "connected") onChanged();
        }
      } catch {
        // One missed poll is not a failure: the code stays up and the next poll retries.
      }
    }, PAIRING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, waiting, onChanged]);

  async function runTest() {
    setTesting(true);
    setError(null);
    try {
      setTest(await client.testChannel(channel.channel));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("ch.testFailed"));
    } finally {
      setTesting(false);
    }
  }

  async function reconnect() {
    setStarting(true);
    setError(null);
    try {
      const next = await client.reconnectChannel(channel.channel);
      setResult(next);
      if (next.state === "refreshing") onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("ch.reconnectFailed"));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="thin-scroll overflow-y-auto p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{relinks ? t("ch.relinkTitle") : t("ch.manageTitle", { channel: t(meta.short) })}</h2>
          <p className="mt-1 font-mono text-xs text-ink-3">{channel.maskedHandle ?? t("ch.noAccount")}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("ch.close")}
          className="-mr-2 -mt-2 inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-white/6 hover:text-ink"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      {waiting && result && (
        <div className="mt-5" aria-live="polite">
          {result.state === "qr_ready" ? (
            <ScannerFrame pairing={result} sample={client.mode === "mock"} />
          ) : (
            <div role="status" className="mx-auto flex size-56 items-center justify-center rounded-xl border border-white/10 bg-white/3 text-xs text-ink-3">
              {t("ch.preparing")}
            </div>
          )}
          <p className="mt-4 text-center text-sm leading-relaxed text-ink-2">{result.detail}</p>
          {result.qrRefreshSeconds != null && (
            <p className="mt-1 text-center font-mono text-xs tabular-nums text-ink-3">
              {t("ch.qrRefresh")}
            </p>
          )}
        </div>
      )}

      {result && !waiting && (
        <div
          role="status"
          className={cn(
            "mt-5 flex items-start gap-2 rounded-xl border p-3 text-sm",
            result.state === "failed" ? "border-warn/30 bg-warn/8 text-ink-2" : "border-signal/25 bg-signal/8 text-ink-2",
          )}
        >
          {result.state === "failed" ? (
            <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
          ) : (
            <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-signal" />
          )}
          <p>{result.detail}</p>
        </div>
      )}

      {test && (
        <div
          role="status"
          className={cn(
            "mt-5 rounded-xl border p-3 text-sm",
            test.ok ? "border-signal/25 bg-signal/8 text-ink-2" : "border-warn/30 bg-warn/8 text-ink-2",
          )}
        >
          <p>{test.detail}</p>
          {test.latencyMs != null && (
            <p className="mt-1 font-mono text-xs tabular-nums text-ink-3">{t("ch.roundTrip", { ms: number(Math.round(test.latencyMs)) })}</p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-halt-soft">
          {error}
        </p>
      )}

      {!relinks && !result && (
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          {t("ch.refreshNote")}
        </p>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          transition={SPRING}
          onClick={runTest}
          disabled={testing}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/12 px-4 text-sm font-medium text-ink transition-colors hover:border-white/25 disabled:opacity-50"
        >
          <Send aria-hidden className="size-4" />
          {testing ? t("ch.testing") : channel.channel === "telegram" ? t("ch.sendTest") : t("ch.testPing")}
        </motion.button>
        {waiting && (
          <SimulateScanButton
            client={client}
            onResult={(next) => {
              setResult(next);
              onChanged();
            }}
          />
        )}
        {!waiting && (
          <motion.button
            type="button"
            whileTap={{ scale: 0.97 }}
            transition={SPRING}
            onClick={reconnect}
            disabled={starting}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian disabled:opacity-50"
          >
            {relinks ? <QrCode aria-hidden className="size-4" /> : <RotateCw aria-hidden className="size-4" />}
            {starting ? t("ch.starting") : relinks ? t("ch.showQr") : t("ch.refreshConnection")}
          </motion.button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- channel cards
function ChannelCard({
  client,
  channel,
  highlighted,
  onHover,
  onManage,
  onConfigure,
  onUpdateAllowlist,
}: {
  client: PortalClient;
  channel: PortalChannel;
  highlighted: boolean;
  onHover: (channel: ChannelName | null) => void;
  onManage: () => void;
  /** Opens the credentials drawer. Only WhatsApp and Telegram have one. */
  onConfigure?: () => void;
  onUpdateAllowlist: (change: { add?: string[]; removeIds?: string[] }) => Promise<string | null>;
}) {
  const { t, number, relative } = useI18n();
  const meta = CHANNEL_META[channel.channel];
  const Icon = meta.icon;
  const hasAllowlist = channel.channel !== "web_widget";
  const configured = channel.status !== "not_configured";

  return (
    <div onPointerEnter={() => onHover(channel.channel)} onPointerLeave={() => onHover(null)} className="h-full">
      <SpotlightCard
        className={cn("h-full rounded-2xl p-5 transition-colors", highlighted && "border-white/20")}
        glow={channel.status === "action_needed" ? "245 158 11" : "0 245 212"}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <Icon aria-hidden className="size-4 shrink-0 text-ink-2" />
            <h3 className="text-sm font-semibold text-ink">{t(meta.title)}</h3>
          </div>
          <StatusBadge channel={channel} />
        </div>

        {channel.attention && (
          <p className="mt-3 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/8 p-2.5 text-xs leading-relaxed text-ink-2">
            <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />
            {channel.attention}
          </p>
        )}

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <div className="col-span-2">
            <dt className="text-ink-3">{channel.channel === "whatsapp" ? t("ch.linkedNumber") : channel.channel === "web_widget" ? t("ch.source") : t("ch.linkedAccount")}</dt>
            <dd className="mt-1 truncate font-mono text-[13px] tabular-nums text-ink">{channel.maskedHandle ?? t("ch.notLinked")}</dd>
          </div>
          <div>
            <dt className="text-ink-3">{t("ch.messagesLabel")}</dt>
            <dd className="mt-1 font-mono text-[13px] tabular-nums text-ink">
              {channel.messages24h != null ? number(channel.messages24h) : "--"}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">{t("ch.lastMessage")}</dt>
            <dd className="mt-1 font-mono text-[13px] tabular-nums text-ink">{relative(channel.lastMessageAt)}</dd>
          </div>
          {channel.voiceTranscription !== null && (
            <div className="col-span-2">
              <dt className="sr-only">{t("ch.voiceNotes")}</dt>
              <dd className="inline-flex items-center gap-1.5 text-ink-2">
                <Mic aria-hidden className={cn("size-3.5", channel.voiceTranscription ? "text-signal" : "text-ink-3")} />
                {channel.voiceTranscription ? t("ch.voiceActive") : t("ch.voiceOff")}
              </dd>
            </div>
          )}
        </dl>

        {hasAllowlist && configured && <AllowlistEditor channel={channel} onUpdate={onUpdateAllowlist} />}

        {configured ? (
          <motion.button
            type="button"
            whileTap={{ scale: 0.98 }}
            transition={SPRING}
            onClick={onManage}
            className={cn(
              "mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition-colors",
              channel.status === "action_needed"
                ? "border-warn/40 bg-warn/10 text-warn hover:border-warn/70"
                : "border-white/12 text-ink hover:border-white/25",
            )}
          >
            {channel.channel === "whatsapp" ? <QrCode aria-hidden className="size-4" /> : <RotateCw aria-hidden className="size-4" />}
            {channel.channel === "whatsapp" ? t("ch.relinkAction") : channel.channel === "telegram" ? t("ch.testReconnect") : t("ch.reconnect")}
          </motion.button>
        ) : (
          !onConfigure && (
            <p className="mt-4 text-xs leading-relaxed text-ink-3">
              {client.mode === "mock" ? t("ch.onRequest") : t("ch.managerEnable")}
            </p>
          )
        )}

        {onConfigure && (
          <motion.button
            type="button"
            whileTap={{ scale: 0.98 }}
            transition={SPRING}
            onClick={onConfigure}
            className={cn(
              "mt-2.5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors",
              configured ? "border border-white/12 text-ink-2 hover:border-white/25 hover:text-ink" : "bg-signal text-obsidian",
            )}
          >
            <KeyRound aria-hidden className="size-4" />
            Connect & configure credentials
          </motion.button>
        )}
      </SpotlightCard>
    </div>
  );
}

export function ChannelsMatrix({ client }: { client: PortalClient }) {
  const { t } = useI18n();
  const notify = useToast();
  const [channels, setChannels] = useState<PortalChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ChannelName | null>(null);
  const [managing, setManaging] = useState<ChannelName | null>(null);
  const [connecting, setConnecting] = useState<ConnectTarget | null>(null);

  const load = useCallback(async () => {
    try {
      setChannels(await client.channels());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("ch.loadError"));
    }
  }, [client, t]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) await load();
      if (!cancelled) timer = setTimeout(poll, 30_000);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  async function updateAllowlist(channel: ChannelName, change: { add?: string[]; removeIds?: string[] }) {
    try {
      setChannels(await client.updateAllowlist(channel, change));
      notify(change.add?.length ? t("ch.added") : t("ch.removed"));
      return null;
    } catch (failure) {
      return failure instanceof Error ? failure.message : t("ch.saveFailed");
    }
  }

  if (!channels) {
    if (error) return <LoadError message={error} onRetry={load} />;
    return <div aria-busy="true" aria-label={t("common.loading")} className="h-96 animate-pulse rounded-3xl bg-white/3" />;
  }

  const bridge = channels.filter((channel) => channel.status !== "not_configured" || channel.channel !== "slack");
  const managed = channels.find((channel) => channel.channel === managing) ?? null;

  return (
    <div className="space-y-4">
      {error && <LoadError message={error} onRetry={load} />}
      <GatewayBridge channels={bridge} active={active} onActivate={setActive} />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {bridge.map((channel) => (
          <ChannelCard
            key={channel.channel}
            client={client}
            channel={channel}
            highlighted={active === channel.channel}
            onHover={setActive}
            onManage={() => setManaging(channel.channel)}
            onConfigure={
              channel.channel === "whatsapp" || channel.channel === "telegram"
                ? () => setConnecting(channel.channel as ConnectTarget)
                : undefined
            }
            onUpdateAllowlist={(change) => updateAllowlist(channel.channel, change)}
          />
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <SetupCard
          icon={<Share2 aria-hidden className="size-4 text-ink-2" />}
          title="Facebook & Instagram"
          body="Connect your Page and Instagram account so the Social Autopilot publishes to them and answers comments."
          onOpen={() => setConnecting("meta")}
        />
        <SetupCard
          icon={<Sparkles aria-hidden className="size-4 text-ink-2" />}
          title="AI model preset"
          body="Choose how your Coordinator balances answer quality against monthly cost."
          onOpen={() => setConnecting("ai")}
        />
      </div>

      <ChannelConnectDrawer
        client={client}
        target={connecting}
        onClose={() => setConnecting(null)}
        onChanged={load}
        whatsappStatus={channels.find((channel) => channel.channel === "whatsapp")?.status ?? "not_configured"}
      />

      <Dialog open={managed !== null} onClose={() => setManaging(null)} title={t("ch.manageChannel")} className="sm:max-w-md">
        {managed && (
          <LinkDialogBody
            key={managed.channel}
            client={client}
            channel={managed}
            onClose={() => setManaging(null)}
            onChanged={load}
          />
        )}
      </Dialog>
    </div>
  );
}

function SetupCard({ icon, title, body, onOpen }: { icon: React.ReactNode; title: string; body: string; onOpen: () => void }) {
  return (
    <SpotlightCard className="rounded-2xl p-5">
      <div className="flex items-center gap-2.5">
        {icon}
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-3">{body}</p>
      <motion.button
        type="button"
        whileTap={{ scale: 0.98 }}
        transition={SPRING}
        onClick={onOpen}
        className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/12 px-4 text-sm font-medium text-ink transition-colors hover:border-white/25"
      >
        <KeyRound aria-hidden className="size-4" />
        Connect & configure credentials
      </motion.button>
    </SpotlightCard>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70"
      >
        <RotateCw aria-hidden className="size-3.5" />
        {t("common.retry")}
      </button>
    </div>
  );
}
