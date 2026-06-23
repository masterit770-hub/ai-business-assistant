// SETTINGS COLD-START DURABILITY eval — the ratchet that generalizes the durability
// family to the SETTINGS/PROMPTS persisted-state class (the class cold-start-durability.mjs
// did NOT cover: it guards uploaded docs + structured rows only).
//
// THE LESSON (why this exists): a user's saved system_prompt + per-user model config are
// persisted state, exactly like an uploaded doc or a structured row. If they only lived in
// the in-memory mem() fallback (no owner dimension), a serverless COLD START would lose them
// AND they would leak across users — the same failure shape as the vanished-spreadsheet bug.
// The per-user-settings eval ran fine yet would have FALSE-PASSED that bug, because the
// in-memory fallback has no owner column: A and B writing the same key just clobber one
// global slot, so isolation "passes" without proving anything durable.
//
// So this eval is deliberately FAIL-CLOSED on the real path:
//   • it ABORTS (not skips) if supabaseEnabled() is false — a meaningless run is worse than
//     no run; the whole point is to exercise the REAL (owner_id,key) upsert, NEVER mem();
//   • it reads the engine_settings ROW DIRECTLY from Supabase after the save, proving the
//     write hit the durable per-user table (not the in-memory map);
//   • it then SIMULATES A COLD START by wiping ALL in-memory engine state — the runtime
//     store, the SQL handles, AND globalThis.__nucleusSettings (the settings mem cache) —
//     reproducing a fresh serverless instance with empty memory;
//   • after the wipe it RE-READS via the real engine read path (getSetting/getSettings under
//     the owner context, what /api/me and /api/settings call) and asserts the saved prompt +
//     model config SURVIVED for the owner, the SHARED default is untouched, and a different
//     owner sees NONE of it (isolation holds across the cold start).
//
// Covers BOTH a prompt setting AND a model-config setting (model_mode + cloud_provider),
// since the client's per-user state is "prompt + model config (cloud/Azure/local/keys)".
//
// RUN:  node tests/evals/settings-durability.mjs
//   Creates throwaway REAL auth users (engine_settings.owner_id FKs auth.users), and DELETES
//   them at the end (CASCADE clears their rows). SKIPS LOUDLY (exit 0) only when Supabase env
//   is entirely absent — once configured it ABORTS rather than silently testing mem().
// SECURITY: reads .env.local / .secrets/supabase.env to set process.env; NEVER prints, echoes,
// logs, or commits any secret value. It only writes throwaway non-secret config values.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

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

function skip(msg) {
  console.log("\n" + "═".repeat(72));
  console.log("⏭  SKIPPED — settings-durability eval did NOT run (this is NOT a pass).");
  console.log("   " + msg);
  console.log("═".repeat(72));
  process.exit(0);
}
if (!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  skip("Supabase URL + SERVICE_ROLE_KEY not found — the DURABLE per-user settings path can't be exercised. (mem() fallback would NOT prove durability/isolation.)");
}

const results = [];
const check = (id, desc, ok, detail = "") => {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
};

const { getSetting, setSetting, getSettings, getModelMode } = await import(ROOT + "/src/lib/engine/settings.ts");
const { runWithOwner } = await import(ROOT + "/src/lib/engine/request-context.ts");
const { supabaseEnabled, admin } = await import(ROOT + "/src/lib/engine/supabase.ts");
const { __resetRuntimeStoreForTests } = await import(ROOT + "/src/lib/engine/runtime-store.ts");
const { resetStore } = await import(ROOT + "/src/lib/engine/structured-store.ts");

// Simulate a serverless COLD START: wipe EVERY in-memory engine cache so the next read can
// only succeed via the DURABLE Supabase path. Crucially this clears globalThis.__nucleusSettings
// — the settings mem() fallback — so if a save had (wrongly) only gone to memory, the read-back
// below would now MISS and the durability assertions would FAIL (no false-green via mem).
function coldStart() {
  __resetRuntimeStoreForTests();
  resetStore();
  // The settings in-memory fallback map lives on globalThis; clearing it reproduces the
  // empty-memory state of a fresh instance for the settings module specifically.
  // eslint-disable-next-line no-undef
  delete globalThis.__nucleusSettings;
}

async function newOwner(tag) {
  const { data, error } = await admin().auth.admin.createUser({
    email: `settingsdur-${tag}-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`,
    password: crypto.randomUUID(),
    email_confirm: true,
  });
  if (error || !data?.user?.id) throw new Error(`createUser failed: ${error?.message ?? "no id"}`);
  return data.user.id;
}

// Read the raw engine_settings ROW for (owner,key) straight from Supabase — proof the save
// hit the DURABLE per-user table, not the in-memory map.
async function rawRow(owner, key) {
  const { data } = await admin()
    .from("engine_settings")
    .select("value")
    .eq("owner_id", owner)
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? null;
}

let A = null, B = null;
async function main() {
  check("ENV/supabase", "the engine sees Supabase as configured — the REAL (owner_id,key) upsert path is live (NOT mem())", supabaseEnabled());
  if (!supabaseEnabled()) throw new Error("supabaseEnabled() is false despite env — aborting (a mem()-fallback run proves nothing).");

  A = await newOwner("a");
  B = await newOwner("b"); // sets nothing → must see the shared default after the cold start, never A's
  console.log(`\n▶ SETTINGS COLD-START DURABILITY — owner A=${A.slice(0, 8)} , isolation control B=${B.slice(0, 8)}`);

  // The shared (NULL-owner) baselines — what B (and any un-customized user) must see.
  const sharedPrompt = await runWithOwner(undefined, () => getSetting("system_prompt"));
  const sharedMode = await runWithOwner(undefined, () => getModelMode());
  // A's model mode must DIFFER from the shared default so "A's mode survived" is distinguishable
  // from "inherited the default".
  const aMode = sharedMode === "local" ? "cloud" : "local";

  // A custom prompt that is NOT any default — a read-back returning it can only mean the
  // SAVE persisted (not a fallback to the built-in/shared default).
  const PROMPT_A = `Durable persona for A [${crypto.randomUUID().slice(0, 8)}]`;

  // ── 1. SAVE A's prompt + model config via the REAL per-user path ──────────────────
  console.log("\n· Saving A's prompt + model config (model_mode + cloud_provider) via the real per-user upsert …");
  await runWithOwner(A, async () => {
    await setSetting("system_prompt", PROMPT_A);
    await setSetting("model_mode", aMode);
    await setSetting("cloud_provider", "openai"); // a model-config value, the per-user class
  });

  // PROOF the write hit the DURABLE table (not mem): the raw Supabase row exists with A's value.
  const rowPrompt = await rawRow(A, "system_prompt");
  const rowMode = await rawRow(A, "model_mode");
  check("DURABLE/row-written", "A's system_prompt row exists in the engine_settings TABLE (durable upsert, not mem())",
    rowPrompt === PROMPT_A, `db row="${(rowPrompt || "").slice(0, 40)}…"`);
  check("DURABLE/mode-row-written", "A's model_mode row exists in the durable table too (model config persists per-user)",
    rowMode === aMode, `db row=${rowMode}`);

  // ── 2. SIMULATE A SERVERLESS COLD START — wipe ALL in-memory engine state ─────────
  console.log("\n· Simulating a serverless COLD START (clearing runtime store + SQL handles + the settings mem() cache) …");
  coldStart();

  // ── 3. THE FIX — after the cold start, A's saved state SURVIVES via the durable read ─
  console.log("\n· Re-reading A's settings via the real engine read path (what /api/me + /api/settings call) …");
  const promptBack = await runWithOwner(A, () => getSetting("system_prompt"));
  const modeBack = await runWithOwner(A, () => getModelMode());
  const settingsBack = await runWithOwner(A, () => getSettings());
  check("DURABLE/prompt-survives", "A's saved PROMPT survives the cold start (durable Supabase read, mem was wiped)",
    promptBack === PROMPT_A, `got="${(promptBack || "").slice(0, 40)}…"`);
  check("DURABLE/mode-survives", `A's saved MODEL MODE '${aMode}' survives the cold start`,
    modeBack === aMode, `got=${modeBack}`);
  check("DURABLE/config-survives", "A's cloud_provider model config survives the cold start (via getSettings)",
    settingsBack.cloud_provider === "openai", `got=${settingsBack.cloud_provider}`);

  // ── 4. ISOLATION ACROSS THE COLD START — B sees the shared default, never A's ──────
  console.log("\n· Isolation across the cold start: B (no custom settings) must see the SHARED default, never A's …");
  const bPrompt = await runWithOwner(B, () => getSetting("system_prompt"));
  const bMode = await runWithOwner(B, () => getModelMode());
  check("ISO/b-default-prompt", "B reads the SHARED default prompt (not A's durable value)",
    bPrompt === sharedPrompt && bPrompt !== PROMPT_A, `bMatchesShared=${bPrompt === sharedPrompt}`);
  check("ISO/b-default-mode", `B reads the SHARED default mode '${sharedMode}' (not A's '${aMode}')`,
    bMode === sharedMode && bMode !== aMode, `got=${bMode}`);

  // ── 5. The SHARED default row is UNTOUCHED by A's per-user writes (no clobber) ─────
  const sharedAfter = await runWithOwner(undefined, () => getSetting("system_prompt"));
  const sharedModeAfter = await runWithOwner(undefined, () => getModelMode());
  check("SHARED/intact", "the shared (NULL-owner) default prompt is unchanged after A's per-user write + cold start",
    sharedAfter === sharedPrompt, `before="${(sharedPrompt || "").slice(0, 20)}" after="${(sharedAfter || "").slice(0, 20)}"`);
  check("SHARED/mode-intact", "the shared model_mode default is unchanged after A's per-user write + cold start",
    sharedModeAfter === sharedMode, `before=${sharedMode} after=${sharedModeAfter}`);
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
console.log(`SETTINGS COLD-START DURABILITY: ${results.length - fails.length}/${results.length} passed` + (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN"));
process.exit(fails.length || runErr ? 1 : 0);
