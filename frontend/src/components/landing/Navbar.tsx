"use client";

import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from "motion/react";
import { ArrowRight, Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type PointerEvent } from "react";
import { Wordmark } from "@/components/ui/Wordmark";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { id: "architecture", label: "Architecture" },
  { id: "scheduler", label: "Agent Scheduler" },
  { id: "skills", label: "Vertical Skills" },
  { id: "security", label: "Security" },
  { id: "pricing", label: "Pricing" },
];

/** Page order, so a card nested in a section wins over the section around it. */
const SPY_ORDER = ["scheduler", "architecture", "security", "skills", "pricing"];

function useActiveSection(): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const current = [...SPY_ORDER].reverse().find((id) => visible.has(id));
        setActive(current ?? null);
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    for (const id of SPY_ORDER) {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, []);

  return active;
}

function MagneticLink({ href, children }: { href: string; children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const offsetX = useMotionValue(0);
  const offsetY = useMotionValue(0);
  const x = useSpring(offsetX, { stiffness: 260, damping: 18, mass: 0.5 });
  const y = useSpring(offsetY, { stiffness: 260, damping: 18, mass: 0.5 });

  function track(event: PointerEvent<HTMLDivElement>) {
    if (reduced || event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    offsetX.set((event.clientX - rect.left - rect.width / 2) * 0.22);
    offsetY.set((event.clientY - rect.top - rect.height / 2) * 0.32);
  }

  function reset() {
    offsetX.set(0);
    offsetY.set(0);
  }

  return (
    <motion.div style={{ x, y }} onPointerMove={track} onPointerLeave={reset} className="relative">
      <span
        aria-hidden
        className="absolute -inset-1 rounded-full bg-signal/30 opacity-60 blur-lg transition-opacity duration-300 group-hover/nav:opacity-90"
      />
      <Link
        href={href}
        className="relative inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-full bg-signal px-4 text-[13px] font-semibold text-obsidian transition-colors hover:bg-[#3ff9e2]"
      >
        {children}
      </Link>
    </motion.div>
  );
}

export function Navbar() {
  const active = useActiveSection();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="fixed inset-x-0 top-4 z-50 flex justify-center px-4 sm:top-6">
      <motion.nav
        aria-label="Primary"
        initial={{ opacity: 0, y: -14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING}
        className="group/nav w-full max-w-fit rounded-[28px] border border-white/10 bg-[#0b0b11]/70 shadow-xl shadow-black/30 backdrop-blur-md max-lg:max-w-full"
      >
        <div className="flex items-center justify-between gap-2 py-1.5 pl-4 pr-1.5 lg:gap-5">
          <Link href="/" aria-label="Hermes Agency Hub home" className="flex min-h-10 items-center">
            <Wordmark />
          </Link>

          <ul className="hidden items-center gap-0.5 lg:flex">
            {NAV_LINKS.map((link) => (
              <li key={link.id}>
                <a
                  href={`#${link.id}`}
                  aria-current={active === link.id ? "true" : undefined}
                  className={cn(
                    "relative inline-flex min-h-9 items-center whitespace-nowrap rounded-full px-3 text-[13px] transition-colors",
                    active === link.id ? "text-ink" : "text-ink-2 hover:text-ink",
                  )}
                >
                  {active === link.id && (
                    <motion.span
                      layoutId="activePill"
                      transition={SPRING}
                      className="absolute inset-0 rounded-full border border-white/10 bg-white/8"
                    />
                  )}
                  <span className="relative">{link.label}</span>
                </a>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-1.5">
            <Link
              href="/admin?provision=cluster"
              className="hidden min-h-10 items-center whitespace-nowrap rounded-full border border-white/10 px-3.5 text-[13px] font-medium text-ink transition-colors hover:border-white/25 hover:bg-white/5 xl:inline-flex"
            >
              Deploy Client Agent
            </Link>
            <div className="hidden sm:block">
              <MagneticLink href="/admin">
                Launch Agency Console
                <ArrowRight aria-hidden className="size-3.5" />
              </MagneticLink>
            </div>
            <button
              type="button"
              aria-expanded={menuOpen}
              aria-controls="mobile-menu"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              onClick={() => setMenuOpen((open) => !open)}
              className="inline-flex size-11 items-center justify-center rounded-full text-ink hover:bg-white/6 lg:hidden"
            >
              {menuOpen ? <X aria-hidden className="size-5" /> : <Menu aria-hidden className="size-5" />}
            </button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {menuOpen && (
            <motion.div
              id="mobile-menu"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0, transition: { duration: 0.18 } }}
              transition={SPRING}
              className="overflow-hidden lg:hidden"
            >
              <ul className="flex flex-col gap-0.5 border-t border-white/7 px-2 pb-2 pt-2">
                {NAV_LINKS.map((link) => (
                  <li key={link.id}>
                    <a
                      href={`#${link.id}`}
                      onClick={() => setMenuOpen(false)}
                      className="flex min-h-11 items-center rounded-2xl px-3 text-sm text-ink-2 hover:bg-white/5 hover:text-ink"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
                <li className="mt-1 grid gap-2 sm:grid-cols-2">
                  <Link
                    href="/admin?provision=cluster"
                    className="flex min-h-11 items-center justify-center rounded-2xl border border-white/10 text-sm font-medium text-ink"
                  >
                    Deploy Client Agent
                  </Link>
                  <Link
                    href="/admin"
                    className="flex min-h-11 items-center justify-center gap-1.5 rounded-2xl bg-signal text-sm font-semibold text-obsidian"
                  >
                    Launch Agency Console
                    <ArrowRight aria-hidden className="size-4" />
                  </Link>
                </li>
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.nav>
    </header>
  );
}
