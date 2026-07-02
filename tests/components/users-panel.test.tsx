// UsersPanel — Settings → Users & access (src/components/users-panel.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug in the admin user-management surface.
// This panel's promises: it lists the REAL users; "Kick out" deactivates and flips
// the row to Deactivated (optimistic, from the server echo); a role change is
// CONFIRM-gated and reflects the server's role; YOUR OWN row never offers kick-out or
// a role toggle (the lockout guard is also enforced in the UI); create surfaces the
// invite/credentials card; every failure surfaces an error and does NOT mutate the row.
// We mock ONLY fetch + window.confirm — the panel's own state machine is the thing
// under test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsersPanel } from "@/components/users-panel";
import { mockFetch } from "./helpers";

const SELF = { id: "admin-self", email: "me@co.com", role: "admin", status: "active", createdAt: "2026-01-01", lastSignInAt: null, isSelf: true };
const MEMBER = { id: "u-2", email: "bob@co.com", role: "user", status: "active", createdAt: "2026-01-02", lastSignInAt: null };
const OFF_MEMBER = { id: "u-3", email: "off@co.com", role: "user", status: "deactivated", createdAt: "2026-01-03", lastSignInAt: null };

function listOf(users: unknown[]) {
  return { "/api/admin/users": { json: { users } } };
}

describe("UsersPanel", () => {
  beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(true); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("loads and lists the real users with the active/total summary", async () => {
    mockFetch(listOf([SELF, MEMBER, OFF_MEMBER]));
    render(<UsersPanel />);
    await waitFor(() => expect(screen.getByTestId("user-row-bob@co.com")).toBeInTheDocument());
    expect(screen.getByText(/2 active · 3 total/)).toBeInTheDocument();
  });

  it("your OWN row offers NO kick-out and NO role toggle (the lockout guard)", async () => {
    mockFetch(listOf([SELF, MEMBER]));
    render(<UsersPanel />);
    await waitFor(() => expect(screen.getByTestId("user-row-me@co.com")).toBeInTheDocument());
    expect(screen.queryByTestId("user-toggle-me@co.com")).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-role-toggle-me@co.com")).not.toBeInTheDocument();
    // a member's row DOES offer both
    expect(screen.getByTestId("user-toggle-bob@co.com")).toBeInTheDocument();
    expect(screen.getByTestId("user-role-toggle-bob@co.com")).toBeInTheDocument();
  });

  it("Kick out deactivates and flips the row to the server-echoed status", async () => {
    let posted: Record<string, unknown> | null = null;
    mockFetch({
      "/api/admin/users": (_url, init) => {
        if (init?.method === "POST") {
          posted = JSON.parse(init.body as string);
          return { json: { ok: true, id: "u-2", status: "deactivated" } };
        }
        return { json: { users: [SELF, MEMBER] } };
      },
    });
    render(<UsersPanel />);
    await waitFor(() => expect(screen.getByTestId("user-toggle-bob@co.com")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("user-toggle-bob@co.com"));

    expect(posted).toEqual({ id: "u-2", action: "deactivate" });
    // the row reflects the echoed status (not an optimistic guess)
    await waitFor(() => expect(screen.getByTestId("user-status-bob@co.com")).toHaveTextContent(/Deactivated/));
    // and the button now offers Reactivate
    expect(screen.getByTestId("user-toggle-bob@co.com")).toHaveTextContent(/Reactivate/);
  });

  it("a deactivated user's button reactivates them", async () => {
    let posted: Record<string, unknown> | null = null;
    mockFetch({
      "/api/admin/users": (_url, init) => {
        if (init?.method === "POST") { posted = JSON.parse(init.body as string); return { json: { ok: true, id: "u-3", status: "active" } }; }
        return { json: { users: [SELF, OFF_MEMBER] } };
      },
    });
    render(<UsersPanel />);
    await waitFor(() => expect(screen.getByTestId("user-toggle-off@co.com")).toHaveTextContent(/Reactivate/));
    await userEvent.click(screen.getByTestId("user-toggle-off@co.com"));
    expect(posted).toEqual({ id: "u-3", action: "reactivate" });
    await waitFor(() => expect(screen.getByTestId("user-status-off@co.com")).toHaveTextContent(/Active/));
  });

  it("a FAILED kick-out surfaces the error and does NOT change the row", async () => {
    mockFetch({
      "/api/admin/users": (_url, init) =>
        init?.method === "POST"
          ? { ok: false, status: 400, json: { error: "you cannot deactivate yourself" } }
          : { json: { users: [SELF, MEMBER] } },
    });
    render(<UsersPanel />);
    await waitFor(() => expect(screen.getByTestId("user-toggle-bob@co.com")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("user-toggle-bob@co.com"));
    await waitFor(() => expect(screen.getByText("you cannot deactivate yourself")).toBeInTheDocument());
    // the row is still Active (the failed action must not optimistically flip it)
    expect(screen.getByTestId("user-status-bob@co.com")).toHaveTextContent(/Active/);
  });

  it("a role change is CONFIRM-gated: cancelling confirm makes NO request", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const fn = mockFetch(listOf([SELF, MEMBER]));
    render(<UsersPanel />);
    await waitFor(() => expect(screen.getByTestId("user-role-toggle-bob@co.com")).toBeInTheDocument());

    const before = fn.mock.calls.length;
    await userEvent.click(screen.getByTestId("user-role-toggle-bob@co.com"));
    // no extra fetch fired (only the initial load)
    expect(fn.mock.calls.length).toBe(before);
    // role unchanged
    expect(screen.getByTestId("user-role-bob@co.com")).toHaveTextContent(/user/);
  });

  it("a confirmed role change promotes the member and reflects the server role", async () => {
    let posted: Record<string, unknown> | null = null;
    mockFetch({
      "/api/admin/users": (_url, init) => {
        if (init?.method === "POST") { posted = JSON.parse(init.body as string); return { json: { ok: true, id: "u-2", role: "admin" } }; }
        return { json: { users: [SELF, MEMBER] } };
      },
    });
    render(<UsersPanel />);
    await waitFor(() => expect(screen.getByTestId("user-role-toggle-bob@co.com")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("user-role-toggle-bob@co.com"));
    expect(posted).toEqual({ id: "u-2", action: "setRole", role: "admin" });
    await waitFor(() => expect(screen.getByTestId("user-role-bob@co.com")).toHaveTextContent(/admin/));
  });

  it("create surfaces the invite hand-off card with the link + temp password", async () => {
    const invite = { email: "new@co.com", inviteLink: "https://app/invite", tempPassword: "temp123" };
    mockFetch({
      "/api/admin/users": (_url, init) =>
        init?.method === "POST"
          ? { json: { ok: true, id: "new-1", status: "active", invite } }
          : { json: { users: [SELF] } },
    });
    render(<UsersPanel />);
    await waitFor(() => expect(screen.getByTestId("create-user-form")).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText(/teammate@company.com/i), "new@co.com");
    await userEvent.type(screen.getByPlaceholderText(/min 6 chars/i), "temp123");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    const card = await screen.findByTestId("invite-card");
    expect(within(card).getByTestId("invite-email-value")).toHaveValue("new@co.com");
    expect(within(card).getByTestId("invite-password-value")).toHaveValue("temp123");
  });

  it("a FAILED create surfaces the error and shows NO invite card", async () => {
    mockFetch({
      "/api/admin/users": (_url, init) =>
        init?.method === "POST"
          ? { ok: false, status: 400, json: { error: "email already in use" } }
          : { json: { users: [SELF] } },
    });
    render(<UsersPanel />);
    await waitFor(() => expect(screen.getByTestId("create-user-form")).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText(/teammate@company.com/i), "dup@co.com");
    await userEvent.type(screen.getByPlaceholderText(/min 6 chars/i), "temp123");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));
    await waitFor(() => expect(screen.getByText("email already in use")).toBeInTheDocument());
    expect(screen.queryByTestId("invite-card")).not.toBeInTheDocument();
  });

  it("a load failure surfaces the error instead of an empty list", async () => {
    mockFetch({ "/api/admin/users": { ok: false, status: 403, json: { error: "forbidden" } } });
    render(<UsersPanel />);
    await waitFor(() => expect(screen.getByText("forbidden")).toBeInTheDocument());
  });
});
