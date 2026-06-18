"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, AlertCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Real Supabase email/password SIGN-IN. Public self-registration is disabled —
// the client's model is admin-creates-accounts only — so this form is sign-in
// only; there is no signUp path in the UI. (`mode` is accepted for compatibility
// but only "sign-in" is supported.)
export function AuthForm({ mode = "sign-in" }: { mode?: "sign-in" | "sign-up" }) {
  void mode;
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  // A mid-session kick-out (the middleware bounces a disabled user to
  // /sign-in?disabled=1) lands here with no failed sign-in attempt, so it would
  // otherwise show NO message. Seed the error with the same friendly text the
  // banned-on-sign-in path uses, so a kicked-out user is told why.
  const [error, setError] = useState<string | null>(
    params.get("disabled") === "1"
      ? "Your access has been removed by an administrator."
      : null
  );
  const [info] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      // Full navigation so the server re-reads the new session cookie.
      router.refresh();
      window.location.assign(next);
    } catch (err) {
      setError(friendlyAuthError(err));
      setLoading(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-1.5">
        <Label htmlFor="email" className="text-sm font-medium text-ink">
          Email
        </Label>
        <Input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="h-11"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password" className="text-sm font-medium text-ink">
          Password
        </Label>
        <Input
          id="password"
          type="password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••••"
          className="h-11"
        />
      </div>

      {error && (
        <p
          data-testid="auth-error"
          className="flex items-center gap-1.5 text-sm font-medium text-red-600"
        >
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </p>
      )}
      {info && (
        <p data-testid="auth-info" className="text-sm font-medium text-accent">
          {info}
        </p>
      )}

      <Button
        type="submit"
        size="lg"
        disabled={loading}
        data-testid="auth-submit"
        className="h-11 w-full gap-2 bg-accent text-accent-fg hover:bg-accent/90 shadow-soft disabled:opacity-60"
      >
        {loading && <Loader2 className="size-4 animate-spin" />}
        {mode === "sign-up" ? "Create account" : "Sign in"}
      </Button>
    </form>
  );
}

// Map raw Supabase auth errors to honest, human messages. The important one: a
// kicked-out (banned/disabled) user gets a clear access-removed message instead
// of the raw "User is banned".
function friendlyAuthError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (/banned|user is banned|user_banned/i.test(raw)) {
    return "Your access has been removed by an administrator.";
  }
  if (/invalid login credentials/i.test(raw)) {
    return "Incorrect email or password.";
  }
  if (/email not confirmed/i.test(raw)) {
    return "Please confirm your email address, then sign in.";
  }
  return raw || "Authentication failed.";
}
