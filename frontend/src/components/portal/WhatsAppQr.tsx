"use client";

import { motion } from "motion/react";
import { CheckCircle2, CircleAlert, LoaderCircle, QrCode, Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { SPRING } from "@/lib/motion";
import type { PortalClient, ReconnectResult } from "@/lib/portal-api";
import { cn } from "@/lib/utils";

/** Quiet zone, in modules, that every scanner needs around a code. */
const QUIET_ZONE = 2;

/** Draws the code as one path of horizontal runs, so it stays sharp at any size. */
function QrSvg({ matrix, label }: { matrix: string[]; label: string }) {
  const size = matrix.length + QUIET_ZONE * 2;
  const runs: string[] = [];
  matrix.forEach((row, y) => {
    for (const run of row.matchAll(/1+/g)) {
      runs.push(`M${run.index + QUIET_ZONE} ${y + QUIET_ZONE}h${run[0].length}v1h-${run[0].length}z`);
    }
  });
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} className="size-full" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={runs.join("")} fill="#050508" />
    </svg>
  );
}

export function ScannerFrame({ pairing, sample }: { pairing: ReconnectResult; sample: boolean }) {
  const { t } = useI18n();
  return (
    <div className="relative mx-auto size-56">
      {[
        "left-0 top-0 border-l-2 border-t-2 rounded-tl-xl",
        "right-0 top-0 border-r-2 border-t-2 rounded-tr-xl",
        "bottom-0 left-0 border-b-2 border-l-2 rounded-bl-xl",
        "bottom-0 right-0 border-b-2 border-r-2 rounded-br-xl",
      ].map((corner) => (
        <span key={corner} aria-hidden className={cn("absolute size-7 border-signal", corner)} />
      ))}
      <div className="absolute inset-3 overflow-hidden rounded-lg bg-white">
        {pairing.qrMatrix ? (
          <QrSvg matrix={pairing.qrMatrix} label={t("ch.qrAlt")} />
        ) : pairing.qrPngBase64 ? (
          // A data URL produced by the backend: next/image has nothing to optimise here.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`data:image/png;base64,${pairing.qrPngBase64}`} alt={t("ch.qrAlt")} className="size-full [image-rendering:pixelated]" />
        ) : null}
        <span
          aria-hidden
          className="scan-line absolute inset-x-1 top-1 h-0.5 rounded-full bg-signal shadow-[0_0_12px_var(--color-signal)]"
          style={{ "--scan-distance": "188px" } as React.CSSProperties}
        />
      </div>
      {sample && (
        <span className="absolute inset-x-6 bottom-6 rounded-md bg-obsidian/90 px-2 py-1 text-center font-mono text-[11px] text-warn">
          {t("ch.sampleCode")}
        </span>
      )}
    </div>
  );
}

/** Stands in for the owner's phone. Only sample mode has one, so a live account never shows it. */
export function SimulateScanButton({ client, onResult }: { client: PortalClient; onResult: (result: ReconnectResult) => void }) {
  const [busy, setBusy] = useState(false);
  if (!client.simulatePhoneScan) return null;
  const simulate = client.simulatePhoneScan.bind(client);

  async function run() {
    setBusy(true);
    try {
      onResult(await simulate());
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.97 }}
      transition={SPRING}
      onClick={run}
      disabled={busy}
      className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/12 px-4 text-sm font-medium text-ink transition-colors hover:border-white/25 disabled:opacity-50"
    >
      {busy ? <LoaderCircle aria-hidden className="size-4 animate-spin-slow" /> : <Smartphone aria-hidden className="size-4" />}
      {busy ? "Linking" : "Simulate Phone Scan (Demo)"}
    </motion.button>
  );
}

const PAIRING_POLL_MS = 3000;

/** The whole QR step of the WhatsApp drawer: start a pairing, show its code, follow it to the end. */
export function WhatsAppQrPanel({ client, onChanged }: { client: PortalClient; onChanged: () => void }) {
  const { t } = useI18n();
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<ReconnectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkedHandle, setLinkedHandle] = useState<string | null>(null);

  const waiting = result?.state === "qr_pending" || result?.state === "qr_ready";

  const settle = useCallback(
    (next: ReconnectResult) => {
      setResult(next);
      if (next.state !== "connected") return;
      onChanged();
      client.channels().then(
        (list) => setLinkedHandle(list.find((channel) => channel.channel === "whatsapp")?.maskedHandle ?? null),
        () => undefined,
      );
    },
    [client, onChanged],
  );

  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await client.pairingStatus();
        if (!cancelled) settle(next);
      } catch {
        // One missed poll is not a failure: the code stays up and the next poll retries.
      }
    }, PAIRING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, waiting, settle]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      settle(await client.reconnectChannel("whatsapp"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("ch.reconnectFailed"));
    } finally {
      setStarting(false);
    }
  }

  if (result?.state === "connected") {
    return (
      <div role="status" className="flex items-start gap-2 rounded-xl border border-signal/25 bg-signal/8 p-3 text-sm text-ink-2">
        <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-signal" />
        <div>
          <p className="font-medium text-ink">Connected{linkedHandle ? ` · ${linkedHandle}` : ""}</p>
          <p className="mt-0.5 text-xs text-ink-3">{result.detail}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {waiting && (
        <div aria-live="polite">
          {result?.state === "qr_ready" ? (
            <ScannerFrame pairing={result} sample={client.mode === "mock"} />
          ) : (
            <div role="status" className="mx-auto flex size-56 items-center justify-center rounded-xl border border-white/10 bg-white/3 text-xs text-ink-3">
              {t("ch.preparing")}
            </div>
          )}
          <p className="mt-4 text-center text-sm leading-relaxed text-ink-2">{result?.detail}</p>
          {result?.qrRefreshSeconds != null && <p className="mt-1 text-center font-mono text-xs text-ink-3">{t("ch.qrRefresh")}</p>}
        </div>
      )}

      {result && !waiting && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/8 p-3 text-xs leading-relaxed text-ink-2">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />
          {result.detail}
        </p>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-halt-soft">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {!waiting && (
          <motion.button
            type="button"
            whileTap={{ scale: 0.97 }}
            transition={SPRING}
            onClick={start}
            disabled={starting}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian disabled:opacity-50"
          >
            {starting ? <LoaderCircle aria-hidden className="size-4 animate-spin-slow" /> : <QrCode aria-hidden className="size-4" />}
            {starting ? "Starting" : result ? "Generate a new QR code" : "Generate QR code"}
          </motion.button>
        )}
        {waiting && <SimulateScanButton client={client} onResult={settle} />}
      </div>
    </div>
  );
}
