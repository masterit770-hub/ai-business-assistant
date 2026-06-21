"use client";

import { useEffect, useRef, useState } from "react";
import { Route, Search, Anchor, Quote, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

// The "how it works" strip: route → retrieve → ground → cite → verify, revealed
// in sequence once scrolled into view, then a connecting line fills across.
const STEPS = [
  { icon: Route, label: "Route", note: "pick the source(s)" },
  { icon: Search, label: "Retrieve", note: "SQL + vector search" },
  { icon: Anchor, label: "Ground", note: "answer only from evidence" },
  { icon: Quote, label: "Cite", note: "a token per claim" },
  { icon: ShieldCheck, label: "Verify", note: "reject if uncited" },
];

export function PipelineStrip() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          obs.disconnect();
          STEPS.forEach((_, i) =>
            setTimeout(() => setActive(i), 250 + i * 320)
          );
        }
      },
      { threshold: 0.4 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={ref} className="relative">
      {/* connecting line */}
      <div className="absolute left-0 right-0 top-7 hidden h-px bg-line md:block" />
      <div
        className="absolute left-0 top-7 hidden h-px bg-accent transition-[width] duration-[1600ms] ease-out md:block"
        style={{ width: active >= 0 ? `${(Math.min(active, STEPS.length - 1) / (STEPS.length - 1)) * 100}%` : "0%" }}
      />
      <ol className="relative grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-5">
        {STEPS.map((s, i) => {
          const on = i <= active;
          return (
            <li key={s.label} className="flex flex-col items-center text-center">
              <span
                className={cn(
                  "flex size-14 items-center justify-center rounded-2xl border transition-colors duration-500",
                  on
                    ? "step-in border-accent-ring bg-accent-soft text-accent"
                    : "border-line bg-surface text-faint"
                )}
              >
                <s.icon className="size-6" strokeWidth={2} />
              </span>
              <span
                className={cn(
                  "mt-3 font-display text-sm font-semibold transition-colors duration-500",
                  on ? "text-ink" : "text-faint"
                )}
              >
                {s.label}
              </span>
              <span className="mt-0.5 text-xs text-faint">{s.note}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
