import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Wordmark } from "@/components/ui/Wordmark";

export function SiteFooter() {
  return (
    <>
      <section className="mx-auto max-w-7xl px-4 pb-24 sm:px-6">
        <div className="surface sheen overflow-hidden rounded-[28px] px-6 py-14 text-center sm:py-20">
          <div
            aria-hidden
            className="absolute inset-x-0 -bottom-24 mx-auto h-48 w-3/4 rounded-full bg-signal/15 blur-[80px]"
          />
          <div className="relative">
            <h2 className="text-gradient mx-auto max-w-2xl text-balance pb-1 text-3xl font-semibold leading-[1.12] tracking-[-0.03em] sm:text-5xl">
              Give your next client an agent that keeps learning.
            </h2>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link
                href="/admin?provision=cluster"
                className="inline-flex min-h-12 items-center gap-2 rounded-full bg-signal px-6 text-sm font-semibold text-obsidian transition-colors hover:bg-[#3ff9e2]"
              >
                Deploy Client Agent
                <ArrowRight aria-hidden className="size-4" />
              </Link>
              <Link
                href="/admin"
                className="inline-flex min-h-12 items-center rounded-full border border-white/12 bg-white/4 px-6 text-sm font-medium text-ink transition-colors hover:border-white/25 hover:bg-white/7"
              >
                Launch Agency Console
              </Link>
            </div>
          </div>
        </div>
      </section>
      <footer className="border-t border-white/6">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-3 px-4 py-8 sm:flex-row sm:items-center sm:px-6">
          <Wordmark />
          <p className="text-sm text-ink-3">Autonomous operations agents, powered by Hermes Agent.</p>
        </div>
      </footer>
    </>
  );
}
