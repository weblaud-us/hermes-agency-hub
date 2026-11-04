"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface SecretInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "autoComplete" | "spellCheck"> {
  /** Names the toggle for screen readers, as in "Show API key". */
  secretName: string;
  /** Applied to the wrapper, so margins do not throw off the toggle's centering. */
  className?: string;
}

export function SecretInput({ secretName, className, ...inputProps }: SecretInputProps) {
  const [shown, setShown] = useState(false);
  return (
    <div className={cn("relative", className)}>
      <input
        {...inputProps}
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        className="field pr-12 font-mono"
      />
      <button
        type="button"
        onClick={() => setShown((current) => !current)}
        aria-label={`${shown ? "Hide" : "Show"} ${secretName}`}
        className="absolute right-1 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-ink-3 hover:text-ink"
      >
        {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
      </button>
    </div>
  );
}
