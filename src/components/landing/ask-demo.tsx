"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, ShieldCheck, ArrowUp } from "lucide-react";

// A self-contained, RENDERED (no image) "Ask Nucleus" mock for the hero. It
// types a REAL golden question, then reveals the REAL grounded answer with its
// citation chips popping in, holds, and loops. Every number/citation here is a
// verified golden value — nothing fabricated.
const QUESTION = "Which contracts expire in the next 90 days?";

// Phases: typing → thinking → answering → hold → reset(loop)
type Phase = "typing" | "thinking" | "answer" | "hold";

export function AskDemo() {
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<Phase>("typing");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const push = (fn: () => void, ms: number) => {
      timers.current.push(setTimeout(fn, ms));
    };
    const clearAll = () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };

    function run() {
      clearAll();
      if (reduced) {
        // Reduced motion: show the finished state, no looping.
        setTyped(QUESTION);
        setPhase("answer");
        return;
      }
      setTyped("");
      setPhase("typing");
      // type the question char-by-char
      const start = 500;
      const perChar = 38;
      for (let i = 1; i <= QUESTION.length; i++) {
        push(() => setTyped(QUESTION.slice(0, i)), start + i * perChar);
      }
      const doneTyping = start + QUESTION.length * perChar;
      push(() => setPhase("thinking"), doneTyping + 350);
      push(() => setPhase("answer"), doneTyping + 1550);
      push(() => setPhase("hold"), doneTyping + 4200);
      push(() => run(), doneTyping + 8500); // loop
    }
    run();
    return clearAll;
  }, []);

  const showAnswer = phase === "answer" || phase === "hold";

  return (
    <div className="relative">
      {/* glow */}
      <div className="absolute -inset-4 -z-10 rounded-[2rem] bg-accent-soft/60 blur-2xl" />
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-lift">
        {/* header */}
        <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
          <span className="flex size-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Sparkles className="size-4" />
          </span>
          <span className="font-display text-sm font-semibold text-ink">
            Ask Nucleus
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-accent-ring bg-accent-soft px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
            <span className="pulse-dot size-1.5 rounded-full bg-accent" />
            Grounded · cited · verified
          </span>
        </div>

        <div className="space-y-3.5 px-5 py-5">
          {/* question bubble (typing) */}
          <div className="flex justify-end">
            <div className="max-w-[88%] rounded-2xl rounded-br-sm bg-ink px-3.5 py-2 text-sm text-white">
              {typed}
              {phase === "typing" && <span className="caret" />}
            </div>
          </div>

          {/* thinking */}
          {phase === "thinking" && (
            <div className="flex items-center gap-2 text-xs text-faint">
              <span className="size-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              route → retrieve → ground → cite → verify
            </div>
          )}

          {/* answer */}
          {showAnswer && (
            <div className="space-y-3">
              <div
                className="line-rise max-w-[94%] rounded-2xl rounded-bl-sm border border-line bg-canvas px-3.5 py-3 text-sm leading-relaxed text-ink"
                style={{ animationDelay: "0ms" }}
              >
                There are{" "}
                <b>38 contracts</b> expiring in the next 90 days, with a combined
                annual value of{" "}
                <span className="tabular font-semibold">$18,924,883.79</span>
                <span
                  className="chip-pop ml-1 inline-flex items-center rounded-md border border-accent-ring bg-accent-soft px-1 py-px align-middle text-[10px] font-medium text-accent"
                  style={{ animationDelay: "260ms" }}
                >
                  [S:contracts#]
                </span>
                .
              </div>

              {/* a representative cited row */}
              <div
                className="line-rise flex items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-2.5"
                style={{ animationDelay: "420ms" }}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-[10px] font-bold text-accent">
                  S
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-ink">
                    Zoombeat — Automation Specialist IV
                  </p>
                  <p className="truncate text-[11px] text-faint">
                    Ends 2026-06-21 · annual cost{" "}
                    <span className="tabular">$428,720.60</span>
                  </p>
                </div>
                <span
                  className="chip-pop tabular shrink-0 rounded-md border border-line bg-canvas px-1.5 py-0.5 text-[10px] text-subtle"
                  style={{ animationDelay: "640ms" }}
                >
                  [S:contracts#25]
                </span>
              </div>

              {/* validation pill */}
              <div
                className="line-rise flex items-center gap-2 rounded-xl border border-accent-ring bg-accent-soft px-3.5 py-2 text-xs text-accent"
                style={{ animationDelay: "780ms" }}
              >
                <ShieldCheck className="size-3.5" />
                Every figure verified against the source rows.
              </div>
            </div>
          )}
        </div>

        {/* input affordance (decorative) */}
        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-canvas px-3 py-2">
            <span className="flex-1 truncate text-sm text-faint">
              Ask about your documents…
            </span>
            <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-accent-fg">
              <ArrowUp className="size-4" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
