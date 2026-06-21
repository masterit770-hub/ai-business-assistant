"use client";

import { useState, useEffect } from "react";
import { LayoutGrid, ScanSearch, Play, ArrowUp, Loader2 } from "lucide-react";
import { suggestedQuestions } from "@/lib/mock";
import { ModelSwitch } from "@/components/model-switch";
import { cn } from "@/lib/utils";
import type { EngineResult } from "./types";
import { AnswerView } from "./answer-view";
import {
  StatusTiles,
  RoutingDecision,
  OrchestratorTrace,
  DocumentRetrieval,
  MetricsPanels,
} from "./inspector-panels";

type Tab = "workspace" | "inspector" | "demo";

// The full AI Business Assistant console — the rebuilt answer experience. It owns
// the Workspace / Inspector / Demo tabs and renders the pipeline transparency
// (routing decision, orchestrator trace, retrieval table, cost & tokens, citation
// check) entirely from the REAL engine response (see src/lib/engine/answer.ts).
export function AssistantConsole() {
  const [tab, setTab] = useState<Tab>("workspace");
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EngineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);

  // Warm the document embedder on mount (avoids cold-start on the first question).
  useEffect(() => {
    fetch("/api/embed", { method: "GET" }).catch(() => {});
  }, []);

  // Keep the "Live · <provider>" badge honest: show the active provider/model once
  // we've answered at least once (it comes straight from the engine's cost report).
  useEffect(() => {
    if (result?.inspector?.cost?.provider && result.inspector.cost.provider !== "—") {
      setProvider(result.inspector.cost.provider);
    }
  }, [result]);

  async function ask(q: string) {
    const query = q.trim();
    if (!query || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: query }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "request failed");
      setResult(data as EngineResult);
      // After an answer, the Inspector tab has the most to show — but stay on the
      // user's current tab; both tabs render the same result.
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setLoading(false);
    }
  }

  const tabs: { value: Tab; label: string; icon: typeof LayoutGrid }[] = [
    { value: "workspace", label: "Workspace", icon: LayoutGrid },
    { value: "inspector", label: "Inspector", icon: ScanSearch },
    { value: "demo", label: "Demo", icon: Play },
  ];

  return (
    <div className="flex h-full flex-col" data-testid="assistant-console">
      {/* header: title + tabs + live badge */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
        <div className="mr-auto flex items-center gap-3">
          <h2 className="font-display text-lg font-bold tracking-tight text-ink">
            AI Business Assistant
          </h2>
          <span className="hidden text-xs text-faint sm:inline">
            Multi-source retrieval &amp; orchestration
          </span>
        </div>

        {/* the tab switcher */}
        <div className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface-2 p-1" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.value}
              role="tab"
              aria-selected={tab === t.value}
              data-testid={`tab-${t.value}`}
              onClick={() => setTab(t.value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors",
                tab === t.value
                  ? "bg-accent text-accent-fg shadow-soft"
                  : "text-subtle hover:text-ink"
              )}
            >
              <t.icon className="size-3.5" strokeWidth={2.2} />
              {t.label}
            </button>
          ))}
        </div>

        {/* live status badge — honest about the active provider */}
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-subtle">
          <span className="size-1.5 rounded-full bg-ok pulse-dot" />
          Live{provider ? ` · ${provider}` : ""}
        </span>
      </div>

      {/* admin-only model switch */}
      <div className="border-b border-line px-5 py-2.5" data-testid="ask-model-switch">
        <ModelSwitch variant="panel" />
      </div>

      {/* the question box — present on every tab so you can ask from anywhere */}
      <form
        className="border-b border-line px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <div className="flex items-start gap-2 rounded-xl border border-line bg-surface px-3.5 py-2.5 focus-within:border-accent-ring focus-within:ring-2 focus-within:ring-accent/15">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                ask(question);
              }
            }}
            rows={1}
            placeholder="Ask a question about your documents and data…"
            aria-label="Ask a question"
            className="flex-1 resize-none bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading || !question.trim()}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg transition-colors hover:bg-accent-strong disabled:opacity-40"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-faint">Press ⌘/Ctrl + Enter to ask</p>
      </form>

      {/* the result area */}
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5" data-testid="ask-result">
        {/* empty state */}
        {!result && !loading && !error && (
          <EmptyState onPick={(q) => { setQuestion(q); ask(q); }} />
        )}

        {/* loading */}
        {loading && (
          <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-sm text-subtle">
            <Loader2 className="size-4 animate-spin text-accent" />
            <span>
              Routing the question and retrieving evidence
              <span className="text-faint"> · route → retrieve → ground → cite → verify</span>
            </span>
          </div>
        )}

        {/* error */}
        {error && (
          <div className="rounded-2xl border border-high/30 bg-high-soft px-4 py-3 text-sm text-high" data-testid="ask-error">
            {error}
          </div>
        )}

        {/* the answered result */}
        {result && (
          <>
            {/* the status tiles are shared across Workspace + Inspector */}
            <StatusTiles result={result} />

            {tab === "workspace" && <AnswerView result={result} />}

            {tab === "inspector" && (
              <div className="space-y-3" data-testid="inspector-view">
                <RoutingDecision result={result} />
                <OrchestratorTrace result={result} />
                <DocumentRetrieval result={result} />
                <MetricsPanels result={result} />
                <details className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-soft">
                  <summary className="cursor-pointer text-[13px] font-semibold text-subtle">
                    Answer (full text)
                  </summary>
                  <div className="mt-3">
                    <AnswerView result={result} />
                  </div>
                </details>
              </div>
            )}

            {tab === "demo" && <DemoTab onPick={(q) => { setQuestion(q); setTab("workspace"); ask(q); }} />}
          </>
        )}
      </div>

      {/* honest pipeline footer strip */}
      <div className="border-t border-line px-5 py-2.5 text-center text-[11px] text-faint">
        PDF + SQLite · query routing · hybrid retrieval (SQL + local dense embeddings + Gemini
        File Search) · grounded generation · citation verification
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-dashed border-line bg-surface-2 px-4 py-5 text-sm text-subtle">
        Ask a question about your contracts, the case file, or maintenance spend. The assistant
        routes it to the right source, shows its reasoning in the Inspector tab, and puts a
        citation on every fact.
      </div>
      <div>
        <p className="text-xs font-medium text-faint">Try asking</p>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {suggestedQuestions.map((q) => (
            <button
              key={q}
              onClick={() => onPick(q)}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-left text-xs text-subtle transition-colors hover:border-accent-ring hover:text-ink"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function DemoTab({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-subtle">
        Run a golden question end-to-end and watch the pipeline light up. Each of these returns a
        grounded, cited answer over the bundled corpus.
      </p>
      <div className="grid gap-2">
        {suggestedQuestions.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="group flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3 text-left text-sm text-ink transition-colors hover:border-accent-ring"
          >
            <span>{q}</span>
            <Play className="size-4 text-faint transition-colors group-hover:text-accent" />
          </button>
        ))}
      </div>
    </div>
  );
}
