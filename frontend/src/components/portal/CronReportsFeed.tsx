"use client";

import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, CalendarClock, Check, ChevronDown, Download, Play, RotateCw, Send } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "@/components/portal/Markdown";
import { SpotlightCard } from "@/components/ui/SpotlightCard";
import { useToast } from "@/components/ui/Toaster";
import type { CronFeed, CronJob, CronReport, PortalClient } from "@/lib/portal-api";
import { formatCountdown, formatDateTime, formatDuration, markdownToPlainText } from "@/lib/portal-format";
import { SPRING } from "@/lib/motion";
import { cn, formatInteger } from "@/lib/utils";

const FEED_POLL_MS = 30_000;
/** A WhatsApp share link longer than this can fail to open on some phones. */
const SHARE_LIMIT = 1600;

type RunState = "idle" | "queuing" | "queued";

/** Its own timer and state, so one ticking clock never re-renders the whole list. */
function Countdown({ target }: { target: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <span className="font-mono tabular-nums" aria-label={`Next run ${formatDateTime(target)}`}>
      {formatCountdown(new Date(target).getTime() - now)}
    </span>
  );
}

const JOB_DOT: Record<CronJob["status"], string> = {
  scheduled: "bg-hyper",
  running: "bg-hyper",
  paused: "bg-white/40",
  error: "bg-warn",
};

const JOB_LABEL: Record<CronJob["status"], string> = {
  scheduled: "Scheduled",
  running: "Running",
  paused: "Paused",
  error: "Last run had a problem",
};

function RunNowButton({
  state,
  disabled,
  onRun,
  jobName,
}: {
  state: RunState;
  disabled: boolean;
  onRun: () => void;
  jobName: string;
}) {
  return (
    <motion.button
      type="button"
      layout
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.94 }}
      transition={SPRING}
      onClick={onRun}
      disabled={disabled || state !== "idle"}
      aria-label={`Run ${jobName} now`}
      className={cn(
        "inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed",
        state === "queued"
          ? "border-signal/40 bg-signal/10 text-signal"
          : "border-hyper/40 bg-hyper/12 text-hyper-soft hover:border-hyper/70",
        disabled && "opacity-40",
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={state}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.1 } }}
          transition={SPRING}
        >
          {state === "queued" ? (
            <Check aria-hidden className="size-3.5" />
          ) : state === "queuing" ? (
            <RotateCw aria-hidden className="animate-spin-slow size-3.5" />
          ) : (
            <Play aria-hidden className="size-3.5" />
          )}
        </motion.span>
      </AnimatePresence>
      {state === "queued" ? "Queued" : state === "queuing" ? "Starting" : "Run Now"}
    </motion.button>
  );
}

function JobRow({
  job,
  reports,
  expanded,
  selectedReport,
  runState,
  indicatorId,
  onToggle,
  onSelectReport,
  onRun,
}: {
  job: CronJob;
  reports: CronReport[];
  expanded: boolean;
  selectedReport: string | null;
  runState: RunState;
  indicatorId: string;
  onToggle: () => void;
  onSelectReport: (id: string) => void;
  onRun: () => void;
}) {
  return (
    <li className="relative rounded-2xl border border-white/7 bg-white/2">
      {expanded && (
        <motion.span
          layoutId={indicatorId}
          transition={SPRING}
          aria-hidden
          className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-hyper"
        />
      )}
      <div className="flex flex-wrap items-center gap-2 p-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-h-11 min-w-0 flex-1 items-start gap-2.5 rounded-lg text-left"
        >
          <span title={JOB_LABEL[job.status]} aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", JOB_DOT[job.status])} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium leading-snug text-ink">{job.jobName}</span>
            <span className="mt-1 block font-mono text-[11px] tabular-nums text-ink-3">{job.scheduleHuman}</span>
            <span className="sr-only">{JOB_LABEL[job.status]}</span>
          </span>
          <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={SPRING} className="mt-0.5 shrink-0 text-ink-3">
            <ChevronDown aria-hidden className="size-4" />
          </motion.span>
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 pb-3 text-xs text-ink-3">
        <span>
          {job.status === "paused" ? (
            "Paused"
          ) : job.nextRunAt ? (
            <>
              Next run in <span className="text-hyper-soft"><Countdown target={job.nextRunAt} /></span>
            </>
          ) : (
            "No upcoming run"
          )}
        </span>
        <RunNowButton state={runState} disabled={job.status === "paused"} onRun={onRun} jobName={job.jobName} />
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="runs"
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            transition={SPRING}
            style={{ overflow: "hidden" }}
          >
            <ul className="space-y-1 border-t border-white/6 p-2">
              {reports.length === 0 && <li className="px-2 py-2 text-xs text-ink-3">No runs yet.</li>}
              {reports.map((report) => (
                <li key={report.id}>
                  <button
                    type="button"
                    onClick={() => onSelectReport(report.id)}
                    aria-current={selectedReport === report.id}
                    className={cn(
                      "flex min-h-10 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-xs transition-colors",
                      selectedReport === report.id ? "bg-white/8 text-ink" : "text-ink-2 hover:bg-white/4",
                    )}
                  >
                    <span className="font-mono tabular-nums">{formatDateTime(report.executedAt)}</span>
                    {report.status === "failed" && <AlertTriangle aria-label="Did not complete" className="size-3.5 text-warn" />}
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function ReportDocument({ report }: { report: CronReport }) {
  const duration = formatDuration(report.durationMs);

  return (
    <>
      <header className="border-b border-white/7 p-5">
        <h3 className="text-lg font-semibold leading-snug tracking-tight text-ink">{report.jobName}</h3>
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-ink-3">
          <span>{formatDateTime(report.executedAt)}</span>
          <span>{report.scheduleHuman}</span>
          {duration && <span>Ran in {duration}</span>}
        </p>
        {report.metrics.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Highlights">
            {report.metrics.map((metric) => (
              <li
                key={metric.label}
                className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-signal/25 bg-signal/8 px-2.5 text-xs text-ink-2"
              >
                <span className="font-mono font-semibold tabular-nums text-signal">{formatInteger(metric.value)}</span>
                {metric.label}
              </li>
            ))}
          </ul>
        )}
      </header>

      <div className="p-5">
        {report.status === "failed" ? (
          <p role="status" className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/8 p-3 text-sm text-ink-2">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
            {report.summaryMarkdown}
          </p>
        ) : (
          <Markdown source={report.summaryMarkdown} />
        )}
      </div>
    </>
  );
}

function ReportInspector({ report }: { report: CronReport }) {
  const shareText = markdownToPlainText(`${report.jobName}\n\n${report.summaryMarkdown}`);
  const clipped = shareText.length > SHARE_LIMIT ? `${shareText.slice(0, SHARE_LIMIT - 1)}…` : shareText;

  return (
    <article className="flex min-h-0 flex-col">
      <ReportDocument report={report} />

      <footer className="flex flex-wrap justify-end gap-2 border-t border-white/7 p-4">
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          transition={SPRING}
          onClick={() => window.print()}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/12 px-4 text-sm font-medium text-ink transition-colors hover:border-white/25"
        >
          <Download aria-hidden className="size-4" />
          Download PDF
        </motion.button>
        <motion.a
          href={`https://wa.me/?text=${encodeURIComponent(clipped)}`}
          target="_blank"
          rel="noopener noreferrer"
          whileTap={{ scale: 0.97 }}
          transition={SPRING}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-obsidian"
        >
          <Send aria-hidden className="size-4" />
          Forward to WhatsApp
        </motion.a>
      </footer>

      {createPortal(
        <div className="print-root">
          <ReportDocument report={report} />
        </div>,
        document.body,
      )}
    </article>
  );
}

export function CronReportsFeed({ client }: { client: PortalClient }) {
  const notify = useToast();
  const [feed, setFeed] = useState<CronFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [runStates, setRunStates] = useState<Record<string, RunState>>({});
  const indicatorId = useId();
  const resetTimers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const load = useCallback(async () => {
    try {
      const next = await client.cronFeed();
      setFeed(next);
      setError(null);
      return next;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load your briefings.");
      return null;
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const timers = resetTimers.current;
    const poll = async () => {
      if (!document.hidden) await load();
      if (!cancelled) timer = setTimeout(poll, FEED_POLL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      timers.forEach(clearTimeout);
    };
  }, [load]);

  // Nothing chosen yet means the newest briefing, which is what an owner opens this
  // tab to read. A polled feed therefore never yanks away a report being read.
  const selected =
    feed?.reports.find((report) => report.id === selectedReportId) ?? feed?.reports[0] ?? null;
  const openJob = expandedJob ?? selected?.jobId ?? feed?.jobs[0]?.id ?? null;

  async function run(job: CronJob) {
    setRunStates((current) => ({ ...current, [job.id]: "queuing" }));
    try {
      const result = await client.triggerJob(job.id);
      notify(result.detail);
      setRunStates((current) => ({ ...current, [job.id]: "queued" }));
      const timer = setTimeout(
        () => {
          resetTimers.current.delete(timer);
          setRunStates((current) => ({ ...current, [job.id]: "idle" }));
        },
        client.mode === "mock" ? 3000 : 60_000,
      );
      resetTimers.current.add(timer);
      if (client.mode === "mock") {
        const next = await load();
        const newest = next?.reports.find((report) => report.jobId === job.id);
        if (newest) {
          setExpandedJob(job.id);
          setSelectedReportId(newest.id);
        }
      }
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : "That briefing could not be started.", "error");
      setRunStates((current) => ({ ...current, [job.id]: "idle" }));
    }
  }

  if (!feed) {
    if (error) {
      return (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-halt/30 bg-halt/8 px-4 py-3 text-sm text-halt-soft">
          <p>{error}</p>
          <button
            type="button"
            onClick={load}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-halt/40 px-3 font-medium hover:border-halt/70"
          >
            <RotateCw aria-hidden className="size-3.5" />
            Try again
          </button>
        </div>
      );
    }
    return <div aria-busy="true" aria-label="Loading briefings" className="h-96 animate-pulse rounded-3xl bg-white/3" />;
  }

  if (feed.jobs.length === 0 && feed.reports.length === 0) {
    return (
      <SpotlightCard className="p-8 text-center">
        <CalendarClock aria-hidden className="mx-auto size-6 text-ink-3" />
        <h2 className="mt-3 text-sm font-semibold text-ink">No briefings scheduled yet</h2>
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-ink-2">
          Ask your Coordinator to send you a daily summary, and it will appear here after its first run.
        </p>
      </SpotlightCard>
    );
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <SpotlightCard className="p-3 sm:p-4" glow="99 102 241">
        <h2 className="mb-3 px-1 text-sm font-semibold text-ink">Scheduled Briefings</h2>
        <ul className="space-y-2">
          {feed.jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              reports={feed.reports.filter((report) => report.jobId === job.id)}
              expanded={openJob === job.id}
              selectedReport={selected?.id ?? null}
              runState={runStates[job.id] ?? "idle"}
              indicatorId={indicatorId}
              onToggle={() => {
                setExpandedJob(job.id);
                const latest = feed.reports.find((report) => report.jobId === job.id);
                if (latest) setSelectedReportId(latest.id);
              }}
              onSelectReport={setSelectedReportId}
              onRun={() => void run(job)}
            />
          ))}
        </ul>
      </SpotlightCard>

      <SpotlightCard className="min-w-0 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {selected ? (
            <motion.div
              key={selected.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={SPRING}
            >
              <ReportInspector report={selected} />
            </motion.div>
          ) : (
            <p key="empty" className="p-8 text-center text-sm text-ink-3">
              Reports appear here after a briefing&apos;s first run.
            </p>
          )}
        </AnimatePresence>
      </SpotlightCard>
    </div>
  );
}
