// PER-USER SETTINGS isolation eval — proves each user's prompt + model config is THEIR
// OWN, not the shared workspace setting and not another user's.
//
// Client decision: every user sets their own system prompt + model mode + cloud/Azure/
// local config (own keys); only managing users stays admin-only. The engine reads these
// per-request via the ALS owner (request-context.runWithOwner). This eval drives the REAL
// settings module under two owner contexts and asserts isolation + the shared-default
// fallback, then deletes its throwaway rows/users.
//
// RUN: node tests/evals/per-user-settings.mjs   (skips loudly if Supabase isn't configured)
// SECURITY: reads local secret files to set process.env; NEVER prints a secret value.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { skip as skipShared } from "./_skip.mjs";
import { assertCleanBefore, assertCleanAfter, settleOwner } from "./_residue-guard.mjs";

const ROOT = "/home/codex/Projects/nucleus";
const WANT = new Set(["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
function loadEnv(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    if (i < 0) continue;
    const k = l.slice(0, i).trim();
    if (!WANT.has(k)) continue;
    let v = l.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}
loadEnv(".env.local");
loadEnv(".secrets/supabase.env");
if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

// Exit code is honest under CI_STRICT/REQUIRE_CREDS: a creds-skip in CI is a FAILURE
// (exit 1), never a silent pass. The loud "NOT a pass" banner prints in either mode. See _skip.mjs.
if (!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  skipShared("per-user-settings", "Supabase not configured; per-user settings durability can't be exercised.");
}

const results = [];
const check = (id, desc, ok, detail = "") => {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
};

const { getSetting, setSetting, getSettings, getModelMode } = await import(ROOT + "/src/lib/engine/settings.ts");
const { runWithOwner } = await import(ROOT + "/src/lib/engine/request-context.ts");
const { admin } = await import(ROOT + "/src/lib/engine/supabase.ts");

async function newOwner(tag) {
  const { data, error } = await admin().auth.admin.createUser({
    email: `settings-${tag}-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`,
    password: crypto.randomUUID(),
    email_confirm: true,
  });
  if (error || !data?.user?.id) throw new Error(`createUser failed: ${error?.message ?? "no id"}`);
  return settleOwner(data.user.id);
}

let A = null, B = null, C = null;
async function main() {
  A = await newOwner("a");
  B = await newOwner("b");
  C = await newOwner("c"); // sets nothing → must see the shared default
  console.log(`\n▶ PER-USER SETTINGS — A=${A.slice(0, 8)} B=${B.slice(0, 8)} C=${C.slice(0, 8)} (C customizes nothing)`);

  // The shared (NULL-owner) defaults — what C (and any un-customized user) must see.
  const sharedDefault = await runWithOwner(undefined, () => getSetting("system_prompt"));
  const sharedMode = await runWithOwner(undefined, () => getModelMode());
  // A sets a mode that DIFFERS from the shared default, so "A's mode" is distinguishable
  // from "inheriting the default" (otherwise the test couldn't tell isolation from fallback).
  const aMode_set = sharedMode === "local" ? "cloud" : "local";

  // A and B each set their OWN prompt + model mode under their own owner context.
  await runWithOwner(A, async () => {
    await setSetting("system_prompt", "PROMPT_FROM_A");
    await setSetting("model_mode", aMode_set);
  });
  await runWithOwner(B, async () => {
    await setSetting("system_prompt", "PROMPT_FROM_B");
    // B leaves model_mode alone → must fall back to the shared default, NOT A's "local".
  });

  // ── Isolation: each owner reads their OWN prompt ──────────────────────────────────
  const aPrompt = await runWithOwner(A, () => getSetting("system_prompt"));
  const bPrompt = await runWithOwner(B, () => getSetting("system_prompt"));
  check("ISO/a-own", "owner A reads A's prompt", aPrompt === "PROMPT_FROM_A", `got="${aPrompt.slice(0, 30)}"`);
  check("ISO/b-own", "owner B reads B's prompt (NOT A's)", bPrompt === "PROMPT_FROM_B", `got="${bPrompt.slice(0, 30)}"`);
  check("ISO/no-cross", "A and B prompts differ (no cross-leak)", aPrompt !== bPrompt);

  // ── Model mode: A's own mode must not leak to B; B inherits the shared default ─────
  const aMode = await runWithOwner(A, () => getModelMode());
  const bMode = await runWithOwner(B, () => getModelMode());
  check("ISO/a-mode", `owner A's model mode is their own '${aMode_set}'`, aMode === aMode_set, `got=${aMode}`);
  check("ISO/b-mode-default", `owner B's model mode is the SHARED default '${sharedMode}' (not A's '${aMode_set}')`,
    bMode === sharedMode && bMode !== aMode_set, `got=${bMode}`);
  // The shared (NULL-owner) model_mode row must be UNCHANGED by A's per-user write.
  const sharedModeAfter = await runWithOwner(undefined, () => getModelMode());
  check("FALLBACK/shared-mode-intact", "the shared model_mode default is unchanged after A's per-user write",
    sharedModeAfter === sharedMode, `before=${sharedMode} after=${sharedModeAfter}`);

  // ── Fallback: C set nothing → sees the shared workspace default, never A's/B's ─────
  const cPrompt = await runWithOwner(C, () => getSetting("system_prompt"));
  check("FALLBACK/c-default", "owner C (no custom setting) reads the SHARED default prompt",
    cPrompt === sharedDefault && cPrompt !== "PROMPT_FROM_A" && cPrompt !== "PROMPT_FROM_B",
    `cMatchesShared=${cPrompt === sharedDefault}`);

  // ── The shared default row was NOT clobbered by A/B writing their own rows ─────────
  const sharedAfter = await runWithOwner(undefined, () => getSetting("system_prompt"));
  check("FALLBACK/shared-intact", "the shared (NULL-owner) default prompt is unchanged after per-user writes",
    sharedAfter === sharedDefault);

  // ── getSettings (the API view) reflects the caller's own values ───────────────────
  const aSettings = await runWithOwner(A, () => getSettings());
  check("API/getSettings-own", "getSettings() returns A's own prompt + mode under A's context",
    aSettings.system_prompt === "PROMPT_FROM_A" && aSettings.model_mode === aMode_set,
    `prompt="${(aSettings.system_prompt || "").slice(0, 20)}" mode=${aSettings.model_mode}`);
}

async function cleanup() {
  // Deleting the throwaway users cascades (engine_settings.owner_id ON DELETE CASCADE),
  // removing every per-user row this eval wrote. Verify none remain.
  let deleted = 0;
  for (const id of [A, B, C]) {
    if (!id) continue;
    try { const { error } = await admin().auth.admin.deleteUser(id); if (!error) deleted++; } catch { /* noop */ }
  }
  let residue = -1;
  try {
    const { count } = await admin()
      .from("engine_settings")
      .select("key", { count: "exact", head: true })
      .in("owner_id", [A, B, C].filter(Boolean));
    residue = count ?? 0;
  } catch { /* noop */ }
  console.log(`\n↩ cleanup: deleted ${deleted}/3 throwaway users; per-user setting rows remaining: ${residue}`);
  check("CLEANUP/clean", "throwaway users + their per-user setting rows removed (no residue)",
    deleted === 3 && residue === 0, `deleted=${deleted} residue=${residue}`);
}

// RESIDUE GUARD (#79): refuse to run over a DB a prior leaked run left dirty (a polluted
// catalog produces a FALSE GREEN); abort loudly. Asserts 0 throwaway orphan rows BEFORE the run.
await assertCleanBefore("per-user-settings");
let runErr = null;
try { await main(); } catch (e) { runErr = e; console.error("\nEVAL ERROR:", e instanceof Error ? e.stack : e); }
finally { await cleanup(); }
// RESIDUE GUARD (#79): this run must leave 0 throwaway residue — fail loudly if its cleanup leaked.
await assertCleanAfter("per-user-settings");

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(`PER-USER SETTINGS: ${results.length - fails.length}/${results.length} passed` + (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN"));
process.exit(fails.length || runErr ? 1 : 0);
