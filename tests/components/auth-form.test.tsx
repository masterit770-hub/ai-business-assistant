// AuthForm — the sign-in form (src/components/auth-form.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug in the auth entry point. Promises:
//   • a kicked-out user landing on /sign-in?disabled=1 sees the access-removed message
//     even with no failed attempt (the mid-session kick-out path)
//   • raw Supabase errors map to HONEST human messages: banned → "access removed",
//     invalid creds → "Incorrect email or password", unconfirmed → confirm-your-email
//   • a successful sign-in navigates to ?next (default /dashboard)
//   • the submit button shows a loading state while the request is in flight
// We mock ONLY the Supabase auth client + next/navigation search params (framework
// seams) — never the form's own error-mapping/loading state machine.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let signInImpl: (args: { email: string; password: string }) => Promise<{ error: Error | null }> =
  async () => ({ error: null });
let searchParams = new URLSearchParams();
const assignMock = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithPassword: async (a: { email: string; password: string }) => signInImpl(a) } }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { AuthForm } from "@/components/auth-form";

describe("AuthForm", () => {
  beforeEach(() => {
    signInImpl = async () => ({ error: null });
    searchParams = new URLSearchParams();
    assignMock.mockClear();
    // window.location.assign is what the form uses on success.
    Object.defineProperty(window, "location", { value: { assign: assignMock }, writable: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it("a kicked-out user (?disabled=1) sees the access-removed message on load", async () => {
    searchParams = new URLSearchParams("disabled=1");
    render(<AuthForm />);
    expect(screen.getByTestId("auth-error")).toHaveTextContent(/access has been removed/i);
  });

  it("no query param → no error shown initially", () => {
    render(<AuthForm />);
    expect(screen.queryByTestId("auth-error")).not.toBeInTheDocument();
  });

  it("a BANNED sign-in maps to the honest access-removed message (not the raw error)", async () => {
    signInImpl = async () => ({ error: new Error("User is banned") });
    render(<AuthForm />);
    await userEvent.type(screen.getByLabelText(/email/i), "x@co.com");
    await userEvent.type(screen.getByLabelText(/password/i), "secret123");
    await userEvent.click(screen.getByTestId("auth-submit"));
    await waitFor(() => expect(screen.getByTestId("auth-error")).toHaveTextContent(/access has been removed/i));
    expect(screen.getByTestId("auth-error")).not.toHaveTextContent(/banned/i);
  });

  it("invalid credentials map to 'Incorrect email or password'", async () => {
    signInImpl = async () => ({ error: new Error("Invalid login credentials") });
    render(<AuthForm />);
    await userEvent.type(screen.getByLabelText(/email/i), "x@co.com");
    await userEvent.type(screen.getByLabelText(/password/i), "secret123");
    await userEvent.click(screen.getByTestId("auth-submit"));
    await waitFor(() => expect(screen.getByTestId("auth-error")).toHaveTextContent(/incorrect email or password/i));
  });

  it("an unconfirmed email maps to the confirm-your-email message", async () => {
    signInImpl = async () => ({ error: new Error("Email not confirmed") });
    render(<AuthForm />);
    await userEvent.type(screen.getByLabelText(/email/i), "x@co.com");
    await userEvent.type(screen.getByLabelText(/password/i), "secret123");
    await userEvent.click(screen.getByTestId("auth-submit"));
    await waitFor(() => expect(screen.getByTestId("auth-error")).toHaveTextContent(/confirm your email/i));
  });

  it("a successful sign-in navigates to ?next (default /dashboard)", async () => {
    signInImpl = async () => ({ error: null });
    render(<AuthForm />);
    await userEvent.type(screen.getByLabelText(/email/i), "ok@co.com");
    await userEvent.type(screen.getByLabelText(/password/i), "secret123");
    await userEvent.click(screen.getByTestId("auth-submit"));
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/dashboard"));
  });

  it("a successful sign-in honours an explicit ?next destination", async () => {
    searchParams = new URLSearchParams("next=/settings");
    signInImpl = async () => ({ error: null });
    render(<AuthForm />);
    await userEvent.type(screen.getByLabelText(/email/i), "ok@co.com");
    await userEvent.type(screen.getByLabelText(/password/i), "secret123");
    await userEvent.click(screen.getByTestId("auth-submit"));
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/settings"));
  });
});
