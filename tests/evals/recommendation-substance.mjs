// RECOMMENDATION-SUBSTANCE eval — the gate for the client requirement (Jenny):
//
//   "im happy it [got] right the truth about the alimony but still needs to give me an
//    'open ai' recommendation."
//
// THE BEHAVIOUR (general, no corpus tuning): when the documents do NOT fully cover a
// recommendation/advice/"how should I" question, the assistant must NOT dead-end with
// "that information isn't in your documents" / "you'd need the X pages" / "please provide a
// different document". It must (a) ground on whatever the file DOES contain, (b) be honest
// about the gap, AND (c) STILL give a substantive, actionable recommendation from general
// knowledge — the ChatGPT-style answer the user expects. It must never refuse a general
// question and never punt to "go give me another file".
//
// This eval asserts REAL SUBSTANCE (not just "no fabrication"): a passing answer is long
// enough to be a real answer, carries ACTIONABLE structure (multiple concrete steps/options),
// and is NOT a refusal / dead-end / "provide another document" punt. It runs each question on
// N fresh, independent runs and gates STRICT N/N (no pass@K) — a single dead-end run FAILS,
// exactly because the bug was intermittent.
//
// CORPORA (the real modules + data the live route uses):
//   • DEMO ADMIN (bundled Carter case file) — the alimony question Jenny named, where the
//     file partly covers the matter (incomes, the child-support judgment) but does NOT spell
//     out an alimony strategy → must ground the facts AND give the strategy recommendation.
//   • GMAIL USER (her one Hebrew national-service handover file) — a general best-practices
//     recommendation her file CANNOT answer → must still give concrete recommendations, never
//     "I would need a document that…".
//
// RUN:  node tests/evals/recommendation-substance.mjs
//   RECOMMENDATION_RUNS=N overrides (default 3; floor 3). Loads the LLM key + Supabase creds
//   from local secret files (read, NEVER printed). SKIPS LOUDLY (exit 0) if either is absent.
// SECURITY: reads .env.local / .secrets/supabase.env / .vercel-prod.env into process.env but
// NEVER prints, echoes, logs, or commits any secret value.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skip as skipShared } from "./_skip.mjs";

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
const haveLlm = !!(process.env.LLM_API_KEY && process.env.LLM_API_KEY.length > 8);

// Exit code is honest under CI_STRICT/REQUIRE_CREDS: a creds-skip in CI is a FAILURE
// (exit 1), never a silent pass. The loud "NOT a pass" banner prints in either mode. See _skip.mjs.
const skip = (msg) => skipShared("recommendation-substance", msg);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — the real corpora can't run.");
if (!haveLlm) skip("No LLM_API_KEY found — the answer pipeline makes real LLM calls and can't run.");

// STRICT N/N — never pass@K. Floor 3 (the dead-end was intermittent; one bad run must fail).
const RUNS = Math.max(3, Number(process.env.RECOMMENDATION_RUNS || 3));

const { answerQuestion } = await import("../../src/lib/engine/answer.ts");
const { __resetRuntimeStoreForTests } = await import("../../src/lib/engine/runtime-store.ts");
const { resetStore } = await import("../../src/lib/engine/structured-store.ts");
const { supabaseEnabled } = await import("../../src/lib/engine/supabase.ts");

const GMAIL = { ownerId: "b01c311e-bd28-4e43-ab1e-d6825bfeb929", isDemo: false, role: "member" };
const DEMO_ADMIN = { isDemo: true, role: "admin" };

// ── SUBSTANCE GRADER ─────────────────────────────────────────────────────────────
// A DEAD-END / PUNT phrasing the answer must NOT use — "I can't help without another
// document", "please provide a different document", "you'd need the X pages", "cannot
// ground any recommendations". This is the exact failure the client flagged. (EN + HE.)
const DEADEND_EN =
  /(provide (a |another |me )?(different |another )?document|i would need (a|another|more) document|please provide (a|another|more)|cannot ground any (recommendation|advice)|if you have a different (document|file)|you'?d need (to (look|refer)|the .{0,30}(pages?|disclosure))|i can only (answer|help|assist).{0,30}(your )?(uploaded )?documents?|unable to (provide|give).{0,30}(recommendation|advice))/i;
const DEADEND_HE =
  /(תספק(י)? (לי )?מסמך|אני זקוק למסמך|צריך(ה)? מסמך אחר|אם יש לך מסמך אחר|לא יכול(ה)? לתת המלצ|אין לי מספיק מידע כדי)/;
const isDeadEnd = (a) => DEADEND_EN.test(a || "") || DEADEND_HE.test(a || "");

// ACTIONABLE STRUCTURE — substance, NOT a specific FORMAT. A real recommendation makes
// several concrete points; the model legitimately writes them as a numbered/bulleted LIST on
// some runs and as multiple PROSE PARAGRAPHS on others. Both are substantive — grading only
// list markers would FALSE-FAIL a perfectly good multi-paragraph recommendation (a real miss
// I hit: a 3.3k-char, fully-cited, no-dead-end alimony strategy written as prose scored 0
// bullets). So we count "actionable units" = list markers OR distinct substantial paragraphs
// (blank-line-separated blocks with real content). Either way a single hedging sentence never
// reaches the threshold, and a genuine multi-point answer always does — regardless of format.
function actionableUnits(a) {
  const text = String(a || "");
  let markers = 0;
  for (const l of text.split("\n")) if (/^\s*(\d+[.)]|[-*•])\s+\S/.test(l)) markers++;
  // Substantial paragraphs: blank-line-separated blocks ≥120 chars (a one-line header/
  // transition doesn't count as a "point").
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length >= 120);
  // Score on whichever structure the answer used (the max), so a bulleted answer is graded on
  // its bullets and a prose answer on its paragraphs.
  return Math.max(markers, paras.length);
}

// A substantive recommendation: not a dead-end/punt, long enough to be a real answer, AND
// carrying several actionable points (in EITHER list or prose form). `mustGround` adds: at
// least one required cited fact is present (it grounded on what the file DOES contain before
// giving the general recommendation).
function gradeRecommendation(res, { mustGroundFacts = [] } = {}) {
  const a = res.answer ?? "";
  if (isDeadEnd(a)) return { ok: false, why: "dead-ended / punted to 'provide another document' instead of giving a recommendation" };
  if (a.length < 600) return { ok: false, why: `answer too short to be a substantive recommendation (len=${a.length})` };
  const units = actionableUnits(a);
  if (units < 3) return { ok: false, why: `not enough actionable points (found ${units} list-items/substantial-paragraphs, need ≥3)` };
  for (const f of mustGroundFacts) {
    if (!(f instanceof RegExp ? f.test(a) : a.includes(f))) {
      return { ok: false, why: `did not ground on the required file fact before recommending: ${f}` };
    }
  }
  return { ok: true };
}

const QUESTIONS = [
  {
    id: "EN/alimony-recommendation",
    ctx: DEMO_ADMIN,
    q: "if i were to be a senior lawyer on the carters case how would i present michaels case in order for him to pay less alimony?",
    // Must ground the real incomes / child-support judgment AND give a substantive strategy.
    grade: (res) => gradeRecommendation(res, { mustGroundFacts: [/130[\s,]?000|95[\s,]?000|1[\s,]?285/] }),
  },
  {
    id: "EN/alimony-next-steps",
    ctx: DEMO_ADMIN,
    q: "What practical steps should Michael take over the next 6 months to improve his position on his financial obligations, and what documents should he gather?",
    grade: (res) => gradeRecommendation(res),
  },
  {
    id: "EN/general-handover-bestpractice",
    ctx: GMAIL,
    // Her national-service handover file CANNOT answer a general best-practices question —
    // the dead-end exhibit ("I would need a document that discusses handover best practices").
    q: "Based on best practices, how should I structure a smooth handover process in general? Give me concrete recommendations.",
    grade: (res) => gradeRecommendation(res),
  },
  {
    id: "HE/handover-recommendation",
    ctx: GMAIL,
    q: "תן לי המלצות מעשיות איך לנהל חפיפה טובה עם הבת הבאה, גם דברים שלא כתובים בקובץ.",
    grade: (res) => gradeRecommendation(res),
  },
];

const results = [];
function record(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}

async function runQuestion(item) {
  let passes = 0;
  const fails = [];
  for (let i = 0; i < RUNS; i++) {
    __resetRuntimeStoreForTests();
    resetStore();
    const res = await answerQuestion(item.q, { ...item.ctx });
    const g = item.grade(res);
    if (g.ok) passes++;
    else fails.push(`run${i + 1}: ${g.why} :: mode=${res.mode} len=${(res.answer || "").length} :: "${(res.answer || "").slice(0, 140).replace(/\n/g, " ")}"`);
  }
  const ok = passes === RUNS;
  record(`REC/${item.id}`, `substantive recommendation (no dead-end) on ${RUNS}/${RUNS} fresh runs — measured ${passes}/${RUNS}`,
    ok, ok ? "" : `FAILED runs:\n         ↳ ${fails.join("\n         ↳ ")}`);
  return ok;
}

async function main() {
  record("ENV/supabase", "the engine sees Supabase as configured (real corpora live)", supabaseEnabled());
  if (!supabaseEnabled()) throw new Error("supabaseEnabled() is false despite env — aborting to avoid a meaningless run");
  console.log(`\n▶ RECOMMENDATION SUBSTANCE — STRICT ${RUNS}/${RUNS} per question (no pass@K). ${QUESTIONS.length} partial-coverage advice questions.`);
  for (const item of QUESTIONS) await runQuestion(item);
}

let runError = null;
try { await main(); } catch (e) { runError = e; console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e); }

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(`RECOMMENDATION SUBSTANCE: ${results.length - fails.length}/${results.length} gates passed` + (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN"));
if (fails.length || runError) process.exit(1);
process.exit(0);
