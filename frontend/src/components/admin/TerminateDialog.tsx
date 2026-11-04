"use client";

import { AlertTriangle, Power } from "lucide-react";
import { useId, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import type { Tenant } from "@/lib/api";

interface TerminateDialogProps {
  tenant: Tenant | null;
  live: boolean;
  onCancel: () => void;
  /** Resolves to an error message, or null when the tenant was terminated. */
  onConfirm: (tenant: Tenant) => Promise<string | null>;
}

function TerminateForm({ tenant, live, onCancel, onConfirm }: TerminateDialogProps & { tenant: Tenant }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const matches = typed === tenant.slug;

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    const message = await onConfirm(tenant);
    setBusy(false);
    if (message) setError(message);
  }

  return (
    <form onSubmit={confirm} className="p-6">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-halt/15 text-halt">
          <AlertTriangle aria-hidden className="size-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold text-ink">Terminate {tenant.companyName}?</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
            {live
              ? "This stops and removes the container and its nginx route on the live hub. The tenant's data directory moves to the archive root."
              : "This removes the simulated tenant from mock telemetry. Nothing real is affected."}
          </p>
        </div>
      </div>

      <label htmlFor={inputId} className="mt-5 block text-sm text-ink-2">
        Type <code className="font-mono text-ink">{tenant.slug}</code> to confirm
      </label>
      <input
        id={inputId}
        data-autofocus
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="field mt-2 font-mono"
      />
      {error && (
        <p role="alert" className="mt-2 text-sm text-halt-soft">
          {error}
        </p>
      )}

      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex min-h-11 items-center rounded-xl border border-white/12 px-4 text-sm font-medium text-ink hover:border-white/25 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!matches || busy}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-halt px-4 text-sm font-semibold text-white transition-colors hover:bg-[#dc2626] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Power aria-hidden className="size-4" />
          {busy ? "Terminating..." : "Terminate instance"}
        </button>
      </div>
    </form>
  );
}

export function TerminateDialog(props: TerminateDialogProps) {
  const { tenant, onCancel } = props;
  return (
    <Dialog open={tenant !== null} onClose={onCancel} title="Terminate instance" className="sm:max-w-lg">
      {tenant && <TerminateForm key={tenant.id} {...props} tenant={tenant} />}
    </Dialog>
  );
}
