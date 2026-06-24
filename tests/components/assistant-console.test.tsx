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
import { render, screen, waitFor, within } from "@testing-library/react";
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

  it("shows the empty state and NO tab switcher before any turn", async () => {
    mockFetch({ ...EMBED });
    render(<AssistantConsole />);
    await waitFor(() => expect(screen.getByTestId("assistant-console")).toBeInTheDocument());
    // No thread → the per-answer tabs are hidden (they'd be identical empty states).
    expect(screen.queryByTestId("tab-inspector")).not.toBeInTheDocument();
    expect(screen.getByText(/Ask a question about your contracts/i)).toBeInTheDocument();
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

    // Thread gone, tabs gone, empty state back.
    expect(screen.queryByTestId("chat-turn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tab-inspector")).not.toBeInTheDocument();
    expect(screen.getByText(/Ask a question about your contracts/i)).toBeInTheDocument();
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
});
