import { Sparkles, ArrowUp, FileSpreadsheet, Quote } from "lucide-react";
import { sampleAnswer, suggestedQuestions } from "@/lib/mock";

export function AskPanel() {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-line bg-surface shadow-soft">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-line px-5 py-4">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Sparkles className="size-4" />
        </span>
        <h2 className="font-display text-base font-semibold text-ink">
          Ask Nucleus
        </h2>
      </div>

      {/* the one worked answer */}
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
        {/* question bubble */}
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-ink px-4 py-2.5 text-sm text-white">
            {sampleAnswer.question}
          </div>
        </div>

        {/* answer */}
        <div className="space-y-3">
          <div className="max-w-[92%] rounded-2xl rounded-bl-sm border border-line bg-canvas px-4 py-3 text-sm leading-relaxed text-ink">
            {sampleAnswer.answer}
          </div>

          {/* the trustworthy number, called out */}
          {sampleAnswer.metric && (
            <div className="flex items-center justify-between rounded-xl border border-accent-ring bg-accent-soft px-4 py-3">
              <div className="flex items-center gap-2">
                <Quote className="size-4 text-accent" />
                <span className="text-xs font-medium uppercase tracking-wide text-accent">
                  {sampleAnswer.metric.label}
                </span>
              </div>
              <span className="tabular text-lg font-semibold text-ink">
                {sampleAnswer.metric.value}
              </span>
            </div>
          )}

          {/* source chips */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-faint">Sources</span>
            {sampleAnswer.citations.map((c) => (
              <span
                key={c.source}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs text-subtle"
              >
                <FileSpreadsheet className="size-3.5 text-accent" />
                <span className="font-medium text-ink">{c.source}</span>
                <span className="text-faint">· {c.detail}</span>
              </span>
            ))}
          </div>
        </div>

        {/* suggested follow-ups */}
        <div className="pt-2">
          <p className="text-xs font-medium text-faint">Try asking</p>
          <div className="mt-2 flex flex-col gap-1.5">
            {suggestedQuestions.map((q) => (
              <button
                key={q}
                className="rounded-lg border border-line bg-canvas px-3 py-2 text-left text-xs text-subtle transition-colors hover:border-accent-ring hover:text-ink"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* input */}
      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2 rounded-xl border border-line bg-canvas px-3 py-2 focus-within:border-accent-ring focus-within:ring-2 focus-within:ring-accent/10">
          <input
            placeholder="Ask about your documents…"
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
          />
          <button className="flex size-7 items-center justify-center rounded-lg bg-accent text-accent-fg transition-colors hover:bg-accent/90">
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
