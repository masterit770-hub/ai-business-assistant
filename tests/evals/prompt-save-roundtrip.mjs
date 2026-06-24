// PROMPT-SAVE ROUND-TRIP eval — the REAL-PATH durability journey for the client report
// "changing the prompt doesn't get saved".
//
// WHAT WAS MISSING (why this exists): there was no end-to-end test that SAVED a prompt the
// way the UI does, then RE-READ it the way the UI does after a reload, and asserted the new
// value survives. The schema was fine (migration 013: engine_settings.owner_id + the
// (owner_id,key) unique index) and DB-level saves persisted — but nothing exercised the
// SAVE → reload → READ-BACK loop the user actually performs, so a regression in that loop
// (e.g. the silent-failure UI that showed a fake "Saved", or a read-back that returned the
// shared default instead of the user's saved value) would not have been caught.
//
// This eval drives the SAME engine modules the live routes use, under the SAME per-request
// owner context the routes establish (runWithOwner(user.id, ...)):
//   • The Answer Setup strip / Settings → Prompts panel SAVE via PUT /api/settings, which
//     runs `runWithOwner(user.id, () => setSetting("system_prompt", value))`.
//   • A reload READS BACK via GET /api/me → `runWithOwner(user.id, () => getSetting(...))`
//     AND GET /api/settings → `runWithOwner(user.id, () => getSettings())`.
// So this models PUT → full reload → both read-back endpoints, on the REAL Supabase path,
// and adds per-user isolation: user A's saved prompt is NOT visible to user B, and merely
// READING as B does not overwrite A's stored value.
//
// REAL-PATH DISCIPLINE: it creates throwaway REAL auth users (engine_settings.owner_id FKs
// auth.users), exercises supabaseEnabled()===true (the real (owner_id,key) upsert, NOT the
// in-memory mem() fallback — that fallback has no owner dimension and is what made the
// per-user behaviour false-pass), and DELETES the users at the end (CASCADE clears their
// rows). It SKIPS LOUDLY (exit 0) if Supabase isn't configured — never a false-green.
//
// RUN:  node tests/evals/prompt-save-roundtrip.mjs
// SECURITY: reads .env.local / .secrets/supabase.env to set process.env; NEVER prints,
// echoes, logs, or commits any secret value.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { skip as skipShared } from "./_skip.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const WANT = new Set(["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
function loadEnvFile(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!WANT.has(key)) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] == null || process.env[key] === "") process.env[key] = val;
  }
}
loadEnvFile(".env.local");
loadEnvFile(".secrets/supabase.env");
if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
}

// Exit code is honest under CI_STRICT/REQUIRE_CREDS: a creds-skip in CI is a FAILURE
// (exit 1), never a silent pass. The loud "NOT a pass" banner prints in either mode. See _skip.mjs.
const skip = (msg) => skipShared("prompt-save-roundtrip", msg);
if (!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  skip("Supabase URL + SERVICE_ROLE_KEY not found — the durable per-user save path can't be exercised.");
}

const results = [];
const check = (id, desc, ok, detail = "") => {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
};

const { getSetting, setSetting, getSettings } = await import(ROOT + "/src/lib/engine/settings.ts");
const { runWithOwner } = await import(ROOT + "/src/lib/engine/request-context.ts");
const { supabaseEnabled, admin } = await import(ROOT + "/src/lib/engine/supabase.ts");

// Model the route layer EXACTLY: the live PUT /api/settings handler does
// `runWithOwner(user.id, () => setSetting("system_prompt", value))`; GET /api/me does
// `runWithOwner(user.id, () => getSetting("system_prompt"))`; GET /api/settings does
// `runWithOwner(user.id, () => getSettings())`. These wrappers ARE that flow.
const savePromptAs = (uid, value) => runWithOwner(uid, () => setSetting("system_prompt", value));
const readMeAs = (uid) => runWithOwner(uid, () => getSetting("system_prompt")); // /api/me
const readSettingsAs = (uid) => runWithOwner(uid, () => getSettings()); // /api/settings (Prompts panel)

async function newOwner(tag) {
  const { data, error } = await admin().auth.admin.createUser({
    email: `promptsave-${tag}-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`,
    password: crypto.randomUUID(),
    email_confirm: true,
  });
  if (error || !data?.user?.id) throw new Error(`createUser failed: ${error?.message ?? "no id"}`);
  return data.user.id;
}

let A = null, B = null;
async function main() {
  check("ENV/supabase", "the engine sees Supabase as configured (durable per-user save path is live)", supabaseEnabled());
  if (!supabaseEnabled()) throw new Error("supabaseEnabled() is false despite env — aborting to avoid a meaningless run");

  A = await newOwner("a");
  B = await newOwner("b");
  console.log(`\n▶ PROMPT-SAVE ROUND-TRIP — A=${A.slice(0, 8)} B=${B.slice(0, 8)} (real Supabase path)`);

  // ── 1. SAVE → FULL RELOAD → READ-BACK (the Answer Setup strip flow) ───────────────
  // A custom prompt that is NOT any default/preset, so a read-back returning it can only
  // mean the SAVE persisted (not a fallback to the shared/built-in default).
  const PROMPT_A = `You are Jenny's expert legal assistant. Answer like a senior lawyer. [${crypto.randomUUID().slice(0, 8)}]`;
  console.log("\n· Save A's prompt via the PUT path, then re-read via BOTH read-back endpoints (a 'full reload') …");
  await savePromptAs(A, PROMPT_A);

  // The read-back must come from a FRESH read (no warm in-memory carry) — getSetting/getSettings
  // both hit Supabase per call, so each of these is the post-reload server read.
  const meBack = await readMeAs(A); // what /api/me returns → the Answer Setup strip's initial value
  const settingsBack = (await readSettingsAs(A)).system_prompt; // what /api/settings returns → the Prompts panel

  check("ROUNDTRIP/me", "after save + reload, GET /api/me returns A's NEW prompt (not the old/default)",
    meBack === PROMPT_A, `got="${(meBack || "").slice(0, 40)}…"`);
  check("ROUNDTRIP/settings", "after save + reload, GET /api/settings returns A's NEW prompt",
    settingsBack === PROMPT_A, `got="${(settingsBack || "").slice(0, 40)}…"`);

  // ── 2. A SECOND save OVERWRITES (an edit must replace, not append/ignore) ──────────
  const PROMPT_A2 = `Updated persona — concise and warm. [${crypto.randomUUID().slice(0, 8)}]`;
  console.log("\n· Edit A's prompt again (a second save) → the newer value must win on reload …");
  await savePromptAs(A, PROMPT_A2);
  const meBack2 = await readMeAs(A);
  check("ROUNDTRIP/overwrite", "a SECOND save overwrites — reload shows the newest prompt, not the first",
    meBack2 === PROMPT_A2 && meBack2 !== PROMPT_A, `got="${(meBack2 || "").slice(0, 40)}…"`);

  // ── 3. Settings → Prompts panel (the SEPARATE Save) round-trips the same way ───────
  // The Prompts panel saves system_prompt + urgency_prompt together; prove its save also
  // persists per-user and reads back. (Same store, separate UI Save button — both must work.)
  const PROMPT_A3 = `Prompts-panel persona [${crypto.randomUUID().slice(0, 8)}]`;
  await savePromptAs(A, PROMPT_A3); // the panel PUTs system_prompt the same way
  const panelBack = (await readSettingsAs(A)).system_prompt;
  check("ROUNDTRIP/prompts-panel", "the Settings → Prompts panel save also round-trips on reload",
    panelBack === PROMPT_A3, `got="${(panelBack || "").slice(0, 40)}…"`);

  // ── 4. PER-USER ISOLATION — B does not see A's prompt ─────────────────────────────
  console.log("\n· Per-user isolation: B must NOT see A's saved prompt …");
  const PROMPT_B = `B's own persona [${crypto.randomUUID().slice(0, 8)}]`;
  await savePromptAs(B, PROMPT_B);
  const bBack = await readMeAs(B);
  const aBack = await readMeAs(A);
  check("ISO/b-own", "B reads B's OWN saved prompt (not A's, not the default)",
    bBack === PROMPT_B, `got="${(bBack || "").slice(0, 40)}…"`);
  check("ISO/a-unchanged", "A's prompt is UNCHANGED by B's save (no cross-write)",
    aBack === PROMPT_A3, `A now="${(aBack || "").slice(0, 40)}…"`);
  check("ISO/distinct", "A and B hold DISTINCT prompts (no leak between users)", aBack !== bBack);

  // ── 5. READING as B does not OVERWRITE A (the read path is side-effect-free) ───────
  // A read under B's context must never write A's row. We snapshot A, do several reads as
  // B (and as A), and assert A's stored value is byte-identical afterwards.
  console.log("\n· A read as B must NOT mutate A's stored prompt (read is side-effect-free) …");
  const aBefore = await readMeAs(A);
  for (let i = 0; i < 3; i++) {
    await readMeAs(B);
    await readSettingsAs(B);
  }
  const aAfter = await readMeAs(A);
  check("ISO/read-no-overwrite", "reading as B (repeatedly) did NOT overwrite A's stored prompt",
    aAfter === aBefore && aAfter === PROMPT_A3, `before="${(aBefore || "").slice(0, 30)}" after="${(aAfter || "").slice(0, 30)}"`);
}

async function cleanup() {
  let usersDeleted = 0, residue = -1;
  for (const id of [A, B]) {
    if (!id) continue;
    try { const { error } = await admin().auth.admin.deleteUser(id); if (!error) usersDeleted++; } catch { /* noop */ }
  }
  try {
    const { count } = await admin()
      .from("engine_settings")
      .select("key", { count: "exact", head: true })
      .in("owner_id", [A, B].filter(Boolean));
    residue = count ?? 0;
  } catch { /* noop */ }
  console.log(`\n↩ cleanup: deleted ${usersDeleted}/2 throwaway users; per-user setting rows remaining: ${residue}`);
  check("CLEANUP/clean", "throwaway users + their per-user setting rows removed (no residue)",
    usersDeleted === 2 && residue === 0, `deleted=${usersDeleted} residue=${residue}`);
}

let runErr = null;
try { await main(); } catch (e) { runErr = e; console.error("\nEVAL ERROR:", e instanceof Error ? e.stack : e); }
finally { await cleanup(); }

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(`PROMPT-SAVE ROUND-TRIP: ${results.length - fails.length}/${results.length} passed` + (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN"));
process.exit(fails.length || runErr ? 1 : 0);
