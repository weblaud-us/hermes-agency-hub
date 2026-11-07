"use client";

import { motion } from "motion/react";
import { CheckCircle2, CircleAlert, KeyRound, LoaderCircle, QrCode, RotateCw, Send, Shuffle, X } from "lucide-react";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { SecretInput } from "@/components/ui/SecretInput";
import { Segmented } from "@/components/ui/Segmented";
import type {
  AiPresetKey,
  IntegrationsSaveResult,
  IntegrationsUpdate,
  IntegrationsView,
  IntegrationTarget,
  IntegrationTestResult,
  SecretStatus,
} from "@/lib/knowledge-api";
import { SPRING } from "@/lib/motion";
import type { PortalClient } from "@/lib/portal-api";
import { cn } from "@/lib/utils";

export type ConnectTarget = "whatsapp" | "telegram" | "meta" | "ai";

const TITLE: Record<ConnectTarget, string> = {
  whatsapp: "Connect WhatsApp",
  telegram: "Connect Telegram",
  meta: "Connect Facebook & Instagram",
  ai: "AI model preset",
};

const PATTERN = {
  telegramToken: /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/,
  telegramId: /^\d{5,20}$/,
  graphToken: /^[A-Za-z0-9_.-]{20,700}$/,
  numericId: /^\d{5,25}$/,
  phoneNumberId: /^\d{8,20}$/,
  verifyToken: /^[A-Za-z0-9_-]{8,64}$/,
};

interface DrawerProps {
  client: PortalClient;
  target: ConnectTarget | null;
  onClose: () => void;
  /** Called after a save, so the channel cards refresh. */
  onChanged: () => void;
  /** Opens the existing QR pairing dialog for WhatsApp. */
  onOpenQr: () => void;
  /** The QR flow only starts for a channel the account manager has already enabled. */
  qrAvailable: boolean;
}

export function ChannelConnectDrawer({ target, onClose, ...rest }: DrawerProps) {
  return (
    <Dialog open={target !== null} onClose={onClose} title={target ? TITLE[target] : "Connect"} placement="right">
      {target && <Body key={target} target={target} onClose={onClose} {...rest} />}
    </Dialog>
  );
}

// ---------------------------------------------------------------------- pieces
function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="space-y-2.5">
      {items.map((item, index) => (
        <li key={index} className="flex gap-3 text-sm leading-relaxed text-ink-2">
          <span aria-hidden className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-signal/50 font-mono text-[10.5px] text-signal">
            {index + 1}
          </span>
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function Field({ id, label, hint, status, children }: { id: string; label: string; hint?: string; status?: SecretStatus; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-ink-2">
          {label}
        </label>
        {status?.configured && <span className="font-mono text-[11px] text-signal">Saved {status.masked}</span>}
      </div>
      {children}
      {hint && <p className="mt-1 text-[11px] leading-snug text-ink-3">{hint}</p>}
    </div>
  );
}

const secretPlaceholder = (status: SecretStatus | undefined, example: string) => (status?.configured ? "Leave empty to keep the saved value" : example);

function randomPhrase(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------------- body
function Body({ client, target, onClose, onChanged, onOpenQr, qrAvailable }: Omit<DrawerProps, "target"> & { target: ConnectTarget }) {
  const base = useId();
  const [view, setView] = useState<IntegrationsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await client.knowledge.integrations());
      setLoadError(null);
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : "Your settings could not be loaded.");
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    client.knowledge.integrations().then(
      (next) => {
        if (!cancelled) setView(next);
      },
      (failure: unknown) => {
        if (!cancelled) setLoadError(failure instanceof Error ? failure.message : "Your settings could not be loaded.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-4">
        <h2 className="flex items-center gap-2 truncate text-lg font-semibold tracking-tight text-ink">
          <KeyRound aria-hidden className="size-4 shrink-0 text-signal" />
          {TITLE[target]}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-white/6 hover:text-ink">
          <X aria-hidden className="size-4" />
        </button>
      </div>

      {!view ? (
        loadError ? (
          <div role="alert" className="m-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
            <p>{loadError}</p>
            <button type="button" onClick={load} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70">
              <RotateCw aria-hidden className="size-3.5" />
              Try again
            </button>
          </div>
        ) : (
          <div aria-busy="true" aria-label="Loading" className="m-5 h-64 animate-pulse rounded-2xl bg-white/4" />
        )
      ) : (
        <Panel
          base={base}
          client={client}
          target={target}
          view={view}
          onSaved={(result) => {
            setView(result.integrations);
            onChanged();
          }}
          onOpenQr={onOpenQr}
          qrAvailable={qrAvailable}
        />
      )}
    </div>
  );
}

function Panel({
  base,
  client,
  target,
  view,
  onSaved,
  onOpenQr,
  qrAvailable,
}: {
  base: string;
  client: PortalClient;
  target: ConnectTarget;
  view: IntegrationsView;
  onSaved: (result: IntegrationsSaveResult) => void;
  onOpenQr: () => void;
  qrAvailable: boolean;
}) {
  // ---- form state, one set of fields per target, all held here so Save sees them
  const [tgToken, setTgToken] = useState("");
  const [tgUsers, setTgUsers] = useState(view.telegram.allowed_users.join(", "));
  const [waMode, setWaMode] = useState<"qr" | "cloud_api">(view.whatsapp.mode === "cloud_api" ? "cloud_api" : "qr");
  const [waToken, setWaToken] = useState("");
  const [waPhone, setWaPhone] = useState(view.whatsapp.phone_number_id ?? "");
  const [waVerify, setWaVerify] = useState("");
  const [metaPage, setMetaPage] = useState(view.meta.page_id ?? "");
  const [metaIg, setMetaIg] = useState(view.meta.ig_user_id ?? "");
  const [metaToken, setMetaToken] = useState("");
  const [preset, setPreset] = useState<AiPresetKey | null>(view.presets.find((item) => item.selected)?.key ?? null);

  const [busy, setBusy] = useState<"save" | "apply" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<IntegrationsSaveResult | null>(null);
  const [test, setTest] = useState<IntegrationTestResult | null>(null);

  /** The update this form asks for, or the reason it cannot be sent. */
  function build(): { update: IntegrationsUpdate } | { problem: string } | null {
    if (target === "telegram") {
      const update: NonNullable<IntegrationsUpdate["telegram"]> = {};
      if (tgToken.trim()) {
        if (!PATTERN.telegramToken.test(tgToken.trim())) return { problem: "That does not look like a Telegram bot token. Copy the whole token from BotFather, including the number and colon." };
        update.bot_token = tgToken.trim();
      }
      const users = tgUsers.split(/[,\s]+/).filter(Boolean);
      if (users.join(",") !== view.telegram.allowed_users.join(",")) {
        if (users.length === 0) return { problem: "Add at least one Telegram ID so only approved people can use the bot." };
        if (users.some((id) => !PATTERN.telegramId.test(id))) return { problem: "A Telegram ID is a number of 5 to 20 digits. Separate several with commas." };
        update.allowed_users = users;
      }
      return Object.keys(update).length ? { update: { telegram: update } } : null;
    }
    if (target === "whatsapp") {
      if (waMode === "qr") return null;
      const update: NonNullable<IntegrationsUpdate["whatsapp_cloud"]> = {};
      if (waToken.trim()) {
        if (!PATTERN.graphToken.test(waToken.trim())) return { problem: "That does not look like a WhatsApp access token." };
        update.access_token = waToken.trim();
      }
      if (waPhone.trim() !== (view.whatsapp.phone_number_id ?? "")) {
        if (waPhone.trim() && !PATTERN.phoneNumberId.test(waPhone.trim())) return { problem: "The phone number ID is 8 to 20 digits. It is not your phone number." };
        update.phone_number_id = waPhone.trim();
      }
      if (waVerify.trim()) {
        if (!PATTERN.verifyToken.test(waVerify.trim())) return { problem: "The verify token is 8 to 64 letters, numbers, dashes or underscores, with no spaces." };
        update.verify_token = waVerify.trim();
      }
      return Object.keys(update).length ? { update: { whatsapp_cloud: update } } : null;
    }
    if (target === "meta") {
      const update: NonNullable<IntegrationsUpdate["meta"]> = {};
      if (metaPage.trim() !== (view.meta.page_id ?? "")) {
        if (metaPage.trim() && !PATTERN.numericId.test(metaPage.trim())) return { problem: "The Page ID is a number of 5 to 25 digits." };
        update.page_id = metaPage.trim();
      }
      if (metaIg.trim() !== (view.meta.ig_user_id ?? "")) {
        if (metaIg.trim() && !PATTERN.numericId.test(metaIg.trim())) return { problem: "The Instagram account ID is a number of 5 to 25 digits." };
        update.ig_user_id = metaIg.trim();
      }
      if (metaToken.trim()) {
        if (!PATTERN.graphToken.test(metaToken.trim())) return { problem: "That does not look like a Page access token." };
        update.page_access_token = metaToken.trim();
      }
      return Object.keys(update).length ? { update: { meta: update } } : null;
    }
    const current = view.presets.find((item) => item.selected)?.key ?? null;
    return preset && preset !== current ? { update: { ai_preset: preset } } : null;
  }

  const pending = build();
  const hasChange = pending !== null;

  async function save(applyNow: boolean) {
    const request = build();
    if (!request) return;
    if ("problem" in request) return setError(request.problem);
    setBusy(applyNow ? "apply" : "save");
    setError(null);
    setTest(null);
    try {
      const result = await client.knowledge.saveIntegrations({ ...request.update, apply_now: applyNow });
      setSaved(result);
      setTgToken("");
      setWaToken("");
      setWaVerify("");
      setMetaToken("");
      onSaved(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  const testTarget: IntegrationTarget | null = target === "telegram" ? "telegram" : target === "meta" ? "meta" : target === "whatsapp" && waMode === "cloud_api" ? "whatsapp_cloud" : null;

  async function runTest() {
    if (!testTarget) return;
    setBusy("test");
    setError(null);
    try {
      setTest(await client.knowledge.testIntegration(testTarget));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The test could not run.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="thin-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {target === "telegram" && (
          <>
            <Steps
              items={[
                <>In Telegram, open <strong className="text-ink">@BotFather</strong> and send <span className="font-mono text-xs">/newbot</span>.</>,
                "Pick a name, then a username that ends in bot.",
                "Copy the token BotFather sends you and paste it below.",
                <>Open <strong className="text-ink">@userinfobot</strong> and send any message. It replies with your numeric ID. Paste it below so only you can use the bot.</>,
              ]}
            />
            <Field id={`${base}-tgtoken`} label="Bot token" status={view.telegram.bot_token}>
              <SecretInput id={`${base}-tgtoken`} secretName="bot token" value={tgToken} onChange={(event) => setTgToken(event.target.value)} placeholder={secretPlaceholder(view.telegram.bot_token, "123456789:AA…")} />
            </Field>
            <Field id={`${base}-tgusers`} label="Approved Telegram IDs" hint="Only these accounts can talk to the bot. Separate several with commas.">
              <input id={`${base}-tgusers`} inputMode="numeric" value={tgUsers} onChange={(event) => setTgUsers(event.target.value)} placeholder="123456789" className="field font-mono" />
            </Field>
          </>
        )}

        {target === "whatsapp" && (
          <>
            <Segmented<"qr" | "cloud_api">
              label="WhatsApp connection method"
              value={waMode}
              onChange={setWaMode}
              optionClassName="min-h-11 px-4"
              options={[
                { value: "qr", label: "Scan a QR code" },
                { value: "cloud_api", label: "WhatsApp Cloud API" },
              ]}
            />
            {waMode === "qr" ? (
              <>
                <Steps
                  items={[
                    "On the phone that holds your business number, open WhatsApp.",
                    <>Go to <strong className="text-ink">Settings, Linked devices, Link a device</strong>.</>,
                    "Press the button below, then scan the code that appears.",
                  ]}
                />
                <p className="rounded-xl border border-white/8 bg-white/3 p-3 text-xs leading-relaxed text-ink-3">
                  Best for getting started quickly. The phone stays your business number, and replies come from it. {view.whatsapp.qr_linked ? "A phone is linked now." : "No phone is linked yet."}
                </p>
                {qrAvailable ? (
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.97 }}
                    transition={SPRING}
                    onClick={onOpenQr}
                    className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian"
                  >
                    <QrCode aria-hidden className="size-4" />
                    Show the QR code
                  </motion.button>
                ) : (
                  <p role="status" className="rounded-xl border border-warn/30 bg-warn/8 p-3 text-xs leading-relaxed text-ink-2">
                    QR linking is switched on by your account manager for each business. Ask them to enable it, or use the WhatsApp Cloud API tab, which you can set up yourself.
                  </p>
                )}
              </>
            ) : (
              <>
                <Steps
                  items={[
                    <>At <strong className="text-ink">developers.facebook.com</strong>, create a Business app and add the WhatsApp product.</>,
                    <>Under <strong className="text-ink">WhatsApp, API Setup</strong>, copy the <em>Phone number ID</em> (not the phone number itself).</>,
                    <>In <strong className="text-ink">Business settings, System users</strong>, create a token with the whatsapp_business_messaging and whatsapp_business_management permissions.</>,
                    "Choose a verify token below, then enter the same phrase in your app&apos;s webhook settings.",
                  ]}
                />
                <Field id={`${base}-watoken`} label="Access token" status={view.whatsapp.access_token}>
                  <SecretInput id={`${base}-watoken`} secretName="access token" value={waToken} onChange={(event) => setWaToken(event.target.value)} placeholder={secretPlaceholder(view.whatsapp.access_token, "EAAG…")} />
                </Field>
                <Field id={`${base}-waphone`} label="Phone number ID">
                  <input id={`${base}-waphone`} inputMode="numeric" value={waPhone} onChange={(event) => setWaPhone(event.target.value)} placeholder="104857612345678" className="field font-mono" />
                </Field>
                <Field id={`${base}-waverify`} label="Verify token" status={view.whatsapp.verify_token}>
                  <div className="flex gap-2">
                    <SecretInput id={`${base}-waverify`} secretName="verify token" value={waVerify} onChange={(event) => setWaVerify(event.target.value)} placeholder={secretPlaceholder(view.whatsapp.verify_token, "any phrase you choose")} className="min-w-0 flex-1" />
                    <button type="button" onClick={() => setWaVerify(randomPhrase())} aria-label="Generate a verify token" className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-white/12 text-ink-2 hover:border-white/25 hover:text-ink">
                      <Shuffle aria-hidden className="size-4" />
                    </button>
                  </div>
                </Field>
              </>
            )}
          </>
        )}

        {target === "meta" && (
          <>
            <Steps
              items={[
                <>Make sure your Instagram account is a <strong className="text-ink">professional account linked to your Facebook Page</strong> (Meta Business Suite, Settings, Linked accounts).</>,
                <>At <strong className="text-ink">developers.facebook.com</strong>, open the Graph API Explorer, choose your app and generate a Page access token with pages_manage_posts, pages_read_engagement, pages_manage_engagement, pages_messaging, instagram_basic and instagram_content_publish.</>,
                "Extend it to a long-lived token in the Access Token Debugger, so posting does not stop after a day.",
                <>Find the Page ID on your Page&apos;s About tab. For the Instagram account ID, ask the Explorer for <span className="font-mono text-xs">me/accounts?fields=instagram_business_account</span>.</>,
              ]}
            />
            <p
              className={cn(
                "flex items-start gap-2 rounded-xl border p-3 text-xs leading-relaxed",
                view.meta.publishes_live ? "border-signal/25 bg-signal/8 text-ink-2" : "border-warn/30 bg-warn/8 text-ink-2",
              )}
            >
              {view.meta.publishes_live ? <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0 text-signal" /> : <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />}
              {view.meta.publishes_live
                ? "Posts go to your own Page. Nothing here can reach another business's page."
                : "Until these are saved, the Social Autopilot works in sandbox mode: it makes the posts but publishes nothing."}
            </p>
            <Field id={`${base}-page`} label="Facebook Page ID">
              <input id={`${base}-page`} inputMode="numeric" value={metaPage} onChange={(event) => setMetaPage(event.target.value)} className="field font-mono" />
            </Field>
            <Field id={`${base}-ig`} label="Instagram account ID" hint="Optional. Leave empty to post to Facebook only.">
              <input id={`${base}-ig`} inputMode="numeric" value={metaIg} onChange={(event) => setMetaIg(event.target.value)} className="field font-mono" />
            </Field>
            <Field id={`${base}-metatoken`} label="Page access token" status={view.meta.page_access_token}>
              <SecretInput id={`${base}-metatoken`} secretName="page access token" value={metaToken} onChange={(event) => setMetaToken(event.target.value)} placeholder={secretPlaceholder(view.meta.page_access_token, "EAAG…")} />
            </Field>
          </>
        )}

        {target === "ai" && (
          <>
            <p className="text-sm leading-relaxed text-ink-2">
              Choose how your Coordinator balances quality and cost. You can change this any time. The estimates assume a typical small business; the Usage tab shows what you actually spend.
            </p>
            <div role="radiogroup" aria-label="AI model preset" className="space-y-2.5">
              {view.presets.map((item) => {
                const on = preset === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setPreset(item.key)}
                    className={cn("flex w-full min-h-11 flex-col gap-1 rounded-2xl border p-4 text-left transition-colors", on ? "border-signal/50 bg-signal/7" : "border-white/10 hover:border-white/25")}
                  >
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-ink">{item.label}</span>
                      <span className="font-mono text-xs tabular-nums text-ink-2">{item.est_monthly_usd}</span>
                    </span>
                    <span className="text-xs leading-relaxed text-ink-3">{item.summary}</span>
                    {item.engines && (
                      <span className="font-mono text-[11px] text-ink-3">{Object.entries(item.engines).map(([kind, name]) => `${kind}: ${name}`).join(" · ")}</span>
                    )}
                  </button>
                );
              })}
            </div>
            {!view.preset_selected && <p className="text-xs text-ink-3">No preset chosen yet. Your Coordinator runs on the platform default until you pick one.</p>}
          </>
        )}

        {error && (
          <p role="alert" className="flex items-start gap-2 text-sm text-halt-soft">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}
        {test && (
          <p role="status" className={cn("rounded-xl border p-3 text-sm text-ink-2", test.ok ? "border-signal/25 bg-signal/8" : "border-warn/30 bg-warn/8")}>
            {test.detail}
          </p>
        )}
        {saved && !error && (
          <p role="status" className="rounded-xl border border-white/10 bg-white/4 p-3 text-sm text-ink-2">
            {saved.detail}
          </p>
        )}
      </div>

      {(target !== "whatsapp" || waMode === "cloud_api") && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-white/8 px-5 py-3">
          {testTarget && (
            <button
              type="button"
              onClick={runTest}
              disabled={busy !== null}
              className="mr-auto inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/12 px-4 text-sm font-medium text-ink transition-colors hover:border-white/25 disabled:opacity-50"
            >
              {busy === "test" ? <LoaderCircle aria-hidden className="size-4 animate-spin-slow" /> : <Send aria-hidden className="size-4" />}
              {busy === "test" ? "Testing" : "Test connection"}
            </button>
          )}
          <button
            type="button"
            onClick={() => save(false)}
            disabled={!hasChange || busy !== null}
            className="min-h-11 rounded-xl border border-white/15 px-4 text-sm font-medium text-ink hover:border-white/30 disabled:opacity-40"
          >
            {busy === "save" ? "Saving" : "Save"}
          </button>
          {target !== "meta" && (
            <button
              type="button"
              onClick={() => save(true)}
              disabled={!hasChange || busy !== null}
              className="min-h-11 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian disabled:opacity-40"
            >
              {busy === "apply" ? "Restarting" : "Save & restart"}
            </button>
          )}
        </div>
      )}
    </>
  );
}
