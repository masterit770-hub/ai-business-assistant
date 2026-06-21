import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Server Supabase client — reads/writes the session cookie so server components,
// route handlers, and the middleware all see the same auth state. Per the SSR
// guidance, getAll/setAll wrap Next's cookie store.
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — the middleware refreshes the
            // session cookie instead, so this is safe to ignore.
          }
        },
      },
    }
  );
}

// Service-role client — server-only, bypasses RLS. Used for admin actions
// (listing all users, deactivating a user). NEVER expose this to the browser.
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
