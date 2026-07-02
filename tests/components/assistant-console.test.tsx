// AssistantConsole — the multi-turn chat console (src/components/assistant/assistant-console.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug in the console's OWN state machine. This is
// the busiest machine in the app: ask → loading → turn appended; Stop = a clean cancel
// (NOT an error); a failed turn = a calm error card WITH Retry that doesn't vanish;
// resume loads a past thread; a resume that finds nothing says so (not a fake fresh
// chat); New chat clears everything; the tab switcher only exists once there's a thread;
// the "Live · <provider>" badge is honest. The cases pin each branch.
//
// ISOLATION: the console composes several PRESENTATIONAL children (AnswerSetup,
// ChatUpload, AnswerView, StatusTiles, the inspector panels). They have their OWN
// component tests; here we mock them to lightweight stand-ins so we test the console's
// orchestration (turns, errors, abort, resume, tabs), not the children's internals. We
// mock ONLY child components + fetch — never the console's own logic.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch, engineResult } from "./helpers";
import React from "react";

// Lightweight child stand-ins. AnswerView renders the answer text + exposes the onRetry
// the console passes (so we can assert retry wiring); the rest render a marker.
vi.mock("@/components/assistant/answer-setup", () => ({ AnswerSetup: () => <div data-testid="mock-answer-setup" /> }));
vi.mock("@/components/assistant/chat-upload", () => ({ ChatUpload: () => <div data-testid="mock-chat-upload" /> }));
vi.mock("@/components/assistant/answer-view", () => ({
  AnswerView: ({ result }: { result: { answer: string } }) => (
    <div data-testid="mock-answer-view">{result.answer}</div>
  ),
}));
vi.mock("@/components/assistant/inspector-panels", () => ({
  StatusTiles: () => <div data-testid="mock-status-tiles" />,
  RoutingDecision: () => <div data-testid="mock-routing" />,
  OrchestratorTrace: () => <div />,
  DocumentRetrieval: () => <div />,
  MetricsPanels: () => <div />,
}));
vi.mock("@/components/assistant/materials-rail", () => ({
  MaterialsRail: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="mock-materials-rail" data-session-id={sessionId ?? ""} />
  ),
}));

import { AssistantConsole } from "@/components/assistant/assistant-console";

// The console warms the embedder on mount (GET /api/embed); every test stubs it.
const EMBED = { "/api/embed": { json: { ok: true } } };

function typeAndSend(text: string) {
  return (async () => {
    const box = screen.getByRole("textbox");
    await userEvent.type(box, text);
    await userEvent.click(screen.getByTestId("send-ask"));
  })();
}

describe("AssistantConsole", () => {
  beforeEach(() => vi.useRealTimers());

  it("shows the empty state before any turn; Files tab is visible but Workspace/Inspector are disabled", async () => {
    mockFetch({ ...EMBED });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("assistant-console")).toBeInTheDocument());
    // Files tab is ALWAYS present (uploading is how you start a chat).
    expect(screen.getByTestId("tab-files")).toBeInTheDocument();
    expect(screen.getByTestId("tab-files")).not.toBeDisabled();
    // Workspace + Inspector are disabled (need a thread) but still present.
    expect(screen.getByTestId("tab-workspace")).toBeDisabled();
    expect(screen.getByTestId("tab-inspector")).toBeDisabled();
    expect(screen.getByText(/Ask a question about your contracts/i)).toBeInTheDocument();
  });

  it("clicking Files tab on a new chat shows the files panel and pre-mints a session id", async () => {
    mockFetch({ ...EMBED });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("tab-files")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("tab-files"));

    // The files tab content is now showing.
    expect(screen.getByTestId("files-tab")).toBeInTheDocument();
    const rail = screen.getByTestId("mock-materials-rail");
    // A session id was pre-minted (non-empty UUID) so uploads are scoped to this chat.
    expect(rail.getAttribute("data-session-id")).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("the send button is disabled until the textarea has non-whitespace text", async () => {
    mockFetch({ ...EMBED });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());

    expect(screen.getByTestId("send-ask")).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox"), "   "); // whitespace only
    expect(screen.getByTestId("send-ask")).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox"), "real question");
    expect(screen.getByTestId("send-ask")).toBeEnabled();
  });

  it("asking appends a turn (question + answer) and reveals the tab switcher", async () => {
    let askBody: Record<string, unknown> | null = null;
    mockFetch({
      ...EMBED,
      "/api/ask": (_url, init) => {
        askBody = JSON.parse(init!.body as string);
        return { json: { ...engineResult({ answer: "Total is $42,000." }), session_id: "sess-1" } };
      },
    });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());

    await typeAndSend("total spend?");

    await waitFor(() => expect(screen.getByTestId("chat-turn")).toBeInTheDocument());
    expect(screen.getByTestId("turn-question")).toHaveTextContent("total spend?");
    expect(screen.getByTestId("mock-answer-view")).toHaveTextContent("Total is $42,000.");
    // First turn sends a null session + empty history.
    expect(askBody).toMatchObject({ question: "total spend?", session_id: null, history: [] });
    // Now there's a thread → the tab switcher appears.
    expect(screen.getByTestId("tab-inspector")).toBeInTheDocument();
  });

  // ── OPTIMISTIC USER BUBBLE + WORKING INDICATOR (chat UX wins) ───────────────
  it("renders the user's bubble IMMEDIATELY on submit, BEFORE the answer returns", async () => {
    // RED-first: the in-flight /api/ask never resolves (pending). Before the fix the
    // turn (and thus the question bubble) was only appended AFTER `await fetch` returned,
    // so during the ~1-minute wait the user saw NO echo of what they asked. The optimistic
    // render must put the question bubble in the thread the moment they hit send.
    mockFetch({ ...EMBED, "/api/ask": { pending: true } });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());

    await typeAndSend("how many vendors are overdue?");

    // While the answer is STILL pending (fetch unresolved), the user's question is on screen.
    await waitFor(() => expect(screen.getByTestId("stop-ask")).toBeInTheDocument()); // loading
    expect(screen.getByTestId("pending-question")).toHaveTextContent("how many vendors are overdue?");
    // No answer view yet (the fetch hasn't resolved) — proves the bubble is optimistic,
    // not driven by the server response.
    expect(screen.queryByTestId("mock-answer-view")).not.toBeInTheDocument();
  });

  it("shows a working/thinking indicator in the thread while the answer is pending", async () => {
    // RED-first companion: during the pending answer a clear "working" progress state must
    // sit in the thread (under the just-rendered question), so a 30-60s wait never looks
    // frozen. Asserted by a stable testid (the loading card), present while loading.
    mockFetch({ ...EMBED, "/api/ask": { pending: true } });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());

    await typeAndSend("a slow question");

    await waitFor(() => expect(screen.getByTestId("working-indicator")).toBeInTheDocument());
    // The working indicator and the optimistic question coexist while pending.
    expect(screen.getByTestId("pending-question")).toBeInTheDocument();
  });

  it("the optimistic bubble becomes the real turn (answer fills in) once the fetch resolves", async () => {
    // The optimistic question must not DOUBLE the bubble: once the answer arrives the
    // thread shows exactly one question + its answer, and the pending placeholder is gone.
    mockFetch({
      ...EMBED,
      "/api/ask": { json: { ...engineResult({ answer: "Three vendors are overdue." }), session_id: "s1" } },
    });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());

    await typeAndSend("how many vendors are overdue?");

    await waitFor(() => expect(screen.getByTestId("mock-answer-view")).toHaveTextContent("Three vendors are overdue."));
    // Exactly one rendered question for this turn — no duplicate from the optimistic bubble.
    expect(screen.getAllByTestId("turn-question")).toHaveLength(1);
    expect(screen.getByTestId("turn-question")).toHaveTextContent("how many vendors are overdue?");
    // The pending placeholder and the working indicator are gone after success.
    expect(screen.queryByTestId("pending-question")).not.toBeInTheDocument();
    expect(screen.queryByTestId("working-indicator")).not.toBeInTheDocument();
  });

  it("clears the optimistic bubble when the in-flight ask is STOPPED (cancel, not an error)", async () => {
    // Stop aborts the pending fetch. The optimistic question must NOT linger as a ghost
    // bubble with no answer — it's cleared (the input is restored by the existing cancel path).
    mockFetch({ ...EMBED, "/api/ask": { pending: true } });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());

    await userEvent.type(screen.getByRole("textbox"), "slow question");
    await userEvent.click(screen.getByTestId("send-ask"));
    await waitFor(() => expect(screen.getByTestId("pending-question")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("stop-ask"));

    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());
    expect(screen.queryByTestId("pending-question")).not.toBeInTheDocument();
    expect(screen.queryByTestId("working-indicator")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ask-error")).not.toBeInTheDocument();
  });

  it("a follow-up sends the prior turns as history and reuses the minted session id", async () => {
    let secondBody: Record<string, unknown> | null = null;
    let n = 0;
    mockFetch({
      ...EMBED,
      "/api/ask": (_url, init) => {
        n += 1;
        if (n === 2) secondBody = JSON.parse(init!.body as string);
        return { json: { ...engineResult({ answer: `answer ${n}` }), session_id: "sess-1" } };
      },
    });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());

    await typeAndSend("first question");
    await waitFor(() => expect(screen.getByTestId("mock-answer-view")).toBeInTheDocument());
    await typeAndSend("what about Q2?");

    await waitFor(() => expect(secondBody).not.toBeNull());
    // The follow-up carries the same session AND the first turn as history.
    expect(secondBody).toMatchObject({
      question: "what about Q2?",
      session_id: "sess-1",
      history: [{ question: "first question", answer: "answer 1" }],
    });
  });

  it("a failed ask shows a calm error card WITH Retry; the card does not vanish", async () => {
    let attempts = 0;
    mockFetch({
      ...EMBED,
      "/api/ask": () => {
        attempts += 1;
        // First attempt fails; the Retry succeeds.
        return attempts === 1
          ? { ok: false, status: 502, json: { error: "the AI provider is unreachable" } }
          : { json: { ...engineResult({ answer: "recovered answer" }), session_id: "s" } };
      },
    });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());

    await typeAndSend("a question");

    // The error card stays in the thread with the friendly, mapped message + a Retry.
    await waitFor(() => expect(screen.getByTestId("ask-error")).toBeInTheDocument());
    expect(screen.getByTestId("retry-failed")).toBeInTheDocument();

    // Retry re-posts the SAME question and succeeds → the answer renders, error clears.
    await userEvent.click(screen.getByTestId("retry-failed"));
    await waitFor(() => expect(screen.getByTestId("mock-answer-view")).toHaveTextContent("recovered answer"));
    expect(screen.queryByTestId("ask-error")).not.toBeInTheDocument();
  });

  it("Stop CANCELS the in-flight ask (restores the input) and is NOT an error", async () => {
    // The ask never resolves; Stop aborts it. The catch treats the abort as a cancel:
    // it restores the typed question and shows no error card.
    mockFetch({ ...EMBED, "/api/ask": { pending: true } });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());

    await userEvent.type(screen.getByRole("textbox"), "slow question");
    await userEvent.click(screen.getByTestId("send-ask"));

    // While loading, the send button becomes a Stop button.
    await waitFor(() => expect(screen.getByTestId("stop-ask")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("stop-ask"));

    // After the abort: no error card, the question is restored, and we're back to idle.
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());
    expect(screen.queryByTestId("ask-error")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("slow question");
  });

  it("New chat clears the thread, the error, and resets to the empty state", async () => {
    mockFetch({
      ...EMBED,
      "/api/ask": { json: { ...engineResult({ answer: "an answer" }), session_id: "s1" } },
    });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());

    await typeAndSend("question");
    await waitFor(() => expect(screen.getByTestId("chat-turn")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("new-chat"));

    // Thread gone, empty state back.
    expect(screen.queryByTestId("chat-turn")).not.toBeInTheDocument();
    expect(screen.getByText(/Ask a question about your contracts/i)).toBeInTheDocument();
    // Workspace + Inspector are now disabled (no thread), Files tab still enabled.
    expect(screen.getByTestId("tab-workspace")).toBeDisabled();
    expect(screen.getByTestId("tab-inspector")).toBeDisabled();
    expect(screen.getByTestId("tab-files")).not.toBeDisabled();
  });

  it("switching to the Inspector tab shows the per-turn inspector view", async () => {
    mockFetch({
      ...EMBED,
      "/api/ask": { json: { ...engineResult({ answer: "an answer" }), session_id: "s1" } },
    });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());
    await typeAndSend("question");
    await waitFor(() => expect(screen.getByTestId("chat-turn")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("tab-inspector"));
    expect(screen.getByTestId("inspector-view")).toBeInTheDocument();
    expect(screen.getByTestId("mock-routing")).toBeInTheDocument();
  });

  it("dispatches nucleus:session after a successful turn (so the column refreshes)", async () => {
    const onSession = vi.fn();
    window.addEventListener("nucleus:session", onSession);
    mockFetch({
      ...EMBED,
      "/api/ask": { json: { ...engineResult({ answer: "x" }), session_id: "s1" } },
    });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());
    await typeAndSend("q");
    await waitFor(() => expect(onSession).toHaveBeenCalled());
    window.removeEventListener("nucleus:session", onSession);
  });

  // ── RESUME ────────────────────────────────────────────────────────────────
  it("resuming a session loads its past turns and continues in that session", async () => {
    mockFetch({
      ...EMBED,
      "/api/history/sess-9": {
        json: {
          turns: [
            { question: "earlier q", answer: "earlier a", mode: "grounded", inspector: { steps: [] } },
          ],
        },
      },
    });
    render(<AssistantConsole initialSessionId="sess-9" />);

    await waitFor(() => expect(screen.getByTestId("turn-question")).toHaveTextContent("earlier q"));
    expect(screen.getByTestId("mock-answer-view")).toHaveTextContent("earlier a");
    // A resumed thread shows the tab switcher (there are turns).
    expect(screen.getByTestId("tab-inspector")).toBeInTheDocument();
  });

  it("a resume that finds NO turns shows the honest 'couldn't be found' notice, not a fresh chat", async () => {
    // RED-first guard: without resumeEmpty, a deleted/foreign session id would render the
    // generic new-chat empty state and look like a brand-new conversation.
    mockFetch({ ...EMBED, "/api/history/gone": { json: { turns: [] } } });
    render(<AssistantConsole initialSessionId="gone" />);

    await waitFor(() => expect(screen.getByTestId("resume-empty")).toBeInTheDocument());
    expect(screen.getByTestId("resume-empty")).toHaveTextContent(/couldn’t be found/i);
    // It must NOT show the generic fresh-chat empty state.
    expect(screen.queryByText(/Ask a question about your contracts/i)).not.toBeInTheDocument();
  });

  it("a resume that errors surfaces the load error", async () => {
    mockFetch({
      ...EMBED,
      "/api/history/bad": { ok: false, status: 500, json: { error: "failed to load conversation" } },
    });
    render(<AssistantConsole initialSessionId="bad" />);
    await waitFor(() => expect(screen.getByTestId("ask-error")).toHaveTextContent(/failed to load conversation/i));
  });

  it("the Live badge names the provider from the most recent turn that reported one", async () => {
    mockFetch({
      ...EMBED,
      "/api/ask": {
        json: {
          ...engineResult({ answer: "x" }),
          session_id: "s1",
        },
      },
    });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());
    await typeAndSend("q");
    // engineResult's inspector.cost.provider is "deepseek".
    await waitFor(() => expect(screen.getByText(/Live · deepseek/)).toBeInTheDocument());
  });

  it("a resumed turn WITHOUT a recorded trace shows the 'trace not recorded' inspector notice", async () => {
    mockFetch({
      ...EMBED,
      "/api/history/old": {
        json: {
          // No `inspector` field on the persisted turn → traceRecorded === false.
          turns: [{ question: "old q", answer: "old a", mode: "grounded" }],
        },
      },
    });
    render(<AssistantConsole initialSessionId="old" />);
    await waitFor(() => expect(screen.getByTestId("turn-question")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("tab-inspector"));
    expect(screen.getByTestId("trace-not-recorded")).toBeInTheDocument();
  });

  it("the Files tab renders the materials rail for the current session", async () => {
    mockFetch({
      ...EMBED,
      "/api/ask": { json: { ...engineResult({ answer: "answer for files tab" }), session_id: "sess-files" } },
    });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("send-ask")).toBeInTheDocument());

    await typeAndSend("question");
    await waitFor(() => expect(screen.getByTestId("chat-turn")).toBeInTheDocument());

    // Files tab is always present; click it and confirm the session from the ask is used.
    expect(screen.getByTestId("tab-files")).not.toBeDisabled();
    await userEvent.click(screen.getByTestId("tab-files"));

    // The materials rail is rendered inside the files tab with the active session id.
    expect(screen.getByTestId("files-tab")).toBeInTheDocument();
    expect(screen.getByTestId("mock-materials-rail")).toBeInTheDocument();
    expect(screen.getByTestId("mock-materials-rail")).toHaveAttribute("data-session-id", "sess-files");
  });

  it("a virtual session (Sample data) skips the resume fetch and shows the welcome state", async () => {
    // Virtual sessions have no ask_history rows — the console must NOT fetch /api/history/<id>
    // for them. Instead it shows a corpus welcome state immediately.
    mockFetch({ ...EMBED });
    render(<AssistantConsole initialSessionId="00000000-0000-0000-0000-000000000002" />);

    // The virtual-session welcome copy should appear without any fetch.
    await waitFor(() =>
      expect(screen.getByText(/Sample data/i)).toBeInTheDocument()
    );
    // The generic "couldn't be found" notice must NOT appear.
    expect(screen.queryByTestId("resume-empty")).not.toBeInTheDocument();
  });

  // ── CRASH GUARD: malformed persisted turn shapes ──────────────────────────
  it("a resumed turn with a LEGACY ARRAY route (not the expected object) renders the turn, never crashes", async () => {
    // Regression for the "Course Enrollment" crash (2026-06-26).
    // The DB row had: route=["structured"] (a bare array), evidence=null, validation=null.
    // Before the fix, result.route.sources was undefined → TypeError in StatusTiles/RoutingDecision.
    // After the fix: normaliseRoute() + component guards coerce the bad shape to a safe sentinel.
    mockFetch({
      ...EMBED,
      "/api/history/bad-route-sess": {
        json: {
          turns: [
            {
              question: "Which course has the most students?",
              answer: "Physics has 93 students.",
              mode: "grounded",
              // LEGACY SHAPE: a bare array instead of {sources, docFilter, rationale}
              route: ["structured"],
              // NULL evidence and validation — also seen in the same bug
              evidence: null,
              validation: null,
              inspector: null,
            },
          ],
        },
      },
    });
    render(<AssistantConsole initialSessionId="bad-route-sess" />);

    // The turn must render (answer visible, question visible) — no crash, no error boundary.
    await waitFor(() => expect(screen.getByTestId("turn-question")).toHaveTextContent("Which course has the most students?"));
    expect(screen.getByTestId("mock-answer-view")).toHaveTextContent("Physics has 93 students.");
    // No ask-error card (the turn itself loaded fine).
    expect(screen.queryByTestId("ask-error")).not.toBeInTheDocument();
  });

  it("a resumed turn with null evidence and null validation renders gracefully", async () => {
    // Companion to the bad-route test: even with a well-shaped route, null evidence
    // or null validation would previously crash AnswerView / MetricsPanels. After the fix
    // the normalise helpers ensure these can never be null when the view renders.
    mockFetch({
      ...EMBED,
      "/api/history/null-ev-val": {
        json: {
          turns: [
            {
              question: "How many employees?",
              answer: "720 employees.",
              mode: "grounded",
              route: { sources: ["structured"], docFilter: null, rationale: "SQL lane." },
              evidence: null,
              validation: null,
              inspector: null,
            },
          ],
        },
      },
    });
    render(<AssistantConsole initialSessionId="null-ev-val" />);

    await waitFor(() => expect(screen.getByTestId("turn-question")).toHaveTextContent("How many employees?"));
    expect(screen.getByTestId("mock-answer-view")).toHaveTextContent("720 employees.");
    expect(screen.queryByTestId("ask-error")).not.toBeInTheDocument();
  });
});
