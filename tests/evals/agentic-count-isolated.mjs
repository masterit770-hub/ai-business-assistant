// AGENTIC COUNT ISOLATED (#81 variant) — isolates count-accuracy from file-selection.
//
// PREMISE: Give the agent ONLY the 2 Hebrew scheduling grids — no other files.
// list_files will show exactly these 2 xlsx files. The agent cannot pick a wrong file.
// Single question being measured: GIVEN THE RIGHT EXCEL, does the bare baseline count
// correctly (רינה אנטוב = 10 across June+August combined), or does it still drift?
//
// SETUP: throwaway MEMBER owner (isDemo:false), stores ONLY 2 grids raw.
// MEASURE: 8 serial repetitions across 3 phrasings.
// GROUND TRUTH: רינה אנטוב = 10 (June + August combined).
//
// REPORT per run: named top person + count given + whether it read both grids.
// CONSISTENCY TALLY: how many runs got EXACTLY רינה אנטוב=10 vs drifted.
//
// RUN: node tests/evals/agentic-count-isolated.mjs
//   Requires: Supabase creds (SUPABASE_URL + SERVICE_ROLE_KEY)
//   Auth:     Claude CLI subscription (SDK falls back to CLI creds)

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

const skip = (msg) => skipShared("agentic-count-isolated", msg);

// ── Pre-flight ───────────────────────────────────────────────────────────────
const haveSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found.");

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

const JUNE_PATH = findBySubstring("יוני", ".xlsx");
const AUG_PATH  = findBySubstring("אוגוסט", ".xlsx");

if (!JUNE_PATH || !AUG_PATH) skip(`Hebrew scheduling xlsx not found (June=${!!JUNE_PATH}, Aug=${!!AUG_PATH}).`);

// ── Imports ─────────────────────────────────────────────────────────────────
const { admin, supabaseEnabled } = await import("../../src/lib/engine/supabase.ts");
const { storeOriginalFile } = await import("../../src/lib/engine/doc-files.ts");
const { answerAgentic } = await import("../../src/lib/engine/agentic.ts");

if (!supabaseEnabled()) { console.error("supabaseEnabled() false — aborting"); process.exit(1); }

// ── State ────────────────────────────────────────────────────────────────────
let OWNER = null;
const STORED_DOC_IDS = [];
const runResults = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function newOwner() {
  const email = `agentic-count-iso-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
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
    .replace(/[^\x00-\x7F]/g, (c) => `U${c.codePointAt(0).toString(16).padStart(4, "0")}`)
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
}

// Haiku pricing: $0.80/$4.00 per 1M tokens
const INPUT_COST_PER_M  = 0.80;
const OUTPUT_COST_PER_M = 4.00;
function estimateCost(inp, out) {
  return (inp / 1_000_000) * INPUT_COST_PER_M + (out / 1_000_000) * OUTPUT_COST_PER_M;
}

async function ask(label, question, juneDocId, augDocId) {
  console.log(`\n  [${label}] "${question.normalize("NFC").slice(0, 70)}"`);
  const t0 = Date.now();
  try {
    const r = await answerAgentic(question, OWNER);
    const ms = Date.now() - t0;
    const cost = estimateCost(r.inputTokens, r.outputTokens);

    // Determine whether it read both grids, just one, or neither
    const readJune = r.filesRead.some(id => id === juneDocId || id.normalize("NFC").includes("יוני"));
    const readAug  = r.filesRead.some(id => id === augDocId  || id.normalize("NFC").includes("אוגוסט"));
    const readBoth = readJune && readAug;
    const readSummary = readBoth ? "BOTH" : readJune ? "june-only" : readAug ? "aug-only" : "NONE";

    const ansNFC = r.answer.normalize("NFC");
    const shortAnswer = ansNFC.replace(/\n/g, " ").slice(0, 220);
    console.log(`    ↳ grids read: ${readSummary} | turns=${r.turns} | in=${r.inputTokens} out=${r.outputTokens} | $${cost.toFixed(4)}`);
    console.log(`    ↳ answer: ${shortAnswer}`);

    return {
      label, question, answer: r.answer, ansNFC,
      filesRead: r.filesRead, filesListed: r.filesListed,
      readJune, readAug, readBoth, readSummary,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens, cost, ms,
      turns: r.turns, ok: true,
    };
  } catch (e) {
    const ms = Date.now() - t0;
    console.error(`    ERROR: ${e instanceof Error ? e.message : e}`);
    return {
      label, question, answer: "", ansNFC: "",
      filesRead: [], filesListed: [],
      readJune: false, readAug: false, readBoth: false, readSummary: "ERROR",
      inputTokens: 0, outputTokens: 0, cost: 0, ms,
      turns: 0, ok: false, error: e?.message,
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const TOP_PERSON = "רינה אנטוב";
// Match standalone "10" (not part of a larger number like 100 or 10,000)
const has10 = (a) => /(?<![0-9])10(?![0-9,])/.test(a || "");
const hasRina = (a) => (a || "").normalize("NFC").includes(TOP_PERSON);

async function main() {
  await assertCleanBefore("agentic-count-isolated");

  OWNER = await newOwner();
  console.log(`\n▶ AGENTIC COUNT ISOLATED — throwaway owner ${OWNER.slice(0, 8)}… (isDemo=false)`);

  // Store ONLY the 2 scheduling grids — no CSV, no PDF, nothing else
  console.log("\n── Storing ONLY the 2 Hebrew scheduling grids (raw bytes) ──");
  const june = await storeRaw(JUNE_PATH, path.basename(JUNE_PATH));
  const aug  = await storeRaw(AUG_PATH,  path.basename(AUG_PATH));

  // Store a _files.json index so list_files returns human-readable names
  const fileIndex = [
    { docId: june.docId, displayName: june.displayName.normalize("NFC"), type: "spreadsheet" },
    { docId: aug.docId,  displayName: aug.displayName.normalize("NFC"),  type: "spreadsheet" },
  ];
  const indexBuf = new TextEncoder().encode(JSON.stringify(fileIndex, null, 2));
  const indexStored = await storeOriginalFile(new Uint8Array(indexBuf), OWNER, "_files.json", "_files.json");
  if (indexStored) STORED_DOC_IDS.push("_files.json");

  console.log(`  stored: ${STORED_DOC_IDS.length} files (2 grids + index)`);
  console.log(`  june  docId=${june.docId.slice(0, 30)}… (${june.displayName.normalize("NFC").slice(0, 25)}…)`);
  console.log(`  aug   docId=${aug.docId.slice(0, 30)}… (${aug.displayName.normalize("NFC").slice(0, 25)}…)`);
  console.log(`\n  GROUND TRUTH: ${TOP_PERSON} = 10 (June + August combined)`);

  // 8 serial runs across 3 phrasings (cycling)
  // Run order: EN, HE, EN2, EN, HE, EN2, HE, EN
  const QUESTIONS = [
    { id: "R1", q: "who participates the most?",       lang: "EN" },
    { id: "R2", q: "מי משתתפת הכי הרבה?",              lang: "HE" },
    { id: "R3", q: "who is more active?",               lang: "EN2" },
    { id: "R4", q: "who participates the most?",        lang: "EN" },
    { id: "R5", q: "מי משתתפת הכי הרבה?",               lang: "HE" },
    { id: "R6", q: "who is more active?",                lang: "EN2" },
    { id: "R7", q: "מי משתתפת הכי הרבה?",               lang: "HE" },
    { id: "R8", q: "who participates the most?",        lang: "EN" },
  ];

  console.log(`\n══ 8 SERIAL RUNS (grids only, no other files) ══`);
  for (const { id, q } of QUESTIONS) {
    const r = await ask(id, q, june.docId, aug.docId);
    runResults.push(r);
  }
}

// ── Cleanup + residue guard ───────────────────────────────────────────────────
let runError = null;
try { await main(); }
catch (e) { runError = e; console.error("\nEVAL ERROR:", e instanceof Error ? e.stack : e); }
finally { await cleanup(); }

await assertCleanAfter("agentic-count-isolated");

// ── Report ────────────────────────────────────────────────────────────────────
const SEP = "═".repeat(80);
console.log(`\n${SEP}`);
console.log(`AGENTIC COUNT ISOLATED (#81 variant) — RESULTS`);
console.log(`Ground truth: ${TOP_PERSON} = 10 (June + August combined)`);
console.log(SEP);

// Per-run detail table
console.log("\n── PER-RUN DETAIL ──");
console.log(`${"Run".padEnd(4)} ${"Phrasing".padEnd(5)} ${"GridsRead".padEnd(10)} ${"Named?".padEnd(8)} ${"Says10?".padEnd(8)} ${"Top person + count in answer"}`);
console.log("-".repeat(100));

for (const r of runResults) {
  if (!r.ok) {
    console.log(`${r.label.padEnd(4)} ${"?".padEnd(5)} ${"ERROR".padEnd(10)} ${"?".padEnd(8)} ${"?".padEnd(8)} ERROR: ${r.error || "unknown"}`);
    continue;
  }
  const namedRina = hasRina(r.ansNFC) ? "YES" : "NO";
  const says10    = has10(r.ansNFC)   ? "YES" : "NO";

  // Extract the mentioned count for the top person (look for N near the name)
  const countMatch = r.ansNFC.match(/(\d+)\s*(?:פעמים|times|appearances|appearances|x)?/g) || [];
  const numbersFound = countMatch.map(m => m.match(/\d+/)?.[0]).filter(Boolean);

  // Identify who the agent named as #1 (first proper noun after position words)
  // Pull first 180 chars of answer
  const ansSnippet = r.ansNFC.replace(/\n/g, " ").slice(0, 180);
  const lang = r.question.includes("מי") ? "HE" : r.question.includes("active") ? "EN2" : "EN";

  console.log(`${r.label.padEnd(4)} ${lang.padEnd(5)} ${r.readSummary.padEnd(10)} ${namedRina.padEnd(8)} ${says10.padEnd(8)} ${ansSnippet}`);
}

// ── Consistency tally ─────────────────────────────────────────────────────────
console.log(`\n${SEP}`);
console.log(`CONSISTENCY TALLY`);
console.log(SEP);

const okRuns    = runResults.filter(r => r.ok);
const rinaCnt   = okRuns.filter(r => hasRina(r.ansNFC)).length;
const count10   = okRuns.filter(r => has10(r.ansNFC)).length;
const bothGrids = okRuns.filter(r => r.readBoth).length;
const exactHit  = okRuns.filter(r => hasRina(r.ansNFC) && has10(r.ansNFC)).length;
const drifted   = okRuns.length - exactHit;

console.log(`  Total runs: ${runResults.length} (${okRuns.length} completed, ${runResults.length - okRuns.length} errors)`);
console.log(`  Named ${TOP_PERSON}: ${rinaCnt}/${okRuns.length}`);
console.log(`  Said "10":           ${count10}/${okRuns.length}`);
console.log(`  Read BOTH grids:     ${bothGrids}/${okRuns.length}`);
console.log(`  EXACT HIT (Rina=10): ${exactHit}/${okRuns.length}`);
console.log(`  DRIFTED (wrong count, wrong person, single-grid, or asked clarification): ${drifted}/${okRuns.length}`);

// Breakdown of drift categories
const juneOnly = okRuns.filter(r => r.readJune && !r.readAug).length;
const augOnly  = okRuns.filter(r => !r.readJune && r.readAug).length;
const noGrid   = okRuns.filter(r => !r.readJune && !r.readAug).length;
const wrongPerson = okRuns.filter(r => !hasRina(r.ansNFC)).length;
const wrongCount  = okRuns.filter(r => !has10(r.ansNFC)).length;

console.log(`\n  Drift breakdown:`);
console.log(`    Read june-only:  ${juneOnly}  (missed August data)`);
console.log(`    Read aug-only:   ${augOnly}   (missed June data)`);
console.log(`    Read no grid:    ${noGrid}    (didn't read xlsx at all)`);
console.log(`    Named wrong person: ${wrongPerson}`);
console.log(`    Said wrong count:   ${wrongCount}`);

// Count values mentioned across all answers (to surface drifted counts)
const allCountMentions = [];
for (const r of okRuns) {
  const matches = (r.ansNFC || "").match(/\b(\d+)\b/g) || [];
  for (const m of matches) {
    const n = parseInt(m, 10);
    if (n >= 5 && n <= 30) allCountMentions.push(n); // plausible participation counts
  }
}
const freq = {};
for (const n of allCountMentions) freq[n] = (freq[n] || 0) + 1;
const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
console.log(`\n  Count values mentioned in answers (plausible range 5-30): ${sorted.map(([k, v]) => `${k}×${v}`).join("  ")}`);

// Token + cost summary
const totalIn  = okRuns.reduce((s, r) => s + r.inputTokens, 0);
const totalOut = okRuns.reduce((s, r) => s + r.outputTokens, 0);
const totalCost = okRuns.reduce((s, r) => s + r.cost, 0);
console.log(`\n── TOKEN + COST ──`);
console.log(`  Total input tokens:  ${totalIn}`);
console.log(`  Total output tokens: ${totalOut}`);
console.log(`  Total cost:          $${totalCost.toFixed(4)}`);
console.log(`  Avg $/question:      $${(totalCost / Math.max(okRuns.length, 1)).toFixed(4)}`);

// ── Honest read ──────────────────────────────────────────────────────────────
console.log(`\n${SEP}`);
console.log(`HONEST READ`);
console.log(SEP);

if (exactHit === okRuns.length) {
  console.log(`  VERDICT: RELIABLE — ${exactHit}/${okRuns.length} runs got EXACTLY ${TOP_PERSON}=10.`);
  console.log(`  Chat-scoping alone (give agent only the right file) is SUFFICIENT.`);
  console.log(`  A deterministic count tool is NOT needed for exact-count accuracy.`);
} else if (exactHit >= Math.ceil(okRuns.length * 0.75)) {
  console.log(`  VERDICT: MOSTLY RELIABLE — ${exactHit}/${okRuns.length} exact hits; ${drifted} drifted.`);
  console.log(`  Drift rate is low enough that further investigation is warranted before adding a tool.`);
} else {
  console.log(`  VERDICT: STILL DRIFTS — only ${exactHit}/${okRuns.length} exact hits.`);
  console.log(`  Even with the RIGHT file isolated, the model's raw count is NOT reliable.`);
  console.log(`  A thin deterministic count tool is needed for exact-grid counts.`);
}

console.log(SEP);

if (runError) { console.error("\nRUNNER ERROR:", runError instanceof Error ? runError.stack : runError); process.exit(1); }
process.exit(exactHit === okRuns.length ? 0 : 1);
