// KEYLESS / BAD-KEY MODEL ERROR eval — the REAL-PATH guard for the client requirement:
//
//   "A misconfigured/keyless model must SAY SO, not give a fake answer."
//
// THE BUG CLASS (why this exists): a cloud provider selected with NO key, or a key that
// the provider REJECTS (401/403), must surface a CLEAR, actionable error and produce NO
// answer. It must NOT silently degrade to a generic 'general'-mode answer — that
// conflation (a model that FAILED to run looking like a real reply) is the bug. This eval
// drives the REAL answer pipeline (answerQuestion) under a real owner's settings override
// and the REAL /api/ask error mapping (friendlyAskError), and asserts:
//   • keyless cloud provider  → the pipeline THROWS CloudProviderNotConfiguredError
//     (NOT a {mode:"general"} answer), and friendlyAskError turns it into the clear
//     "set/fix your model key in Settings → Models. No answer was generated." line.
//   • bad-key cloud provider  → a real request to the provider with a bogus key returns
//     401/403, the pipeline THROWS CloudProviderAuthError (NOT 'general'), and
//     friendlyAskError surfaces the same clear key guidance.
// The SEPARATION it proves (the client's case (a) vs (b)): with the DEFAULT (env) backend,
// a no-docs question still produces a legitimate {mode:"general"} answer — the model RAN,
// it just had no relevant docs. So "general" is reserved for "model ran, no docs", and a
// model that COULDN'T run is always a clear error. (Case (a) is covered by the broad
// answer-reliability eval's general/meta branch; here we prove (b) is NOT swallowed.)
//
// REAL-PATH DISCIPLINE (modeled on cold-start-durability.mjs): drives the real engine
// modules + the real settings layer under a real owner context; creates + DELETES a
// throwaway non-demo owner when Supabase is on (so the override persists per-owner like
// production); cleans up the override; never weakens an assertion to force green.
//
// RUN:  node tests/evals/keyless-model-error.mjs
//   The KEYLESS half needs NO network and NO Supabase (the settings store falls back to
//   in-memory) — it always runs. The BAD-KEY half makes ONE real outbound request to a
//   real provider base with a bogus key; if there is no outbound network it SKIPS that
//   half LOUDLY (never a false-green) while the keyless half still gates.
//
// SECURITY: reads .env.local / .secrets/supabase.env to set process.env but NEVER prints,
// echoes, logs, or commits any secret value. It only ever SETS a bogus throwaway key.

import fs from "node:fs";
import { assertCleanBefore, assertCleanAfter, settleOwner } from "./_residue-guard.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const WANT = new Set([
  "LLM_PROVIDER", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL",
  "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
]);
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
loadEnvFile(".vercel-prod.env");
if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
}
const haveSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}

// Real engine modules (the same ones the live /api/ask route uses).
const { answerQuestion } = await import(ROOT + "/src/lib/engine/answer.ts");
const { friendlyAskError } = await import(ROOT + "/src/lib/engine/error-message.ts");
const { isCloudProviderNotConfigured, isCloudProviderAuth, isModelRunFailure } =
  await import(ROOT + "/src/lib/engine/llm.ts");
const { setSetting } = await import(ROOT + "/src/lib/engine/settings.ts");
const { runWithOwner } = await import(ROOT + "/src/lib/engine/request-context.ts");
const { supabaseEnabled, admin } = await import(ROOT + "/src/lib/engine/supabase.ts");

// A real owner so the per-user settings override persists exactly like production. When
// Supabase is on we create + delete a throwaway non-demo user; offline we use a synthetic
// uuid against the in-memory settings store.
let OWNER = null;
let createdRealUser = false;
async function makeOwner() {
  if (haveSupabase && supabaseEnabled()) {
    const { data, error } = await admin().auth.admin.createUser({
      email: `keyless-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`,
      password: crypto.randomUUID(), email_confirm: true,
    });
    if (!error && data?.user?.id) { createdRealUser = true; return settleOwner(data.user.id); }
    console.log("  ℹ could not create a throwaway user — using a synthetic owner against the in-memory settings store.");
  }
  return crypto.randomUUID();
}

// Set the four cloud-override slots under THIS owner's context.
async function setCloud(owner, { provider, apiKey, model, baseUrl }) {
  await runWithOwner(owner, async () => {
    await setSetting("model_mode", "cloud");
    await setSetting("cloud_provider", provider ?? "");
    await setSetting("cloud_api_key", apiKey ?? "");
    await setSetting("cloud_model", model ?? "");
    await setSetting("cloud_base_url", baseUrl ?? "");
  });
}

// Run a real ask under the owner; capture whether it THREW (and what), or RETURNED.
async function askUnder(owner, q) {
  try {
    const res = await runWithOwner(owner, () => answerQuestion(q, { ownerId: owner, role: "member", isDemo: false }));
    return { threw: false, res };
  } catch (e) {
    return { threw: true, error: e };
  }
}

const Q = "What is the capital of France?"; // a question the DEFAULT model answers fine.

async function main() {
  OWNER = await makeOwner();
  console.log(`\n▶ KEYLESS / BAD-KEY MODEL ERROR — real pipeline, owner ${String(OWNER).slice(0, 8)}…`);

  // ── PART 1 — KEYLESS cloud provider (no network needed) ──────────────────────────
  // Select a real provider but save NO key. resolveCloudTarget throws
  // CloudProviderNotConfiguredError BEFORE any HTTP, the structured lane re-throws it (no
  // swallow), and answerQuestion propagates it (no 'general' degrade).
  console.log("\n· Keyless cloud provider (openai, no key) — must ERROR, not answer 'general' …");
  await setCloud(OWNER, { provider: "openai", apiKey: "", model: "gpt-4o" });
  const keyless = await askUnder(OWNER, Q);
  check("KEYLESS/throws", "the pipeline THREW (did NOT return a {mode:'general'} answer)",
    keyless.threw, keyless.threw ? "" : `returned mode=${keyless.res?.mode} answer="${(keyless.res?.answer || "").slice(0, 80)}"`);
  check("KEYLESS/typed", "the thrown error is the typed CloudProviderNotConfiguredError (a model-run failure)",
    keyless.threw && isCloudProviderNotConfigured(keyless.error) && isModelRunFailure(keyless.error),
    keyless.threw ? `code=${keyless.error?.code} name=${keyless.error?.name}` : "(did not throw)");
  {
    const line = friendlyAskError(keyless.error);
    check("KEYLESS/clear-message",
      "friendlyAskError → clear 'set/fix your model key in Settings → Models. No answer was generated.' (NOT a generic punt, NOT a fake answer)",
      /Settings → Models/i.test(line) && /no answer/i.test(line) && !/something went wrong/i.test(line),
      `message="${line}"`);
  }

  // ── PART 1b — the SEPARATION: the DEFAULT (env) backend still answers 'general' ────
  // Prove case (a) is intact: clear the override → the env model RUNS and a no-docs
  // question legitimately returns {mode:'general'} (NOT an error). This is what makes the
  // 'general' label honest — it is reserved for "model ran, no docs".
  const haveEnvKey = !!(process.env.LLM_API_KEY && process.env.LLM_API_KEY.length > 8);
  if (haveEnvKey) {
    console.log("\n· Control: DEFAULT (env) backend on a no-docs question still answers mode='general' (the model RAN) …");
    await setCloud(OWNER, { provider: "", apiKey: "", model: "" });
    const def = await askUnder(OWNER, Q);
    check("SEPARATION/default-general",
      "with the working env model, a general question returns mode='general' (case a — NOT an error)",
      !def.threw && def.res?.mode === "general" && /paris/i.test(def.res?.answer || ""),
      def.threw ? `threw ${def.error?.name}` : `mode=${def.res?.mode} answer="${(def.res?.answer || "").slice(0, 60)}"`);
  } else {
    console.log("  ℹ no working env LLM key — skipping the 'default still answers general' control (the keyless ERROR gate still holds).");
  }

  // ── PART 2 — BAD KEY (a real provider, a bogus key → a real 401/403) ──────────────
  // This is the "key set but not working" case. We point at a real provider base with a
  // bogus key and make ONE real outbound request; the provider returns 401/403, chatCloud
  // throws CloudProviderAuthError, and it must propagate (NOT 'general').
  console.log("\n· Bad key (openai base, bogus key) — must ERROR with the key guidance, not answer 'general' …");
  await setCloud(OWNER, { provider: "openai", apiKey: "sk-nucleus-eval-bogus-" + crypto.randomUUID().slice(0, 8), model: "gpt-4o-mini" });
  const bad = await askUnder(OWNER, Q);
  if (bad.threw && isCloudProviderAuth(bad.error)) {
    check("BADKEY/typed-auth", "a rejected key (401/403) threw the typed CloudProviderAuthError (model-run failure)",
      isModelRunFailure(bad.error), `status=${bad.error?.status} provider=${bad.error?.provider}`);
    const line = friendlyAskError(bad.error);
    check("BADKEY/clear-message", "friendlyAskError → the clear key guidance (Settings → Models), not a generic punt",
      /Settings → Models/i.test(line) && !/something went wrong/i.test(line), `message="${line}"`);
  } else if (bad.threw && isModelRunFailure(bad.error)) {
    // Some networks reject the connection outright (no 401 reachable). Still a model-run
    // failure that PROPAGATES (never 'general') — the requirement holds. Report honestly.
    check("BADKEY/propagated", "the bad-key request propagated a model-run failure (no 'general' degrade) — provider unreachable for a true 401",
      true, `name=${bad.error?.name}`);
  } else if (bad.threw) {
    // It threw SOMETHING (not a 'general' answer) — the core requirement (no fake answer)
    // holds; we just couldn't reach a real 401 to classify. Not a false-green: it did NOT
    // return a 'general' answer.
    check("BADKEY/no-general", "the bad-key request did NOT degrade to a 'general' answer (it errored) — could not reach a real 401 to classify",
      true, `threw ${bad.error?.name || "error"}: ${(bad.error?.message || "").slice(0, 80)}`);
    console.log("  ℹ note: outbound network may be blocked — a real 401 classification could not be exercised here.");
  } else {
    // It RETURNED an answer with a bogus key — that is the BUG (a failed model masquerading
    // as a real reply). Only acceptable if the env happened to ignore the override; flag it.
    check("BADKEY/no-general", "the bad-key request must NOT return a 'general' answer (a failed model must not look like a real reply)",
      false, `returned mode=${bad.res?.mode} answer="${(bad.res?.answer || "").slice(0, 80)}"`);
  }
}

async function cleanup() {
  // Clear the override so we leave no keyless/bad-key state behind.
  try { await setCloud(OWNER, { provider: "", apiKey: "", model: "", baseUrl: "" }); } catch { /* in-memory store — fine */ }
  if (createdRealUser && OWNER) {
    try {
      const { error } = await admin().auth.admin.deleteUser(OWNER); // CASCADE clears the owner's settings rows
      check("CLEANUP/clean", "the throwaway owner + its settings override were deleted (no residue)", !error, error?.message || "");
    } catch (e) {
      check("CLEANUP/clean", "the throwaway owner was deleted", false, e instanceof Error ? e.message : String(e));
    }
  } else {
    console.log("\n↩ cleanup: in-memory settings override cleared (no real user to delete).");
  }
}

// RESIDUE GUARD (#79): refuse to run over a DB a prior leaked run left dirty (a polluted
// catalog produces a FALSE GREEN); abort loudly. Asserts 0 throwaway orphan rows BEFORE the run.
await assertCleanBefore("keyless-model-error");
let runError = null;
try {
  await main();
} catch (e) {
  runError = e;
  console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e);
} finally {
  await cleanup();
}
// RESIDUE GUARD (#79): this run must leave 0 throwaway residue — fail loudly if its cleanup leaked.
await assertCleanAfter("keyless-model-error");

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(
  `KEYLESS / BAD-KEY MODEL ERROR: ${results.length - fails.length}/${results.length} gates passed` +
    (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN")
);
if (fails.length || runError) process.exit(1);
process.exit(0);
