"use client";

import { useState, useEffect } from "react";
import {
  Sparkles,
  ArrowUp,
  FileSpreadsheet,
  FileText,
  ShieldCheck,
  ShieldAlert,
  Database,
} from "lucide-react";
import { suggestedQuestions } from "@/lib/mock";

// ── The engine's real response shape (Contract-Retriever-RAG /api/ask) ─────────
type EngineResult = {
  question: string;
  route: {
    sources: string[];
    intents: { name: string; params: Record<string, unknown> }[];
    docFilter: string | null;
    rationale: string;
  };
  answer: string;
  evidence: {
    rows: { table: string; id: number; token: string; data: Record<string, unknown> }[];
    chunks: { doc: string; page: number; token: string; text: string }[];
  };
  validation: { ok: boolean; reasons: string[] };
};

const CITE_RE = /(\[(?:S|P):[^\]#]+#\d+\])/g;
const isHebrew = (s: string) => /[֐-׿]/.test(s);

const sourceLabel = (s: string) =>
  s === "structured" ? "Structured · SQL" : "Documents · RAG";

// Render the grounded answer, turning each [S:...]/[P:...] citation token into a
// small inline chip so every fact visibly traces to a source.
function renderAnswer(text: string) {
  return text.split(CITE_RE).map((part, i) => {
    const m = part.match(/^\[(S|P):/);
    if (m) {
      const isSql = m[1] === "S";
      return (
        <span
          key={i}
          className={
            "mx-0.5 inline-flex items-center rounded-md border px-1 py-px align-baseline text-[10px] font-medium " +
            (isSql
              ? "border-accent-ring bg-accent-soft text-accent"
              : "border-line bg-canvas text-subtle")
          }
          title="Traceable citation — resolves to a retrieved row or page"
        >
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function AskPanel() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EngineResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Warm the document embedder on mount so the user's FIRST bundled-doc question
  // doesn't pay the cold-start (~30-60s to load the WASM model). Fire-and-forget.
  useEffect(() => {
    fetch("/api/embed", { method: "GET" }).catch(() => {});
  }, []);

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
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setLoading(false);
    }
  }

  const rows = result?.evidence.rows ?? [];
  const chunks = result?.evidence.chunks ?? [];
  const answerRtl = result ? isHebrew(result.answer) : false;

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
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-faint">
          grounded · cited · verified
        </span>
      </div>

      {/* conversation / result area */}
      <div
        className="flex-1 space-y-4 overflow-y-auto px-5 py-5"
        data-testid="ask-result"
      >
        {/* the question, once asked */}
        {(result || loading || error) && (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-ink px-4 py-2.5 text-sm text-white">
              {result?.question ?? question}
            </div>
          </div>
        )}

        {/* empty state — invite a real question */}
        {!result && !loading && !error && (
          <div className="rounded-2xl border border-dashed border-line bg-canvas px-4 py-5 text-sm text-subtle">
            Ask a question about your contracts, the case file, or maintenance
            spend. Nucleus routes it to the right source and answers with a
            citation on every fact.
          </div>
        )}

        {/* loading — show the real pipeline steps */}
        {loading && (
          <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-line bg-canvas px-4 py-3 text-sm text-subtle">
            <span className="size-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <span>
              Routing the question and retrieving evidence
              <span className="text-faint"> · route → retrieve → ground → cite → verify</span>
            </span>
          </div>
        )}

        {/* error — honest, no fabricated fallback */}
        {error && (
          <div className="rounded-2xl rounded-bl-sm border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* the REAL grounded answer */}
        {result && (
          <div className="space-y-3">
            {/* routing decision */}
            <div
              className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-canvas px-3 py-2"
              data-testid="route-panel"
            >
              <span className="text-[10px] font-medium uppercase tracking-wide text-faint">
                Routed to
              </span>
              {result.route.sources.map((s) => (
                <span
                  key={s}
                  data-testid={`source-${s}`}
                  className="inline-flex items-center gap-1 rounded-md border border-accent-ring bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent"
                >
                  <Database className="size-3" />
                  {sourceLabel(s)}
                </span>
              ))}
            </div>

            {/* answer text with inline citations */}
            <div
              className="max-w-[95%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-line bg-canvas px-4 py-3 text-sm leading-relaxed text-ink"
              data-testid="answer"
              dir={answerRtl ? "rtl" : "ltr"}
              lang={answerRtl ? "he" : "en"}
            >
              {renderAnswer(result.answer)}
            </div>

            {/* validation pill — the grounding guarantee */}
            <div
              data-testid="validation"
              className={
                "flex items-center gap-2 rounded-xl border px-4 py-2.5 text-xs " +
                (result.validation.ok
                  ? "border-accent-ring bg-accent-soft text-accent"
                  : "border-red-200 bg-red-50 text-red-700")
              }
            >
              {result.validation.ok ? (
                <ShieldCheck className="size-4" />
              ) : (
                <ShieldAlert className="size-4" />
              )}
              <span>
                {result.validation.ok
                  ? "Grounded — every cited fact resolves to retrieved evidence (validateAnswer passed)."
                  : "Rejected by validateAnswer(): " +
                    result.validation.reasons.join("; ")}
              </span>
            </div>

            {/* source chips — the real retrieved rows / pages */}
            {(rows.length > 0 || chunks.length > 0) && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-faint">
                  Sources · {rows.length} row{rows.length === 1 ? "" : "s"} ·{" "}
                  {chunks.length} page{chunks.length === 1 ? "" : "s"}
                </span>
                {rows.slice(0, 4).map((r) => (
                  <span
                    key={r.token}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs text-subtle"
                  >
                    <FileSpreadsheet className="size-3.5 text-accent" />
                    <span className="font-medium text-ink">{r.token}</span>
                    <span className="text-faint">· {r.table}</span>
                  </span>
                ))}
                {chunks.slice(0, 4).map((c) => (
                  <span
                    key={c.token}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs text-subtle"
                  >
                    <FileText className="size-3.5 text-accent" />
                    <span className="font-medium text-ink">{c.token}</span>
                    <span className="text-faint">· {c.doc} p.{c.page}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* suggested questions — wired to actually ask the engine */}
        {!loading && (
          <div className="pt-2">
            <p className="text-xs font-medium text-faint">Try asking</p>
            <div className="mt-2 flex flex-col gap-1.5">
              {suggestedQuestions.map((q) => (
                <button
                  key={q}
                  onClick={() => {
                    setQuestion(q);
                    ask(q);
                  }}
                  className="rounded-lg border border-line bg-canvas px-3 py-2 text-left text-xs text-subtle transition-colors hover:border-accent-ring hover:text-ink"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* input — now functional */}
      <form
        className="border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <div className="flex items-center gap-2 rounded-xl border border-line bg-canvas px-3 py-2 focus-within:border-accent-ring focus-within:ring-2 focus-within:ring-accent/10">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about your documents…"
            aria-label="Ask a question"
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading || !question.trim()}
            className="flex size-7 items-center justify-center rounded-lg bg-accent text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
