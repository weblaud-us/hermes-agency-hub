"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { en, type MessageKey } from "./i18n-messages";
import { formatCountdown, formatDuration } from "./portal-format";

export interface I18n {
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

function build(): I18n {
  const t: I18n["t"] = (key, vars) => {
    let text: string = en[key];
    for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  };

  return {
    t,
    number(value, fractionDigits = 0) {
      return new Intl.NumberFormat("en-US", { maximumFractionDigits: fractionDigits }).format(value);
    },
    percent(value) {
      return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}%`;
    },
    money(value, currency) {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        currencyDisplay: "narrowSymbol",
        // Exact when there are cents, and no ".00" noise when there are none.
        minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(value);
    },
    date(iso) {
      return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(iso));
    },
    month(period) {
      const [year, month] = period.split("-").map(Number);
      return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
        new Date(Date.UTC(year, month - 1, 1)),
      );
    },
    dateTime(iso) {
      return new Intl.DateTimeFormat("en-US", {
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
      if (minutes < 60) return t("time.minutes", { count: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return t("time.hours", { count: hours });
      return t("time.days", { count: Math.round(hours / 24) });
    },
    duration(ms) {
      return formatDuration(ms);
    },
    countdown(ms) {
      return ms <= 0 ? t("time.dueNow") : formatCountdown(ms);
    },
  };
}

const I18nContext = createContext<I18n>(build());

export function useI18n(): I18n {
  return useContext(I18nContext);
}

/** The interface is English only. The provider stays so every page keeps one place to read formatting from. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const value = useMemo(() => build(), []);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
