"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, CircleAlert, FlaskConical, HandCoins, LoaderCircle, MessageCircle, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { SecretInput } from "@/components/ui/SecretInput";
import { Segmented } from "@/components/ui/Segmented";
import { Wordmark } from "@/components/ui/Wordmark";
import { goTo, homeFor, login, requestOtp, safeNext, verifyOtp, type SessionUser } from "@/lib/auth";
import { ApiError } from "@/lib/hub-types";
import { LanguageToggle, LocaleProvider, useI18n } from "@/lib/i18n";
import { riseIn, SPRING, staggerContainer } from "@/lib/motion";
import { cn } from "@/lib/utils";

type Audience = "agency" | "client";
type Method = "password" | "otp";

/**
 * The console's demo sign-ins. The passwords are only compiled into the page when the
 * site is built with NEXT_PUBLIC_DEMO_LOGINS=true, which a local install does and a
 * production build does not. Without it the pills still pick the account, and the
 * person types the password.
 */
const DEMO = process.env.NEXT_PUBLIC_DEMO_LOGINS === "true";
const DEMO_ROLES = [
  { name: "Ishtiaq", role: "Product & Tech Lead", email: "ishtiaq@weblaud.com", password: DEMO ? "WeblaudAdmin!2026" : "" },
  { name: "Sakib", role: "Growth & Content Lead", email: "sakib@weblaud.com", password: DEMO ? "WeblaudAdmin!2026" : "" },
  { name: "Jubayed", role: "Sales & CRM Lead", email: "jubayed@weblaud.com", password: DEMO ? "WeblaudSales!2026" : "" },
] as const;

/** The business a sign-in link was meant for, from `?next=/portal/<slug>`. */
function subdomainFrom(next: string | null): string {
  return /^\/portal\/([a-z0-9-]+)/.exec(next ?? "")?.[1] ?? "";
}

function SubdomainField({ id, value, onChange }: { id: string; value: string; onChange: (next: string) => void }) {
  const { t } = useI18n();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink-2">
        {t("login.subdomain")}
      </label>
      <input
        id={id}
        name="subdomain"
        autoComplete="organization"
        autoCapitalize="none"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value.trim().toLowerCase())}
        placeholder="apex-dental"
        aria-describedby={`${id}-hint`}
        className="field font-mono"
      />
      <p id={`${id}-hint`} className="mt-1.5 text-xs text-ink-3">
        {t("login.subdomainHint")}
      </p>
    </div>
  );
}

function DemoRoles({ email, onPick }: { email: string; onPick: (role: (typeof DEMO_ROLES)[number]) => void }) {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={t("login.demoLabel")} className="rounded-2xl border border-white/8 bg-black/20 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
        <FlaskConical aria-hidden className="size-3.5 text-warn" />
        {t("login.demoLabel")}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {DEMO_ROLES.map((role) => {
          const active = email.trim().toLowerCase() === role.email;
          return (
            <motion.button
              key={role.email}
              type="button"
              aria-pressed={active}
              whileTap={{ scale: 0.96 }}
              transition={SPRING}
              onClick={() => onPick(role)}
              className={cn(
                "inline-flex min-h-11 flex-col items-start justify-center rounded-xl border px-3 py-1.5 text-left transition-colors",
                active ? "border-signal/50 bg-signal/10" : "border-white/12 hover:border-white/25",
              )}
            >
              <span className="text-sm font-semibold text-ink">{role.name}</span>
              <span className="text-[11px] leading-tight text-ink-3">{role.role}</span>
            </motion.button>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] leading-snug text-ink-3">{DEMO ? t("login.demoFills") : t("login.demoEmailOnly")}</p>
    </div>
  );
}

function ErrorNote({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-2 text-sm text-halt-soft">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function SubmitButton({ busy, busyLabel, children }: { busy: boolean; busyLabel: string; children: ReactNode }) {
  return (
    <motion.button
      type="submit"
      whileTap={{ scale: 0.98 }}
      transition={SPRING}
      disabled={busy}
      className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian transition-colors hover:bg-[#3ff9e2] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy && <LoaderCircle aria-hidden className="animate-spin-slow size-4" />}
      {busy ? busyLabel : children}
    </motion.button>
  );
}

/** Tells apart "you got it wrong" from "the server is down", which needs a different next step. */
function useFailure() {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [hubDown, setHubDown] = useState(false);

  function report(failure: unknown) {
    const down =
      failure instanceof ApiError && (failure.status === 0 || failure.code === "portal_backend_unavailable" || failure.status >= 502);
    setHubDown(down);
    setError(down ? t("login.hubDown") : failure instanceof Error ? failure.message : t("approvals.error"));
  }

  return {
    error,
    hubDown,
    report,
    setMessage(message: string) {
      setHubDown(false);
      setError(message);
    },
    clear() {
      setHubDown(false);
      setError(null);
    },
  };
}

function PasswordForm({
  audience,
  initialSubdomain,
  onSignedIn,
}: {
  audience: Audience;
  initialSubdomain: string;
  onSignedIn: (user: SessionUser) => void;
}) {
  const { t } = useI18n();
  const failure = useFailure();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [subdomain, setSubdomain] = useState(initialSubdomain);
  const [busy, setBusy] = useState(false);
  const base = useId();
  const passwordRef = useRef<HTMLInputElement>(null);
  const business = audience === "client";

  function pick(role: (typeof DEMO_ROLES)[number]) {
    setEmail(role.email);
    setPassword(role.password);
    failure.clear();
    // Without a built-in password the next thing to do is type it.
    if (!role.password) passwordRef.current?.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (business && !subdomain) {
      failure.setMessage(t("login.subdomainRequired"));
      return;
    }
    if (!email.trim() || !password) {
      failure.setMessage(t("login.emailRequired"));
      return;
    }
    setBusy(true);
    failure.clear();
    try {
      onSignedIn(await login(email.trim(), password, business ? subdomain : undefined));
    } catch (error) {
      failure.report(error);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {!business && <DemoRoles email={email} onPick={pick} />}
      {business && <SubdomainField id={`${base}-subdomain`} value={subdomain} onChange={setSubdomain} />}
      <div>
        <label htmlFor={`${base}-email`} className="mb-1.5 block text-sm font-medium text-ink-2">
          {t("login.email")}
        </label>
        <input
          id={`${base}-email`}
          type="email"
          name="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={Boolean(failure.error) && !failure.hubDown}
          className="field"
        />
      </div>
      <div>
        <label htmlFor={`${base}-password`} className="mb-1.5 block text-sm font-medium text-ink-2">
          {t("login.password")}
        </label>
        <SecretInput
          id={`${base}-password`}
          ref={passwordRef}
          name="password"
          secretName="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={Boolean(failure.error) && !failure.hubDown}
        />
      </div>
      {failure.error && <ErrorNote>{failure.error}</ErrorNote>}
      {failure.hubDown && <SampleLink />}
      <SubmitButton busy={busy} busyLabel={t("login.signingIn")}>
        {t("login.signIn")}
      </SubmitButton>
    </form>
  );
}

function SampleLink() {
  const { t } = useI18n();
  return (
    <Link
      href="/admin?preview=1"
      className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-white/12 px-3 text-xs font-medium text-ink hover:border-white/25"
    >
      <FlaskConical aria-hidden className="size-3.5" />
      {t("login.openSample")}
    </Link>
  );
}

function OtpForm({ initialSubdomain, onSignedIn }: { initialSubdomain: string; onSignedIn: (user: SessionUser) => void }) {
  const { t, number } = useI18n();
  const failure = useFailure();
  const [subdomain, setSubdomain] = useState(initialSubdomain);
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<{ minutes: number; simulatedCode: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const base = useId();

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!subdomain) {
      failure.setMessage(t("login.subdomainRequired"));
      return;
    }
    if (!identifier.trim()) {
      failure.setMessage(t("login.identifierRequired"));
      return;
    }
    setBusy(true);
    failure.clear();
    try {
      const issued = await requestOtp(identifier.trim(), subdomain);
      setSent({ minutes: Math.round(issued.expiresIn / 60), simulatedCode: issued.simulatedCode });
      setCode("");
    } catch (error) {
      failure.report(error);
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      failure.setMessage(t("login.codeRequired"));
      return;
    }
    setBusy(true);
    failure.clear();
    try {
      onSignedIn(await verifyOtp(identifier.trim(), code, subdomain));
    } catch (error) {
      failure.report(error);
      setBusy(false);
    }
  }

  if (!sent) {
    return (
      <form onSubmit={send} noValidate className="space-y-4">
        <SubdomainField id={`${base}-subdomain`} value={subdomain} onChange={setSubdomain} />
        <div>
          <label htmlFor={`${base}-id`} className="mb-1.5 block text-sm font-medium text-ink-2">
            {t("login.identifier")}
          </label>
          <input
            id={`${base}-id`}
            name="username"
            autoComplete="username"
            inputMode="email"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            aria-describedby={`${base}-id-hint`}
            className="field"
          />
          <p id={`${base}-id-hint`} className="mt-1.5 text-xs text-ink-3">
            {t("login.identifierHint")}
          </p>
        </div>
        {failure.error && <ErrorNote>{failure.error}</ErrorNote>}
        {failure.hubDown && <SampleLink />}
        <SubmitButton busy={busy} busyLabel={t("login.sending")}>
          <MessageCircle aria-hidden className="size-4" />
          {t("login.sendCode")}
        </SubmitButton>
      </form>
    );
  }

  return (
    <form onSubmit={verify} noValidate className="space-y-4">
      <p className="text-sm text-ink-2">{t("login.sentTo", { minutes: number(sent.minutes) })}</p>
      {sent.simulatedCode && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warn/30 bg-warn/8 px-3 py-2.5 text-xs text-ink-2">
          <span className="min-w-0 flex-1">
            {t("login.simulated")} <span className="font-mono text-sm font-semibold tracking-widest text-ink">{sent.simulatedCode}</span>
          </span>
          <button
            type="button"
            onClick={() => setCode(sent.simulatedCode ?? "")}
            className="inline-flex min-h-9 items-center rounded-lg border border-white/15 px-2.5 font-medium text-ink hover:border-white/30"
          >
            {t("login.useCode")}
          </button>
        </div>
      )}
      <div>
        <label htmlFor={`${base}-code`} className="mb-1.5 block text-sm font-medium text-ink-2">
          {t("login.code")}
        </label>
        {/* Paste stays allowed and the OS can autofill from the message. */}
        <input
          id={`${base}-code`}
          name="one-time-code"
          autoComplete="one-time-code"
          inputMode="numeric"
          autoFocus
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
          aria-invalid={Boolean(failure.error) && !failure.hubDown}
          className="field text-center font-mono text-lg tracking-[0.5em]"
        />
      </div>
      {failure.error && <ErrorNote>{failure.error}</ErrorNote>}
      <SubmitButton busy={busy} busyLabel={t("login.signingIn")}>
        {t("login.verify")}
      </SubmitButton>
      <div className="flex flex-wrap justify-between gap-2 text-xs">
        <button
          type="button"
          onClick={() => {
            setSent(null);
            failure.clear();
          }}
          className="min-h-9 text-ink-2 underline-offset-2 hover:text-ink hover:underline"
        >
          {t("login.changeNumber")}
        </button>
        <button
          type="button"
          onClick={() => send()}
          disabled={busy}
          className="min-h-9 text-ink-2 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
        >
          {t("login.resend")}
        </button>
      </div>
    </form>
  );
}

function BrandPanel() {
  const { t } = useI18n();
  const points = [
    { icon: <Sparkles aria-hidden className="size-4" />, text: t("login.point1") },
    { icon: <ShieldCheck aria-hidden className="size-4" />, text: t("login.point2") },
    { icon: <HandCoins aria-hidden className="size-4" />, text: t("login.point3") },
  ];
  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="hidden lg:block">
      <motion.h2 variants={riseIn} className="text-gradient text-4xl font-semibold leading-tight tracking-tight xl:text-5xl">
        {t("login.tagline")}
      </motion.h2>
      <motion.p variants={riseIn} className="mt-4 max-w-md text-base leading-relaxed text-ink-2">
        {t("login.subtitle")}
      </motion.p>
      <ul className="mt-8 space-y-3">
        {points.map((point) => (
          <motion.li key={point.text} variants={riseIn} className="flex items-center gap-3 text-sm text-ink-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-signal/12 text-signal">{point.icon}</span>
            {point.text}
          </motion.li>
        ))}
      </ul>
    </motion.div>
  );
}

function LoginCard() {
  const params = useSearchParams();
  const { t } = useI18n();
  const [audience, setAudience] = useState<Audience>(params.get("tab") === "client" ? "client" : "agency");
  const [method, setMethod] = useState<Method>("password");
  const initialSubdomain = subdomainFrom(params.get("next"));

  function onSignedIn(user: SessionUser) {
    // A full navigation, so the route guard sees the new cookies.
    goTo(safeNext(params.get("next")) ?? homeFor(user));
  }

  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-6xl items-center gap-12 px-4 py-8 sm:px-6 lg:grid-cols-[1.1fr_1fr]">
      <div className="lg:col-start-1 lg:row-start-1 lg:self-center">
        <BrandPanel />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING}
        className="mx-auto w-full max-w-md lg:col-start-2"
      >
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Wordmark />
          <LanguageToggle />
        </div>

        <div className="surface sheen rounded-3xl p-5 sm:p-7">
          <h1 className="sr-only">{t("login.signIn")}</h1>
          <Segmented<Audience>
            label={t("login.signIn")}
            value={audience}
            onChange={setAudience}
            className="relative flex w-full rounded-2xl"
            optionClassName="flex-1 rounded-xl py-2 text-center leading-snug"
            options={[
              { value: "agency", label: t("login.tabAgency") },
              { value: "client", label: t("login.tabClient") },
            ]}
          />

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={audience}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
              transition={SPRING}
              className="relative mt-5"
            >
              <h2 className="text-lg font-semibold tracking-tight text-ink">
                {audience === "agency" ? t("login.agencyTitle") : t("login.clientTitle")}
              </h2>
              <p className="mt-1 mb-5 text-sm text-ink-2">
                {audience === "agency" ? t("login.agencyBody") : t("login.clientBody")}
              </p>

              {audience === "client" && (
                <div className="mb-4">
                  <Segmented<Method>
                    label={t("login.signIn")}
                    value={method}
                    onChange={setMethod}
                    className="flex w-full"
                    optionClassName="flex-1 text-center"
                    options={[
                      { value: "password", label: t("login.methodPassword") },
                      { value: "otp", label: t("login.methodOtp") },
                    ]}
                  />
                </div>
              )}

              {audience === "client" && method === "otp" ? (
                <OtpForm initialSubdomain={initialSubdomain} onSignedIn={onSignedIn} />
              ) : (
                <PasswordForm key={audience} audience={audience} initialSubdomain={initialSubdomain} onSignedIn={onSignedIn} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <Link
          href="/"
          className={cn("mt-4 inline-flex min-h-10 items-center gap-1.5 text-xs text-ink-3 transition-colors hover:text-ink")}
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          {t("login.back")}
        </Link>
      </motion.div>
    </main>
  );
}

export function LoginExperience() {
  return (
    <LocaleProvider>
      <LoginCard />
    </LocaleProvider>
  );
}
