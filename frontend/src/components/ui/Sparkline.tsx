"use client";

import { useId, useState, type PointerEvent } from "react";

interface SparklineProps {
  data: number[];
  label: string;
  format: (value: number) => string;
  color?: string;
  width?: number;
  height?: number;
}

/** Single-series trend with a crosshair and value readout on hover. */
export function Sparkline({
  data,
  label,
  format,
  color = "var(--color-signal)",
  width = 120,
  height = 36,
}: SparklineProps) {
  const gradientId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [hover, setHover] = useState<number | null>(null);

  if (data.length < 2) {
    return (
      <div className="flex items-end font-mono text-[11px] text-ink-3" style={{ height }}>
        Collecting samples
      </div>
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = 3;
  const xAt = (index: number) => (index / (data.length - 1)) * width;
  const yAt = (value: number) =>
    max === min ? height / 2 : height - pad - ((value - min) / span) * (height - pad * 2);

  const line = data.map((value, index) => `${index ? "L" : "M"}${xAt(index).toFixed(1)} ${yAt(value).toFixed(1)}`).join(" ");
  const area = `${line} L${width} ${height} L0 ${height} Z`;

  function track(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(data.length - 1, Math.round(ratio * (data.length - 1)))));
  }

  const hoverX = hover === null ? 0 : (xAt(hover) / width) * 100;

  return (
    <div className="relative w-full" style={{ height }}>
      <svg
        role="img"
        aria-label={`${label} trend, latest ${format(data[data.length - 1])}`}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block size-full overflow-visible"
        onPointerMove={track}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.22" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {hover !== null && (
          <line
            x1={xAt(hover)}
            x2={xAt(hover)}
            y1="0"
            y2={height}
            stroke="rgb(255 255 255 / 0.35)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute -top-8 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-[#14141c] px-2 py-1 font-mono text-[11px] tabular-nums text-ink shadow-lg"
          style={{ left: `${Math.max(14, Math.min(86, hoverX))}%` }}
        >
          {format(data[hover])}
        </div>
      )}
    </div>
  );
}
