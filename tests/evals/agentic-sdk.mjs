// AGENTIC SDK EVAL (#81) — proves answerAgentic() works with DEFAULT built-in tools.
//
// DESIGN PRINCIPLE (Chris): use the RAW Agent SDK with DEFAULT built-in tools
// (Bash + Read + Glob). The agent reads files from a per-request working dir
// and RUNS CODE to compute answers — exactly like the Claude cloud app.
//
// SETUP:
//   1. Create a THROWAWAY owner (isDemo:false; @nucleus-eval.invalid domain).
//   2. Store the 2 Hebrew scheduling xlsx grids + Carter MOCK PDF via
//      storeOriginalFile() under the throwaway owner.
//      Also write a _files.json index so answerAgentic can list files.
//   3. answerAgentic() fetches these files from Supabase, writes them to
//      /tmp/nucleus-agent-<id>/, and runs the SDK agent over that local dir.
//   4. Run ≤3 serial questions (cost cap). Assert answers + AnswerResult shape.
//   5. CLEANUP: delete all storage objects + throwaway owner. Residue 0/0.
//
// WHAT WE CHECK:
//   Q1 (×3): "who participates the most?" → רינה אנטוב=10
//             agent MUST run code (Bash) to count — not guess.
//   Q2 (×1-2): "who is the petitioner?" → Joni (grounded, from PDF)
//
// For EACH run, CONFIRM the returned AnswerResult has:
//   - sources populated (evidence.chunks OR route.sources)
//   - inspector.steps populated (traces)
//   - route.sources reflects what the agent did
//
// HONEST REPORT: no faking. If auth fails → STOP + report. Per-run token cost.
//
// RUN: node tests/evals/agentic-sdk.mjs
//   Requires: Supabase creds + Claude CLI creds (~/.claude)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { skip as skipShared } from "./_skip.mjs";
import { assertCleanBefore, assertCleanAfter, settleOwner } from "./_residue-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── Env loading ──────────────────────────────────────────────────────────────
const WANT = new Set([
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
if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL)
  process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

const skip = (msg) => skipShared("agentic-sdk", msg);

// ── Pre-flight checks ────────────────────────────────────────────────────────
const haveSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — throwaway-owner upload can't run.");

// Resolve her files by stable substrings
function findBySubstring(substr, ext) {
  const dir = path.join(ROOT, "data");
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    if (name.normalize("NFC").includes(substr.normalize("NFC")) && name.toLowerCase().endsWith(ext)) {
      return path.join(dir, name);
    }
  }
  return null;
}

const JUNE_PATH        = findBySubstring("יוני", ".xlsx");
const AUG_PATH         = findBySubstring("אוגוסט", ".xlsx");
const CARTER_MOCK_PATH = findBySubstring("FAMILY COURT", ".pdf");
const ENROLLMENT_PATH  = findBySubstring("school data 2", ".csv");

if (!JUNE_PATH || !AUG_PATH) skip(`Hebrew scheduling xlsx not on disk (June=${!!JUNE_PATH}, Aug=${!!AUG_PATH}) — cannot run.`);
if (!CARTER_MOCK_PATH)       skip("Carter MOCK PDF not found in data/ — cannot run.");
// enrollment CSV is best-effort — skip its sub-test if missing, not the whole eval

// ── Imports ─────────────────────────────────────────────────────────────────
const { admin, supabaseEnabled } = await import("../../src/lib/engine/supabase.ts");
const { storeOriginalFile }      = await import("../../src/lib/engine/doc-files.ts");
const { answerAgentic }          = await import("../../src/lib/engine/answer-agentic.ts");

if (!supabaseEnabled()) { console.error("supabaseEnabled() false — aborting"); process.exit(1); }

// ── State ────────────────────────────────────────────────────────────────────
let OWNER = null;
const STORED_DOC_IDS = [];
const results = [];
const runResults = [];

function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  const sym = ok ? "✓ PASS" : "✗ FAIL";
  console.log(`  ${sym} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function newOwner() {
  const email = `agentic-sdk-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password: crypto.randomUUID(),
    email_confirm: true,
  });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  return settleOwner(data.user.id);
}

function safeDocId(filename) {
  return filename
    .replace(/[^\x00-\x7F]/g, (c) => `U${c.codePointAt(0).toString(16).padStart(4,"0")}`)
    .replace(/\s+/g, "_");
}

async function storeRaw(filePath, hintName) {
  const buf = new Uint8Array(fs.readFileSync(filePath));
  const displayName = hintName || path.basename(filePath);
  const docId = safeDocId(displayName);
  const stored = await storeOriginalFile(buf, OWNER, docId, displayName);
  if (!stored) throw new Error(`storeOriginalFile returned false for ${displayName}`);
  STORED_DOC_IDS.push(docId);
  return { docId, displayName };
}

async function cleanup() {
  let objectsDeleted = 0;
  let userDeleted = 0;
  const client = admin();
  for (const docId of STORED_DOC_IDS) {
    try {
      const { error } = await client.storage.from("documents").remove([`${OWNER}/${docId}`]);
      if (!error) objectsDeleted++;
    } catch { /* noop */ }
  }
  if (OWNER) {
    for (let attempt = 0; attempt < 4 && userDeleted === 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
      try { await client.auth.admin.deleteUser(OWNER); } catch { /* fall through */ }
      try {
        const { data, error } = await client.auth.admin.getUserById(OWNER);
        if ((error && /not found/i.test(error.message)) || !data?.user) userDeleted = 1;
      } catch { /* retry */ }
    }
  }
  console.log(`\n↩ cleanup: ${objectsDeleted}/${STORED_DOC_IDS.length} storage objects deleted, owner ${userDeleted}/1 deleted`);
  check("CLEANUP/owner-deleted", "throwaway owner deleted (no residue)", userDeleted === 1, `userDeleted=${userDeleted}`);
}

// Pricing: claude-haiku-4-5 $0.80/$4.00 per 1M tokens
const INPUT_COST_PER_M  = 0.80;
const OUTPUT_COST_PER_M = 4.00;
function estimateCost(inp, out) {
  return (inp / 1_000_000) * INPUT_COST_PER_M + (out / 1_000_000) * OUTPUT_COST_PER_M;
}

async function ask(label, question, section) {
  console.log(`\n  [${label}] "${question.normalize("NFC").slice(0, 70)}"`);
  const t0 = Date.now();
  try {
    const result = await answerAgentic(question, OWNER);
    const ms = Date.now() - t0;

    const inp = result.inspector?.cost?.promptTokens ?? 0;
    const out = result.inspector?.cost?.completionTokens ?? 0;
    const cost = estimateCost(inp, out);
    const filesRead = result.evidence.chunks.map(c => c.doc).filter(Boolean);
    const bashCalls = result.inspector?.steps?.find(s => s.key === "retrieval")?.detail ?? "";

    console.log(`    ↳ mode=${result.mode} grounded=${result.grounded}`);
    console.log(`    ↳ route.sources=${JSON.stringify(result.route.sources)}`);
    console.log(`    ↳ files in evidence: ${filesRead.join(", ") || "(none)"}`);
    console.log(`    ↳ inspector.steps: ${(result.inspector?.steps ?? []).map(s => s.key).join(" → ")}`);
    console.log(`    ↳ tokens: in=${inp} out=${out} $${cost.toFixed(4)}`);
    const shortAnswer = (result.answer || "").normalize("NFC").replace(/\n/g, " ").slice(0, 220);
    console.log(`    ↳ answer: ${shortAnswer}`);

    runResults.push({ label, section, question, result, inp, out, cost, ms, filesRead, ok: true });
    return result;
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`    ✗ ERROR (${ms}ms): ${msg}`);
    // Auth failure → hard stop
    if (/authentication|auth|login|credential|401|403/i.test(msg)) {
      console.error("\n⛔ AUTH FAILURE — Claude CLI creds not working. STOP.");
      console.error("   Fix: run `claude login` and try again.");
      process.exit(2);
    }
    runResults.push({ label, section, question, result: null, inp: 0, out: 0, cost: 0, ms, filesRead: [], ok: false, error: msg });
    return null;
  }
}

// ── AnswerResult shape checks ─────────────────────────────────────────────────

function checkAnswerResultShape(prefix, result) {
  if (!result) {
    check(`${prefix}/shape/present`, "AnswerResult returned", false, "result was null (error)");
    return;
  }
  check(`${prefix}/shape/present`,  "AnswerResult returned",              true);
  check(`${prefix}/shape/answer`,   "answer is non-empty string",         !!(result.answer && result.answer.trim().length > 0),
        `answer[:60]=${result.answer?.slice(0,60)}`);
  check(`${prefix}/shape/route`,    "route.sources populated",            Array.isArray(result.route?.sources),
        `route.sources=${JSON.stringify(result.route?.sources)}`);
  check(`${prefix}/shape/evidence`, "evidence object present",            !!(result.evidence?.chunks !== undefined && result.evidence?.rows !== undefined),
        `chunks=${result.evidence?.chunks?.length}, rows=${result.evidence?.rows?.length}`);
  check(`${prefix}/shape/inspector`, "inspector.steps populated",        Array.isArray(result.inspector?.steps) && result.inspector.steps.length > 0,
        `steps=${result.inspector?.steps?.map(s=>s.key).join(",")}`);
  check(`${prefix}/shape/inspector-cost`, "inspector.cost present",      !!(result.inspector?.cost),
        `promptTokens=${result.inspector?.cost?.promptTokens}`);
  check(`${prefix}/shape/mode`,     "mode is grounded or general",       result.mode === "grounded" || result.mode === "general",
        `mode=${result.mode}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await assertCleanBefore("agentic-sdk");

  OWNER = await newOwner();
  console.log(`\n▶ AGENTIC SDK EVAL — throwaway owner ${OWNER.slice(0,8)}… (will be deleted)`);

  // Store files raw under the throwaway owner
  console.log("\n── Storing raw files ──");
  const june   = await storeRaw(JUNE_PATH,        path.basename(JUNE_PATH));
  const aug    = await storeRaw(AUG_PATH,         path.basename(AUG_PATH));
  const carter = await storeRaw(CARTER_MOCK_PATH, path.basename(CARTER_MOCK_PATH));
  const enrollment = ENROLLMENT_PATH ? await storeRaw(ENROLLMENT_PATH, "school_enrollment.csv") : null;

  // Write _files.json metadata index so answerAgentic knows the display names + types
  const fileIndex = [
    { docId: june.docId,   displayName: june.displayName.normalize("NFC"),    type: "spreadsheet" },
    { docId: aug.docId,    displayName: aug.displayName.normalize("NFC"),      type: "spreadsheet" },
    { docId: carter.docId, displayName: carter.displayName.normalize("NFC"),  type: "pdf" },
    ...(enrollment ? [{ docId: enrollment.docId, displayName: enrollment.displayName, type: "csv" }] : []),
  ];
  const indexBuf = new TextEncoder().encode(JSON.stringify(fileIndex, null, 2));
  const indexStored = await storeOriginalFile(new Uint8Array(indexBuf), OWNER, "_files.json", "_files.json");
  if (indexStored) STORED_DOC_IDS.push("_files.json");

  console.log(`  stored: ${STORED_DOC_IDS.length} files (incl. index)`);
  console.log(`  june  docId=${june.docId.slice(0,30)}…`);
  console.log(`  aug   docId=${aug.docId.slice(0,30)}…`);
  console.log(`  carter docId=${carter.docId.slice(0,30)}…`);

  // ══ Q1: Grid — "who participates the most?" (3 runs) ══════════════════════
  console.log("\n══ Q1: Grid count — 3 serial runs ══");
  const TOP = "רינה אנטוב";
  const hasNum10 = (a) => /(?<![0-9])10(?![0-9])/.test((a || "").normalize("NFC"));

  for (const label of ["G1", "G2", "G3"]) {
    const result = await ask(label, "who participates the most?", "grid");
    const a = (result?.answer || "").normalize("NFC");
    const hasRina = a.includes(TOP);
    const has10   = hasNum10(a);
    const grounded = result?.grounded === true;

    checkAnswerResultShape(`grid/${label}`, result);
    check(`grid/${label}/named-rina`, `${label}: answer names רינה אנטוב`, hasRina, `answer[:120]=${a.slice(0,120)}`);
    check(`grid/${label}/says-10`,    `${label}: answer says 10`,           has10,   `answer[:120]=${a.slice(0,120)}`);
    check(`grid/${label}/grounded`,   `${label}: result.grounded=true`,     grounded, `grounded=${result?.grounded}`);
  }

  // ══ Q2: Carter PDF — petitioner (2 runs) ══════════════════════════════════
  console.log("\n══ Q2: Carter PDF — petitioner (2 runs) ══");

  for (const label of ["P1", "P2"]) {
    const result = await ask(label, "who is the petitioner?", "petitioner");
    const a = (result?.answer || "").normalize("NFC").toLowerCase();
    const hasJoni    = a.includes("joni");
    const noBeyonce  = !a.includes("beyonc");
    const grounded   = result?.grounded === true;

    checkAnswerResultShape(`petitioner/${label}`, result);
    check(`petitioner/${label}/joni`,       `${label}: names Joni (petitioner)`,    hasJoni,   `answer[:120]=${a.slice(0,120)}`);
    check(`petitioner/${label}/no-beyonce`, `${label}: does NOT say Beyoncé`,       noBeyonce, `answer[:120]=${a.slice(0,120)}`);
    check(`petitioner/${label}/grounded`,   `${label}: result.grounded=true`,       grounded,  `grounded=${result?.grounded}`);
  }

  // ══ Q3: Enrollment CSV — which course has the most students? (1 run) ══════
  if (enrollment) {
    console.log("\n══ Q3: Enrollment CSV — most students (1 run) ══");
    const resultE1 = await ask("E1", "which course has the most students?", "enrollment");
    const aE1 = (resultE1?.answer || "").normalize("NFC").toLowerCase();
    const hasPhysics = aE1.includes("physics");
    const has93      = /(?<![0-9])93(?![0-9])/.test(aE1);
    const grounded   = resultE1?.grounded === true;

    checkAnswerResultShape("enrollment/E1", resultE1);
    check("enrollment/E1/physics", "E1: names physics as most enrolled course", hasPhysics, `answer[:120]=${aE1.slice(0,120)}`);
    check("enrollment/E1/count93", "E1: says 93 students",                      has93,      `answer[:120]=${aE1.slice(0,120)}`);
    check("enrollment/E1/grounded","E1: result.grounded=true",                  grounded,   `grounded=${resultE1?.grounded}`);
  } else {
    console.log("\n  [E1] SKIP — enrollment CSV not found in data/");
  }
}

// ── Cleanup + residue guard ───────────────────────────────────────────────────
let runError = null;
try { await main(); }
catch (e) { runError = e; console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e); }
finally { await cleanup(); }

await assertCleanAfter("agentic-sdk");

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(80)}`);
console.log("AGENTIC SDK EVAL (#81) — RESULTS");
console.log(`${"═".repeat(80)}`);

// Per-section summary
for (const section of ["grid", "petitioner", "enrollment"]) {
  const s = runResults.filter(r => r.section === section);
  if (!s.length) continue;
  console.log(`\n── ${section.toUpperCase()} (${s.length} runs) ──`);
  const totalIn  = s.reduce((acc, r) => acc + r.inp, 0);
  const totalOut = s.reduce((acc, r) => acc + r.out, 0);
  const totalCost = s.reduce((acc, r) => acc + r.cost, 0);
  for (const r of s) {
    const ans = (r.result?.answer || "").normalize("NFC").replace(/\n/g, " ").slice(0, 120);
    const hasInspector = Array.isArray(r.result?.inspector?.steps) && r.result.inspector.steps.length > 0;
    console.log(`  [${r.label}] grounded=${r.result?.grounded} files=${r.filesRead.length} inspector=${hasInspector}`);
    console.log(`         in=${r.inp} out=${r.out} $${r.cost.toFixed(4)} | ${ans}`);
  }
  console.log(`  TOTAL: in=${totalIn} out=${totalOut} cost=$${totalCost.toFixed(4)}`);
  console.log(`  avg $/question: $${totalCost > 0 ? (totalCost / s.length).toFixed(4) : "0.0000"}`);
}

// Consistency
console.log("\n── CONSISTENCY CHECK ──");
const TOP = "רינה אנטוב";
const gridRuns = runResults.filter(r => r.section === "grid" && r.result);
const rina_hits = gridRuns.filter(r => (r.result?.answer || "").normalize("NFC").includes(TOP)).length;
const ten_hits  = gridRuns.filter(r => /(?<![0-9])10(?![0-9])/.test((r.result?.answer || "").normalize("NFC"))).length;
console.log(`  Grid (${gridRuns.length} runs): רינה אנטוב=${rina_hits}/${gridRuns.length}, says-10=${ten_hits}/${gridRuns.length}`);

const petRuns = runResults.filter(r => r.section === "petitioner" && r.result);
const joni_hits = petRuns.filter(r => (r.result?.answer || "").toLowerCase().includes("joni")).length;
console.log(`  Petitioner (${petRuns.length} runs): Joni=${joni_hits}/${petRuns.length}`);

const enrollRuns = runResults.filter(r => r.section === "enrollment" && r.result);
if (enrollRuns.length > 0) {
  const phys_hits = enrollRuns.filter(r => (r.result?.answer || "").toLowerCase().includes("physics")).length;
  const n93_hits  = enrollRuns.filter(r => /(?<![0-9])93(?![0-9])/.test((r.result?.answer || ""))).length;
  console.log(`  Enrollment (${enrollRuns.length} runs): physics=${phys_hits}/${enrollRuns.length}, 93=${n93_hits}/${enrollRuns.length}`);
}

// Feature coverage check
console.log("\n── FEATURE COVERAGE (every existing feature still works) ──");
const allRuns = runResults.filter(r => r.result);
const hasRoute      = allRuns.filter(r => Array.isArray(r.result.route?.sources)).length;
const hasEvidence   = allRuns.filter(r => r.result.evidence?.chunks !== undefined).length;
const hasInspector  = allRuns.filter(r => Array.isArray(r.result.inspector?.steps) && r.result.inspector.steps.length > 0).length;
const hasCost       = allRuns.filter(r => r.result.inspector?.cost?.promptTokens !== undefined).length;
console.log(`  route.sources:       ${hasRoute}/${allRuns.length} runs have route`);
console.log(`  evidence.chunks:     ${hasEvidence}/${allRuns.length} runs have evidence`);
console.log(`  inspector.steps:     ${hasInspector}/${allRuns.length} runs have inspector trace`);
console.log(`  inspector.cost:      ${hasCost}/${allRuns.length} runs have cost report`);

// Overall
const fails = results.filter(r => !r.ok);
console.log(`\n${"═".repeat(80)}`);
console.log(`TOTAL: ${results.length - fails.length}/${results.length} checks passed` +
  (fails.length ? ` · FAILED: ${fails.map(f => f.id).join(", ")}` : " · ALL GREEN"));
if (fails.length || runError) process.exit(1);
process.exit(0);
