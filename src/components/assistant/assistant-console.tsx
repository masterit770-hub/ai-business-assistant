"use client";

import { useState, useEffect, useRef } from "react";
import { LayoutGrid, ScanSearch, Play, ArrowUp, Loader2, MessageSquarePlus } from "lucide-react";
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

// One turn of the running conversation: the user's question and the engine's full
// result for it. The result carries everything the AnswerView/Inspector render, so a
// turn is rendered exactly like the old single-shot answer — just repeated per turn.
type ChatTurn = { question: string; result: EngineResult };

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
  const [resuming, setResuming] = useState<boolean>(!!initialSessionId);
  const threadEndRef = useRef<HTMLDivElement>(null);

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
          }) => ({
            question: t.question,
            result: {
              question: t.question,
              answer: t.answer,
              mode: (t.mode as "grounded" | "general" | undefined) ?? undefined,
              grounded: t.mode ? t.mode === "grounded" : undefined,
              route: { sources: [], docFilter: null, rationale: "" },
              evidence: { rows: [], chunks: [] },
              validation: { ok: true, reasons: [] },
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
    setTab("workspace");
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
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "request failed");
      // Store the session_id the server assigned (or echoed) so every follow-up stays
      // in the same conversation.
      if (typeof data.session_id === "string" && data.session_id) {
        setSessionId(data.session_id);
      }
      setTurns((prev) => [...prev, { question: query, result: data as EngineResult }]);
      setQuestion("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setLoading(false);
    }
  }

  // NEW CHAT: clear the thread + the session so the next question starts a fresh
  // conversation (the server will mint a new session_id on that first turn).
  function newChat() {
    setTurns([]);
    setSessionId(null);
    setQuestion("");
    setError(null);
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
              {tab === "workspace" && <AnswerView result={t.result} />}
              {tab === "inspector" && (
                <div className="space-y-3" data-testid="inspector-view">
                  <RoutingDecision result={t.result} />
                  <OrchestratorTrace result={t.result} />
                  <DocumentRetrieval result={t.result} />
                  <MetricsPanels result={t.result} />
                  <details className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-soft">
                    <summary className="cursor-pointer text-[13px] font-semibold text-subtle">
                      Answer (full text)
                    </summary>
                    <div className="mt-3">
                      <AnswerView result={t.result} />
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

        {/* error */}
        {error && (
          <div className="rounded-2xl border border-high/30 bg-high-soft px-4 py-3 text-sm text-high" data-testid="ask-error">
            {error}
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
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                ask(question);
              }
            }}
            rows={1}
            placeholder={hasThread ? "Ask a follow-up…" : "Ask a question about your documents and data…"}
            aria-label={hasThread ? "Ask a follow-up" : "Ask a question"}
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
        <p className="mt-1.5 px-1 text-[11px] text-faint">
          Press ⌘/Ctrl + Enter to send{hasThread ? " · follow-ups use the whole conversation" : ""}
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
