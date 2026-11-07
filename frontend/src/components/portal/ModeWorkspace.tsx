"use client";

import { BellRing, Boxes, CalendarCheck, Download, Inbox, Plus, RotateCw, Truck } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toaster";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages";
import type {
  BusinessMode,
  CodStatus,
  PortalClient,
  Qualification,
  RecordChanges,
  RecordInput,
  RecordKind,
  RecordStatus,
  WorkRecord,
  WorkspaceKind,
  WorkspaceRecord,
  WorkspaceView,
} from "@/lib/portal-api";
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

// ------------------------------------------------------------------ leads and orders
const LEAD_STATUSES: RecordStatus[] = ["new", "booked", "completed"];
const COD_STATUSES: CodStatus[] = ["pending", "collected", "prepaid"];
const LEAD_STATUS_LABEL: Record<string, MessageKey> = { new: "records.new", booked: "records.booked", completed: "records.completed" };
const ORDER_STATUS_LABEL: Record<string, MessageKey> = { pending: "records.pending", dispatched: "records.dispatchedStatus", delivered: "records.delivered" };
const COD_LABEL: Record<CodStatus, MessageKey> = { pending: "records.codPending", collected: "records.codCollected", prepaid: "records.codPrepaid" };

const FIELD = "min-h-10 w-full rounded-lg border border-white/12 bg-white/4 px-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-signal/50 focus:outline-none";
const HEAD = "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-ink-3";
const CELL = "px-3 py-2.5 align-top text-[13px] text-ink-2";
const BUTTON = "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/12 px-3 text-[13px] font-medium text-ink-2 hover:border-white/30 hover:text-ink disabled:opacity-50";

/** A spreadsheet treats a cell that starts with one of these as a formula, so it is defanged. */
function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function downloadCsv(name: string, header: string[], rows: (string | number)[][]) {
  const body = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function Score({ value }: { value: Qualification }) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        "inline-flex rounded-md border px-1.5 py-0.5 text-[11px] font-semibold",
        value === "hot" ? "border-halt/35 bg-halt/8 text-halt-soft" : "border-warn/35 bg-warn/8 text-warn",
      )}
    >
      {value === "hot" ? t("records.hot") : t("records.warm")}
    </span>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className={cn(FIELD, "min-w-28 py-1")}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} className="bg-obsidian">
          {option.label}
        </option>
      ))}
    </select>
  );
}

function TableShell({
  icon,
  title,
  note,
  actions,
  children,
}: {
  icon: ReactNode;
  title: string;
  note?: string;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="surface rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span className="flex size-7 items-center justify-center rounded-lg bg-signal/12 text-signal">{icon}</span>
          {title}
        </h3>
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </div>
      {note && <p className="mt-2 text-xs text-ink-3">{note}</p>}
      {children}
    </section>
  );
}

/** Saves on blur or Enter, and only when the text actually changed. */
function InlineText({
  label,
  placeholder,
  value,
  maxLength,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value: string;
  maxLength: number;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };
  return (
    <input
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      maxLength={maxLength}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className={cn(FIELD, "min-h-9 py-1")}
    />
  );
}

function AddRecord({
  kind,
  onCreate,
  onCancel,
}: {
  kind: RecordKind;
  onCreate: (input: RecordInput) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ customerName: "", contact: "", serviceRequested: "", preferredDate: "", items: "", totalUsd: "" });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !form.customerName.trim()) return;
    setBusy(true);
    const total = Number.parseFloat(form.totalUsd);
    const saved = await onCreate(
      kind === "lead"
        ? { kind, customerName: form.customerName, contact: form.contact, serviceRequested: form.serviceRequested, preferredDate: form.preferredDate }
        : { kind, customerName: form.customerName, contact: form.contact, items: form.items, totalUsd: Number.isFinite(total) && total >= 0 ? total : 0 },
    );
    setBusy(false);
    if (saved) onCancel();
  }

  return (
    <form onSubmit={submit} className="mt-3 grid gap-2 rounded-xl border border-white/10 bg-white/3 p-3 sm:grid-cols-2 lg:grid-cols-4">
      <input required aria-label={t("records.customerName")} placeholder={t("records.customerName")} value={form.customerName} onChange={set("customerName")} maxLength={120} className={FIELD} />
      <input aria-label={t("records.contact")} placeholder={t("records.contact")} value={form.contact} onChange={set("contact")} maxLength={80} className={FIELD} />
      {kind === "lead" ? (
        <>
          <input aria-label={t("records.service")} placeholder={t("records.service")} value={form.serviceRequested} onChange={set("serviceRequested")} maxLength={200} className={FIELD} />
          <input aria-label={t("records.preferredDate")} placeholder={t("records.preferredDate")} value={form.preferredDate} onChange={set("preferredDate")} maxLength={40} className={FIELD} />
        </>
      ) : (
        <>
          <input aria-label={t("records.itemsAndSize")} placeholder={t("records.itemsPlaceholder")} value={form.items} onChange={set("items")} maxLength={400} className={FIELD} />
          <input aria-label={t("records.total")} placeholder={t("records.total")} inputMode="decimal" value={form.totalUsd} onChange={set("totalUsd")} className={FIELD} />
        </>
      )}
      <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
        <button type="submit" disabled={busy || !form.customerName.trim()} className={cn(BUTTON, "border-signal/40 text-signal")}>
          {t("records.save")}
        </button>
        <button type="button" onClick={onCancel} className={BUTTON}>
          {t("records.cancel")}
        </button>
      </div>
    </form>
  );
}

interface RecordActions {
  create: (input: RecordInput) => Promise<boolean>;
  update: (id: string, changes: RecordChanges, done?: MessageKey) => Promise<boolean>;
}

function LeadsTable({ rows, actions }: { rows: WorkRecord[]; actions: RecordActions }) {
  const { t, dateTime } = useI18n();
  const notify = useToast();
  const [adding, setAdding] = useState(false);
  const leads = rows.filter((row) => row.kind === "lead");

  function exportCsv() {
    if (leads.length === 0) {
      notify(t("records.exportEmpty"), "info");
      return;
    }
    downloadCsv(
      "leads-and-appointments.csv",
      ["Customer Name", "Phone/Handle", "Service Requested", "Preferred Date", "Qualification Score", "Status", "Source", "Captured"],
      leads.map((row) => [row.customerName, row.contact, row.serviceRequested, row.preferredDate, row.qualification === "hot" ? "Hot" : "Warm", row.status, row.source, row.createdAt]),
    );
  }

  return (
    <TableShell
      icon={<CalendarCheck aria-hidden className="size-4" />}
      title={t("records.leadsTitle")}
      actions={
        <>
          <button type="button" onClick={exportCsv} className={BUTTON}>
            <Download aria-hidden className="size-3.5" />
            {t("records.exportCsv")}
          </button>
          <button type="button" onClick={() => setAdding((open) => !open)} aria-expanded={adding} className={cn(BUTTON, "border-signal/40 text-signal")}>
            <Plus aria-hidden className="size-3.5" />
            {t("records.addLead")}
          </button>
        </>
      }
    >
      {adding && <AddRecord kind="lead" onCancel={() => setAdding(false)} onCreate={actions.create} />}
      {leads.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">{t("records.leadsEmpty")}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[56rem] border-collapse">
            <thead>
              <tr className="border-b border-white/8">
                <th scope="col" className={HEAD}>{t("records.customerName")}</th>
                <th scope="col" className={HEAD}>{t("records.contact")}</th>
                <th scope="col" className={HEAD}>{t("records.service")}</th>
                <th scope="col" className={HEAD}>{t("records.preferredDate")}</th>
                <th scope="col" className={HEAD}>{t("records.score")}</th>
                <th scope="col" className={HEAD}>{t("records.status")}</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-t border-white/6">
                  <td className={CELL}>
                    <p className="font-medium text-ink">{lead.customerName}</p>
                    <p className="text-[11px] text-ink-3">{lead.ref} • {dateTime(lead.createdAt)}</p>
                    {lead.message && <p className="mt-1 max-w-64 text-xs text-ink-3">{lead.message}</p>}
                  </td>
                  <td className={CELL}>{lead.contact || "—"}</td>
                  <td className={CELL}>{lead.serviceRequested || "—"}</td>
                  <td className={CELL}>{lead.preferredDate || "—"}</td>
                  <td className={CELL}>
                    <div className="flex items-center gap-2">
                      <Score value={lead.qualification} />
                      <Select<Qualification>
                        label={`${t("records.score")}: ${lead.customerName}`}
                        value={lead.qualification}
                        options={[{ value: "hot", label: t("records.hot") }, { value: "warm", label: t("records.warm") }]}
                        onChange={(qualification) => actions.update(lead.id, { qualification })}
                      />
                    </div>
                  </td>
                  <td className={CELL}>
                    <Select<RecordStatus>
                      label={`${t("records.status")}: ${lead.customerName}`}
                      value={lead.status}
                      options={LEAD_STATUSES.map((value) => ({ value, label: t(LEAD_STATUS_LABEL[value]) }))}
                      onChange={(status) => actions.update(lead.id, { status })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </TableShell>
  );
}

function OrdersTable({ rows, actions }: { rows: WorkRecord[]; actions: RecordActions }) {
  const { t, money } = useI18n();
  const notify = useToast();
  const [adding, setAdding] = useState(false);
  const orders = rows.filter((row) => row.kind === "order");

  function exportCsv() {
    if (orders.length === 0) {
      notify(t("records.exportEmpty"), "info");
      return;
    }
    downloadCsv(
      "orders.csv",
      ["Order ID", "Customer", "Phone/Handle", "Items & Size", "Total (USD)", "COD Status", "Courier", "Courier Tracking #", "Status", "Placed"],
      orders.map((row) => [row.ref, row.customerName, row.contact, row.items, row.totalUsd.toFixed(2), row.codStatus, row.courier, row.trackingNumber, row.status, row.createdAt]),
    );
  }

  return (
    <TableShell
      icon={<Truck aria-hidden className="size-4" />}
      title={t("records.ordersTitle")}
      note={t("records.noCourierNote")}
      actions={
        <>
          <button type="button" onClick={exportCsv} className={BUTTON}>
            <Download aria-hidden className="size-3.5" />
            {t("records.exportCsv")}
          </button>
          <button type="button" onClick={() => setAdding((open) => !open)} aria-expanded={adding} className={cn(BUTTON, "border-signal/40 text-signal")}>
            <Plus aria-hidden className="size-3.5" />
            {t("records.addOrder")}
          </button>
        </>
      }
    >
      {adding && <AddRecord kind="order" onCancel={() => setAdding(false)} onCreate={actions.create} />}
      {orders.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">{t("records.ordersEmpty")}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[64rem] border-collapse">
            <thead>
              <tr className="border-b border-white/8">
                <th scope="col" className={HEAD}>{t("records.orderId")}</th>
                <th scope="col" className={HEAD}>{t("records.customerAndPhone")}</th>
                <th scope="col" className={HEAD}>{t("records.itemsAndSize")}</th>
                <th scope="col" className={HEAD}>{t("records.total")}</th>
                <th scope="col" className={HEAD}>{t("records.cod")}</th>
                <th scope="col" className={HEAD}>{t("records.tracking")}</th>
                <th scope="col" className={HEAD}>{t("records.status")}</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="border-t border-white/6">
                  <td className={cn(CELL, "font-mono text-xs text-ink")}>{order.ref}</td>
                  <td className={CELL}>
                    <p className="font-medium text-ink">{order.customerName}</p>
                    <p className="text-xs text-ink-3">{order.contact || "—"}</p>
                  </td>
                  <td className={CELL}>{order.items || "—"}</td>
                  <td className={cn(CELL, "tabular-nums")}>{money(order.totalUsd, "USD")}</td>
                  <td className={CELL}>
                    <Select<CodStatus>
                      label={`${t("records.cod")}: ${order.ref}`}
                      value={order.codStatus}
                      options={COD_STATUSES.map((value) => ({ value, label: t(COD_LABEL[value]) }))}
                      onChange={(codStatus) => actions.update(order.id, { codStatus })}
                    />
                  </td>
                  <td className={CELL}>
                    <div className="flex min-w-40 flex-col gap-1.5">
                      <InlineText
                        label={`${t("records.courier")}: ${order.ref}`}
                        placeholder={t("records.courier")}
                        value={order.courier}
                        maxLength={80}
                        onCommit={(courier) => actions.update(order.id, { courier })}
                      />
                      <InlineText
                        label={`${t("records.tracking")}: ${order.ref}`}
                        placeholder={t("records.tracking")}
                        value={order.trackingNumber}
                        maxLength={80}
                        onCommit={(trackingNumber) => actions.update(order.id, { trackingNumber })}
                      />
                    </div>
                  </td>
                  <td className={CELL}>
                    <div className="flex flex-col items-start gap-1.5">
                      <span className="rounded-md border border-white/12 px-1.5 py-0.5 text-[11px] font-medium text-ink-2">
                        {t(ORDER_STATUS_LABEL[order.status] ?? "records.pending")}
                      </span>
                      {order.status === "pending" && (
                        <button
                          type="button"
                          onClick={() => actions.update(order.id, { status: "dispatched" }, "records.dispatched")}
                          className={cn(BUTTON, "border-signal/40 text-signal")}
                        >
                          <Truck aria-hidden className="size-3.5" />
                          {t("records.dispatch")}
                        </button>
                      )}
                      {order.status === "dispatched" && (
                        <button type="button" onClick={() => actions.update(order.id, { status: "delivered" })} className={BUTTON}>
                          {t("records.markDelivered")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </TableShell>
  );
}

/** Enquiries the Coordinator captured from comments and chats, ready to turn into an order. */
function Inquiries({ rows, actions }: { rows: WorkRecord[]; actions: RecordActions }) {
  const { t, dateTime } = useI18n();
  const open = rows.filter((row) => row.kind === "lead" && row.status === "new");
  return (
    <section aria-label={t("records.inquiriesTitle")} className="surface rounded-2xl p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <span className="flex size-7 items-center justify-center rounded-lg bg-signal/12 text-signal">
          <Inbox aria-hidden className="size-4" />
        </span>
        {t("records.inquiriesTitle")}
      </h3>
      {open.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">{t("records.inquiriesEmpty")}</p>
      ) : (
        <ul className="mt-2">
          {open.map((lead) => (
            <li key={lead.id} className="border-t border-white/6 py-3 first:border-t-0">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-ink">
                  {lead.customerName} <Score value={lead.qualification} />
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    const created = await actions.create({
                      kind: "order",
                      customerName: lead.customerName,
                      contact: lead.contact,
                      items: lead.message.slice(0, 400),
                      source: lead.source,
                    });
                    if (created) await actions.update(lead.id, { status: "completed" });
                  }}
                  className={BUTTON}
                >
                  {t("records.convert")}
                </button>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-ink-3">
                {[lead.contact, dateTime(lead.createdAt), lead.message].filter(Boolean).join(" • ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ModeWorkspace({ client, currency, mode }: { client: PortalClient; currency: string; mode: BusinessMode }) {
  const { t, number } = useI18n();
  const notify = useToast();
  const [view, setView] = useState<WorkspaceView | null>(null);
  const [rows, setRows] = useState<WorkRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lens, setLens] = useState<BusinessMode>(mode);

  const load = useCallback(async () => {
    try {
      const [workspace, records] = await Promise.all([client.workspace(), client.records()]);
      setView(workspace);
      setRows(records);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("workspace.loadError"));
    }
  }, [client, t]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.workspace(), client.records()]).then(
      ([workspace, records]) => {
        if (!cancelled) {
          setView(workspace);
          setRows(records);
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

  const actions: RecordActions = {
    async create(input) {
      try {
        const created = await client.createRecord(input);
        setRows((current) => [created, ...(current ?? [])]);
        notify(t("records.saved"));
        return true;
      } catch (failure) {
        notify(failure instanceof Error ? failure.message : t("records.saveError"), "error");
        return false;
      }
    },
    async update(id, changes, done) {
      const before = rows;
      // Shown at once and put back if the save fails, so the table never lies for long.
      setRows((current) => current?.map((row) => (row.id === id ? { ...row, ...changes } : row)) ?? current);
      try {
        const saved = await client.updateRecord(id, changes);
        setRows((current) => current?.map((row) => (row.id === id ? saved : row)) ?? current);
        if (done) notify(t(done));
        return true;
      } catch (failure) {
        setRows(before);
        notify(failure instanceof Error ? failure.message : t("records.saveError"), "error");
        return false;
      }
    },
  };

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

  if (!view || !rows) {
    return <div aria-busy="true" aria-label={t("common.loading")} className="h-72 animate-pulse rounded-2xl bg-white/4" />;
  }

  const of = (kind: WorkspaceKind) => view.records.filter((record) => record.kind === kind);
  const stock = of("stock_alert");
  const awaitingCod = rows.filter((row) => row.kind === "order" && row.status === "pending" && row.codStatus === "pending").length;

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
        <div className="mt-4 grid items-start gap-3">
          <LeadsTable rows={rows} actions={actions} />
          <Column icon={<BellRing aria-hidden className="size-4" />} title={t("workspace.followUps")} empty={t("workspace.followUpsEmpty")} records={of("follow_up")} currency={currency} />
        </div>
      ) : (
        <div className="mt-4 grid items-start gap-3">
          <OrdersTable rows={rows} actions={actions} />
          {awaitingCod > 0 && <p className="text-xs font-medium text-warn">{t("workspace.awaitingCod", { count: number(awaitingCod) })}</p>}
          <div className="grid items-start gap-3 lg:grid-cols-2">
            <Inquiries rows={rows} actions={actions} />
            <Column
              icon={<Boxes aria-hidden className="size-4" />}
              title={t("workspace.catalog")}
              note={stock.length > 0 ? t("workspace.lowStock", { count: number(stock.length) }) : undefined}
              empty={t("workspace.catalogEmpty")}
              records={stock}
              currency={currency}
            />
          </div>
        </div>
      )}
    </div>
  );
}
