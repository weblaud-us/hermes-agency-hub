"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, RotateCw, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Markdown } from "@/components/portal/Markdown";
import { Dialog } from "@/components/ui/Dialog";
import { StatusOrb } from "@/components/ui/StatusOrb";
import type { ChatTurn, PortalClient } from "@/lib/portal-api";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages";
import { SPRING } from "@/lib/motion";

interface Bubble extends ChatTurn {
  id: number;
  durationMs?: number;
}

const STARTERS: MessageKey[] = ["chat.starter1", "chat.starter2", "chat.starter3"];

/** The hub accepts this many turns; older ones have already left the agent's context. */
const HISTORY_LIMIT = 30;

function ChatBody({ client, company, onClose }: { client: PortalClient; company: string; onClose: () => void }) {
  const { t, duration } = useI18n();
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const nextId = useRef(1);
  const scroller = useRef<HTMLDivElement>(null);
  const inputId = useId();

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, waiting, failed]);

  async function exchange(history: Bubble[]) {
    setWaiting(true);
    setFailed(null);
    try {
      const reply = await client.chat(
        history.slice(-HISTORY_LIMIT).map(({ role, content }) => ({ role, content })),
      );
      setMessages((current) => [
        ...current,
        { id: nextId.current++, role: "assistant", content: reply.reply, durationMs: reply.durationMs },
      ]);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : t("chat.noResponse"));
    } finally {
      setWaiting(false);
    }
  }

  function send(text: string) {
    const content = text.trim();
    if (!content || waiting) return;
    const history: Bubble[] = [...messages, { id: nextId.current++, role: "user", content }];
    setMessages(history);
    setDraft("");
    void exchange(history);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-white/7 px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <StatusOrb tone="signal" />
            {t("portal.ask")}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            {client.mode === "mock"
              ? t("chat.sample")
              : t("chat.privateLine", { company })}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("chat.close")}
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-white/6 hover:text-ink"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      <div
        ref={scroller}
        role="log"
        aria-live="polite"
        aria-label={t("chat.log")}
        tabIndex={0}
        className="thin-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4"
      >
        {messages.length === 0 && !waiting && (
          <div className="flex h-full flex-col justify-end gap-2">
            <p className="mb-1 text-sm text-ink-2">{t("chat.tryAsking")}</p>
            {STARTERS.map((starter) => (
              <motion.button
                key={starter}
                type="button"
                whileTap={{ scale: 0.98 }}
                transition={SPRING}
                onClick={() => send(t(starter))}
                className="min-h-11 rounded-xl border border-white/10 bg-white/3 px-3.5 py-2 text-left text-sm text-ink-2 transition-colors hover:border-white/20 hover:text-ink"
              >
                {t(starter)}
              </motion.button>
            ))}
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((message) => (
            <motion.div
              key={message.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={SPRING}
              className={message.role === "user" ? "flex justify-end" : "flex justify-start"}
            >
              {message.role === "user" ? (
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-hyper/25 px-3.5 py-2.5 text-sm text-ink">
                  {message.content}
                </p>
              ) : (
                <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-white/8 bg-white/3 px-3.5 py-2.5">
                  <Markdown source={message.content} />
                  {message.durationMs != null && (
                    <p className="mt-2 font-mono text-[11px] tabular-nums text-ink-3">{duration(message.durationMs)}</p>
                  )}
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>

        {waiting && (
          <div role="status" aria-label={t("chat.working")} className="flex w-fit items-center gap-1.5 rounded-2xl rounded-bl-md border border-white/8 bg-white/3 px-3.5 py-3.5">
            {[0, 0.16, 0.32].map((delay) => (
              <span key={delay} className="typing-dot size-1.5 rounded-full bg-ink-2" style={{ animationDelay: `${delay}s` }} />
            ))}
          </div>
        )}

        {failed && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-halt/30 bg-halt/8 px-3.5 py-2.5 text-sm text-halt-soft">
            <p>{failed}</p>
            <button
              type="button"
              onClick={() => void exchange(messages)}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-halt/40 px-2.5 text-xs font-medium hover:border-halt/70"
            >
              <RotateCw aria-hidden className="size-3.5" />
              {t("chat.retry")}
            </button>
          </div>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
        className="border-t border-white/7 p-3"
      >
        <label htmlFor={inputId} className="sr-only">
          {t("chat.placeholder")}
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id={inputId}
            data-autofocus
            rows={2}
            maxLength={4000}
            value={draft}
            placeholder={t("chat.placeholder")}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send(draft);
              }
            }}
            className="field thin-scroll max-h-40 min-h-11 resize-none"
          />
          <motion.button
            type="submit"
            whileTap={{ scale: 0.92 }}
            transition={SPRING}
            disabled={!draft.trim() || waiting}
            aria-label={t("chat.send")}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-signal text-obsidian disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowUp aria-hidden className="size-4" />
          </motion.button>
        </div>
      </form>
    </div>
  );
}

interface AgentSandboxDrawerProps {
  client: PortalClient;
  open: boolean;
  company: string;
  onClose: () => void;
}

export function AgentSandboxDrawer({ client, open, company, onClose }: AgentSandboxDrawerProps) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={onClose} title={t("portal.ask")} placement="right" className="sm:max-w-lg">
      <ChatBody client={client} company={company} onClose={onClose} />
    </Dialog>
  );
}
