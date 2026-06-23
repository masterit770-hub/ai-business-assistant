// ROUTER-DECISIONS eval — guards the engine's most basic-but-uneval'd capability: the
// ROUTER makes the RIGHT SOURCE DECISION for a question. routeQuestion is a plain function
// (a real LLM call that returns {sources,...}) with NO direct eval until now. The product
// promise the client paid for is "a routing decision over heterogeneous sources" — not
// "embed everything and search". So the router must:
//   (1) NOT retrieve for a pure greeting (sources EMPTY) — no documents/data are relevant;
//   (2) route a narrative/document question over the bundled case file to "documents";
//   (3) route a STRUCTURED/data question over an UPLOADED table to "structured" — and it
//       must do so even though the table lives in a non-demo owner's durable store;
//   (4) NOT hallucinate a source for a question over a doc/topic the user does NOT have
//       (sources empty, or at worst general — never invent "documents"/"structured").
//
// This asserts from the DATA + the user's standard (the route DECISION), not from our own
// code. Each case is a wrong-route trap: a router that "queries both to be safe" fails (1)
// and (4); a cold-memory router fails (3); a router blind to bundled docs fails (2).
//
// RUN (from the repo root):
//   node tests/evals/router-decisions.mjs
// It loads the LLM key + Supabase creds from local secret files (READ, never printed). If
// either is absent it SKIPS loudly with exit 0 (never a false-green — the router makes real
// LLM calls and case (3) needs the durable Supabase lane). It creates a UNIQUE throwaway
// non-demo owner via the admin API, ingests one tiny CSV, and at the END DELETES that
// owner's rows + the throwaway user, leaving no residue.
//
// PROVIDER-NEUTRAL: uses LLM_PROVIDER/LLM_API_KEY/LLM_BASE_URL/LLM_MODEL only. No Gemini.
//
// SECURITY: this file READs .env.local / .secrets/supabase.env / .vercel-prod.env to set
// process.env, but NEVER prints, echoes, logs, or commits any secret value.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── ENV LOADING (secret-safe) ──────────────────────────────────────────────────
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
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
const haveLlm = !!(process.env.LLM_API_KEY && process.env.LLM_API_KEY.length > 8);

function skip(msg) {
  console.log("\n" + "═".repeat(72));
  console.log("⏭  SKIPPED — router-decisions eval did NOT run (this is NOT a pass).");
  console.log("   " + msg);
  console.log("═".repeat(72));
  process.exit(0);
}
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — the structured-lane case (3) needs the durable store.");
if (!haveLlm) skip("No LLM_API_KEY found — the router makes real LLM calls and can't run.");

// ── TEST HARNESS ─────────────────────────────────────────────────────────────────
const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}

// A tiny STRUCTURED table — vendors + amounts. This is canonical text-to-SQL territory
// ("what is the total amount?" = SUM(amount) over rows), NOT document prose. The router
// must route a question over it to "structured". Headers + real-looking rows.
const VENDORS_CSV =
  "vendor,amount\n" +
  "Acme Supplies,1200\n" +
  "Globex Corp,3400\n" +
  "Initech LLC,560\n" +
  "Umbrella Co,7800\n";

// Import the REAL engine entry points (same modules the live route uses). Per the task:
// ingest* + routeQuestion + answerQuestion + the cold-start wipe + durable listing/cleanup.
const { ingestPdf, ingestCsv, ingestXlsx, ingestDocx } = await import("../../src/lib/engine/ingest.ts");
const { routeQuestion } = await import("../../src/lib/engine/router.ts");
const { answerQuestion } = await import("../../src/lib/engine/answer.ts");
const { resetStore } = await import("../../src/lib/engine/structured-store.ts");
const { listUploadedTables, deleteUploadedTable } = await import("../../src/lib/engine/structured-rows-store.ts");
const { __resetRuntimeStoreForTests } = await import("../../src/lib/engine/runtime-store.ts");
const { supabaseEnabled, admin } = await import("../../src/lib/engine/supabase.ts");
// Touch the unused-but-required imports so the lint/contract that the FULL ingest surface is
// importable holds (the task asks all four ingest entry points be imported from the engine).
void ingestPdf; void ingestXlsx; void ingestDocx; void answerQuestion;

let OWNER = null;   // a throwaway NON-DEMO owner (FK to auth.users) who uploads the table
let TABLE = null;   // the ingested vendors table id

async function newOwner(tag) {
  const email = `router-${tag}-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({
    email, password: crypto.randomUUID(), email_confirm: true,
  });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  return data.user.id;
}

async function main() {
  check("ENV/supabase", "the engine sees Supabase as configured (durable structured lane is live)", supabaseEnabled());
  if (!supabaseEnabled()) throw new Error("supabaseEnabled() is false despite env — aborting to avoid a meaningless run");

  // ── CASE 1: a pure GREETING needs NO retrieval → sources EMPTY [isDemo:true] ──────
  // A demo caller sees the bundled corpus, so this is the HARD version of the test: even
  // WITH documents+tables available, the router must recognize "hello, how are you?" needs
  // none of them and return an empty sources list (the differentiator: it decides, it does
  // not blindly query both). A router that "queries both to be safe" FAILS here.
  console.log("\n· CASE 1 — pure greeting (isDemo:true): expect sources EMPTY (no retrieval) …");
  const planGreet = await routeQuestion("hello, how are you?", { isDemo: true });
  check("GREETING/empty",
    "a pure greeting routes to NO source (sources is empty — the router skips retrieval)",
    Array.isArray(planGreet.sources) && planGreet.sources.length === 0,
    `sources=[${(planGreet.sources || []).join(",")}] rationale="${(planGreet.rationale || "").slice(0, 80)}"`);

  // ── CASE 2: a NARRATIVE/DOCUMENT question over the bundled case file → "documents" ─
  // The bundled corpus is a Family Court Case File + the Carter family story (prose). A
  // qualitative/narrative question is answered from document passages → must route to
  // "documents" (and NOT to "structured" — there is no table that answers a narrative).
  console.log("\n· CASE 2 — narrative question over the bundled case file (isDemo:true): expect 'documents' …");
  const planDoc = await routeQuestion("what happened to the Carter family in the case file?", { isDemo: true });
  check("DOC/includes-documents",
    "a narrative question over the bundled case file routes to 'documents'",
    planDoc.sources.includes("documents"),
    `sources=[${planDoc.sources.join(",")}] rationale="${(planDoc.rationale || "").slice(0, 80)}"`);

  // ── Ingest the tiny vendors table as a throwaway NON-DEMO owner ──────────────────
  OWNER = await newOwner("a");
  const FILENAME = `router-vendors-${OWNER.slice(0, 8)}.csv`;
  console.log(`\n· Ingesting the vendors+amounts CSV as non-demo owner ${OWNER.slice(0, 8)}… (table for CASE 3) …`);
  const res = await ingestCsv(VENDORS_CSV, FILENAME, OWNER);
  TABLE = res.table;
  check("INGEST/rows", "CSV ingested with rows", (res.rows ?? 0) > 0, `rows=${res.rows} table=${TABLE}`);
  check("INGEST/persisted", "rows PERSISTED to the durable uploaded_rows store (so they survive a cold start)",
    (res.persisted ?? 0) > 0, `persisted=${res.persisted} (must be > 0)`);
  check("INGEST/not-ragged", "a spreadsheet is NOT embedded as RAG/pgvector doc chunks (it's structured, not documents)",
    (res.chunks ?? 0) === 0, `chunks=${res.chunks} (must be 0)`);

  // ── COLD-START WIPE — clear ALL in-memory engine state before routing CASE 3 ─────
  // Reproduce a fresh serverless instance: the in-memory runtime store (sqlRows) + the
  // structured-store's cached SQL handles are empty. The router must rehydrate the owner's
  // durable rows BEFORE its introspect so it STILL sees the table and routes "structured".
  console.log("\n· Simulating a serverless COLD START (wipe in-memory runtime store + SQL handles) …");
  __resetRuntimeStoreForTests();
  resetStore();

  // ── CASE 3: a STRUCTURED/data question over the uploaded table → "structured" ────
  // {ownerId, isDemo:false} — a real client user over THEIR OWN uploaded table. "what is
  // the total amount?" = SUM(amount), pure text-to-SQL. The router must include "structured"
  // (post-cold-start, owner-scoped). The exact bug class this guards: empty memory →
  // "(no structured tables loaded)" → wrongly NOT routing to structured.
  console.log("\n· CASE 3 — structured question over the uploaded table (isDemo:false, post-cold-start): expect 'structured' …");
  const planStruct = await routeQuestion("what is the total amount?", { ownerId: OWNER, isDemo: false });
  check("STRUCTURED/includes-structured",
    "a data/aggregation question over the uploaded table routes to 'structured' (durable catalog survived the cold start)",
    planStruct.sources.includes("structured"),
    `sources=[${planStruct.sources.join(",")}] rationale="${(planStruct.rationale || "").slice(0, 80)}"`);

  // ── CASE 4: a question over a doc the user does NOT have → NO hallucinated source ──
  // Same non-demo owner: he has ONLY the vendors table (no documents, and nothing about a
  // medieval castle). A correct router returns EMPTY sources (nothing relevant). The wrong
  // behaviors it must avoid: inventing "documents" (he has none) or "structured" (no table
  // about castles). "general" is acceptable per the task (the answer pipeline falls back to
  // general knowledge for an empty route) — but the ROUTE itself must claim no real source.
  console.log("\n· CASE 4 — question over a doc the owner does NOT have (isDemo:false): expect NO hallucinated source …");
  const planMissing = await routeQuestion("what does the 14th-century castle restoration report say about the moat?", { ownerId: OWNER, isDemo: false });
  const hallucinated =
    planMissing.sources.includes("documents") || planMissing.sources.includes("structured");
  check("MISSING/no-hallucination",
    "a question over content the owner does NOT have routes to NO source (empty) — it does not invent 'documents'/'structured'",
    !hallucinated,
    `sources=[${planMissing.sources.join(",")}] rationale="${(planMissing.rationale || "").slice(0, 80)}"`);
}

async function cleanup() {
  let removed = 0, after = -1, usersDeleted = 0;
  try {
    if (OWNER && TABLE) removed = await deleteUploadedTable(OWNER, TABLE, false);
    if (OWNER) after = (await listUploadedTables(OWNER)).length;
  } catch (e) {
    console.error("rows cleanup error:", e instanceof Error ? e.message : e);
  }
  if (OWNER) {
    try {
      const { error } = await admin().auth.admin.deleteUser(OWNER); // ON DELETE CASCADE clears uploaded_rows
      if (!error) usersDeleted++; else console.error("user delete error:", error.message);
    } catch (e) {
      console.error("user delete threw:", e instanceof Error ? e.message : e);
    }
  }
  console.log(`\n↩ cleanup: deleted ${removed} row(s) (owner tables remaining: ${after}); throwaway users deleted: ${usersDeleted}/1`);
  check("CLEANUP/clean", "the throwaway owner's rows + user were deleted from the live DB (no residue)",
    after === 0 && usersDeleted === 1, `tablesRemaining=${after} usersDeleted=${usersDeleted}`);
}

let runError = null;
try {
  await main();
} catch (e) {
  runError = e;
  console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e);
} finally {
  await cleanup();
}

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(
  `ROUTER DECISIONS: ${results.length - fails.length}/${results.length} passed` +
    (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN")
);
if (fails.length || runError) process.exit(1);
process.exit(0);
