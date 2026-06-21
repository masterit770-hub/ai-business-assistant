"use client";

import { createBrowserClient } from "@supabase/ssr";
import { processLock } from "@supabase/supabase-js";

// Browser Supabase client — resolves the signed-in user's session from cookies.
// Used by client components (sign-in/up forms, the auth state in the shell).
//
// `lock: processLock` replaces supabase-js's default navigator.locks guard. On
// real-world browsers (persistent profile, multiple tabs, a stuck background
// refresh) the Web Locks API can contend → getSession()/refreshSession() hang or
// return null and the client silently sends the anon key (401 / RLS 42501). The
// in-process lock structurally avoids that — see the supabase playbook landmine.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { lock: processLock } }
  );
}
