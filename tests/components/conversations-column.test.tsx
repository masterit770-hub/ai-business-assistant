// ConversationsColumn — the left-of-chat list of saved conversations
// (src/components/assistant/conversations-column.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug. Its promise: "your real conversations show
// here, the one you're viewing is highlighted, a new turn makes the list refresh, and a
// load failure says so instead of looking empty." The cases pin each list state:
//   • loading (null) → a Loading… row, no error, no empty copy
//   • empty list → the "No conversations yet" empty state
//   • populated → one row per session with title + relative time + turn-count grammar
//   • the active ?session row is marked data-active=true; the others false
//   • a nucleus:session event (a turn landed) RE-FETCHES the list
//   • the Refresh button re-fetches
//   • a load error shows the error and NOT the loading/empty states
//   • each row links to /dashboard?session=<id>; "New chat" links to /dashboard
//
// We control the active session by re-mocking next/navigation's useSearchParams per file.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "./helpers";

// Per-file override of the active ?session= so we can test the highlight. The default
// setup mock returns an empty query; here we make it return a controllable session id.
let activeSession: string | null = null;
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (k: string) => (k === "session" ? activeSession : null) }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/dashboard",
}));

// Imported AFTER the mock so it picks up the override.
import { ConversationsColumn } from "@/components/assistant/conversations-column";

function sessions() {
  const now = Date.now();
  return [
    { session_id: "s1", title: "Maintenance spend Q3", turn_count: 3, last_at: new Date(now - 5 * 60000).toISOString() },
    { session_id: "s2", title: "Lease renewal terms", turn_count: 1, last_at: new Date(now - 2 * 3600000).toISOString() },
  ];
}

describe("ConversationsColumn", () => {
  beforeEach(() => {
    activeSession = null;
    vi.useRealTimers();
  });

  it("shows a Loading… state while the first fetch is in flight", async () => {
    mockFetch({ "/api/history": { pending: true } });
    render(<ConversationsColumn />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByTestId("conversations-error")).not.toBeInTheDocument();
  });

  it("renders the empty state when there are no conversations", async () => {
    mockFetch({ "/api/history": { json: { sessions: [] } } });
    render(<ConversationsColumn />);
    await waitFor(() => expect(screen.getByText(/No conversations yet/i)).toBeInTheDocument());
    expect(screen.queryByTestId("conversation-item")).not.toBeInTheDocument();
  });

  it("renders one row per session with title, relative time and turn-count grammar", async () => {
    mockFetch({ "/api/history": { json: { sessions: sessions() } } });
    render(<ConversationsColumn />);

    await waitFor(() => expect(screen.getAllByTestId("conversation-item")).toHaveLength(2));
    const rows = screen.getAllByTestId("conversation-item");
    expect(within(rows[0]).getByText("Maintenance spend Q3")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/5m ago · 3 turns/)).toBeInTheDocument();
    // Singular grammar for a one-turn session.
    expect(within(rows[1]).getByText(/2h ago · 1 turn$/)).toBeInTheDocument();
  });

  it("marks ONLY the active ?session row as data-active=true", async () => {
    activeSession = "s2";
    mockFetch({ "/api/history": { json: { sessions: sessions() } } });
    render(<ConversationsColumn />);

    await waitFor(() => expect(screen.getAllByTestId("conversation-item")).toHaveLength(2));
    const rows = screen.getAllByTestId("conversation-item");
    expect(rows[0]).toHaveAttribute("data-active", "false"); // s1
    expect(rows[1]).toHaveAttribute("data-active", "true"); // s2 (active)
  });

  it("each row links to /dashboard?session=<id> and New chat links to /dashboard", async () => {
    mockFetch({ "/api/history": { json: { sessions: sessions() } } });
    render(<ConversationsColumn />);

    await waitFor(() => expect(screen.getAllByTestId("conversation-item")).toHaveLength(2));
    expect(screen.getAllByTestId("conversation-item")[0]).toHaveAttribute("href", "/dashboard?session=s1");
    expect(screen.getByTestId("new-chat-link")).toHaveAttribute("href", "/dashboard");
  });

  it("re-fetches when a turn lands (nucleus:session event)", async () => {
    // First load: empty. After a turn lands, the list now has one session.
    let call = 0;
    const fetchFn = mockFetch({
      "/api/history": () => {
        call += 1;
        return { json: { sessions: call === 1 ? [] : sessions().slice(0, 1) } };
      },
    });
    render(<ConversationsColumn />);
    await waitFor(() => expect(screen.getByText(/No conversations yet/i)).toBeInTheDocument());

    // The console dispatches this when a turn is saved.
    window.dispatchEvent(new CustomEvent("nucleus:session"));

    await waitFor(() => expect(screen.getByTestId("conversation-item")).toBeInTheDocument());
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("the Refresh button re-fetches the list", async () => {
    const fetchFn = mockFetch({ "/api/history": { json: { sessions: sessions() } } });
    render(<ConversationsColumn />);
    await waitFor(() => expect(screen.getAllByTestId("conversation-item")).toHaveLength(2));

    await userEvent.click(screen.getByRole("button", { name: /refresh conversations/i }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
  });

  it("a load failure shows the error and NOT the loading/empty states", async () => {
    mockFetch({ "/api/history": { ok: false, status: 500, json: { error: "history table missing" } } });
    render(<ConversationsColumn />);

    await waitFor(() => expect(screen.getByTestId("conversations-error")).toHaveTextContent("history table missing"));
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText(/No conversations yet/i)).not.toBeInTheDocument();
  });

  it("a network reject also surfaces an error rather than a phantom empty list", async () => {
    mockFetch({ "/api/history": { reject: new Error("offline") } });
    render(<ConversationsColumn />);
    await waitFor(() => expect(screen.getByTestId("conversations-error")).toHaveTextContent("offline"));
    expect(screen.queryByText(/No conversations yet/i)).not.toBeInTheDocument();
  });
});
