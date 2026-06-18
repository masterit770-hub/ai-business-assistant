// Supabase client + capability flag for the persistent document store.
//
// PHI requirement: uploaded documents (hospital/legal) live in a store the CLIENT
// owns — Supabase Postgres + pgvector — not a managed third-party index. This
// module is the single seam for that store.
//
// Env (server-only; never shipped to the browser, never committed):
//   SUPABASE_URL                 https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    service-role key (server-side writes + seed)
//
// If those are absent the engine runs in its prior mode (bundled JSON/SQLite +
// per-Lambda in-memory uploads) — so the codebase is always runnable, and the
// switch to persistence is a config change. `supabaseEnabled()` gates every
// Supabase code path.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let _admin: SupabaseClient | null = null;

/** True when the persistent Supabase store is configured. */
export function supabaseEnabled(): boolean {
  return Boolean(URL && SERVICE_KEY);
}

/**
 * The service-role client — full DB access, server-only. Used for ingestion
 * writes and the one-time corpus seed. NEVER import this into client code.
 * For per-user RLS reads (Phase C) we will additionally build a request-scoped
 * client from the caller's JWT.
 */
export function admin(): SupabaseClient {
  if (!supabaseEnabled()) {
    throw new Error(
      "Supabase is not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)."
    );
  }
  if (_admin) return _admin;
  _admin = createClient(URL!, SERVICE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}
