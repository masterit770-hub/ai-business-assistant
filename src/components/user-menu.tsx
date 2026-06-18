"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

// The signed-in user + a real Sign out. Reads the live Supabase session, shows
// the actual email/initials, and signs the user out (clears the session → the
// middleware bounces them to /sign-in on the next navigation).
export function UserMenu() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  async function signOut() {
    setBusy(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.refresh();
    window.location.assign("/sign-in");
  }

  const initials = email
    ? email
        .split("@")[0]
        .split(/[.\-_]/)
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
          {email ?? "Not signed in"}
        </span>
        <span className="block truncate text-xs text-faint">Nucleus workspace</span>
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
