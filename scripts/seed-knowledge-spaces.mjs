#!/usr/bin/env node
// Idempotent seed for Knowledge Spaces (migration 016).
//
// Creates Finance / Contracts / HR spaces for the DEMO admin account
// (3d1ca025-d718-4d55-bab5-821a239cadbf) via the LIVE /api/spaces endpoint,
// authenticating with the admin's real credentials.
//
// ⛔ NEVER touches the real client account (b01c311e-...) — guard is enforced.
// ⛔ Idempotent: if a space with the same name already exists it is left untouched;
//    the seed creates only what's missing.
//
// Usage:
//   node scripts/seed-knowledge-spaces.mjs
//
// Environment:
//   NUCLEUS_BASE — optional, defaults to https://nucleus-woad.vercel.app
//   (credentials read from .secrets/demo-accounts.txt — never printed)

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const BASE = process.env.NUCLEUS_BASE || "https://nucleus-woad.vercel.app";
const ACCOUNTS_FILE = "/home/codex/Projects/nucleus/.secrets/demo-accounts.txt";
const SUPABASE_ENV = "/home/codex/Projects/nucleus/.secrets/supabase.env";

// ── Forbidden owner guard ────────────────────────────────────────────────────────
const FORBIDDEN_OWNER = "b01c311e-bd28-4e43-ab1e-d6825bfeb929";

// ── Read admin credentials ────────────────────────────────────────────────────────
function readAdmin() {
  const raw = readFileSync(ACCOUNTS_FILE, "utf8");
  const lines = raw.split(/\r?\n/);
  let inAdmin = false;
  const cred = {};
  for (const line of lines) {
    if (/^ADMIN/i.test(line)) { inAdmin = true; continue; }
    if (inAdmin && /^[A-Z]/i.test(line.trim()) && !/^\s/.test(line)) { inAdmin = false; }
    if (!inAdmin) continue;
    const m = line.match(/^\s*(email|password)\s*:\s*(.+?)\s*$/i);
    if (m) cred[m[1].toLowerCase()] = m[2];
  }
  if (!cred.email || !cred.password) throw new Error("could not parse admin credentials");
  return cred;
}

// ── Read supabase.env ─────────────────────────────────────────────────────────────
function readSupabaseEnv() {
  const raw = readFileSync(SUPABASE_ENV, "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*"?(.+?)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

// ── psql helper ───────────────────────────────────────────────────────────────────
function psql(sql) {
  const script =
    `set -a; . "${SUPABASE_ENV}"; set +a; ` +
    `PGPASSWORD="$SUPABASE_DB_PASSWORD" psql ` +
    `"host=db.\${SUPABASE_PROJECT_REF}.supabase.co port=5432 dbname=postgres user=postgres sslmode=require" ` +
    `-tAc "$NUCLEUS_SQL"`;
  const res = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, NUCLEUS_SQL: sql },
  });
  if (res.status !== 0) throw new Error(`psql failed: ${(res.stderr || res.stdout || "").slice(0, 300)}`);
  return (res.stdout || "").trim();
}

async function main() {
  const admin = readAdmin();

  // Build a Supabase client with the admin's session for authenticated API calls.
  const sbEnv = readSupabaseEnv();
  const supabase = createClient(
    `https://${sbEnv.SUPABASE_PROJECT_REF}.supabase.co`,
    sbEnv.SUPABASE_ANON_KEY ?? sbEnv.SUPABASE_PUBLISHABLE_KEY ?? "",
    { auth: { persistSession: false } }
  );

  // Sign in to get a session.
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: admin.email,
    password: admin.password,
  });
  if (authError || !authData?.session) {
    throw new Error(`auth failed: ${authError?.message ?? "no session"}`);
  }
  const accessToken = authData.session.access_token;
  const userId = authData.user.id;

  // ⛔ HARD GUARD: never seed the real client's account.
  if (userId === FORBIDDEN_OWNER) {
    throw new Error(
      `ABORTED — detected real client owner (${FORBIDDEN_OWNER}). This seed must never run on the client's account.`
    );
  }
  console.log(`[seed] authenticated as ${admin.email} (${userId})`);

  // ── Helper: GET /api/spaces with the session cookie ──────────────────────────
  async function apiFetch(path, opts = {}) {
    const r = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: {
        ...(opts.headers ?? {}),
        // Pass the Supabase access token as a cookie value — the middleware reads it.
        cookie: `sb-access-token=${accessToken}; sb-refresh-token=${authData.session.refresh_token}`,
      },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }

  // ── Fetch existing spaces ─────────────────────────────────────────────────────
  const { body: listBody } = await apiFetch("/api/spaces");
  const existing = listBody.spaces ?? [];
  const existingNames = new Set(existing.map((s) => s.name));
  console.log(`[seed] existing spaces: ${existing.length > 0 ? existing.map((s) => s.name).join(", ") : "(none)"}`);

  // ── Desired demo spaces ────────────────────────────────────────────────────────
  const DEMO_SPACES = ["Finance", "Contracts", "HR"];
  const created = [];
  const skipped = [];

  for (const name of DEMO_SPACES) {
    if (existingNames.has(name)) {
      skipped.push(name);
      console.log(`[seed] SKIP "${name}" — already exists`);
      continue;
    }
    const { status, body } = await apiFetch("/api/spaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (status === 200 || status === 201) {
      created.push({ name, id: body.space?.id });
      console.log(`[seed] CREATED "${name}" id=${body.space?.id}`);
    } else {
      console.error(`[seed] FAILED to create "${name}": status=${status} body=${JSON.stringify(body)}`);
      process.exitCode = 1;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────────
  console.log(`\n[seed] done — ${created.length} created, ${skipped.length} skipped (already existed)`);
  if (created.length > 0) {
    console.log("[seed] created:");
    for (const s of created) console.log(`  • "${s.name}" (${s.id})`);
  }
  if (skipped.length > 0) {
    console.log("[seed] skipped:", skipped.join(", "));
  }

  // Sign out — no lingering session.
  await supabase.auth.signOut().catch(() => {});
}

main().catch((e) => {
  console.error(`[seed] ERROR: ${e.message}`);
  process.exit(1);
});
