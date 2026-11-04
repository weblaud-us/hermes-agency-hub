"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** False while closing would lose work, such as an in-flight provision. */
  dismissable?: boolean;
  placement?: "center" | "right";
  className?: string;
}

const subscribeNever = () => () => undefined;

export function Dialog(props: DialogProps) {
  const isClient = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  if (!isClient) return null;
  return createPortal(
    <AnimatePresence>{props.open && <DialogSurface {...props} />}</AnimatePresence>,
    document.body,
  );
}

function DialogSurface({
  onClose,
  title,
  children,
  dismissable = true,
  placement = "center",
  className,
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const dismissRef = useRef({ dismissable, onClose });

  useEffect(() => {
    dismissRef.current = { dismissable, onClose };
  });

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = panel.current;
    const autofocus = node?.querySelector<HTMLElement>("[data-autofocus]");
    (autofocus ?? node?.querySelector<HTMLElement>(FOCUSABLE) ?? node)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (dismissRef.current.dismissable) dismissRef.current.onClose();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  const right = placement === "right";

  return (
    <motion.div
      className={cn(
        "fixed inset-0 z-60 flex bg-black/70 backdrop-blur-sm",
        right ? "justify-end" : "items-end justify-center sm:items-center sm:p-6",
      )}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
      transition={{ duration: 0.2 }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && dismissable) onClose();
      }}
    >
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        initial={right ? { x: "100%" } : { opacity: 0, y: 28, scale: 0.98 }}
        animate={right ? { x: 0 } : { opacity: 1, y: 0, scale: 1 }}
        exit={
          right
            ? { x: "100%", transition: { duration: 0.2, ease: "easeIn" } }
            : { opacity: 0, y: 16, transition: { duration: 0.16 } }
        }
        transition={SPRING}
        className={cn(
          "relative flex max-h-dvh w-full flex-col overflow-hidden border border-white/10 bg-[#0a0a10]/95 shadow-2xl shadow-black/60 outline-none",
          right
            ? "h-full max-w-2xl border-y-0 border-r-0"
            : "max-h-[94dvh] rounded-t-3xl sm:rounded-3xl",
          className,
        )}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
