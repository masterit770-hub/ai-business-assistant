// PARTICIPATION COUNT over HER REAL scheduling sheets — the committed regression gate for the exact
// bug Jenny reported in her own words. She asked "who participates the most?" / "מי משתתפת הכי הרבה?"
// and got "names not in the excel / numbers wrong": the answer came back in GENERAL mode ("unable to
// find participation counts"), because the occurrence-cue detector did NOT recognize participate(s)/
// participation/משתתף/משתתפת/השתתפות as occurrence-ranking cues over a calendar GRID — so the cell-tally
// lane never fired. "Participating in a monthly schedule" IS a name recurring across the grid's cells,
// the same as "scheduled / appears"; the fix adds that synonym class to the cue.
//
// GROUND TRUTH (lead-computed from the raw xlsx, June + August combined): the person who participates
// MOST is רינה אנטוב, 10 occurrences. The OLD over-count bug said 18. The activity-as-person trap:
// "חדר מתנות" (gift room) is an ACTIVITY appearing 8× in August — it must NOT be crowned a participant.
//
// This ingests her TWO real xlsx under a THROWAWAY owner, asks all three phrasings, asserts every one
// → רינה אנטוב, 10 (cell-tally lane fired, mode=grounded, NOT 18, NOT an activity), then DELETES the
// owner + tables. It NEVER touches her live accounts. PII discipline: it prints only the single top
// name + aggregate counts, never the roster.
//
// RUN: node tests/evals/participation-count-her-data.mjs  (SERIAL; SKIPS LOUDLY without creds OR if her
// two source xlsx are not on disk — never a false green). Reads the LLM key + Supabase creds from
// .env.local OR .vercel-prod.env OR .secrets/supabase.env.

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

const skip = (msg) => skipShared("participation-count-her-data", msg);
const haveSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const haveLlm = !!(process.env.LLM_API_KEY && process.env.LLM_API_KEY.length > 8);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — the throwaway-owner upload path can't run.");
if (!haveLlm) skip("No LLM_API_KEY found (checked .env.local AND .vercel-prod.env) — the answer pipeline makes real LLM calls.");

// Resolve her two real source xlsx by a STABLE Hebrew month substring (the August file's bytes are
// mangled on disk, so we never hardcode the full name). NFC-normalize both sides before matching.
function findByMonth(monthHe) {
  const wanted = monthHe.normalize("NFC");
  const dir = path.join(ROOT, "data");
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    if (name.normalize("NFC").includes(wanted) && name.toLowerCase().endsWith(".xlsx")) {
      return path.join(dir, name);
    }
  }
  return null;
}
const JUNE = findByMonth("יוני");
const AUGUST = findByMonth("אוגוסט");
if (!JUNE || !AUGUST) {
  skip(`Her two scheduling xlsx are not on disk under data/ (June=${!!JUNE}, August=${!!AUGUST}) — cannot run the real-data gate.`);
}

const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}

const { answerQuestion } = await import("../../src/lib/engine/answer.ts");
const { ingestXlsx } = await import("../../src/lib/engine/ingest.ts");
const { __resetRuntimeStoreForTests } = await import("../../src/lib/engine/runtime-store.ts");
const { resetStore } = await import("../../src/lib/engine/structured-store.ts");
const { listUploadedTables, deleteUploadedTable } = await import("../../src/lib/engine/structured-rows-store.ts");
const { admin, supabaseEnabled } = await import("../../src/lib/engine/supabase.ts");

if (!supabaseEnabled()) { console.error("supabaseEnabled() false despite env — aborting"); process.exit(1); }

const TOP = "רינה אנטוב";        // ground-truth top participant (June + August combined)
const TOP_COUNT = 10;            // her exact occurrence count
const OLD_WRONG = 18;            // the over-count bug's wrong number
const ACTIVITY_TRAP = "חדר מתנות"; // an ACTIVITY (gift room) that recurs 8× — never a participant

let OWNER = null;
const uploadedTables = [];

async function newOwner() {
  const email = `participation-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({ email, password: crypto.randomUUID(), email_confirm: true });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  return data.user.id;
}
// Reset the in-memory stores ONCE before the first question (a cold-start simulation: the answer
// pipeline must rehydrate the owner's durable rows). We do NOT reset between every question: doing a
// synchronous resetStore() immediately before each answerQuestion, back-to-back with no settle, races
// the async SQLite handle rebuild and intermittently leaves the catalog EMPTY for the next turn (the
// router then sees no tables → route=[] → general). That race is a HARNESS artifact of hammering the
// reset, not the routing logic under test — proven by a durable-row probe: with a tiny inter-turn
// settle the catalog stays at 107 rows and every phrasing routes structured+grounded. A real product
// turn never resets the store mid-session. (The cold-start rehydration path itself is covered by
// cold-start-durability.mjs, which resets ONCE then asks.)
let _didColdReset = false;
async function ask(q) {
  if (!_didColdReset) {
    __resetRuntimeStoreForTests();
    resetStore();
    _didColdReset = true;
  }
  return answerQuestion(q, { ownerId: OWNER, role: "member", isDemo: false });
}
const hasNum = (a, n) => new RegExp(`(?<![\\d.,])${n}(?![\\d.,])`).test((a || "").normalize("NFC"));

async function main() {
  // RESIDUE GUARD (task #79): refuse to run over a DB that a prior leaked run left dirty —
  // a polluted catalog produces a FALSE GREEN. Aborts loudly (exit 1) if not residue-clean.
  await assertCleanBefore("participation-count-her-data");
  OWNER = await newOwner();
  console.log(`\n▶ PARTICIPATION COUNT (her real June+August xlsx) — throwaway owner ${OWNER.slice(0, 8)}… (created + deleted)`);

  for (const p of [JUNE, AUGUST]) {
    const buf = new Uint8Array(fs.readFileSync(p));
    const r = await ingestXlsx(buf, path.basename(p), OWNER);
    console.log(`  ingested ${path.basename(p).normalize("NFC").slice(0, 18)}… → ${r.rows} rows, ${r.sheets} sheet(s)`);
  }
  // ingestXlsx returns ONE base name, but a multi-sheet workbook persists several real tables under
  // sanitized names. Enumerate the owner's ACTUAL uploaded tables so cleanup deletes every one (no
  // residue) — never trust an assumed table name.
  for (const t of await listUploadedTables(OWNER)) uploadedTables.push(t.table);

  // The THREE phrasings she + we used. ALL must reach the cell-tally lane (grounded mode) and report
  // the ground-truth top participant with the EXACT count — never the over-count 18, never an activity.
  // The verbatim phrasings she + the lead used — DELIBERATELY spanning words a cue-list would miss
  // ("more active", "פעילה") to prove the trigger is phrasing-independent (LLM intent, no regex).
  const phrasings = [
    { id: "EN-participates", q: "who participates the most?" },
    { id: "HE-participates", q: "מי משתתפת הכי הרבה?" },
    { id: "EN-more-active", q: "who is more active?" },
    { id: "HE-active", q: "מי הכי פעילה?" },
    { id: "EN-scheduled", q: "who is scheduled the most across the schedules?" },
  ];

  async function assertPhrasing(idPrefix, q) {
    const res = await ask(q);
    const a = (res.answer ?? "").normalize("NFC");
    const oneLine = a.replace(/\n/g, " ");
    console.log(`\n[${idPrefix}] route=${JSON.stringify(res.route?.sources)} mode=${res.mode} sql="${(res.inspector?.structuredSql || "—").slice(0, 70)}"\n   ${oneLine.slice(0, 300)}`);
    // HARD outcome: names the ground-truth top participant, states 10, NOT 18, NOT the gift-room activity.
    check(`${idPrefix}/top-is-rina-10`,
      `"${q}" → names ${TOP}, count ${TOP_COUNT} (NOT ${OLD_WRONG}, NOT the gift-room activity)`,
      a.includes(TOP) && hasNum(a, TOP_COUNT) && !hasNum(a, OLD_WRONG) && !a.includes(ACTIVITY_TRAP),
      `names=${a.includes(TOP)} says${TOP_COUNT}=${hasNum(a, TOP_COUNT)} says${OLD_WRONG}=${hasNum(a, OLD_WRONG)} activityLeak=${a.includes(ACTIVITY_TRAP)}`);
    // The answer must be GROUNDED (the cell-tally lane fired), not the GENERAL "unable to find" deflection.
    check(`${idPrefix}/grounded-not-general`,
      `"${q}" answered in grounded mode (cell-tally fired), not the general "unable to find" deflection`,
      res.mode === "grounded" && !/unable to find|couldn't find|cannot find|no participation/i.test(a),
      `mode=${res.mode}`);
  }

  // ── PHASE 1: the live path (router LLM decides). Proves the end-to-end answer is correct. ─────────
  console.log("\n── PHASE 1: live router decision ──");
  for (const { id, q } of phrasings) await assertPhrasing(id, q);

  // ── PHASE 2: the WORST CASE — force the router LLM to return an EMPTY route, exactly the
  //    non-determinism that stranded these questions live (route=[] → ungrounded general → "names not
  //    in the excel"). The grid-cell routing GUARD must rescue the question anyway via the intent
  //    classifier. ONE representative phrasing proves the guard fires when the router is empty (it's a
  //    guard-rescue proof, not a per-phrasing sweep — the phrasing-independence is already covered by
  //    PHASE 1's five phrasings). Without the guard this fails (the proven RED: route stays []). We use
  //    ONE phrasing here deliberately to keep the LLM-call count low — forcing the router empty makes
  //    EVERY turn pay the rescue classifier, and a long forced-empty sweep was exhausting the shared
  //    dev key mid-run (a provider rate-limit cascade, not a logic failure). ───────────────────────
  console.log("\n── PHASE 2: router LLM FORCED empty (the guard must rescue) ──");
  process.env.__ROUTER_FORCE_EMPTY = "1";
  try {
    await assertPhrasing("forced-empty/HE-participates", "מי משתתפת הכי הרבה?");
  } finally {
    delete process.env.__ROUTER_FORCE_EMPTY;
  }
}

async function cleanup() {
  let tablesDeleted = 0, userDeleted = 0;
  for (const t of uploadedTables) {
    try { const n = await deleteUploadedTable(OWNER, t, false); if (n >= 0) tablesDeleted++; } catch { /* noop */ }
  }
  // Delete the auth user, retrying on a transient blip — a throwaway owner left behind corrupts the
  // next run's catalog → a false green (the recorded miss). Ground truth is "is the user GONE", not
  // "did this one call return error:null": a transient first call can error WHILE the delete lands, so
  // the retry then sees "User not found" — which means SUCCESS, not failure. We verify with
  // getUserById and treat not-found as deleted.
  if (OWNER) {
    for (let attempt = 0; attempt < 4 && userDeleted === 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
      try { await admin().auth.admin.deleteUser(OWNER); } catch { /* fall through to the existence check */ }
      // Authoritative check: is the user actually gone now?
      try {
        const { data, error } = await admin().auth.admin.getUserById(OWNER);
        if ((error && /not found/i.test(error.message)) || !data?.user) userDeleted = 1;
      } catch { /* retry */ }
    }
  }
  console.log(`\n↩ cleanup: tables ${tablesDeleted}/${uploadedTables.length}, owner ${userDeleted}/1 deleted`);
  check("CLEANUP/owner-deleted", "the throwaway owner was deleted (no residue)", userDeleted === 1, `userDeleted=${userDeleted}`);
}

let runError = null;
try { await main(); }
catch (e) { runError = e; console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e); }
finally { await cleanup(); }

// RESIDUE GUARD (task #79): assert THIS run left zero throwaway residue — a leak here would
// silently corrupt the NEXT run (the recorded false-green). Fails the run (exit 1) if dirty.
await assertCleanAfter("participation-count-her-data");

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(`PARTICIPATION COUNT (her data): ${results.length - fails.length}/${results.length} passed` + (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN"));
if (fails.length || runError) process.exit(1);
process.exit(0);
