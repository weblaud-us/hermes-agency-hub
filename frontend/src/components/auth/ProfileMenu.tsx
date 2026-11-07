"use client";

import { AnimatePresence, motion } from "motion/react";
import { Building2, KeyRound, LayoutDashboard, LoaderCircle, LogOut } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { SecretInput } from "@/components/ui/SecretInput";
import { useToast } from "@/components/ui/Toaster";
import { changePassword, goTo, logout, ROLE_LABELS, type SessionUser } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { SPRING } from "@/lib/motion";

function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

const ITEM_CLASS =
  "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-ink-2 transition-colors hover:bg-white/6 hover:text-ink";

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Change password" className="sm:max-w-md">
      <ChangePasswordForm onClose={onClose} />
    </Dialog>
  );
}

function ChangePasswordForm({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const notify = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next.length < 10) {
      setError(t("account.passwordTooShort"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      notify(t("account.passwordChanged"));
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("approvals.error"));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 p-6">
      <h2 className="text-base font-semibold text-ink">{t("account.changePassword")}</h2>
      <div>
        <label htmlFor={`${base}-current`} className="mb-1.5 block text-sm font-medium text-ink-2">
          {t("account.currentPassword")}
        </label>
        <SecretInput
          id={`${base}-current`}
          data-autofocus
          secretName="current password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
      </div>
      <div>
        <label htmlFor={`${base}-new`} className="mb-1.5 block text-sm font-medium text-ink-2">
          {t("account.newPassword")}
        </label>
        <SecretInput
          id={`${base}-new`}
          secretName="new password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          aria-describedby={`${base}-hint`}
        />
        <p id={`${base}-hint`} className="mt-1.5 text-xs text-ink-3">
          {t("account.newPasswordHint")}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-halt-soft">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex min-h-11 items-center rounded-xl border border-white/12 px-4 text-sm font-medium text-ink hover:border-white/25"
        >
          {t("common.cancel")}
        </button>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian disabled:opacity-60"
        >
          {busy && <LoaderCircle aria-hidden className="animate-spin-slow size-4" />}
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}

interface ProfileMenuProps {
  user: SessionUser;
  /** The sample console has no account behind it, so it offers nothing to change. */
  preview?: boolean;
  extraItems?: ReactNode;
}

/** Who you are signed in as, and where you can go from here. */
export function ProfileMenu({ user, preview = false, extraItems }: ProfileMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function signOut() {
    await logout();
    goTo("/login");
  }

  const isOwner = user.role === "CLIENT_OWNER";

  return (
    <div ref={root} className="relative flex items-center gap-1">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t("account.menu")}
        className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-white/10 bg-white/3 py-1 pl-1 pr-2.5 transition-colors hover:border-white/20"
      >
        <span className="relative">
          <span
            aria-hidden
            className="flex size-8 items-center justify-center rounded-md bg-linear-to-br from-hyper/50 to-signal/25 font-mono text-[11px] font-semibold text-ink"
          >
            {initialsOf(user.fullName)}
          </span>
          {/* The session is live: the hub checks it on every request, so this is not decoration. */}
          <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-signal ring-2 ring-[#0b0b10]" />
          <span className="sr-only">{t("account.sessionActive")}</span>
        </span>
        <span className="hidden text-left leading-tight sm:block">
          <span className="block max-w-32 truncate text-xs font-medium text-ink">{user.fullName}</span>
          <span className="mt-0.5 inline-flex rounded border border-hyper/35 bg-hyper/8 px-1 text-[10px] font-medium leading-4 text-hyper-soft">
            {ROLE_LABELS[user.role]}
          </span>
        </span>
      </button>
      {!preview && (
        <button
          type="button"
          onClick={signOut}
          aria-label={t("common.signOut")}
          title={t("common.signOut")}
          className="inline-flex size-11 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-white/6 hover:text-ink"
        >
          <LogOut aria-hidden className="size-4" />
        </button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            id={menuId}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
            transition={SPRING}
            style={{ transformOrigin: "top right" }}
            className="absolute right-0 z-50 mt-2 w-64 rounded-2xl border border-white/10 bg-[#0d0d14] p-1.5 shadow-2xl shadow-black/60"
          >
            <div className="border-b border-white/7 px-2.5 pb-2.5 pt-1.5">
              <p className="text-[11px] text-ink-3">{t("account.signedInAs")}</p>
              <p className="mt-0.5 truncate text-sm font-medium text-ink">{user.fullName}</p>
              <p className="truncate font-mono text-[11px] text-ink-3">{user.email}</p>
              <p className="mt-1.5 inline-flex rounded-md border border-hyper/35 bg-hyper/8 px-1.5 py-0.5 text-[10.5px] font-medium text-hyper-soft">
                {ROLE_LABELS[user.role]}
              </p>
            </div>
            <div className="pt-1.5">
              {extraItems}
              {!isOwner && !preview && (
                <Link href="/admin" className={ITEM_CLASS} onClick={() => setOpen(false)}>
                  <LayoutDashboard aria-hidden className="size-4 shrink-0" />
                  {t("account.toConsole")}
                </Link>
              )}
              {isOwner && user.clientSlug && (
                <Link href={`/portal/${user.clientSlug}`} className={ITEM_CLASS} onClick={() => setOpen(false)}>
                  <Building2 aria-hidden className="size-4 shrink-0" />
                  {t("account.toPortal")}
                </Link>
              )}
              {!preview && (
                <button
                  type="button"
                  className={ITEM_CLASS}
                  onClick={() => {
                    setOpen(false);
                    setPasswordOpen(true);
                  }}
                >
                  <KeyRound aria-hidden className="size-4 shrink-0" />
                  {t("account.changePassword")}
                </button>
              )}
              <button type="button" className={ITEM_CLASS} onClick={signOut}>
                <LogOut aria-hidden className="size-4 shrink-0" />
                {t("common.signOut")}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  );
}
