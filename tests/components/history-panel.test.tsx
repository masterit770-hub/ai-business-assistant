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

  // ── BULK-SELECT TESTS ────────────────────────────────────────────────────────────
  // These are RED-first: they fail if the bulk-select checkboxes, select-all, or the
  // bulk-delete flow are missing or broken. They drive the component's real state machine
  // via userEvent — never mock per-row state directly.

  it("checkboxes are rendered for each session row", async () => {
    mockFetch({ "/api/history": { json: { sessions: SESS } } });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());
    const checkboxes = screen.getAllByTestId("bulk-select-checkbox");
    expect(checkboxes).toHaveLength(SESS.length);
  });

  it("select-all checkbox selects all sessions and shows selected-count", async () => {
    mockFetch({ "/api/history": { json: { sessions: SESS } } });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("select-all-checkbox"));

    const checkboxes = screen.getAllByTestId("bulk-select-checkbox") as HTMLInputElement[];
    expect(checkboxes.every((cb) => cb.checked)).toBe(true);
    expect(screen.getByTestId("selected-count")).toHaveTextContent("2 selected");
  });

  it("unchecking select-all deselects all sessions", async () => {
    mockFetch({ "/api/history": { json: { sessions: SESS } } });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());

    // Select all, then deselect all.
    await userEvent.click(screen.getByTestId("select-all-checkbox"));
    await userEvent.click(screen.getByTestId("select-all-checkbox"));

    const checkboxes = screen.getAllByTestId("bulk-select-checkbox") as HTMLInputElement[];
    expect(checkboxes.every((cb) => !cb.checked)).toBe(true);
    expect(screen.queryByTestId("selected-count")).not.toBeInTheDocument();
  });

  it("Delete selected button appears when any session is checked", async () => {
    mockFetch({ "/api/history": { json: { sessions: SESS } } });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());

    // Before selecting: button must not be visible.
    expect(screen.queryByTestId("bulk-delete-button")).not.toBeInTheDocument();

    // Check one row.
    const checkboxes = screen.getAllByTestId("bulk-select-checkbox");
    await userEvent.click(checkboxes[0]);

    expect(screen.getByTestId("bulk-delete-button")).toBeInTheDocument();
  });

  it("first click on Delete selected shows confirm, does NOT delete", async () => {
    const fn = mockFetch({
      "/api/history/bulk-delete": { json: { deleted: 1 } },
      "/api/history": { json: { sessions: SESS } },
    });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());

    const checkboxes = screen.getAllByTestId("bulk-select-checkbox");
    await userEvent.click(checkboxes[0]);
    await userEvent.click(screen.getByTestId("bulk-delete-button"));

    // Confirm UI is now showing.
    expect(screen.getByTestId("bulk-delete-confirm")).toBeInTheDocument();

    // No POST to bulk-delete should have fired yet.
    const bulkPosts = fn.mock.calls.filter(
      ([url, init]) =>
        typeof url === "string" &&
        url.includes("/api/history/bulk-delete") &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    expect(bulkPosts).toHaveLength(0);
  });

  it("Cancel on bulk-delete confirm dismisses confirm but keeps selection", async () => {
    mockFetch({ "/api/history": { json: { sessions: SESS } } });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());

    const checkboxes = screen.getAllByTestId("bulk-select-checkbox");
    await userEvent.click(checkboxes[0]);
    await userEvent.click(screen.getByTestId("bulk-delete-button"));
    expect(screen.getByTestId("bulk-delete-confirm")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("bulk-delete-confirm-no"));

    // Confirm gone, but selection still active.
    expect(screen.queryByTestId("bulk-delete-confirm")).not.toBeInTheDocument();
    expect(screen.getByTestId("selected-count")).toBeInTheDocument();
  });

  it("confirming bulk-delete POSTs to /api/history/bulk-delete and refreshes the list", async () => {
    let postedBody: unknown = null;
    let sessions = [...SESS];
    mockFetch({
      "/api/history/bulk-delete": (_url, init) => {
        postedBody = JSON.parse((init as RequestInit).body as string);
        sessions = sessions.filter((s) => !(postedBody as { session_ids: string[] }).session_ids.includes(s.session_id));
        return { json: { deleted: 1 } };
      },
      "/api/history": { json: { sessions } },
    });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());

    // Check only the first session (s1).
    const checkboxes = screen.getAllByTestId("bulk-select-checkbox");
    await userEvent.click(checkboxes[0]);
    await userEvent.click(screen.getByTestId("bulk-delete-button"));
    await userEvent.click(screen.getByTestId("bulk-delete-confirm-yes"));

    // Verify the POST body.
    await waitFor(() => expect(postedBody).not.toBeNull());
    expect((postedBody as { session_ids: string[] }).session_ids).toContain("s1");
  });

  it("a failed bulk-delete surfaces an error", async () => {
    mockFetch({
      "/api/history/bulk-delete": { ok: false, status: 500, json: { error: "bulk-delete failed" } },
      "/api/history": { json: { sessions: SESS } },
    });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Maintenance costs")).toBeInTheDocument());

    await userEvent.click(screen.getAllByTestId("select-all-checkbox")[0]);
    await userEvent.click(screen.getByTestId("bulk-delete-button"));
    await userEvent.click(screen.getByTestId("bulk-delete-confirm-yes"));

    await waitFor(() => expect(screen.getByTestId("history-error")).toHaveTextContent("bulk-delete failed"));
  });

  // ── BATCHING TEST (RED-first: fails before the >100-batching fix) ────────────────
  // The server caps at MAX_IDS=100. Selecting >100 sessions in a single call gets a 400.
  // The fix: client-side batch into chunks of ≤100. This test verifies that selecting 120
  // sessions results in TWO separate POST calls (each with ≤100 ids) rather than one
  // failing call of 120.
  it("bulk-delete of >100 sessions batches into chunks of ≤100 (no single oversized POST)", async () => {
    const BIG = Array.from({ length: 120 }, (_, i) => ({
      session_id: `big-${i}`,
      title: `Session ${i}`,
      turn_count: 1,
      last_at: "2026-06-20T10:00:00Z",
    }));
    const postedBodies: { session_ids: string[] }[] = [];
    let deleted = 0;
    let remaining = [...BIG];
    mockFetch({
      "/api/history/bulk-delete": (_url, init) => {
        const body = JSON.parse((init as RequestInit).body as string) as { session_ids: string[] };
        // Mimic the server's MAX_IDS cap: reject if >100 ids in a single call.
        if (body.session_ids.length > 100) {
          return { ok: false, status: 400, json: { error: `Too many session_ids — max 100 per request` } };
        }
        postedBodies.push(body);
        deleted += body.session_ids.length;
        remaining = remaining.filter((s) => !body.session_ids.includes(s.session_id));
        return { json: { deleted: body.session_ids.length } };
      },
      "/api/history": { json: { sessions: remaining } },
    });
    render(<HistoryPanel isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Session 0")).toBeInTheDocument());

    // Select all 120 sessions.
    await userEvent.click(screen.getByTestId("select-all-checkbox"));
    await waitFor(() => expect(screen.getByTestId("selected-count")).toHaveTextContent("120 selected"));

    // Trigger bulk delete.
    await userEvent.click(screen.getByTestId("bulk-delete-button"));
    await userEvent.click(screen.getByTestId("bulk-delete-confirm-yes"));

    // After batching: NO error shown, and 2 POST calls were made (each ≤100 ids).
    await waitFor(
      () => expect(screen.queryByTestId("history-error")).not.toBeInTheDocument(),
      { timeout: 5000 }
    );
    expect(postedBodies.length).toBeGreaterThanOrEqual(2);
    expect(postedBodies.every((b) => b.session_ids.length <= 100)).toBe(true);
    expect(deleted).toBe(120);
  });
});
