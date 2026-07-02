// AGENTIC BASELINE (#81) — measures the pure raw-read baseline of the Claude Agent SDK.
//
// SETUP:
//   1. Create a THROWAWAY owner (isDemo:false; @nucleus-eval.invalid domain).
//   2. Store 4 files UNPROCESSED via storeOriginalFile() — raw bytes only, NO ingestXlsx/ingestPdf.
//      Files: 2 Hebrew scheduling xlsx grids, Carter MOCK PDF, enrollment CSV.
//   3. Build answerAgentic() (SDK query() + createSdkMcpServer) with EXACTLY TWO tools:
//        list_files()       → [{docId, name, type}]
//        read_file({docId}) → parsed content (xlsx → full grid; pdf → text; csv → all rows)
//      NO SQL, no tally, no RAG, no grep. Model PICKS which file to read.
//   4. Measure across 5+3+3 serial runs. Report per-question answer, file picked, token cost.
//   5. CLEANUP: delete all storage objects + throwaway owner. Residue guard: 0/0 before+after.
//
// GROUND TRUTH:
//   Grid (June + August xlsx):  top participant = רינה אנטוב, 10 appearances
//   Carter MOCK PDF petitioner:  Joni Carter
//   Carter children:             Emma, Noah, Olivia (NOT Beyoncé)
//
// RUN: node tests/evals/agentic-baseline.mjs
//   Requires: Supabase creds (SUPABASE_URL + SERVICE_ROLE_KEY)
//   Auth:     Claude CLI subscription (SDK falls back to CLI creds if no ANTHROPIC_API_KEY)

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

const skip = (msg) => skipShared("agentic-baseline", msg);

// ── Pre-flight checks ────────────────────────────────────────────────────────
const haveSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — the throwaway-owner upload path can't run.");

// Resolve her files by stable substrings (avoid hardcoding mangled names)
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

const JUNE_PATH  = findBySubstring("יוני", ".xlsx");
const AUG_PATH   = findBySubstring("אוגוסט", ".xlsx");
const CARTER_MOCK_PATH = findBySubstring("FAMILY COURT", ".pdf");
const ENROLLMENT_PATH = path.join(ROOT, "data", "school data 1.csv"); // ~1000 rows

if (!JUNE_PATH || !AUG_PATH) skip(`Her scheduling xlsx not on disk (June=${!!JUNE_PATH}, Aug=${!!AUG_PATH}) — cannot run.`);
if (!CARTER_MOCK_PATH) skip("Carter MOCK PDF not found in data/ — cannot run.");
if (!fs.existsSync(ENROLLMENT_PATH)) skip("school data 1.csv not found — cannot run.");

// ── Imports ─────────────────────────────────────────────────────────────────
const { admin, supabaseEnabled } = await import("../../src/lib/engine/supabase.ts");
const { storeOriginalFile } = await import("../../src/lib/engine/doc-files.ts");
const { answerAgentic } = await import("../../src/lib/engine/agentic.ts");

if (!supabaseEnabled()) { console.error("supabaseEnabled() false — aborting"); process.exit(1); }

// ── State ────────────────────────────────────────────────────────────────────
let OWNER = null;
const STORED_DOC_IDS = []; // track what we stored for cleanup
const results = [];
const runResults = []; // raw per-run data for the report

function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a throwaway owner + FK-settle */
async function newOwner() {
  const email = `agentic-baseline-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password: crypto.randomUUID(),
    email_confirm: true,
  });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  return settleOwner(data.user.id);
}

/** Sanitize a filename to a storage-safe docId (ASCII-only, no spaces). */
function safeDocId(filename) {
  // Encode non-ASCII characters + replace spaces with underscores
  return filename
    .replace(/[^\x00-\x7F]/g, (c) => `U${c.codePointAt(0).toString(16).padStart(4,'0')}`)
    .replace(/\s+/g, "_");
}

/** Store raw bytes under the throwaway owner. Returns {docId, displayName}. */
async function storeRaw(filePath, hintName) {
  const buf = new Uint8Array(fs.readFileSync(filePath));
  const displayName = hintName || path.basename(filePath);
  const docId = safeDocId(displayName);
  const stored = await storeOriginalFile(buf, OWNER, docId, displayName);
  if (!stored) throw new Error(`storeOriginalFile returned false for ${displayName} — Supabase storage may be unavailable`);
  STORED_DOC_IDS.push(docId);
  return { docId, displayName };
}

/** Delete all stored objects + auth user */
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

// ── Haiku pricing (input/output $/1M tokens as of 2025) ──────────────────────
// claude-haiku-4-5: $0.80/$4.00 per 1M tokens
const INPUT_COST_PER_M  = 0.80;
const OUTPUT_COST_PER_M = 4.00;
function estimateCost(inp, out) {
  return (inp / 1_000_000) * INPUT_COST_PER_M + (out / 1_000_000) * OUTPUT_COST_PER_M;
}

/** Run one agentic question; return result + timing */
async function ask(label, question) {
  console.log(`\n  [${label}] "${question.normalize("NFC").slice(0, 60)}"`);
  const t0 = Date.now();
  try {
    const r = await answerAgentic(question, OWNER);
    const ms = Date.now() - t0;
    const cost = estimateCost(r.inputTokens, r.outputTokens);
    const filesReadNames = r.filesRead.map(id => id).join(", ") || "(none)";
    console.log(`    ↳ picked: ${filesReadNames} | turns=${r.turns} | in=${r.inputTokens} out=${r.outputTokens} | $${cost.toFixed(4)}`);
    const shortAnswer = r.answer.normalize("NFC").replace(/\n/g, " ").slice(0, 200);
    console.log(`    ↳ answer: ${shortAnswer}`);
    return { label, question, answer: r.answer, filesRead: r.filesRead, filesListed: r.filesListed,
             inputTokens: r.inputTokens, outputTokens: r.outputTokens, cost, ms, ok: true };
  } catch (e) {
    const ms = Date.now() - t0;
    console.error(`    ✗ ERROR: ${e instanceof Error ? e.message : e}`);
    return { label, question, answer: "", filesRead: [], filesListed: [], inputTokens: 0, outputTokens: 0, cost: 0, ms, ok: false, error: e?.message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // RESIDUE GUARD: abort if DB is dirty from a prior leaked run
  await assertCleanBefore("agentic-baseline");

  OWNER = await newOwner();
  console.log(`\n▶ AGENTIC BASELINE — throwaway owner ${OWNER.slice(0, 8)}… (created; will be deleted)`);

  // Store 4 files RAW (no decomposition into uploaded_rows or doc_chunks)
  console.log("\n── Storing raw files (unprocessed bytes) ──");
  const june   = await storeRaw(JUNE_PATH,        path.basename(JUNE_PATH));
  const aug    = await storeRaw(AUG_PATH,         path.basename(AUG_PATH));
  const carter = await storeRaw(CARTER_MOCK_PATH, path.basename(CARTER_MOCK_PATH));
  const enroll = await storeRaw(ENROLLMENT_PATH,  path.basename(ENROLLMENT_PATH));

  // Store a small metadata index so list_files can return human-readable names
  const fileIndex = [
    { docId: june.docId,   displayName: june.displayName.normalize("NFC"),   type: "spreadsheet" },
    { docId: aug.docId,    displayName: aug.displayName.normalize("NFC"),     type: "spreadsheet" },
    { docId: carter.docId, displayName: carter.displayName.normalize("NFC"), type: "pdf" },
    { docId: enroll.docId, displayName: enroll.displayName,                  type: "csv" },
  ];
  const indexBuf = new TextEncoder().encode(JSON.stringify(fileIndex, null, 2));
  const indexStored = await storeOriginalFile(new Uint8Array(indexBuf), OWNER, "_files.json", "_files.json");
  if (indexStored) STORED_DOC_IDS.push("_files.json");

  console.log(`  stored: ${STORED_DOC_IDS.length} files (incl. index) under owner ${OWNER.slice(0, 8)}…`);
  console.log(`  june docId=${june.docId.slice(0,25)}… (${june.displayName.normalize("NFC").slice(0,20)}…)`);
  console.log(`  aug  docId=${aug.docId.slice(0,25)}… (${aug.displayName.normalize("NFC").slice(0,20)}…)`);
  console.log(`  carter docId=${carter.docId.slice(0,25)}… | enroll docId=${enroll.docId}`);

  // ══ QUESTION SET 1: Grid — "who participates the most?" (5 runs) ═══════════
  console.log("\n══ Q1: Grid questions (5 serial runs) ══");
  const GRID_QUESTIONS = [
    { id: "G1", q: "who participates the most?" },
    { id: "G2", q: "מי משתתפת הכי הרבה?" },
    { id: "G3", q: "who is more active?" },
    { id: "G4", q: "who participates the most?" },    // run again for consistency
    { id: "G5", q: "מי משתתפת הכי הרבה?" },          // run again for consistency
  ];

  const gridRuns = [];
  for (const { id, q } of GRID_QUESTIONS) {
    const r = await ask(id, q);
    gridRuns.push(r);
    runResults.push({ ...r, section: "grid" });
  }

  // Grade grid runs: does agent pick the xlsx, answer רינה אנטוב = 10?
  const TOP = "רינה אנטוב";
  const hasNum10 = (a) => /(?<![0-9])10(?![0-9])/.test((a || "").normalize("NFC"));
  const pickedGrid = (r) => r.filesRead.some(id => id.normalize("NFC").includes("יוני") || id.normalize("NFC").includes("אוגוסט") || id.normalize("NFC").toLowerCase().includes("xlsx") || id.normalize("NFC").toLowerCase().endsWith(".xlsx"));

  for (const r of gridRuns) {
    const a = (r.answer || "").normalize("NFC");
    const hasRina = a.includes(TOP);
    const has10   = hasNum10(a);
    const picked  = pickedGrid(r);
    check(`grid/${r.label}/picked-xlsx`, `${r.label}: agent picked xlsx grid file(s)`, picked, `filesRead=${r.filesRead.join(",")}`);
    check(`grid/${r.label}/named-rina`, `${r.label}: answer names רינה אנטוב`, hasRina, `answer[:100]=${a.slice(0,100)}`);
    check(`grid/${r.label}/says-10`, `${r.label}: answer says 10`, has10, `answer[:100]=${a.slice(0,100)}`);
  }

  // ══ QUESTION SET 2: Carter MOCK PDF — petitioner (3 runs) ════════════════
  console.log("\n══ Q2: Carter PDF — petitioner (3 runs) ══");
  const PETITIONER_QUESTIONS = [
    { id: "P1", q: "who is the petitioner?" },
    { id: "P2", q: "who is the petitioner?" },
    { id: "P3", q: "who is the petitioner?" },
  ];

  const petRuns = [];
  for (const { id, q } of PETITIONER_QUESTIONS) {
    const r = await ask(id, q);
    petRuns.push(r);
    runResults.push({ ...r, section: "petitioner" });
  }

  const pickedCartePDF = (r) => r.filesRead.some(id => id.toUpperCase().includes("FAMILY") || id.toUpperCase().includes("COURT") || id.toUpperCase().includes("MOCK") || id.toLowerCase().endsWith(".pdf"));
  for (const r of petRuns) {
    const a = (r.answer || "").normalize("NFC").toLowerCase();
    const hasJoni = a.includes("joni");
    const noBeyonce = !a.includes("beyonc");
    const picked = pickedCartePDF(r);
    check(`petitioner/${r.label}/picked-pdf`, `${r.label}: picked Carter PDF`, picked, `filesRead=${r.filesRead.join(",")}`);
    check(`petitioner/${r.label}/joni`, `${r.label}: names Joni (petitioner)`, hasJoni, `answer[:120]=${a.slice(0,120)}`);
    check(`petitioner/${r.label}/no-beyonce`, `${r.label}: does NOT say Beyoncé`, noBeyonce, `answer[:120]=${a.slice(0,120)}`);
  }

  // ══ QUESTION SET 3: Carter MOCK PDF — children (3 runs) ════════════════════
  console.log("\n══ Q3: Carter PDF — children (3 runs) ══");
  const CHILDREN_QUESTIONS = [
    { id: "C1", q: "how many children do the Carters have?" },
    { id: "C2", q: "how many children do the Carters have?" },
    { id: "C3", q: "how many children do the Carters have?" },
  ];

  const childRuns = [];
  for (const { id, q } of CHILDREN_QUESTIONS) {
    const r = await ask(id, q);
    childRuns.push(r);
    runResults.push({ ...r, section: "children" });
  }

  const CARTER_CHILDREN = ["emma", "noah", "olivia"];
  const hasChildren3 = (a) => {
    const lower = (a || "").toLowerCase();
    return CARTER_CHILDREN.every(name => lower.includes(name));
  };
  const noBeyonceInAnswer = (a) => !(a || "").toLowerCase().includes("beyonc");

  for (const r of childRuns) {
    const a = r.answer || "";
    const allThree = hasChildren3(a);
    const noBeyonce = noBeyonceInAnswer(a);
    const picked = pickedCartePDF(r);
    check(`children/${r.label}/picked-pdf`, `${r.label}: picked Carter PDF`, picked, `filesRead=${r.filesRead.join(",")}`);
    check(`children/${r.label}/all-three-children`, `${r.label}: names Emma, Noah, Olivia`, allThree, `answer[:150]=${a.normalize("NFC").slice(0,150)}`);
    check(`children/${r.label}/no-beyonce`, `${r.label}: does NOT invent Beyoncé`, noBeyonce, `answer[:150]=${a.normalize("NFC").slice(0,150)}`);
  }
}

// ── Cleanup + residue guard ───────────────────────────────────────────────────
let runError = null;
try { await main(); }
catch (e) { runError = e; console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e); }
finally { await cleanup(); }

await assertCleanAfter("agentic-baseline");

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(80)}`);
console.log(`AGENTIC BASELINE (#81) — RESULTS`);
console.log(`${"═".repeat(80)}`);

// Per-section summary
function sectionReport(section, runs) {
  const s = runResults.filter(r => r.section === section);
  if (!s.length) return;
  console.log(`\n── ${section.toUpperCase()} (${s.length} runs) ──`);
  const totalIn  = s.reduce((acc, r) => acc + r.inputTokens, 0);
  const totalOut = s.reduce((acc, r) => acc + r.outputTokens, 0);
  const totalCost = s.reduce((acc, r) => acc + r.cost, 0);
  for (const r of s) {
    const ans = r.answer.normalize("NFC").replace(/\n/g, " ").slice(0, 120);
    console.log(`  [${r.label}] files=${r.filesRead.map(x => x.normalize("NFC").slice(0,18)).join(", ")||"(none)"}`);
    console.log(`         in=${r.inputTokens} out=${r.outputTokens} $${r.cost.toFixed(4)} | ${ans}`);
  }
  console.log(`  TOTAL: in=${totalIn} out=${totalOut} cost=$${totalCost.toFixed(4)}`);
  console.log(`  $/question avg: $${(totalCost/s.length).toFixed(4)}`);
}

sectionReport("grid", runResults);
sectionReport("petitioner", runResults);
sectionReport("children", runResults);

// Answer consistency
console.log("\n── CONSISTENCY CHECK ──");
const gridAnswers = runResults.filter(r => r.section === "grid").map(r => r.answer.normalize("NFC"));
const rina_hits = gridAnswers.filter(a => a.includes("רינה אנטוב")).length;
const ten_hits  = gridAnswers.filter(a => /(?<![0-9])10(?![0-9])/.test(a)).length;
console.log(`  Grid (${gridAnswers.length} runs): רינה אנטוב=${rina_hits}/${gridAnswers.length}, says-10=${ten_hits}/${gridAnswers.length}`);

const petAnswers = runResults.filter(r => r.section === "petitioner").map(r => r.answer.toLowerCase());
const joni_hits  = petAnswers.filter(a => a.includes("joni")).length;
console.log(`  Petitioner (${petAnswers.length} runs): Joni=${joni_hits}/${petAnswers.length}`);

const childAnswers = runResults.filter(r => r.section === "children").map(r => r.answer.toLowerCase());
const all3_hits  = childAnswers.filter(a => ["emma","noah","olivia"].every(n => a.includes(n))).length;
const beyonce_hits = childAnswers.filter(a => a.includes("beyonc")).length;
console.log(`  Children (${childAnswers.length} runs): all-3-kids=${all3_hits}/${childAnswers.length}, Beyoncé-halluc=${beyonce_hits}/${childAnswers.length}`);

// Overall score
const fails = results.filter(r => !r.ok);
console.log(`\n${"═".repeat(80)}`);
console.log(`TOTAL: ${results.length - fails.length}/${results.length} checks passed` +
  (fails.length ? ` · FAILED: ${fails.map(f => f.id).join(", ")}` : " · ALL GREEN"));
if (fails.length || runError) process.exit(1);
process.exit(0);
