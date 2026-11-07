"use client";

import { CalendarCheck, ClipboardList, BellRing, Boxes, RotateCw, Truck } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Segmented } from "@/components/ui/Segmented";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages";
import type { BusinessMode, PortalClient, WorkspaceKind, WorkspaceRecord, WorkspaceView } from "@/lib/portal-api";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, string> = {
  awaiting_cod_confirmation: "border-warn/35 bg-warn/8 text-warn",
  low: "border-warn/35 bg-warn/8 text-warn",
  in_transit: "border-hyper/35 bg-hyper/8 text-hyper-soft",
  delivered: "border-signal/30 bg-signal/8 text-signal",
  confirmed: "border-signal/30 bg-signal/8 text-signal",
  qualified: "border-signal/30 bg-signal/8 text-signal",
};

const KNOWN_STATUSES = new Set([
  "awaiting_cod_confirmation",
  "confirmed",
  "in_transit",
  "delivered",
  "returned",
  "open",
  "new",
  "qualified",
  "low",
]);

function Status({ value }: { value: string }) {
  const { t } = useI18n();
  const label = KNOWN_STATUSES.has(value) ? t(`order.${value}` as MessageKey) : value.replaceAll("_", " ");
  return (
    <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium", STATUS_TONE[value] ?? "border-white/12 text-ink-2")}>
      {label}
    </span>
  );
}

function detailText(detail: Record<string, unknown>, key: string): string | null {
  const value = detail[key];
  return typeof value === "string" && value ? value : null;
}

function detailNumber(detail: Record<string, unknown>, key: string): number | null {
  const value = detail[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function Row({ record, currency }: { record: WorkspaceRecord; currency: string }) {
  const { t, money, number, date } = useI18n();
  const courier = detailText(record.detail, "courier");
  const tracking = detailText(record.detail, "tracking");
  const contact = detailText(record.detail, "contact") ?? detailText(record.detail, "customer");
  const cod = detailNumber(record.detail, "cod_amount");
  const stock = detailNumber(record.detail, "stock");
  const reorder = detailNumber(record.detail, "reorder_at");
  const sku = detailText(record.detail, "sku");

  const facts = [
    contact,
    cod !== null ? money(cod, currency) : null,
    courier,
    tracking ? t("workspace.tracking", { code: tracking }) : null,
    sku,
    stock !== null ? t("workspace.leftInStock", { count: number(stock), reorder: number(reorder ?? 0) }) : null,
    record.dueAt ? t("workspace.due", { date: date(record.dueAt) }) : null,
  ].filter(Boolean);

  return (
    <li className="border-t border-white/6 py-3 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 text-sm font-medium text-ink">{record.title}</p>
        <Status value={record.status} />
      </div>
      {facts.length > 0 && <p className="mt-1 text-xs leading-relaxed text-ink-3">{facts.join(" • ")}</p>}
    </li>
  );
}

function Column({
  icon,
  title,
  note,
  empty,
  records,
  currency,
  wide,
}: {
  icon: ReactNode;
  title: string;
  note?: string;
  empty: string;
  records: WorkspaceRecord[];
  currency: string;
  wide?: boolean;
}) {
  return (
    <section aria-label={title} className={cn("surface rounded-2xl p-4", wide && "lg:col-span-2")}>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <span className="flex size-7 items-center justify-center rounded-lg bg-signal/12 text-signal">{icon}</span>
        {title}
      </h3>
      {note && <p className="mt-2 text-xs font-medium text-warn">{note}</p>}
      {records.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">{empty}</p>
      ) : (
        <ul className="mt-2">
          {records.map((record) => (
            <Row key={record.id} record={record} currency={currency} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function ModeWorkspace({ client, currency, mode }: { client: PortalClient; currency: string; mode: BusinessMode }) {
  const { t, number } = useI18n();
  const [view, setView] = useState<WorkspaceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lens, setLens] = useState<BusinessMode>(mode);

  const load = useCallback(async () => {
    try {
      setView(await client.workspace());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("workspace.loadError"));
    }
  }, [client, t]);

  useEffect(() => {
    let cancelled = false;
    client.workspace().then(
      (next) => {
        if (!cancelled) {
          setView(next);
          setError(null);
        }
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : t("workspace.loadError"));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, t]);

  if (error && !view) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
        <p>{error}</p>
        <button type="button" onClick={load} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70">
          <RotateCw aria-hidden className="size-3.5" />
          {t("common.retry")}
        </button>
      </div>
    );
  }

  if (!view) {
    return <div aria-busy="true" aria-label={t("common.loading")} className="h-72 animate-pulse rounded-2xl bg-white/4" />;
  }

  const of = (kind: WorkspaceKind) => view.records.filter((record) => record.kind === kind);
  const orders = of("order");
  const stock = of("stock_alert");
  const awaiting = orders.filter((order) => order.status === "awaiting_cod_confirmation").length;

  return (
    <div>
      <Segmented<BusinessMode>
        label={t("workspace.view")}
        value={lens}
        onChange={setLens}
        options={[
          { value: "general", label: t("workspace.general") },
          { value: "ecommerce", label: t("workspace.ecommerce") },
        ]}
      />
      {lens !== mode && (
        <p className="mt-3 text-sm text-ink-3">
          {t("workspace.otherMode", { mode: lens === "general" ? t("workspace.general") : t("workspace.ecommerce") })}
        </p>
      )}

      {lens === "general" ? (
        <div className="mt-4 grid items-start gap-3 lg:grid-cols-3">
          <Column icon={<CalendarCheck aria-hidden className="size-4" />} title={t("workspace.appointments")} empty={t("workspace.appointmentsEmpty")} records={of("appointment")} currency={currency} />
          <Column icon={<ClipboardList aria-hidden className="size-4" />} title={t("workspace.leads")} empty={t("workspace.leadsEmpty")} records={of("lead")} currency={currency} />
          <Column icon={<BellRing aria-hidden className="size-4" />} title={t("workspace.followUps")} empty={t("workspace.followUpsEmpty")} records={of("follow_up")} currency={currency} />
        </div>
      ) : (
        <div className="mt-4 grid items-start gap-3 lg:grid-cols-3">
          <Column
            wide
            icon={<Truck aria-hidden className="size-4" />}
            title={t("workspace.orders")}
            note={awaiting > 0 ? t("workspace.awaitingCod", { count: number(awaiting) }) : undefined}
            empty={t("workspace.ordersEmpty")}
            records={orders}
            currency={currency}
          />
          <Column
            icon={<Boxes aria-hidden className="size-4" />}
            title={t("workspace.catalog")}
            note={stock.length > 0 ? t("workspace.lowStock", { count: number(stock.length) }) : undefined}
            empty={t("workspace.catalogEmpty")}
            records={stock}
            currency={currency}
          />
        </div>
      )}
    </div>
  );
}
