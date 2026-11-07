"use client";

import { Check, X } from "lucide-react";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { UsageCostMeter } from "@/components/portal/UsageCostMeter";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toaster";
import type { BaselineMetrics, Tenant } from "@/lib/hub-types";
import { agencyPeriod, type OpsClient } from "@/lib/ops-api";
import { mockUsage } from "@/lib/knowledge-mock";
import { loadUsageAsStaff, type RoiReport } from "@/lib/portal-api";
import { CURRENCY_SYMBOLS, ONBOARDING_STEPS } from "@/lib/provisioning";
import { cn } from "@/lib/utils";

interface ClientOpsDrawerProps {
  tenant: Tenant | null;
  ops: OpsClient;
  canEditRoi: boolean;
  /** True when no hub answers, so the usage panel shows sample figures instead of failing. */
  mock: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export function ClientOpsDrawer({ tenant, onClose, ...rest }: ClientOpsDrawerProps) {
  return (
    <Dialog open={tenant !== null} onClose={onClose} title={tenant ? `Manage ${tenant.companyName}` : "Manage client"} placement="right">
      {tenant && <Body key={tenant.id} tenant={tenant} onClose={onClose} {...rest} />}
    </Dialog>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-ink-2">
        {label}
      </label>
      <input id={id} inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} className="field font-mono" />
    </div>
  );
}

function Body({ tenant, ops, canEditRoi, mock, onClose, onChanged }: Omit<ClientOpsDrawerProps, "tenant"> & { tenant: Tenant }) {
  const notify = useToast();
  const base = useId();
  const [stage, setStage] = useState(tenant.onboardingStage);
  const [report, setReport] = useState<RoiReport | null>(null);
  const [period, setPeriod] = useState(agencyPeriod);
  const [baseline, setBaseline] = useState({
    inquiries: tenant.baseline ? String(tenant.baseline.monthlyInquiries) : "",
    conversion: tenant.baseline ? String(tenant.baseline.conversionRate) : "",
    value: tenant.baseline ? String(tenant.baseline.avgOrderOrProfitValue) : "",
    retainer: tenant.baseline ? String(tenant.baseline.monthlyRetainerInvestment) : "",
  });
  const [entry, setEntry] = useState({ inquiries: "", qualified: "", confirmed: "", adSpend: "" });
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const [entryError, setEntryError] = useState<string | null>(null);
  const symbol = CURRENCY_SYMBOLS[tenant.currency] ?? tenant.currency;
  const slug = tenant.slug;
  const loadUsage = useCallback(
    () => (mock ? Promise.resolve(mockUsage(null, true)) : loadUsageAsStaff(slug)),
    [mock, slug],
  );

  useEffect(() => {
    let cancelled = false;
    ops.roi(tenant.id, period).then(
      (next) => {
        if (cancelled) return;
        setReport(next);
        setEntry({
          inquiries: next.funnel ? String(next.funnel.totalInquiries) : "",
          qualified: next.funnel ? String(next.funnel.qualifiedLeads) : "",
          confirmed: next.funnel ? String(next.funnel.confirmedOutcomes) : "",
          adSpend: next.result ? String(next.result.adSpend) : "",
        });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [ops, tenant.id, period]);

  async function chooseStage(next: number) {
    const before = stage;
    setStage(next);
    try {
      await ops.updateClient(tenant.id, { onboardingStage: next });
      notify(`${tenant.companyName} moved to ${ONBOARDING_STEPS[next - 1]}.`);
      onChanged();
    } catch (failure) {
      setStage(before);
      notify(failure instanceof Error ? failure.message : "That did not save.", "error");
    }
  }

  async function saveBaseline(event: FormEvent) {
    event.preventDefault();
    const values = [baseline.inquiries, baseline.conversion, baseline.value, baseline.retainer];
    const numbers = values.map(Number);
    if (values.some((value) => !value.trim()) || numbers.some((value) => !Number.isFinite(value) || value < 0) || numbers[1] > 100) {
      setBaselineError("Fill in all four figures with valid numbers. Conversion is a percentage, up to 100.");
      return;
    }
    setBaselineError(null);
    const metrics: BaselineMetrics = {
      monthlyInquiries: Math.round(numbers[0]),
      conversionRate: numbers[1],
      avgOrderOrProfitValue: numbers[2],
      monthlyRetainerInvestment: numbers[3],
    };
    try {
      await ops.updateClient(tenant.id, { baseline: metrics });
      setReport(await ops.roi(tenant.id, period));
      notify("Baseline saved.");
      onChanged();
    } catch (failure) {
      setBaselineError(failure instanceof Error ? failure.message : "That did not save.");
    }
  }

  async function saveEntry(event: FormEvent) {
    event.preventDefault();
    const values = [entry.inquiries, entry.qualified, entry.confirmed];
    const numbers = [...values, entry.adSpend || "0"].map(Number);
    if (values.some((value) => !value.trim()) || numbers.some((value) => !Number.isFinite(value) || value < 0)) {
      setEntryError("Enter whole numbers for the funnel, and a valid ad spend.");
      return;
    }
    if (!(numbers[2] <= numbers[1] && numbers[1] <= numbers[0])) {
      setEntryError("Confirmed cannot exceed qualified, and qualified cannot exceed inquiries.");
      return;
    }
    setEntryError(null);
    try {
      setReport(
        await ops.saveRoi(tenant.id, period, {
          totalInquiries: Math.round(numbers[0]),
          qualifiedLeads: Math.round(numbers[1]),
          confirmedOutcomes: Math.round(numbers[2]),
          adSpend: numbers[3],
        }),
      );
      notify("Results saved. The owner sees them now.");
    } catch (failure) {
      setEntryError(failure instanceof Error ? failure.message : "That did not save.");
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-4">
        <h2 className="truncate text-lg font-semibold tracking-tight text-ink">{tenant.companyName}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-white/6 hover:text-ink">
          <X aria-hidden className="size-4" />
        </button>
      </div>

      <div className="thin-scroll min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
        <section aria-label="Onboarding stage">
          <h3 className="text-sm font-semibold text-ink">7-step onboarding</h3>
          <p className="mt-0.5 text-xs text-ink-3">
            Until step 7, every draft goes to the team first. At step 7 drafts go straight to the owner.
          </p>
          <ol className="mt-2 space-y-1">
            {ONBOARDING_STEPS.map((step, index) => {
              const number = index + 1;
              const done = number < stage;
              const current = number === stage;
              return (
                <li key={step}>
                  <button
                    type="button"
                    onClick={() => chooseStage(number)}
                    aria-current={current ? "step" : undefined}
                    className={cn(
                      "flex min-h-10 w-full items-center gap-2.5 rounded-lg border px-2.5 text-left text-sm transition-colors",
                      current ? "border-signal/50 bg-signal/7 text-ink" : "border-transparent text-ink-2 hover:bg-white/4",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[10.5px]",
                        done ? "bg-signal text-obsidian" : current ? "border border-signal text-signal" : "border border-white/15 text-ink-3",
                      )}
                    >
                      {done ? <Check aria-hidden className="size-3" /> : number}
                    </span>
                    {step}
                  </button>
                </li>
              );
            })}
          </ol>
        </section>

        <section aria-label="AI usage and cost" className="border-t border-white/8 pt-5">
          <UsageCostMeter load={loadUsage} />
        </section>

        {canEditRoi && (
          <>
            <form onSubmit={saveBaseline} aria-label="Baseline" className="border-t border-white/8 pt-5">
              <h3 className="text-sm font-semibold text-ink">Baseline, in {tenant.currency}</h3>
              <p className="mt-0.5 text-xs text-ink-3">Where the business stood before onboarding. ROI is measured against this.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <NumberField id={`${base}-b1`} label="Monthly inquiries" value={baseline.inquiries} onChange={(inquiries) => setBaseline({ ...baseline, inquiries })} />
                <NumberField id={`${base}-b2`} label="Conversion rate %" value={baseline.conversion} onChange={(conversion) => setBaseline({ ...baseline, conversion })} />
                <NumberField id={`${base}-b3`} label={`Profit per order or booking (${symbol})`} value={baseline.value} onChange={(value) => setBaseline({ ...baseline, value })} />
                <NumberField id={`${base}-b4`} label={`Monthly retainer (${symbol})`} value={baseline.retainer} onChange={(retainer) => setBaseline({ ...baseline, retainer })} />
              </div>
              {baselineError && <p role="alert" className="mt-2 text-sm text-halt-soft">{baselineError}</p>}
              <button type="submit" className="mt-3 inline-flex min-h-10 items-center rounded-xl border border-white/15 px-3.5 text-sm font-medium text-ink hover:border-white/30">
                Save baseline
              </button>
            </form>

            <form onSubmit={saveEntry} aria-label="Monthly results" className="border-t border-white/8 pt-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink">Monthly results</h3>
                <label className="flex items-center gap-2 text-xs text-ink-3">
                  Month
                  <input type="month" value={period} onChange={(event) => event.target.value && setPeriod(event.target.value)} className="field min-h-10 w-auto py-1.5 text-xs [color-scheme:dark]" />
                </label>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <NumberField id={`${base}-e1`} label="Total inquiries" value={entry.inquiries} onChange={(inquiries) => setEntry({ ...entry, inquiries })} />
                <NumberField id={`${base}-e2`} label="Qualified leads" value={entry.qualified} onChange={(qualified) => setEntry({ ...entry, qualified })} />
                <NumberField
                  id={`${base}-e3`}
                  label={tenant.businessMode === "ecommerce" ? "Delivered orders" : "Confirmed bookings"}
                  value={entry.confirmed}
                  onChange={(confirmed) => setEntry({ ...entry, confirmed })}
                />
                <NumberField id={`${base}-e4`} label={`Ad spend (${symbol})`} value={entry.adSpend} onChange={(adSpend) => setEntry({ ...entry, adSpend })} />
              </div>
              {entryError && <p role="alert" className="mt-2 text-sm text-halt-soft">{entryError}</p>}
              <button type="submit" className="mt-3 inline-flex min-h-10 items-center rounded-xl bg-signal px-3.5 text-sm font-semibold text-obsidian">
                Save results
              </button>
              {report?.result && (
                <p role="status" className="mt-3 rounded-xl border border-white/8 bg-white/3 px-3 py-2 text-sm text-ink-2">
                  Net value {symbol}
                  {report.result.netValue.toLocaleString()}
                  {report.result.roiPercent !== null && <> , ROI {report.result.roiPercent}%</>}
                </p>
              )}
              {report && report.funnel && !report.result && (
                <p role="status" className="mt-3 text-xs text-ink-3">Add a baseline to calculate ROI for this month.</p>
              )}
            </form>
          </>
        )}
      </div>
    </div>
  );
}
