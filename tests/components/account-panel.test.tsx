// AccountPanel — the per-user Account page (src/components/account-panel.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug. The promises:
//   • Save name is DISABLED until the name actually changes (dirty), and ENABLED again
//     never after a no-op; "Saved" shows ONLY on a real success, never on an error
//     (the "Saved"-lie this layer exists to catch)
//   • a Supabase error surfaces the message and shows NO "Saved"
//   • password change runs the shared validators FIRST — a mismatch / too-short never
//     calls Supabase; a valid change clears the fields + shows "Password updated"
//   • theme + brand persist to localStorage + the data-theme/brand attributes
// We mock ONLY the Supabase auth client (a framework seam) + localStorage — never the
// panel's own dirty/save/validate state machine, which is the thing under test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── mock the Supabase browser client (the auth seam) ──────────────────────────────
let authUser: { email: string; user_metadata?: { display_name?: string } } | null = {
  email: "jenny@co.com",
  user_metadata: { display_name: "Jenny" },
};
// Supabase returns { error: AuthError } where AuthError IS an Error instance — so the
// component's `err instanceof Error ? err.message` surfaces the real message. A faithful
// failure mock must therefore return a real Error, not a plain object.
let updateUserImpl: (args: unknown) => Promise<{ error: Error | null }> = async () => ({ error: null });
const updateUserCalls: unknown[] = [];

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: authUser } }),
      updateUser: async (args: unknown) => { updateUserCalls.push(args); return updateUserImpl(args); },
    },
  }),
}));

import { AccountPanel } from "@/components/account-panel";

describe("AccountPanel", () => {
  beforeEach(() => {
    authUser = { email: "jenny@co.com", user_metadata: { display_name: "Jenny" } };
    updateUserImpl = async () => ({ error: null });
    updateUserCalls.length = 0;
    document.documentElement.removeAttribute("data-theme");
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  async function mounted() {
    render(<AccountPanel />);
    // identity loads from the auth user
    await waitFor(() => expect(screen.getByTestId("account-email")).toHaveValue("jenny@co.com"));
  }

  // ── display name dirty + save ────────────────────────────────────────────────────
  it("Save name is disabled until the name actually changes", async () => {
    await mounted();
    expect(screen.getByTestId("save-name")).toBeDisabled();
    await userEvent.type(screen.getByTestId("display-name-input"), " Cohen");
    expect(screen.getByTestId("save-name")).toBeEnabled();
  });

  it("editing back to the ORIGINAL name re-disables Save (no phantom dirty)", async () => {
    await mounted();
    const input = screen.getByTestId("display-name-input");
    await userEvent.type(input, "X");
    expect(screen.getByTestId("save-name")).toBeEnabled();
    await userEvent.type(input, "{backspace}");
    expect(screen.getByTestId("save-name")).toBeDisabled();
  });

  it("a successful save calls updateUser with the trimmed name and shows 'Saved'", async () => {
    await mounted();
    const input = screen.getByTestId("display-name-input");
    await userEvent.clear(input);
    await userEvent.type(input, "  Jenny Cohen  ");
    await userEvent.click(screen.getByTestId("save-name"));

    await waitFor(() => expect(screen.getByTestId("name-saved")).toBeInTheDocument());
    expect(updateUserCalls).toContainEqual({ data: { display_name: "Jenny Cohen" } });
    // dirty cleared → Save disables again (the saved value is now the baseline)
    expect(screen.getByTestId("save-name")).toBeDisabled();
  });

  it("a FAILED save surfaces the error and shows NO 'Saved' (the Saved-lie guard)", async () => {
    updateUserImpl = async () => ({ error: new Error("session expired") });
    await mounted();
    await userEvent.type(screen.getByTestId("display-name-input"), " Cohen");
    await userEvent.click(screen.getByTestId("save-name"));

    await waitFor(() => expect(screen.getByTestId("name-error")).toHaveTextContent("session expired"));
    expect(screen.queryByTestId("name-saved")).not.toBeInTheDocument();
    // still dirty → user can retry
    expect(screen.getByTestId("save-name")).toBeEnabled();
  });

  // ── password change: validators run FIRST ──────────────────────────────────────────
  it("a password MISMATCH surfaces the error and never calls Supabase", async () => {
    await mounted();
    await userEvent.type(screen.getByTestId("new-password-input"), "longenough1");
    await userEvent.type(screen.getByTestId("confirm-password-input"), "different99");
    await userEvent.click(screen.getByTestId("save-password"));

    await waitFor(() => expect(screen.getByTestId("password-error")).toBeInTheDocument());
    // no password updateUser call fired
    expect(updateUserCalls.some((c) => (c as { password?: string }).password)).toBe(false);
    expect(screen.queryByTestId("password-saved")).not.toBeInTheDocument();
  });

  it("a too-SHORT password surfaces the error and never calls Supabase", async () => {
    await mounted();
    await userEvent.type(screen.getByTestId("new-password-input"), "abc");
    await userEvent.type(screen.getByTestId("confirm-password-input"), "abc");
    await userEvent.click(screen.getByTestId("save-password"));
    await waitFor(() => expect(screen.getByTestId("password-error")).toBeInTheDocument());
    expect(updateUserCalls.some((c) => (c as { password?: string }).password)).toBe(false);
  });

  it("a valid password change calls Supabase, clears the fields, and shows 'Password updated'", async () => {
    await mounted();
    await userEvent.type(screen.getByTestId("new-password-input"), "longenough1");
    await userEvent.type(screen.getByTestId("confirm-password-input"), "longenough1");
    await userEvent.click(screen.getByTestId("save-password"));

    await waitFor(() => expect(screen.getByTestId("password-saved")).toBeInTheDocument());
    expect(updateUserCalls).toContainEqual({ password: "longenough1" });
    // fields cleared after success
    expect(screen.getByTestId("new-password-input")).toHaveValue("");
    expect(screen.getByTestId("confirm-password-input")).toHaveValue("");
  });

  it("a FAILED password change surfaces the error and shows NO success", async () => {
    updateUserImpl = async () => ({ error: new Error("password too weak") });
    await mounted();
    await userEvent.type(screen.getByTestId("new-password-input"), "longenough1");
    await userEvent.type(screen.getByTestId("confirm-password-input"), "longenough1");
    await userEvent.click(screen.getByTestId("save-password"));
    await waitFor(() => expect(screen.getByTestId("password-error")).toHaveTextContent("password too weak"));
    expect(screen.queryByTestId("password-saved")).not.toBeInTheDocument();
  });

  // ── theme persists to the DOM + localStorage ───────────────────────────────────────
  it("choosing Dark sets data-theme=dark and persists it", async () => {
    await mounted();
    await userEvent.click(screen.getByTestId("theme-dark"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("ab-theme")).toBe("dark");
    expect(screen.getByTestId("theme-dark")).toHaveAttribute("aria-pressed", "true");
  });

  it("the brand picker marks the chosen brand active", async () => {
    await mounted();
    await userEvent.click(screen.getByTestId("brand-teal"));
    expect(screen.getByTestId("brand-teal")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("brand-violet")).toHaveAttribute("aria-pressed", "false");
  });
});
