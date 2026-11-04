/** Fixed page atmosphere: aurora, perspective dot matrix and film grain. */
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-obsidian">
      <div className="animate-aurora-a absolute -left-[12%] -top-[18%] h-[58vh] w-[58vw] rounded-full bg-hyper/25 blur-[140px]" />
      <div className="animate-aurora-b absolute -right-[10%] top-[6%] h-[50vh] w-[46vw] rounded-full bg-signal/14 blur-[140px]" />
      <div className="dot-matrix absolute inset-0 [mask-image:radial-gradient(ellipse_80%_65%_at_50%_0%,#000_30%,transparent_100%)]" />
      <div className="noise absolute inset-0 opacity-[0.025]" />
    </div>
  );
}
