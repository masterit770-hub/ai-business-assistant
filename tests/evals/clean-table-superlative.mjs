// CLEAN-TABLE SUPERLATIVE → the real top group / honest tie, never "only one record" (#80). The
// committed regression gate for the LIMIT-1-hides-the-ranking bug on a CLEAN named table — covering
// BOTH of the verifier's live REDs on her real enrollment CSV:
//   • LK5 (wrong winner / false "only one"): "which course has the most students" / "most popular
//     course" → physics=93 but framed "the only course record provided, so most popular by default"
//     (and a stray run even said "biology 86" — wrong winner AND wrong count).
//   • EG4 (false ABSENCE): "which student enrolls the most" over 1000 distinct students who EACH enroll
//     once → "the evidence contains only ONE student record: <name>, so that student enrolls the most"
//     — a confident lie (claims 1 student, truth 1000).
//
// ROOT CAUSE (one, general): the SQL collapsed the GROUP BY to LIMIT 1, so the generator saw a SINGLE
// row and read it as "the table has only one <category>". The count was right; the FRAMING was
// invented — and for the all-tied-at-1 student case it became a false absence.
//
// THE FIX (text-to-sql prompt, de-band-aided — NO magic number): a "which X has the MOST/LEAST Y"
// count-superlative returns the RANKED groups (ORDER BY DESC, omit LIMIT so the system cap bounds it),
// NOT LIMIT 1. The model then SEES the full ranking → names the top of many for courses, and SEES
// every student at cnt=1 → answers honestly "each enrolls once, no single top" for EG4. Verified
// reliable serial on her real CSV; RED-first proven against the committed pre-fix state.
//
// GROUND TRUTH (computed from the raw CSV): courses (school data 2, course_code): physics = 93 is the
// unique max (next: photography/biology/bible = 90). A plain table-wide COUNT(*) = 1000 (the read is
// exact — there is no truncation; this gate also pins that the count stays exact).
//
// SCOPE NOTE: this gate is SINGLE-TABLE (enrollment only) and reset-ONCE — deliberately. The
// "which vendor has the most" symptom is a separate ROUTER-STRAND (route=[]→general) that belongs to
// the router work (#81), NOT this narration fix; mixing it in would make this gate fail on an
// unrelated cause. Per-question resetStore() is AVOIDED (the #79 harness store-rebuild race).
//
// RUN: node tests/evals/clean-table-superlative.mjs  (SERIAL; SKIPS LOUDLY without creds; residue-
// guard pre/post-flight; ISOLATED throwaway owner created + deleted; never her live accounts).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { skip as skipShared } from "./_skip.mjs";
import { assertCleanBefore, assertCleanAfter } from "./_residue-guard.mjs";

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
if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

const skip = (msg) => skipShared("clean-table-superlative", msg);
const haveSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const haveLlm = !!(process.env.LLM_API_KEY && process.env.LLM_API_KEY.length > 8);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — the throwaway-owner upload path can't run.");
if (!haveLlm) skip("No LLM_API_KEY found (checked .env.local AND .vercel-prod.env) — the answer pipeline makes real LLM calls.");

const ENROLLMENT = path.join(ROOT, "data/school data 2.csv");
if (!fs.existsSync(ENROLLMENT)) skip(`Her enrollment CSV (school data 2.csv) is not on disk.`);

const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}

const { answerQuestion } = await import("../../src/lib/engine/answer.ts");
const { ingestCsv } = await import("../../src/lib/engine/ingest.ts");
const { __resetRuntimeStoreForTests } = await import("../../src/lib/engine/runtime-store.ts");
const { resetStore } = await import("../../src/lib/engine/structured-store.ts");
const { listUploadedTables, deleteUploadedTable } = await import("../../src/lib/engine/structured-rows-store.ts");
const { admin, supabaseEnabled } = await import("../../src/lib/engine/supabase.ts");

if (!supabaseEnabled()) { console.error("supabaseEnabled() false despite env — aborting"); process.exit(1); }

let OWNER = null;
const uploadedTables = [];

async function newOwner() {
  const email = `superlative-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({ email, password: crypto.randomUUID(), email_confirm: true });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  const id = data.user.id;
  // FK-SETTLE: createUser() can return before the auth.users row is FK-visible to uploaded_rows; an
  // immediate ingest then fails the owner_id FK → 0 rows → empty catalog → a spurious miss. Wait for
  // getUserById to confirm visibility before ingesting. (Harness-only; product never hits this.)
  for (let i = 0; i < 15; i++) {
    const g = await admin().auth.admin.getUserById(id);
    if (!g.error && g.data?.user?.id === id) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return id;
}
// Reset ONCE (cold-start sim) — NOT per question (the #79 store-rebuild race wipes the catalog).
let _didColdReset = false;
async function ask(q) {
  if (!_didColdReset) { __resetRuntimeStoreForTests(); resetStore(); _didColdReset = true; }
  return answerQuestion(q, { ownerId: OWNER, role: "member", isDemo: false });
}
const hasNum = (a, n) => new RegExp(`(?<![\\d.,])${n}(?![\\d.,])`).test((a || "").normalize("NFC"));
// The exact RED narration: claiming a LIMIT-1/single-cited row means the table has one category.
const claimsOnlyOne = (a) =>
  /\bonly one\b|\bjust one\b|\bsingle (course|record|row|entry)\b|one course (record|listed)|no other course|there is no data on other|only.*course.*listed/i.test(a || "");

// Repeat the headline assertion N times — this bug was ~50% (a single pass would be a coin-flip
// false-green). Every run must be clean; no pass@K.
const REPEAT = 4;

async function main() {
  OWNER = await newOwner();
  console.log(`\n▶ CLEAN-TABLE SUPERLATIVE — throwaway owner ${OWNER.slice(0, 8)}… (created + deleted)`);
  await ingestCsv(fs.readFileSync(ENROLLMENT, "utf8"), "enrollment.csv", OWNER);
  for (const t of await listUploadedTables(OWNER)) uploadedTables.push(t.table);
  console.log(`  ingested enrollment → tables: ${uploadedTables.join(", ")}`);

  // ── THE FIX: "which course has the most students" → physics 93, NEVER "only one course" (×N) ─────
  for (let i = 0; i < REPEAT; i++) {
    const q = "which course has the most students?";
    const res = await ask(q);
    const a = (res.answer ?? "").normalize("NFC");
    console.log(`\n[course/most #${i}] mode=${res.mode}\n   ${a.replace(/\n/g, " ").slice(0, 220)}`);
    check(`course/most-physics-93-run${i}`, `"${q}" → physics, 93 (the true max), NOT a fabricated "only one course"`,
      res.mode === "grounded" && /physics/i.test(a) && hasNum(a, 93) && !claimsOnlyOne(a),
      `mode=${res.mode} physics=${/physics/i.test(a)} says93=${hasNum(a, 93)} claimsOnlyOne=${claimsOnlyOne(a)}`);
  }

  // ── EG4 — THE FALSE-ABSENCE TRAP (the verifier's 2nd live RED): "which student enrolls the most"
  //    over 1000 distinct students who EACH enroll exactly once. The OLD LIMIT-1 path returned ONE
  //    row and the generator fabricated "the evidence contains only ONE student record: <name>, so
  //    that student enrolls the most" — a confident FALSE ABSENCE (claims 1 student, truth 1000). With
  //    the ranked-groups fix the model SEES every student at cnt=1 → answers honestly that each/every
  //    student enrolls once and there is no single top. We assert it does NOT claim "only one student"
  //    and DOES acknowledge the each-appears-once reality. (×N — the bug was a coin-flip.) ───────────
  for (let i = 0; i < REPEAT; i++) {
    const q = "which student enrolls the most?";
    const res = await ask(q);
    const a = (res.answer ?? "").normalize("NFC");
    console.log(`\n[student/most #${i}] mode=${res.mode}\n   ${a.replace(/\n/g, " ").slice(0, 220)}`);
    // LOAD-BEARING: the answer must NOT crown a lone student as "the most" via the FALSE-ABSENCE
    // claim — "the evidence contains only one student (record)", "only one student appears", "no other
    // students appear". (We must NOT flag an HONEST use like "each shows a single enrollment with cnt 1"
    // — that's the right answer; only the "ONE STUDENT exists" lie is the RED.)
    const claimsOnlyOneStudent =
      /only one student\b|one student (record|listed|appears|exists)|no other students?\b|just one student\b/i.test(a);
    // Honest signal (robust to phrasing): mentions "each/every/all" students, OR a tie/no-single-top,
    // OR explicitly that the data lacks the counts to pick one. Any of these = NOT a false absence.
    const honestNoSingleTop =
      /\b(each|every|all)\b/i.test(a) || /no single|a tie\b|tied\b|equally|same (number|count)/i.test(a) ||
      /does not contain|cannot determine|no .* (most|single)/i.test(a);
    check(`student/no-false-absence-run${i}`, `"${q}" → NOT "only one student" (1000 distinct, each enroll once); no false absence`,
      res.mode === "grounded" && !claimsOnlyOneStudent && honestNoSingleTop,
      `mode=${res.mode} claimsOnlyOneStudent=${claimsOnlyOneStudent} honestNoSingleTop=${honestNoSingleTop}`);
  }

  // ── NO-REGRESSION: the phrasing that already worked must still work ──────────────────────────────
  {
    const q = "what is the most popular course?";
    const res = await ask(q);
    const a = (res.answer ?? "").normalize("NFC");
    console.log(`\n[course/popular] mode=${res.mode}\n   ${a.replace(/\n/g, " ").slice(0, 160)}`);
    check("course/popular-still-physics-93", `"${q}" still → physics, 93 (no regression on the working phrasing)`,
      /physics/i.test(a) && hasNum(a, 93) && !claimsOnlyOne(a), `physics=${/physics/i.test(a)} says93=${hasNum(a, 93)}`);
  }

  // ── NO-REGRESSION: the exact table-wide COUNT is unaffected by the top-N change (read is not truncated) ─
  {
    const q = "how many enrollment records are there?";
    const res = await ask(q);
    const a = (res.answer ?? "").normalize("NFC");
    console.log(`\n[count/total] mode=${res.mode}\n   ${a.replace(/\n/g, " ").slice(0, 140)}`);
    check("count/total-1000", `"${q}" → exactly 1000 (no truncated read)`, hasNum(a, 1000), `says1000=${hasNum(a, 1000)}`);
  }
}

async function cleanup() {
  let tablesDeleted = 0, userDeleted = 0;
  for (const t of uploadedTables) {
    try { const n = await deleteUploadedTable(OWNER, t, false); if (n >= 0) tablesDeleted++; } catch { /* noop */ }
  }
  if (OWNER) {
    for (let attempt = 0; attempt < 4 && userDeleted === 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
      try { await admin().auth.admin.deleteUser(OWNER); } catch { /* fall through */ }
      try {
        const { data, error } = await admin().auth.admin.getUserById(OWNER);
        if ((error && /not found/i.test(error.message)) || !data?.user) userDeleted = 1;
      } catch { /* retry */ }
    }
  }
  console.log(`\n↩ cleanup: tables ${tablesDeleted}/${uploadedTables.length}, owner ${userDeleted}/1 deleted`);
  check("CLEANUP/owner-deleted", "the throwaway owner was deleted (no residue)", userDeleted === 1, `userDeleted=${userDeleted}`);
}

await assertCleanBefore("clean-table-superlative");
let runError = null;
try { await main(); }
catch (e) { runError = e; console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e); }
finally { await cleanup(); }
await assertCleanAfter("clean-table-superlative");

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(`CLEAN-TABLE SUPERLATIVE: ${results.length - fails.length}/${results.length} passed` + (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN"));
if (fails.length || runError) process.exit(1);
process.exit(0);
