"use client";

import { useState, useEffect, useRef } from "react";
import { LayoutGrid, ScanSearch, Play, ArrowUp, Loader2, MessageSquarePlus, Square, RotateCcw, AlertTriangle } from "lucide-react";
import { suggestedQuestions } from "@/lib/mock";
import { ModelSwitch } from "@/components/model-switch";
import { cn } from "@/lib/utils";
import type { EngineResult } from "./types";
import { AnswerView } from "./answer-view";
import { classifyAskError } from "./answer-helpers";
import {
  StatusTiles,
  RoutingDecision,
  OrchestratorTrace,
  DocumentRetrieval,
  MetricsPanels,
} from "./inspector-panels";

type Tab = "workspace" | "inspector" | "demo";

// One turn of the running conversation: the user's question and the engine's full
// result for it. The result carries everything the AnswerView/Inspector render, so a
// turn is rendered exactly like the old single-shot answer — just repeated per turn.
// `traceRecorded` is set only on RESUMED turns: true when the persisted row carried a
// full inspector trace (migration 008+), false for older rows that didn't. Undefined on
// a live turn (which always has its real trace). When false, the Inspector tab shows an
// honest "trace not recorded" notice rather than implying a real zero-passage retrieval.
type ChatTurn = { question: string; result: EngineResult; traceRecorded?: boolean };

// The full AI Business Assistant console — now a MULTI-TURN chat. It owns the running
// `turns` thread + the conversation's `sessionId`, the Workspace / Inspector / Demo
// tabs, and the pipeline transparency (all from the REAL engine response, see
// src/lib/engine/answer.ts). A follow-up is sent with the prior turns as history so the
// engine resolves "it/that/the next quarter"; "New chat" starts a fresh session; an
// optional `initialSessionId` resumes a past conversation and lets the user keep going.
export function AssistantConsole({ initialSessionId }: { initialSessionId?: string }) {
  const [tab, setTab] = useState<Tab>("workspace");
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [error, setError] = useState<string | null>(null);
  // The question that just failed (or was nothing) — lets the error card offer a one-click
  // Retry that re-posts the SAME question through the normal ask flow (same session/history).
  const [failedQuestion, setFailedQuestion] = useState<string | null>(null);
  const [resuming, setResuming] = useState<boolean>(!!initialSessionId);
  const threadEndRef = useRef<HTMLDivElement>(null);
  // Per-request AbortController so a Stop button can cancel the in-flight /api/ask fetch.
  const abortRef = useRef<AbortController | null>(null);

  // Warm the document embedder on mount (avoids cold-start on the first question).
  useEffect(() => {
    fetch("/api/embed", { method: "GET" }).catch(() => {});
  }, []);

  // RESUME: if mounted with a session id (from /dashboard?session=<id>), load that
  // conversation's ordered turns and continue chatting in the SAME session. Each turn
  // is reconstructed into the EngineResult shape the views expect; missing inspector
  // detail (we only persist the essentials) just renders the minimal answer chrome.
  useEffect(() => {
    if (!initialSessionId) return;
    let cancelled = false;
    (async () => {
      setResuming(true);
      try {
        const res = await fetch(`/api/history/${initialSessionId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "failed to load conversation");
        if (cancelled) return;
        const loaded: ChatTurn[] = (data.turns ?? []).map(
          (t: {
            question: string;
            answer: string;
            mode?: "grounded" | "general" | null;
            citations?: { tokens?: string[]; sources?: string[] } | null;
            route?: EngineResult["route"] | null;
            inspector?: EngineResult["inspector"] | null;
            evidence?: EngineResult["evidence"] | null;
          }) => ({
            question: t.question,
            // Replay the turn from its PERSISTED trace (migration 008) so the inspector
            // shows what ACTUALLY happened — route, retrieved passages, steps, method —
            // not a fabricated empty trace. `traceRecorded` is false for rows saved
            // before 008; the inspector then says so rather than implying a real
            // zero-passage retrieval next to a grounded, cited answer.
            traceRecorded: !!t.inspector,
            result: {
              question: t.question,
              answer: t.answer,
              mode: (t.mode as "grounded" | "general" | undefined) ?? undefined,
              grounded: t.mode ? t.mode === "grounded" : undefined,
              route: t.route ?? { sources: [], docFilter: null, rationale: "" },
              evidence: t.evidence ?? { rows: [], chunks: [] },
              validation: { ok: true, reasons: [] },
              inspector: t.inspector ?? undefined,
            } as EngineResult,
          })
        );
        setTurns(loaded);
        setSessionId(initialSessionId);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed to load conversation");
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialSessionId]);

  // Keep the "Live · <provider>" badge honest: the active provider is the one reported
  // by the most recent turn that actually named one (the engine's cost report). Derived
  // purely during render from the thread — no effect, no extra state.
  let provider: string | null = null;
  for (const t of turns) {
    const p = t.result.inspector?.cost?.provider;
    if (p && p !== "—") provider = p;
  }

  // Auto-scroll the thread to the newest turn as it streams in.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, loading]);

  async function ask(q: string) {
    const query = q.trim();
    if (!query || loading) return;
    setLoading(true);
    setError(null);
    setFailedQuestion(null);
    setTab("workspace");
    // Fresh AbortController for this turn so Stop can cancel exactly this fetch.
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // FOLLOW-UP: send the conversation's session_id (so this turn logs into the same
      // thread) AND the prior turns as history (so the engine resolves references like
      // "what about Q2?" against the conversation). On the FIRST turn both are absent /
      // null and the server mints a session_id, returned below.
      const history = turns.map((t) => ({ question: t.question, answer: t.result.answer }));
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: query, session_id: sessionId, history }),
        signal: controller.signal,
      });
      // Check res.ok BEFORE parsing: a gateway/HTML error (502/504, Vercel error page)
      // isn't JSON, so res.json() would throw "Unexpected token <". Read the body
      // defensively and surface a friendly, actionable line instead.
      if (!res.ok) {
        let serverMsg = "";
        try {
          const errBody = await res.json();
          serverMsg = typeof errBody?.error === "string" ? errBody.error : "";
        } catch {
          // non-JSON error body (HTML gateway page) — fall back to status text.
          serverMsg = `${res.status} ${res.statusText}`.trim();
        }
        throw new Error(serverMsg || `request failed (${res.status})`);
      }
      const data = await res.json();
      // Store the session_id the server assigned (or echoed) so every follow-up stays
      // in the same conversation.
      if (typeof data.session_id === "string" && data.session_id) {
        setSessionId(data.session_id);
      }
      setTurns((prev) => [...prev, { question: query, result: data as EngineResult }]);
      setQuestion("");
    } catch (e) {
      // An abort is a deliberate CANCEL, not an error: restore the input, show nothing.
      if (e instanceof DOMException && e.name === "AbortError") {
        setQuestion(query);
      } else {
        // A failed turn renders as a calm error card WITH a Retry button — it does not vanish.
        setError(classifyAskError(e));
        setFailedQuestion(query);
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }

  // STOP: abort the in-flight ask. The catch above treats the abort as a cancel (restores
  // the input), so this is non-destructive — the user just stopped waiting.
  function stop() {
    abortRef.current?.abort();
  }

  // NEW CHAT: clear the thread + the session so the next question starts a fresh
  // conversation (the server will mint a new session_id on that first turn).
  function newChat() {
    abortRef.current?.abort();
    setTurns([]);
    setSessionId(null);
    setQuestion("");
    setError(null);
    setFailedQuestion(null);
    setTab("workspace");
  }

  const tabs: { value: Tab; label: string; icon: typeof LayoutGrid }[] = [
    { value: "workspace", label: "Workspace", icon: LayoutGrid },
    { value: "inspector", label: "Inspector", icon: ScanSearch },
    { value: "demo", label: "Demo", icon: Play },
  ];

  const hasThread = turns.length > 0;

  return (
    <div className="flex h-full flex-col" data-testid="assistant-console">
      {/* header: title + tabs + live badge */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
        <div className="mr-auto flex items-center gap-3">
          <h2 className="font-display text-lg font-bold tracking-tight text-ink">
            AI Business Assistant
          </h2>
          <span className="hidden text-xs text-faint sm:inline">
            Multi-turn chat &amp; cited retrieval
          </span>
        </div>

        {/* New chat — start a fresh conversation */}
        <button
          onClick={newChat}
          disabled={loading}
          data-testid="new-chat"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] font-semibold text-subtle transition-colors hover:border-accent-ring hover:text-ink disabled:opacity-40"
          title="Start a new conversation"
        >
          <MessageSquarePlus className="size-3.5" strokeWidth={2.2} />
          New chat
        </button>

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

      {/* the conversation thread */}
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5" data-testid="ask-result">
        {/* resuming a past conversation */}
        {resuming && (
          <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-sm text-subtle">
            <Loader2 className="size-4 animate-spin text-accent" />
            <span>Loading this conversation…</span>
          </div>
        )}

        {/* empty state (no turns yet, not resuming) */}
        {!hasThread && !loading && !error && !resuming && (
          <EmptyState onPick={(q) => ask(q)} />
        )}

        {/* the running thread — each turn rendered like the old single-shot answer */}
        {turns.map((t, i) => (
          <div key={i} className="space-y-3" data-testid="chat-turn">
            {/* the user's question */}
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-sm text-accent-fg" data-testid="turn-question">
                {t.question}
              </div>
            </div>
            {/* the assistant's answer — Workspace shows the answer view; Inspector adds
                the full pipeline trace for that SAME turn. */}
            <div className="space-y-3">
              <StatusTiles result={t.result} />
              {tab === "workspace" && <AnswerView result={t.result} onRetry={ask} />}
              {tab === "inspector" && (
                <div className="space-y-3" data-testid="inspector-view">
                  {t.traceRecorded === false && (
                    <div
                      data-testid="trace-not-recorded"
                      className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-700"
                    >
                      The full retrieval trace wasn’t recorded for this earlier answer, so
                      the passage counts below may read as zero. The answer and its
                      citations are exactly as given at the time. New answers record their
                      complete trace.
                    </div>
                  )}
                  <RoutingDecision result={t.result} />
                  <OrchestratorTrace result={t.result} />
                  <DocumentRetrieval result={t.result} />
                  <MetricsPanels result={t.result} />
                  <details className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-soft">
                    <summary className="cursor-pointer text-[13px] font-semibold text-subtle">
                      Answer (full text)
                    </summary>
                    <div className="mt-3">
                      <AnswerView result={t.result} onRetry={ask} />
                    </div>
                  </details>
                </div>
              )}
            </div>
          </div>
        ))}

        {/* demo tab — picking a question asks it in the current conversation */}
        {tab === "demo" && (
          <DemoTab onPick={(q) => ask(q)} />
        )}

        {/* loading the pending turn */}
        {loading && (
          <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-sm text-subtle">
            <Loader2 className="size-4 animate-spin text-accent" />
            <span>
              Routing the question and retrieving evidence
              <span className="text-faint"> · route → retrieve → ground → cite → verify</span>
            </span>
          </div>
        )}

        {/* error — a calm card that stays in the thread and offers a one-click Retry. */}
        {error && (
          <div
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn"
            data-testid="ask-error"
          >
            <AlertTriangle className="size-4 shrink-0" />
            <span className="flex-1">{error}</span>
            {failedQuestion && (
              <button
                type="button"
                onClick={() => ask(failedQuestion)}
                disabled={loading}
                data-testid="retry-failed"
                className="inline-flex items-center gap-1.5 rounded-lg border border-warn/40 bg-surface px-2.5 py-1 text-[12px] font-semibold text-warn transition-colors hover:bg-warn-soft disabled:opacity-40"
              >
                <RotateCcw className="size-3.5" />
                Retry
              </button>
            )}
          </div>
        )}

        <div ref={threadEndRef} />
      </div>

      {/* follow-up input — present on every tab so you can keep the conversation going */}
      <form
        className="border-t border-line px-5 py-4"
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
              // Enter sends (ChatGPT-style); Shift+Enter inserts a newline. Guard against
              // IME composition (Hebrew/other input methods) so a composing Enter never sends.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                ask(question);
              }
            }}
            rows={1}
            placeholder={hasThread ? "Ask a follow-up…" : "Ask a question about your documents and data…"}
            aria-label={hasThread ? "Ask a follow-up" : "Ask a question"}
            className="flex-1 resize-none bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
          />
          {loading ? (
            // While a turn is in flight, the action becomes STOP — it aborts the fetch
            // (treated as a cancel: the input is restored, no error card).
            <button
              type="button"
              onClick={stop}
              data-testid="stop-ask"
              title="Stop generating"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-subtle transition-colors hover:border-accent-ring hover:text-ink"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!question.trim()}
              data-testid="send-ask"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg transition-colors hover:bg-accent-strong disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-faint">
          Press Enter to send · Shift+Enter for a new line{hasThread ? " · follow-ups use the whole conversation" : ""}
        </p>
      </form>

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
        citation on every fact. Keep going with follow-ups — it remembers the conversation.
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
        grounded, cited answer over the bundled corpus — then ask a follow-up.
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
