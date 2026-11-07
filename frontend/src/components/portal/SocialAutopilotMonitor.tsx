"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRight,
  BadgeCheck,
  CircleAlert,
  FlaskConical,
  Hand,
  Image as ImageIcon,
  LoaderCircle,
  MessageCircle,
  MessagesSquare,
  Palette,
  RotateCw,
  Send,
  Sparkles,
  UserCheck,
} from "lucide-react";
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toaster";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages";
import { riseIn, SPRING } from "@/lib/motion";
import type {
  BrandKit,
  GenerateNowResult,
  PortalClient,
  SocialAutopilot,
  SocialComment,
  SocialOutcome,
  SocialPost,
  SocialPostStatus,
} from "@/lib/portal-api";
import { cn } from "@/lib/utils";

const HEX = /^#[0-9A-Fa-f]{6}$/;
type Mode = "zero" | "approval";

const STATUS_LABEL: Record<SocialPostStatus, MessageKey> = {
  published: "social.statusPublished",
  awaiting_approval: "social.statusAwaiting",
  failed: "social.statusFailed",
  rejected: "social.statusRejected",
};

const STATUS_STYLE: Record<SocialPostStatus, string> = {
  published: "border-signal/30 bg-signal/10 text-signal",
  awaiting_approval: "border-warn/30 bg-warn/10 text-warn",
  failed: "border-halt/35 bg-halt/10 text-halt-soft",
  rejected: "border-white/12 bg-white/4 text-ink-3",
};

const OUTCOME_MESSAGE: Record<Exclude<SocialOutcome, "published">, MessageKey> = {
  awaiting_owner: "social.resultAwaitingOwner",
  in_qa_review: "social.resultQa",
  failed: "social.resultFailed",
};

function resultMessage(result: GenerateNowResult): MessageKey {
  if (result.outcome !== "published") return OUTCOME_MESSAGE[result.outcome];
  return result.post.publishMode === "live" ? "social.resultPublishedLive" : "social.resultPublishedSandbox";
}

/** The post's visual, fetched with the caller's own credentials so no image URL is ever public. */
function PostImage({ client, post, className }: { client: PortalClient; post: SocialPost; className?: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ id: string; src: string | null } | null>(null);

  useEffect(() => {
    if (!post.hasImage) return;
    let cancelled = false;
    let created: string | null = null;
    client.socialMedia(post.id).then((src) => {
      if (src?.startsWith("blob:")) created = src;
      if (cancelled) {
        if (created) URL.revokeObjectURL(created);
        return;
      }
      setState({ id: post.id, src });
    });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [client, post.id, post.hasImage]);

  const src = state?.id === post.id ? state.src : null;
  const loading = post.hasImage && state?.id !== post.id;

  return (
    <div className={cn("relative aspect-square overflow-hidden rounded-2xl bg-obsidian", className)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- a blob or data URL: next/image cannot optimise either
        <img src={src} alt={t("social.imageAlt", { headline: post.headline })} className="size-full object-cover" />
      ) : (
        <div
          role={loading ? "status" : undefined}
          aria-label={loading ? t("common.loading") : undefined}
          className={cn(
            "flex size-full flex-col items-center justify-center gap-2 text-ink-3",
            loading ? "animate-pulse bg-white/4" : "bg-linear-to-br from-hyper/20 to-signal/10",
          )}
        >
          {!loading && (
            <>
              <ImageIcon aria-hidden className="size-6" />
              <span className="px-3 text-center text-xs">{post.headline}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Chip({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex min-h-6 items-center gap-1 rounded-full border px-2 font-mono text-[10.5px] uppercase tracking-wider", className)}>
      {children}
    </span>
  );
}

function PostMeta({ post }: { post: SocialPost }) {
  const { t, number } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip className={STATUS_STYLE[post.status]}>{t(STATUS_LABEL[post.status])}</Chip>
      {post.publishMode === "sandbox" && <Chip className="border-white/12 bg-white/4 text-ink-2">{t("social.sandbox")}</Chip>}
      {post.publishMode === "live" && <Chip className="border-signal/30 bg-signal/10 text-signal">{t("social.live")}</Chip>}
      {post.demo && (
        <Chip className="border-warn/30 bg-warn/10 text-warn">
          <FlaskConical aria-hidden className="size-3" />
          {t("social.sample")}
        </Chip>
      )}
      {post.platforms.map((platform) => (
        <Chip key={platform} className="border-hyper/30 bg-hyper/10 text-hyper-soft">
          {platform === "facebook" ? t("social.facebook") : platform === "instagram" ? t("social.instagram") : platform}
        </Chip>
      ))}
      <span className="sr-only">
        {post.reach === null ? t("social.reachUnknown") : `${t("social.reach")} ${number(post.reach)}`}
      </span>
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title} className="min-w-0">
      <dt className="truncate text-[11px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-ink">{value}</dd>
    </div>
  );
}

function PostCard({ client, post }: { client: PortalClient; post: SocialPost }) {
  const { t, number } = useI18n();
  return (
    <motion.li
      layout
      variants={riseIn}
      initial="hidden"
      animate="show"
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      className="surface flex flex-col gap-3 rounded-2xl p-3.5"
    >
      <PostImage client={client} post={post} />
      <PostMeta post={post} />
      <div className="min-w-0">
        <h4 className="text-sm font-semibold leading-snug text-ink">{post.headline}</h4>
        <p className="mt-1 line-clamp-3 whitespace-pre-line text-[13px] leading-relaxed text-ink-2">{post.caption}</p>
        <p className="mt-1.5 flex flex-wrap gap-x-2 text-xs text-hyper-soft">
          {post.hashtags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </p>
      </div>
      <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-white/7 pt-3">
        <Stat
          label={t("social.reach")}
          value={post.reach === null ? "--" : number(post.reach)}
          title={post.reach === null ? t("social.reachUnknown") : undefined}
        />
        <Stat label={t("social.replied")} value={number(post.commentsReplied)} />
        <Stat label={t("social.leads")} value={number(post.leadsCaptured)} />
      </dl>
    </motion.li>
  );
}

function ConversionRow({ comment }: { comment: SocialComment }) {
  const { t } = useI18n();
  return (
    <motion.li
      layout
      variants={riseIn}
      initial="hidden"
      animate="show"
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      className="surface rounded-2xl p-4"
    >
      <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr] lg:items-stretch">
        <div className="min-w-0 rounded-xl border border-white/7 bg-black/25 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-3">
            <MessageCircle aria-hidden className="size-3.5" />
            {t("social.streamComment")}
          </p>
          <p className="mt-1.5 text-sm font-medium text-ink">{comment.text}</p>
          <p className="mt-1 text-xs text-ink-3">{comment.author}</p>
        </div>
        <ArrowRight aria-hidden className="hidden size-4 self-center text-ink-3 lg:block" />
        <div className="min-w-0 rounded-xl border border-signal/20 bg-signal/6 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-signal">
            <Sparkles aria-hidden className="size-3.5" />
            {t("social.streamReply")}
          </p>
          <p className="mt-1.5 text-sm text-ink">{comment.publicReply}</p>
        </div>
        <ArrowRight aria-hidden className="hidden size-4 self-center text-ink-3 lg:block" />
        <div className="min-w-0 rounded-xl border border-hyper/25 bg-hyper/8 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-hyper-soft">
            <Send aria-hidden className="size-3.5" />
            {t("social.streamDm")}
          </p>
          <p className="mt-1.5 text-sm text-ink">{comment.dmText}</p>
          {comment.handoffTo && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-white/6 px-2 py-0.5 text-[11px] font-medium text-ink-2">
              <UserCheck aria-hidden className="size-3" />
              {t("social.streamHandoff", { agent: comment.handoffTo })}
            </p>
          )}
        </div>
      </div>
      {comment.sample && (
        <p className="mt-2.5 inline-flex items-center gap-1 text-[11px] text-warn">
          <FlaskConical aria-hidden className="size-3" />
          {t("social.streamSample")}
        </p>
      )}
    </motion.li>
  );
}

function ColourField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-ink-2">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={label}
          value={HEX.test(value) ? value : "#00F5D4"}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="size-11 shrink-0 cursor-pointer rounded-lg border border-white/10 bg-transparent p-1"
        />
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!HEX.test(value)}
          className="field font-mono"
        />
      </div>
    </div>
  );
}

function BrandKitCard({
  kit,
  saving,
  onSave,
}: {
  kit: BrandKit;
  saving: boolean;
  onSave: (kit: BrandKit) => void;
}) {
  const { t } = useI18n();
  const base = useId();
  const [draft, setDraft] = useState(kit);
  const [invalid, setInvalid] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(kit);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!HEX.test(draft.primaryColor) || !HEX.test(draft.accentColor) || !draft.logoText.trim() || !draft.contactCta.trim()) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSave({ ...draft, logoText: draft.logoText.trim(), contactCta: draft.contactCta.trim() });
  }

  return (
    <form onSubmit={submit} noValidate className="surface rounded-2xl p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Palette aria-hidden className="size-4 text-ink-3" />
        {t("social.brandTitle")}
      </h3>
      <p className="mt-1 text-xs text-ink-3">{t("social.brandBody")}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <ColourField
          id={`${base}-primary`}
          label={t("social.brandPrimary")}
          value={draft.primaryColor}
          onChange={(primaryColor) => setDraft((current) => ({ ...current, primaryColor }))}
        />
        <ColourField
          id={`${base}-accent`}
          label={t("social.brandAccent")}
          value={draft.accentColor}
          onChange={(accentColor) => setDraft((current) => ({ ...current, accentColor }))}
        />
        <div>
          <label htmlFor={`${base}-logo`} className="mb-1.5 block text-xs font-medium text-ink-2">
            {t("social.brandLogo")}
          </label>
          <input
            id={`${base}-logo`}
            value={draft.logoText}
            onChange={(event) => setDraft((current) => ({ ...current, logoText: event.target.value }))}
            maxLength={24}
            className="field"
          />
        </div>
        <div>
          <label htmlFor={`${base}-cta`} className="mb-1.5 block text-xs font-medium text-ink-2">
            {t("social.brandCta")}
          </label>
          <input
            id={`${base}-cta`}
            value={draft.contactCta}
            onChange={(event) => setDraft((current) => ({ ...current, contactCta: event.target.value }))}
            maxLength={34}
            className="field"
          />
        </div>
      </div>
      {invalid && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-halt-soft">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t("social.brandInvalid")}
        </p>
      )}
      <motion.button
        type="submit"
        whileTap={{ scale: 0.98 }}
        transition={SPRING}
        disabled={!dirty || saving}
        className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/15 px-4 text-sm font-semibold text-ink transition-colors hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving && <LoaderCircle aria-hidden className="animate-spin-slow size-4" />}
        {t("social.brandSave")}
      </motion.button>
    </form>
  );
}

interface SocialAutopilotMonitorProps {
  client: PortalClient;
  /** Called after anything that may have changed the approval queue. */
  onChanged: () => void;
}

export function SocialAutopilotMonitor({ client, onChanged }: SocialAutopilotMonitorProps) {
  const { t } = useI18n();
  const notify = useToast();
  const [data, setData] = useState<SocialAutopilot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"mode" | "brand" | null>(null);
  const [generating, setGenerating] = useState(false);
  const [latest, setLatest] = useState<GenerateNowResult | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await client.socialAutopilot());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("social.loadError"));
    }
  }, [client, t]);

  useEffect(() => {
    let cancelled = false;
    client.socialAutopilot().then(
      (next) => {
        if (!cancelled) setData(next);
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : t("social.loadError"));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, t]);

  async function changeMode(next: Mode) {
    if (!data || saving || (next === "zero") === data.autopilotSocial) return;
    setSaving("mode");
    try {
      setData(await client.updateSocialSettings({ autopilotSocial: next === "zero" }));
      notify(t("social.modeSaved"), "success");
      onChanged();
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : t("social.generateError"), "error");
    } finally {
      setSaving(null);
    }
  }

  async function saveBrand(kit: BrandKit) {
    setSaving("brand");
    try {
      setData(await client.updateSocialSettings({ brandKit: kit }));
      notify(t("social.brandSaved"), "success");
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : t("social.generateError"), "error");
    } finally {
      setSaving(null);
    }
  }

  async function generate() {
    if (generating) return;
    setGenerating(true);
    try {
      const result = await client.generateNow();
      setLatest(result);
      await load();
      onChanged();
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : t("social.generateError"), "error");
    } finally {
      setGenerating(false);
    }
  }

  if (error && !data) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
        <p>{error}</p>
        <button
          type="button"
          onClick={load}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70"
        >
          <RotateCw aria-hidden className="size-3.5" />
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (!data) {
    return <div aria-busy="true" aria-label={t("common.loading")} className="h-96 animate-pulse rounded-3xl bg-white/3" />;
  }

  const zero = data.autopilotSocial;

  return (
    <div className="space-y-6">
      <motion.div
        role="status"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING}
        className={cn(
          "relative overflow-hidden rounded-2xl border px-4 py-3.5 sm:px-5",
          zero
            ? "border-signal/35 bg-signal/8 shadow-[0_0_40px_-12px_rgb(0_245_212/0.5)]"
            : "border-warn/30 bg-warn/8",
        )}
      >
        <p className={cn("flex items-center gap-2.5 font-mono text-[11.5px] font-semibold tracking-[0.12em] sm:text-xs", zero ? "text-signal" : "text-warn")}>
          <span aria-hidden className="relative flex size-2.5 shrink-0">
            {zero && <span className="absolute inline-flex size-full animate-ping rounded-full bg-signal/60 motion-reduce:animate-none" />}
            <span className={cn("relative inline-flex size-2.5 rounded-full", zero ? "bg-signal" : "bg-warn")} />
          </span>
          {zero ? t("social.bannerOn") : t("social.bannerOff")}
        </p>
      </motion.div>

      {!data.livePublishing && (
        <div role="note" className="flex items-start gap-2.5 rounded-2xl border border-warn/30 bg-warn/8 px-4 py-3 text-sm text-ink-2">
          <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
          <p>
            <span className="font-semibold text-warn">{t("social.sandboxTitle")}</span> {t("social.sandboxBody")}
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="surface rounded-2xl p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Hand aria-hidden className="size-4 text-ink-3" />
            {t("social.modeLabel")}
          </h3>
          <Segmented<Mode>
            label={t("social.modeLabel")}
            value={zero ? "zero" : "approval"}
            onChange={changeMode}
            className="mt-3 flex w-full flex-wrap rounded-2xl"
            optionClassName="min-h-11 flex-1 px-3 text-center"
            options={[
              { value: "zero", label: t("social.modeZero") },
              { value: "approval", label: t("social.modeApproval") },
            ]}
          />
          <p className="mt-2.5 text-xs leading-relaxed text-ink-3" aria-live="polite">
            {zero ? t("social.modeZeroBody") : t("social.modeApprovalBody")}
          </p>

          <motion.button
            type="button"
            onClick={generate}
            disabled={generating}
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.98 }}
            transition={SPRING}
            className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian transition-colors hover:bg-[#3ff9e2] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {generating ? <LoaderCircle aria-hidden className="animate-spin-slow size-4" /> : <Sparkles aria-hidden className="size-4" />}
            {generating ? t("social.generating") : zero ? t("social.generate") : t("social.generateApproval")}
          </motion.button>
        </div>

        <BrandKitCard key={JSON.stringify(data.brandKit)} kit={data.brandKit} saving={saving === "brand"} onSave={saveBrand} />
      </div>

      <AnimatePresence initial={false}>
        {latest && (
          <motion.section
            key={latest.post.id}
            aria-label={t("social.resultTitle")}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={SPRING}
            className="surface sheen grid gap-4 rounded-3xl p-4 sm:grid-cols-[minmax(0,15rem)_1fr] sm:p-5"
          >
            <PostImage client={client} post={latest.post} />
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-signal">
                <BadgeCheck aria-hidden className="size-4" />
                {t("social.resultTitle")}
              </p>
              <h3 className="mt-2 text-lg font-semibold tracking-tight text-ink">{latest.post.headline}</h3>
              <div className="mt-2">
                <PostMeta post={latest.post} />
              </div>
              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-ink-2">{latest.post.caption}</p>
              <p className="mt-2 flex flex-wrap gap-x-2 text-sm text-hyper-soft">
                {latest.post.hashtags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </p>
              <p role="status" className="mt-3 text-sm font-medium text-ink">
                {t(resultMessage(latest))}
              </p>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <section aria-label={t("social.postsTitle")}>
        <h3 className="text-base font-semibold tracking-tight text-ink">{t("social.postsTitle")}</h3>
        {data.posts.length === 0 ? (
          <p className="mt-3 text-sm text-ink-3">{t("social.postsEmpty")}</p>
        ) : (
          <ul className="relative mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <AnimatePresence mode="popLayout" initial={false}>
              {data.posts.map((post) => (
                <PostCard key={post.id} client={client} post={post} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>

      <section aria-label={t("social.streamTitle")}>
        <h3 className="flex items-center gap-2 text-base font-semibold tracking-tight text-ink">
          <MessagesSquare aria-hidden className="size-4 text-ink-3" />
          {t("social.streamTitle")}
        </h3>
        <p className="mt-1 text-sm text-ink-2">{t("social.streamBody")}</p>
        {data.comments.length === 0 ? (
          <p className="mt-3 text-sm text-ink-3">{t("social.streamEmpty")}</p>
        ) : (
          <ul aria-live="polite" className="relative mt-3 space-y-3">
            <AnimatePresence mode="popLayout" initial={false}>
              {data.comments.map((comment) => (
                <ConversionRow key={comment.id} comment={comment} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>
    </div>
  );
}
