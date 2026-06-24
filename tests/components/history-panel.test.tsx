// HistoryPanel — the conversations list with inline rename + delete
// (src/components/history-panel.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug. Promises:
//   • lists sessions; resume link points at /dashboard?session=<id>
//   • rename: opens an inline editor; a blank/UNCHANGED title closes WITHOUT a PATCH;
//     a real change PATCHes the new title and refreshes; a failed rename surfaces the
//     error and keeps the editor open
//   • delete: a TWO-STEP inline confirm — the first click only reveals "Delete?",
//     it does NOT delete; Cancel aborts with no request; Confirm DELETEs and refreshes
//   • admin sees the owner email on each row
// We mock ONLY fetch — never the panel's own per-row state machine.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistoryPanel } from "@/components/history-panel";
import { mockFetch } from "./helpers";

const SESS = [
  { session_id: "s1", title: "Maintenance costs", turn_count: 3, last_at: "2026-06-20T10:00:00Z", owner_email: "bob@co.com" },
  { session_id: "s2", title: "Lease questions", turn_count: 1, last_at: "2026-06-21T10:00:00Z" },
];

describe("HistoryPanel", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.restoreAllMocks());

  it("lists sessions and points resume at /dashboard?session=<id>", async () => {
    mockFetch({ "/api/history": { json: { sessions: SESS } } });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());
    const links = screen.getAllByTestId("resume-session");
    expect(links[0]).toHaveAttribute("href", "/dashboard?session=s1");
  });

  it("admin sees the owner email on a row", async () => {
    mockFetch({ "/api/history": { json: { sessions: SESS } } });
    render(<HistoryPanel isAdmin={true} />);
    await waitFor(() => expect(screen.getByText("bob@co.com")).toBeInTheDocument());
  });

  it("rename with a blank/unchanged title closes the editor and makes NO PATCH", async () => {
    const fn = mockFetch({ "/api/history": { json: { sessions: SESS } } });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());

    await userEvent.click(screen.getAllByTestId("rename-button")[0]);
    expect(screen.getByTestId("rename-input")).toBeInTheDocument();
    // save without changing → no PATCH, editor closes
    await userEvent.click(screen.getByTestId("rename-save"));
    expect(fn.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toBe(false);
    await waitFor(() => expect(screen.queryByTestId("rename-input")).not.toBeInTheDocument());
  });

  it("a real rename PATCHes the new title and refreshes", async () => {
    let patched: { url: string; body: unknown } | null = null;
    let sessions = [...SESS];
    mockFetch({
      "/api/history": (url, init) => {
        if (init?.method === "PATCH") {
          patched = { url, body: JSON.parse(init.body as string) };
          // rename ONLY the session whose id is in the URL (the title was changed for s1).
          sessions = sessions.map((s) => (url.includes(`/${s.session_id}`) ? { ...s, title: "Renamed" } : s));
          return { json: { ok: true } };
        }
        return { json: { sessions } };
      },
    });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());

    await userEvent.click(screen.getAllByTestId("rename-button")[0]);
    const input = screen.getByTestId("rename-input");
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed");
    await userEvent.click(screen.getByTestId("rename-save"));

    expect(patched!.url).toContain("/api/history/s1");
    expect(patched!.body).toEqual({ title: "Renamed" });
    await waitFor(() => expect(screen.getByText("Renamed")).toBeInTheDocument());
  });

  it("a FAILED rename surfaces the error and keeps the editor open", async () => {
    mockFetch({
      "/api/history": (_url, init) =>
        init?.method === "PATCH"
          ? { ok: false, status: 404, json: { error: "session not found" } }
          : { json: { sessions: SESS } },
    });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());
    await userEvent.click(screen.getAllByTestId("rename-button")[0]);
    await userEvent.type(screen.getByTestId("rename-input"), " more");
    await userEvent.click(screen.getByTestId("rename-save"));
    await waitFor(() => expect(screen.getByTestId("history-error")).toHaveTextContent("session not found"));
    expect(screen.getByTestId("rename-input")).toBeInTheDocument();
  });

  it("delete is a TWO-STEP confirm: the first click reveals 'Delete?' but does NOT delete", async () => {
    const fn = mockFetch({ "/api/history": { json: { sessions: SESS } } });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());

    await userEvent.click(screen.getAllByTestId("delete-button")[0]);
    expect(screen.getByTestId("delete-confirm")).toBeInTheDocument();
    // NO delete request yet
    expect(fn.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);

    // Cancel aborts with no request
    await userEvent.click(screen.getByTestId("delete-confirm-no"));
    expect(screen.queryByTestId("delete-confirm")).not.toBeInTheDocument();
    expect(fn.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });

  it("confirming the delete DELETEs the session and refreshes the list", async () => {
    let deletedUrl: string | null = null;
    let sessions = [...SESS];
    mockFetch({
      "/api/history": (url, init) => {
        if (init?.method === "DELETE") {
          deletedUrl = url;
          // drop ONLY the session whose id is in the DELETE url.
          sessions = sessions.filter((s) => !url.includes(`/${s.session_id}`));
          return { json: { deleted: 1 } };
        }
        return { json: { sessions } };
      },
    });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());

    await userEvent.click(screen.getAllByTestId("delete-button")[0]);
    await userEvent.click(screen.getByTestId("delete-confirm-yes"));

    expect(deletedUrl).toContain("/api/history/s1");
    await waitFor(() => expect(screen.queryByText("Maintenance costs")).not.toBeInTheDocument());
    expect(screen.getByText("Lease questions")).toBeInTheDocument();
  });

  it("a load failure surfaces the error", async () => {
    mockFetch({ "/api/history": { ok: false, status: 500, json: { error: "history unavailable" } } });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("history unavailable")).toBeInTheDocument());
  });

  it("an empty history shows the empty-state invite", async () => {
    mockFetch({ "/api/history": { json: { sessions: [] } } });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText(/No conversations yet/i)).toBeInTheDocument());
  });
});
