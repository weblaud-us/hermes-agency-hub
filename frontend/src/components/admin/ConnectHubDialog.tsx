"use client";

import { KeyRound } from "lucide-react";
import { useId, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { SecretInput } from "@/components/ui/SecretInput";
import { HUB_URL } from "@/lib/api";

interface ConnectHubDialogProps {
  open: boolean;
  live: boolean;
  connecting: boolean;
  onClose: () => void;
  /** Resolves to an error message, or null when connected. */
  onConnect: (key: string) => Promise<string | null>;
  onDisconnect: () => void;
}

function ConnectForm({ live, connecting, onClose, onConnect, onDisconnect }: Omit<ConnectHubDialogProps, "open">) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!key.trim() || connecting) return;
    setError(null);
    const message = await onConnect(key.trim());
    if (message) setError(message);
  }

  if (!HUB_URL) {
    return (
      <div className="p-6">
        <h2 className="text-base font-semibold text-ink">No hub configured</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          Set <code className="font-mono text-ink">NEXT_PUBLIC_API_URL</code> in{" "}
          <code className="font-mono text-ink">frontend/.env.local</code> and rebuild to connect this console to a hub.
          Until then it runs on mock telemetry.
        </p>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 items-center rounded-xl border border-white/12 px-4 text-sm font-medium text-ink hover:border-white/25"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  if (live) {
    return (
      <div className="p-6">
        <h2 className="text-base font-semibold text-ink">Connected to the live hub</h2>
        <p className="mt-2 break-all font-mono text-xs text-ink-2">{HUB_URL}</p>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">
          The admin key is held in this tab&apos;s session storage and is sent only to this hub.
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onDisconnect}
            className="inline-flex min-h-11 items-center rounded-xl border border-halt/40 px-4 text-sm font-medium text-halt-soft hover:border-halt/70"
          >
            Disconnect
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 items-center rounded-xl border border-white/12 px-4 text-sm font-medium text-ink hover:border-white/25"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="p-6">
      <h2 className="text-base font-semibold text-ink">Connect to the hub</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">
        Enter the hub&apos;s <code className="font-mono text-ink">ADMIN_API_KEY</code>. It stays in this tab&apos;s session
        storage and is sent only to <span className="break-all font-mono text-xs text-ink">{HUB_URL}</span>.
      </p>
      <label htmlFor={inputId} className="mt-5 block text-sm font-medium text-ink-2">
        Admin API key
      </label>
      <SecretInput
        id={inputId}
        secretName="admin API key"
        data-autofocus
        value={key}
        onChange={(event) => setKey(event.target.value)}
        aria-invalid={Boolean(error)}
        className="mt-2"
      />
      {error && (
        <p role="alert" className="mt-2 text-sm text-halt-soft">
          {error}
        </p>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex min-h-11 items-center rounded-xl border border-white/12 px-4 text-sm font-medium text-ink hover:border-white/25"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!key.trim() || connecting}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian disabled:cursor-not-allowed disabled:opacity-40"
        >
          <KeyRound aria-hidden className="size-4" />
          {connecting ? "Connecting..." : "Connect"}
        </button>
      </div>
    </form>
  );
}

export function ConnectHubDialog({ open, onClose, ...rest }: ConnectHubDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Hub connection" className="sm:max-w-lg">
      <ConnectForm onClose={onClose} {...rest} />
    </Dialog>
  );
}
