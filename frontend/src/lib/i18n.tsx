"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { bn, en, type MessageKey } from "./i18n-messages";
import { formatCountdown, formatDuration } from "./portal-format";

export type Locale = "en" | "bn";

const STORAGE_KEY = "portal.locale";
const listeners = new Set<() => void>();
/** Used when storage is blocked, so the toggle still works for this page's lifetime. */
let memoryLocale: Locale = "en";

function readLocale(): Locale {
  try {
    return localStorage.getItem(STORAGE_KEY) === "bn" ? "bn" : "en";
  } catch {
    return memoryLocale;
  }
}

function writeLocale(next: Locale): void {
  memoryLocale = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage blocked: memoryLocale carries it.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface I18n {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  number: (value: number, fractionDigits?: number) => string;
  percent: (value: number) => string;
  money: (value: number, currency: string) => string;
  date: (iso: string) => string;
  month: (period: string) => string;
  dateTime: (iso: string) => string;
  relative: (iso: string | null) => string;
  duration: (ms: number | null) => string | null;
  countdown: (ms: number) => string;
}

const BANGLA_DIGITS = "০১২৩৪৫৬৭৮৯";

function build(locale: Locale): I18n {
  const messages = locale === "bn" ? bn : en;
  const numberLocale = locale === "bn" ? "bn-BD" : "en-US";
  const digits = (text: string) => (locale === "bn" ? text.replace(/\d/g, (digit) => BANGLA_DIGITS[Number(digit)]) : text);
  const t: I18n["t"] = (key, vars) => {
    let text: string = messages[key] ?? en[key];
    for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  };

  return {
    locale,
    setLocale: writeLocale,
    t,
    number(value, fractionDigits = 0) {
      return new Intl.NumberFormat(numberLocale, { maximumFractionDigits: fractionDigits }).format(value);
    },
    percent(value) {
      return `${new Intl.NumberFormat(numberLocale, { maximumFractionDigits: 2 }).format(value)}%`;
    },
    money(value, currency) {
      // Bangladeshi readers group in lakhs and crores, in either language.
      const moneyLocale = locale === "bn" ? "bn-BD" : currency === "BDT" ? "en-IN" : "en-US";
      return new Intl.NumberFormat(moneyLocale, {
        style: "currency",
        currency,
        currencyDisplay: "narrowSymbol",
        // Exact when there are cents, and no ".00" noise when there are none.
        minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(value);
    },
    date(iso) {
      return new Intl.DateTimeFormat(locale === "bn" ? "bn-BD" : "en-GB", { day: "numeric", month: "short" }).format(new Date(iso));
    },
    month(period) {
      const [year, month] = period.split("-").map(Number);
      return new Intl.DateTimeFormat(locale === "bn" ? "bn-BD" : "en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
        new Date(Date.UTC(year, month - 1, 1)),
      );
    },
    dateTime(iso) {
      return new Intl.DateTimeFormat(locale === "bn" ? "bn-BD" : "en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(iso));
    },
    relative(iso) {
      if (!iso) return t("time.never");
      const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
      if (seconds < 60) return t("time.justNow");
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return t("time.minutes", { count: digits(String(minutes)) });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return t("time.hours", { count: digits(String(hours)) });
      return t("time.days", { count: digits(String(Math.round(hours / 24))) });
    },
    duration(ms) {
      const text = formatDuration(ms);
      return text === null ? null : digits(text);
    },
    countdown(ms) {
      return ms <= 0 ? t("time.dueNow") : digits(formatCountdown(ms));
    },
  };
}

const I18nContext = createContext<I18n>(build("en"));

export function useI18n(): I18n {
  return useContext(I18nContext);
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  // The server cannot see the stored choice, so it renders English and the client
  // switches right after hydration.
  const locale = useSyncExternalStore(subscribe, readLocale, () => "en" as Locale);
  const value = useMemo(() => build(locale), [locale]);

  useEffect(() => {
    document.documentElement.lang = locale;
    return () => {
      document.documentElement.lang = "en";
    };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Each option is written in its own language, so it can be found by someone who cannot read the other. */
export function LanguageToggle({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t("common.language")}
      className={`inline-flex rounded-lg border border-white/10 bg-white/3 p-0.5 text-xs font-medium ${className ?? ""}`}
    >
      {(["en", "bn"] as const).map((option) => (
        <button
          key={option}
          type="button"
          lang={option}
          aria-pressed={locale === option}
          onClick={() => setLocale(option)}
          className={`inline-flex min-h-9 min-w-10 items-center justify-center rounded-md px-2.5 transition-colors ${
            locale === option ? "bg-white/12 text-ink" : "text-ink-3 hover:text-ink-2"
          }`}
        >
          {option === "en" ? "EN" : "বাংলা"}
        </button>
      ))}
    </div>
  );
}
