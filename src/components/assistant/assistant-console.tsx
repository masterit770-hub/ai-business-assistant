"use client";

import { useState, useEffect, useRef } from "react";
import { LayoutGrid, ScanSearch, Paperclip, ArrowUp, Loader2, MessageSquarePlus, Square, RotateCcw, AlertTriangle } from "lucide-react";
import { MaterialsRail } from "@/components/assistant/materials-rail";
import { suggestedQuestions } from "@/lib/mock";
import { SAMPLE_DATA_SESSION_ID, IMPORTED_SESSION_ID } from "@/lib/engine/virtual-sessions";
import { cn } from "@/lib/utils";
import type { EngineResult } from "./types";
import { AnswerSetup } from "./answer-setup";
import { ChatUpload } from "./chat-upload";
import { AnswerView } from "./answer-view";
import { classifyAskError } from "./answer-helpers";
import {
  StatusTiles,
  RoutingDecision,
  OrchestratorTrace,
  DocumentRetrieval,
  MetricsPanels,
} from "./inspector-panels";

type Tab = "workspace" | "inspector" | "files";

// ── Persisted-turn normalisers ───────────────────────────────────────────────
// Older rows in ask_history may carry malformed / legacy shapes for route,
// evidence, and validation. These helpers coerce any stored value into the
// shape the renderers (StatusTiles, AnswerView, InspectorPanels) require, so a
// single bad row can NEVER throw a TypeError that crashes the whole page.

const SAFE_ROUTE: EngineResult["route"] = { sources: [], docFilter: null, rationale: "" };
const SAFE_EVIDENCE: EngineResult["evidence"] = { rows: [], chunks: [] };
const SAFE_VALIDATION: EngineResult["validation"] = { ok: true, reasons: [] };

function normaliseRoute(raw: unknown): EngineResult["route"] {
  if (raw == null) return SAFE_ROUTE;
  // Must be a plain object with an array .sources property.
  if (typeof raw !== "object" || Array.isArray(raw)) return SAFE_ROUTE;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.sources)) return SAFE_ROUTE;
  return {
    sources: r.sources as string[],
    docFilter: typeof r.docFilter === "string" ? r.docFilter : null,
    rationale: typeof r.rationale === "string" ? r.rationale : "",
  };
}

function normaliseEvidence(raw: unknown): EngineResult["evidence"] {
  if (raw == null) return SAFE_EVIDENCE;
  if (typeof raw !== "object" || Array.isArray(raw)) return SAFE_EVIDENCE;
  const r = raw as Record<string, unknown>;
  return {
    rows: Array.isArray(r.rows) ? (r.rows as EngineResult["evidence"]["rows"]) : [],
    chunks: Array.isArray(r.chunks) ? (r.chunks as EngineResult["evidence"]["chunks"]) : [],
  };
}

function normaliseValidation(raw: unknown): EngineResult["validation"] {
  if (raw == null) return SAFE_VALIDATION;
  if (typeof raw !== "object" || Array.isArray(raw)) return SAFE_VALIDATION;
  const r = raw as Record<string, unknown>;
  return {
    ok: typeof r.ok === "boolean" ? r.ok : true,
    reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [],
  };
}

// One turn of the running conversation: the user's question and the engine's full
// result for it. The result carries everything the AnswerView/Inspector render, so a
// turn is rendered exactly like the old single-shot answer — just repeated per turn.
// `traceRecorded` is set only on RESUMED turns: true when the persisted row carried a
// full inspector trace (migration 008+), false for older rows that didn't. Undefined on
// a live turn (which always has its real trace). When false, the Inspector tab shows an
// honest "trace not recorded" notice rather than implying a real zero-passage retrieval.
type ChatTurn = { question: string; result: EngineResult; traceRecorded?: boolean };

// The full NUCLEUS 770 console — now a MULTI-TURN chat. It owns the running
// `turns` thread + the conversation's `sessionId`, the Workspace / Inspector / Demo
// tabs, and the pipeline transparency (all from the REAL engine response, see
// src/lib/engine/answer.ts). A follow-up is sent with the prior turns as history so the
// engine resolves "it/that/the next quarter"; "New chat" starts a fresh session; an
// optional `initialSessionId` resumes a past conversation and lets the user keep going.
export function AssistantConsole({
  initialSessionId,
  activeSpaceId,
  globalMode = false,
}: {
  initialSessionId?: string;
  // Knowledge Space: when set, file retrieval is scoped to this space (cross-chat).
  activeSpaceId?: string | null;
  // Global search: when true, retrieval spans ALL of the owner's spaces.
  globalMode?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("workspace");
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [error, setError] = useState<string | null>(null);
  // OPTIMISTIC BUBBLE: the question the user just submitted, staged INSTANTLY (before the
  // ~1-minute agent answer returns) so their message shows in the thread the moment they
  // hit send — not only after the server responds. Set at the top of ask(); cleared when
  // the real turn lands (success), on a failed turn, or on a Stop/cancel. The working
  // indicator renders right beneath it so a long wait reads as "assistant is thinking".
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  // The question that just failed (or was nothing) — lets the error card offer a one-click
  // Retry that re-posts the SAME question through the normal ask flow (same session/history).
  const [failedQuestion, setFailedQuestion] = useState<string | null>(null);
  const [resuming, setResuming] = useState<boolean>(!!initialSessionId);
  // True when a resume was requested (?session=ID) but came back with zero turns — a
  // deleted/unknown/foreign session id. We show an honest notice instead of silently
  // rendering the generic new-chat empty state (which looks like a brand-new chat).
  const [resumeEmpty, setResumeEmpty] = useState(false);
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
  //
  // VIRTUAL SESSIONS (SAMPLE_DATA_SESSION_ID, IMPORTED_SESSION_ID): these are reserved
  // pseudo-sessions that have no ask_history rows. Skip the fetch entirely and just set
  // the sessionId — the user will see the virtual-session welcome state and can ask
  // questions that will be logged into this virtual session.
  useEffect(() => {
    if (!initialSessionId) return;
    if (
      initialSessionId === SAMPLE_DATA_SESSION_ID ||
      initialSessionId === IMPORTED_SESSION_ID
    ) {
      setSessionId(initialSessionId);
      setResuming(false);
      return;
    }
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
            route?: unknown;
            inspector?: EngineResult["inspector"] | null;
            evidence?: unknown;
            validation?: unknown;
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
              // Normalise the persisted route. Old rows may have stored a bare array
              // (e.g. ["structured"]) instead of the {sources, docFilter, rationale}
              // object the renderers expect. Any shape that isn't a plain object with
              // a .sources array collapses to the safe sentinel — a crash-safe fallback
              // that lets the inspector render an honest "NONE / no trace" state.
              route: normaliseRoute(t.route),
              // Normalise evidence — old rows may be null. Never let null propagate to
              // renderers that dereference .rows / .chunks without guards.
              evidence: normaliseEvidence(t.evidence),
              // Replay the REAL grounding verdict (migration 010). A turn that was
              // REJECTED by validateAnswer must replay as rejected, not as a fabricated
              // green "passed". Only a pre-010 row (no recorded verdict) falls back to
              // ok — and those already carry the "trace not recorded" notice.
              validation: normaliseValidation(t.validation),
              inspector: t.inspector ?? undefined,
            } as EngineResult,
          })
        );
        setTurns(loaded);
        setSessionId(initialSessionId);
        // A resume that returns no turns is EITHER a real-but-empty chat (it has a title
        // and/or uploaded docs — e.g. a restored account whose chats carry no asks yet)
        // OR a genuinely gone/unknown/foreign session. The endpoint tells us which via
        // `exists`: only a non-existent session shows the honest "couldn't be found"
        // notice; a real empty chat opens to its welcome state (scoped to THIS session,
        // so its uploaded docs are in scope and the user can start asking).
        setResumeEmpty(loaded.length === 0 && data?.exists !== true);
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
    // OPTIMISTIC: stage the user's bubble + clear the input the instant they submit, so
    // the question is on screen before the (slow) agent answer returns. The working
    // indicator renders beneath this pending bubble while the fetch is in flight.
    setPendingQuestion(query);
    setQuestion("");
    // Fresh AbortController for this turn so Stop can cancel exactly this fetch.
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // FOLLOW-UP: send the conversation's session_id (so this turn logs into the same
      // thread) AND the prior turns as history (so the engine resolves references like
      // "what about Q2?" against the conversation). On the FIRST turn both are absent /
      // null and the server mints a session_id, returned below.
      const history = turns.map((t) => ({ question: t.question, answer: t.result.answer }));
      // Build the request body with space context (migration 016).
      const askBody: Record<string, unknown> = { question: query, session_id: sessionId, history };
      if (globalMode) {
        askBody.global_mode = true;
      } else if (activeSpaceId) {
        askBody.space_id = activeSpaceId;
      }
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(askBody),
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
      // The real turn is now in the thread → retire the optimistic placeholder so the
      // question bubble isn't shown twice.
      setPendingQuestion(null);
      // Tell the conversations column a turn was saved so it re-fetches /api/history —
      // a brand-new conversation then appears in the list (and an existing one's
      // turn-count/title updates) without a manual refresh.
      window.dispatchEvent(new CustomEvent("nucleus:session"));
    } catch (e) {
      // Either path retires the optimistic bubble — it must never linger as a ghost
      // question with no answer beneath it.
      setPendingQuestion(null);
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
    setPendingQuestion(null);
    setResumeEmpty(false);
    setTab("workspace");
  }

  const tabs: { value: Tab; label: string; icon: typeof LayoutGrid }[] = [
    { value: "workspace", label: "Workspace", icon: LayoutGrid },
    { value: "inspector", label: "Inspector", icon: ScanSearch },
    { value: "files", label: "Files", icon: Paperclip },
  ];

  const hasThread = turns.length > 0;

  return (
    <div className="flex h-full flex-col" data-testid="assistant-console">
      {/* header: title + tabs + live badge */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
        <div className="mr-auto flex items-center gap-3">
          <h2 className="font-display text-lg font-bold tracking-tight text-ink">
            NUCLEUS 770
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

        {/* the tab switcher — always rendered so the Files tab is reachable from a
            new/empty chat (uploading a file IS how you start a chat). Workspace +
            Inspector are per-answer views; they're visually disabled until there's a
            thread. The Files tab is always enabled. */}
        <div className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface-2 p-1" role="tablist">
          {tabs.map((t) => {
            // Files tab is always enabled; Workspace + Inspector require a thread.
            const disabled = !hasThread && t.value !== "files";
            return (
              <button
                key={t.value}
                role="tab"
                aria-selected={tab === t.value}
                data-testid={`tab-${t.value}`}
                onClick={() => {
                  if (disabled) return;
                  // Switching to Files on a new/empty chat: pre-mint a session id so
                  // any file uploaded from the Files tab is linked to THIS chat, not
                  // assigned to the legacy/unscoped pool. The minted id is used by both
                  // the ChatUpload in the ask box and the FilesTab materials rail.
                  if (t.value === "files" && !sessionId) {
                    setSessionId(crypto.randomUUID());
                  }
                  setTab(t.value);
                }}
                disabled={disabled}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors",
                  tab === t.value
                    ? "bg-accent text-accent-fg shadow-soft"
                    : "text-subtle hover:text-ink",
                  disabled && "pointer-events-none opacity-40"
                )}
              >
                <t.icon className="size-3.5" strokeWidth={2.2} />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* live status badge — honest about the active provider */}
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-subtle">
          <span className="size-1.5 rounded-full bg-ok pulse-dot" />
          Live{provider ? ` · ${provider}` : ""}
        </span>
      </div>

      {/* answer setup — style presets + inline prompt editor + model switch */}
      <AnswerSetup />

      {/* ASK BOX — up top: the latest answer renders right below it (per the reference) */}
      <form
        className="border-b border-line px-5 py-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <div className="flex items-start gap-2 rounded-xl border border-line bg-surface px-3.5 py-2.5 focus-within:border-accent-ring focus-within:ring-2 focus-within:ring-accent/15">
          {/* attach a file without leaving the chat (PDF / Word / Excel / CSV).
              Per-chat scoping: pass the active sessionId so uploads are linked to this chat.
              Space tagging: pass the active space so the file is space-scoped (migration 016). */}
          <ChatUpload sessionId={sessionId ?? undefined} onSessionId={setSessionId} spaceId={activeSpaceId} />
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
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

      {/* the conversation thread */}
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5" data-testid="ask-result">
        {/* resuming a past conversation */}
        {resuming && (
          <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-sm text-subtle">
            <Loader2 className="size-4 animate-spin text-accent" />
            <span>Loading this conversation…</span>
          </div>
        )}

        {/* a resume that found nothing — say so honestly (don't look like a fresh chat) */}
        {resumeEmpty && !hasThread && !loading && !resuming && (
          <div
            data-testid="resume-empty"
            className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700"
          >
            This conversation couldn’t be found — it may have been deleted, or the link
            isn’t yours. Start a new chat below, or pick another from History.
          </div>
        )}

        {/* virtual session welcome — no turns yet, not a real resume, just set the corpus */}
        {!hasThread && !loading && !error && !resuming && !resumeEmpty &&
          (initialSessionId === SAMPLE_DATA_SESSION_ID || initialSessionId === IMPORTED_SESSION_ID) && (
          <VirtualSessionWelcome
            label={initialSessionId === SAMPLE_DATA_SESSION_ID ? "Sample data" : "Imported"}
            onPick={(q) => ask(q)}
          />
        )}

        {/* empty state (no turns yet, not resuming, not a failed resume, not a virtual session) */}
        {!hasThread && !loading && !error && !resuming && !resumeEmpty &&
          initialSessionId !== SAMPLE_DATA_SESSION_ID && initialSessionId !== IMPORTED_SESSION_ID && (
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

        {/* files tab — this chat's uploaded files, with an upload panel */}
        {tab === "files" && (
          <FilesTab sessionId={sessionId ?? undefined} spaceId={activeSpaceId} globalMode={globalMode} />
        )}

        {/* the pending turn: the OPTIMISTIC user bubble + the WORKING indicator beneath it.
            The bubble appears the instant the user hits send (driven by the submit event,
            not the server response), and the indicator reads as "the assistant is thinking"
            right under the question — so a 30-60s agent run never looks frozen. */}
        {loading && pendingQuestion && (
          <div className="space-y-3" data-testid="pending-turn">
            {/* the user's question — same markup as a settled turn-question bubble */}
            <div className="flex justify-end">
              <div
                className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-sm text-accent-fg"
                data-testid="pending-question"
              >
                {pendingQuestion}
              </div>
            </div>
            {/* working / thinking indicator */}
            <div
              className="flex items-center gap-2 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-sm text-subtle"
              data-testid="working-indicator"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="size-4 animate-spin text-accent" />
              <span>
                Working on your answer
                <span className="text-faint"> · route → retrieve → ground → cite → verify</span>
              </span>
            </div>
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

      {/* honest pipeline footer strip */}
      <div className="border-t border-line px-5 py-2.5 text-center text-[11px] text-faint">
        PDF · Word · Excel · CSV · scanned docs · the AI reads your files directly,
        runs the computation, and cites what it actually used
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

function FilesTab({
  sessionId,
  spaceId,
  globalMode,
}: {
  sessionId?: string;
  spaceId?: string | null;
  globalMode?: boolean;
}) {
  return (
    <div data-testid="files-tab">
      <MaterialsRail mode="chat" sessionId={sessionId} spaceId={spaceId} globalMode={globalMode} />
    </div>
  );
}

function VirtualSessionWelcome({
  label,
  onPick,
}: {
  label: string;
  onPick: (q: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-dashed border-line bg-surface-2 px-4 py-5 text-sm text-subtle">
        This is the <span className="font-medium text-ink">{label}</span> corpus. Ask a question
        to explore it — the assistant will route, retrieve, and cite from this data.
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
