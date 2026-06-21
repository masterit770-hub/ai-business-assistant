"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { resolveDisplayLabel } from "@/lib/account/validate";

// The signed-in user + a real Sign out. Reads the live Supabase session, shows
// the actual display name (set on /account) — or the email if none is set — plus
// matching initials, and signs the user out (clears the session → the middleware
// bounces them to /sign-in on the next navigation).
export function UserMenu() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
      setDisplayName(
        (data.user?.user_metadata?.display_name as string | undefined)?.trim() || null
      );
    });
  }, []);

  async function signOut() {
    setBusy(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.refresh();
    window.location.assign("/sign-in");
  }

  // The label shown for the user: their display name if set, else the email.
  const label = resolveDisplayLabel(displayName, email);
  // When a display name is set, surface the email underneath; otherwise keep the
  // existing subtitle so nothing looks empty.
  const subtitle = displayName && email ? email : "AI Business Assistant";

  // Initials come from the resolved label (a name's words, or the email local part).
  const initialsSource = displayName?.trim() || email?.split("@")[0] || "";
  const initials = initialsSource
    ? initialsSource
        .split(/[.\-_\s]+/)
        .filter(Boolean)
        .map((p) => p[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : "—";

  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2" data-testid="user-menu">
      <span className="flex size-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg">
        {initials}
      </span>
      <span className="min-w-0 flex-1">
        <span
          data-testid="user-email"
          className="block truncate text-sm font-semibold text-ink"
        >
          {label}
        </span>
        <span className="block truncate text-xs text-faint">{subtitle}</span>
      </span>
      <button
        onClick={signOut}
        disabled={busy}
        title="Sign out"
        data-testid="sign-out"
        className="flex size-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-muted hover:text-ink disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
      </button>
    </div>
  );
}
