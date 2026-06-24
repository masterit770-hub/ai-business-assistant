// CLEAN-TABLE → TEXT-TO-SQL (the over-count fix) — proves the cell-tally OCCURRENCE-COUNTER no longer
// HIJACKS a clean tabular sheet. The client uploaded a simple Excel and asked "who participates most"
// → got the right NAME but the WRONG NUMBER (said 18, truth 10), because the cell-tally hack tallies a
// name's occurrences across ALL columns instead of reading the real table. On a clean sheet that is
// just wrong; the model/text-to-SQL should GROUP BY the real participant column for the EXACT count.
//
// THE SYNTHETIC OVER-COUNT TRAP (general, invented, in NO other test): a "participation log" with a
// Participant column AND a Coach column. "Maya Adler" PARTICIPATES in exactly 8 sessions (8 rows where
// Participant = Maya) but ALSO appears as the COACH in 4 other rows — so her name occurs 12× total
// across the two columns. The occurrence-counter would say 12 (or "most"=12); the CORRECT answer is
// her PARTICIPATION count = 8, read from the real Participant column. We assert 8, NOT 12.
//
// RUN: node tests/evals/clean-table-not-occurrence-count.mjs  (SERIAL; SKIPS LOUDLY without creds —
// never a false green). Uses a THROWAWAY owner; ingests one synthetic CSV; deletes it + the user.
// Reads the LLM key from .env.local OR .vercel-prod.env (the key dropped from .env.local 2026-06-24).

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

const haveSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const haveLlm = !!(process.env.LLM_API_KEY && process.env.LLM_API_KEY.length > 8);
const skip = (msg) => skipShared("clean-table-not-occurrence-count", msg);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — the throwaway-owner upload path can't run.");
if (!haveLlm) skip("No LLM_API_KEY found (checked .env.local AND .vercel-prod.env) — the answer pipeline makes real LLM calls.");

const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}

const { answerQuestion } = await import("../../src/lib/engine/answer.ts");
const { ingestCsv } = await import("../../src/lib/engine/ingest.ts");
const { __resetRuntimeStoreForTests } = await import("../../src/lib/engine/runtime-store.ts");
const { resetStore } = await import("../../src/lib/engine/structured-store.ts");
const { deleteUploadedTable } = await import("../../src/lib/engine/structured-rows-store.ts");
const { admin, supabaseEnabled } = await import("../../src/lib/engine/supabase.ts");

if (!supabaseEnabled()) { console.error("supabaseEnabled() false despite env — aborting"); process.exit(1); }

let OWNER = null;
const uploadedTables = [];

async function newOwner() {
  const email = `cleantable-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({ email, password: crypto.randomUUID(), email_confirm: true });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  return data.user.id;
}
// Ask as a MEMBER over ONLY this throwaway owner's synthetic CSV (the real client path).
async function ask(q) {
  __resetRuntimeStoreForTests();
  resetStore();
  return answerQuestion(q, { ownerId: OWNER, role: "member", isDemo: false });
}
const hasNum = (a, n) => new RegExp(`(?<![\\d.,])${n}(?![\\d.,])`).test((a || "").normalize("NFC"));

async function main() {
  OWNER = await newOwner();
  console.log(`\n▶ CLEAN-TABLE → TEXT-TO-SQL — throwaway owner ${OWNER.slice(0, 8)}… (synthetic CSV; created + deleted)`);

  // The over-count trap, fully invented. Distinct named columns → a CLEAN table (text-to-SQL should
  // GROUP BY participant). Maya Adler PARTICIPATES in 8 rows; she is also the COACH in 4 other rows →
  // 12 occurrences of her name total, but the PARTICIPATION count is 8.
  // FOUR+ distinct, all-TEXT, named columns → wide + text-heavy (so the OLD isGridShaped called it a
  // grid and the occurrence-tally hijacked it), BUT the columns are CLEANLY NAMED — so the fix routes
  // it to text-to-SQL instead. Participant / Coach / Venue / Notes: Maya is the COACH (and named in
  // Notes) in some rows too, inflating her raw occurrence count beyond her real participation count.
  const P = "Maya Adler";       // participates 8×; appears elsewhere 4× → 12 occurrences, 8 participations
  const other = ["Liam Cohen", "Noa Sharon", "Ron Levi", "Tamar Ben-David", "Eitan Mor"];
  const venues = ["Hall A", "Hall B", "Studio 1", "Field", "Annex"];
  const rows = [];
  // 8 sessions where Maya is the PARTICIPANT (coached by others, neutral notes).
  for (let i = 0; i < 8; i++) rows.push([P, other[i % other.length], venues[i % venues.length], "regular session"]);
  // 4 sessions where Maya is the COACH and is also named in Notes — her name occurs 2× per row here
  // (Coach + Notes), so a naive across-all-columns tally massively over-counts her.
  for (let i = 0; i < 4; i++) rows.push([other[i % other.length], P, venues[i % venues.length], `led by ${P}`]);
  // Filler rows so Maya is clearly the top PARTICIPANT (others participate ≤5×).
  for (let i = 0; i < 5; i++) rows.push([other[i % other.length], other[(i + 1) % other.length], venues[i % venues.length], "regular session"]);
  const csv = ["Participant,Coach,Venue,Notes", ...rows.map((r) => r.join(","))].join("\n");
  await ingestCsv(csv, "participation-log.csv", OWNER);
  uploadedTables.push("participation-log");

  // ── Q1: an OCCURRENCE-CUE superlative over the clean table — the exact phrasing that USED to trip
  //    the cell-tally hijack ("appears the most" hits the occurrence cue + "most" hits the ranking
  //    cue, and the wide all-text sheet looked grid-shaped to the OLD isGridShaped). Over a clean
  //    PARTICIPANT/COACH table the occurrence-counter would tally Maya across BOTH columns = 12; the
  //    correct answer (text-to-SQL GROUP BY participant) is 8. We assert 8, never 12. ──────────────
  {
    const q = "In the participation log, who appears the most as a participant, and how many times?";
    const res = await ask(q);
    const a = res.answer ?? "";
    console.log(`\n[clean-table/most] route=${JSON.stringify(res.route?.sources)} mode=${res.mode} sql=${res.inspector?.structuredSql ? "yes" : "—"}\n   ${a.replace(/\n/g, " ").slice(0, 320)}`);
    // HARD: the answer is the real PARTICIPATION count = 8, NEVER the inflated occurrence count
    // (8 Participant + 4 Coach + 4 Notes = 16) the cell-tally hack would produce by counting her
    // name across ALL columns. 8, not 16 — and not 12 either.
    check("clean-table/count-is-8-not-occurrence", "states Maya's PARTICIPATION count = 8 (real GROUP BY), not the inflated occurrence count (16/12)",
      hasNum(a, 8) && !hasNum(a, 16) && !hasNum(a, 12) && /maya/i.test(a),
      `answer: "${a.replace(/\n/g, " ").slice(0, 220)}"`);
    // The right entity is still named (the bug was right name, wrong number — keep the name right too).
    check("clean-table/names-maya", "names Maya Adler as the top participant", /maya/i.test(a),
      `answer: "${a.replace(/\n/g, " ").slice(0, 160)}"`);
  }

  // ── Q2: a plain count of one named value over the clean table — also exact via SQL ──
  {
    const q = "How many sessions does Maya Adler participate in?";
    const res = await ask(q);
    const a = res.answer ?? "";
    console.log(`\n[clean-table/named-count] route=${JSON.stringify(res.route?.sources)} mode=${res.mode}\n   ${a.replace(/\n/g, " ").slice(0, 240)}`);
    check("clean-table/named-count-8", "Maya participates in 8 sessions (GROUP BY participant), not the inflated occurrence count",
      hasNum(a, 8) && !hasNum(a, 16) && !hasNum(a, 12),
      `answer: "${a.replace(/\n/g, " ").slice(0, 200)}"`);
  }

  // ── NO-REGRESSION: a HEADER-LESS GRID (placeholder columns, the calendar layout) must STILL fall
  //    to the occurrence-tally — text-to-SQL genuinely can't GROUP BY when there are no real columns.
  //    A name recurs ACROSS the unnamed day-columns; the tally is the only thing that counts it. We
  //    confirm the lane STILL fires here (the fix narrowed it to grids, it didn't disable it). The
  //    header row is placeholder names (a real header-less export → __EMPTY / Column-n on ingest).
  {
    const G = "Dana Roth"; // appears across the unnamed day-columns; the tally must count her
    const gridRows = [
      ["Mon", G, "Yoga", "Tue", "Liam Cohen", "Run"],
      ["Wed", G, "Swim", "Thu", G, "Yoga"],
      ["Fri", "Noa Sharon", "Run", "Sat", G, "Swim"],
      ["Sun", G, "Yoga", "Mon", "Liam Cohen", "Run"],
    ];
    // Placeholder header names → isPlaceholderColumnName matches → isGridShaped stays true.
    const gridCsv = ["Column1,Column2,Column3,Column4,Column5,Column6", ...gridRows.map((r) => r.join(","))].join("\n");
    await ingestCsv(gridCsv, "headerless-grid.csv", OWNER);
    uploadedTables.push("headerless-grid");
    const q = "In the headerless grid, who appears the most across the schedule?";
    const res = await ask(q);
    const a = res.answer ?? "";
    // Diagnostic only (the hard assertion is the OUTCOME below): the tally fired if the trace names
    // it OR the answer restates the verified tally ("based on the verified tally", "N occurrences").
    const usedTally = /cell-tally|occurrence frequency/i.test(res.inspector?.structuredSql || "") ||
      /verified tally|occurrences?\b/i.test(a);
    console.log(`\n[no-regression/headerless-grid] route=${JSON.stringify(res.route?.sources)} mode=${res.mode} usedTally=${usedTally} sql="${(res.inspector?.structuredSql||"").slice(0,60)}"\n   ${a.replace(/\n/g, " ").slice(0, 220)}`);
    // The messy-grid path is PRESERVED — we assert the OUTCOME (the value, not the internal lane
    // label): the recurring person Dana Roth (across the unnamed day-columns) is named with her true
    // cross-column occurrence count of 5. GROUND TRUTH: Dana is in col2 of rows 1/2/4 and col5 of
    // rows 2/3 = 5 occurrences. A wide cross-column tally IS the right answer here (no real column to
    // GROUP BY), so this proves the fix narrowed the tally to grids WITHOUT disabling it.
    check("no-regression/grid-recurring-name-counted", "a header-less grid's recurring name (Dana=5 across columns) is still counted correctly",
      /dana/i.test(a) && hasNum(a, 5),
      `usedTally=${usedTally} sql="${(res.inspector?.structuredSql||"").slice(0,80)}" answer="${a.replace(/\n/g, " ").slice(0, 160)}"`);
  }
}

async function cleanup() {
  let tablesDeleted = 0, userDeleted = 0;
  for (const t of uploadedTables) {
    try { const n = await deleteUploadedTable(OWNER, t, false); if (n >= 0) tablesDeleted++; } catch { /* noop */ }
  }
  if (OWNER) {
    try { const { error } = await admin().auth.admin.deleteUser(OWNER); if (!error) userDeleted++; } catch { /* noop */ }
  }
  console.log(`\n↩ cleanup: tables ${tablesDeleted}/${uploadedTables.length}, owner ${userDeleted}/1 deleted`);
  check("CLEANUP/owner-deleted", "the throwaway owner was deleted (no residue)", userDeleted === 1, `userDeleted=${userDeleted}`);
}

// RESIDUE GUARD (#79): refuse to run over a DB a prior leaked run left dirty (a polluted
// catalog produces a FALSE GREEN); abort loudly. Asserts 0 throwaway orphan rows BEFORE the run.
await assertCleanBefore("clean-table-not-occurrence-count");
let runError = null;
try { await main(); }
catch (e) { runError = e; console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e); }
finally { await cleanup(); }
// RESIDUE GUARD (#79): this run must leave 0 throwaway residue — fail loudly if its cleanup leaked.
await assertCleanAfter("clean-table-not-occurrence-count");

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(`CLEAN-TABLE → TEXT-TO-SQL: ${results.length - fails.length}/${results.length} passed` + (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN"));
if (fails.length || runError) process.exit(1);
process.exit(0);
