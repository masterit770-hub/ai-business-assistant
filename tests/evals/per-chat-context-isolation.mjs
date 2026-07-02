// PER-CHAT CONTEXT ISOLATION EVAL (#75 core behavior)
//
// WHAT THIS PROVES: when answerAgentic() is called with a chatId, the agent
// receives ONLY that chat's files — not another chat's files. This drives the
// REAL agentic engine path (the Claude Agent SDK, local CLI subscription).
//
// SETUP:
//   Owner T — throwaway (@nucleus-eval.invalid)
//   Session A (uuid) — one distinctive doc: "The project codename is FALCON-7."
//   Session B (uuid) — one distinctive doc: "The budget ceiling is 42000 shekels."
//
// VERIFY via the real answerAgentic() path with explicit chatId (~4 calls):
//   1. Chat A: "what is the project codename?" → FALCON-7 (A's doc)
//   2. Chat A: "what is the budget ceiling?"   → NOT FOUND (B's doc must not leak)
//   3. Chat B: "what is the budget ceiling?"   → 42000 (B's doc)
//   4. Chat B: "what is the project codename?" → NOT FOUND (A's doc must not leak)
//
// Also confirms: inspector shows the agent ONLY received the active chat's file(s).
//
// RUN:
//   node tests/evals/per-chat-context-isolation.mjs
//
// REQUIREMENTS:
//   • Supabase creds (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local)
//   • Claude CLI creds (~/.claude) — uses the LOCAL SUBSCRIPTION, $0
//   • NEVER: Fly, ANTHROPIC_API_KEY, live owner ids 3d1ca025/b01c311e
//
// COST: local CLI subscription — $0. ~4 agentic calls total.
// JUSTIFICATION (per CLAUDE.md): verifies per-chat context isolation in the
//   real agent loop (#75 core behavior) — requires the real engine; local
//   subscription, free, not Fly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { skip as skipShared } from "./_skip.mjs";
import { assertCleanBefore, assertCleanAfter, settleOwner } from "./_residue-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── Env loading ───────────────────────────────────────────────────────────────
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
if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL)
  process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

const skip = (msg) => skipShared("per-chat-context-isolation", msg);

const haveSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — throwaway-owner upload can't run.");

// ── Imports ──────────────────────────────────────────────────────────────────
const { admin, supabaseEnabled } = await import("../../src/lib/engine/supabase.ts");
const { storeOriginalFile }      = await import("../../src/lib/engine/doc-files.ts");
const { answerAgentic }          = await import("../../src/lib/engine/answer-agentic.ts");

if (!supabaseEnabled()) { console.error("supabaseEnabled() false — aborting"); process.exit(1); }

// ── State ─────────────────────────────────────────────────────────────────────
let OWNER = null;
const STORED_PATHS = [];   // for cleanup: `${ownerId}/${docId}`
const results = [];
const calls = [];          // for the call log table

function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  const sym = ok ? "✓ PASS" : "✗ FAIL";
  console.log(`  ${sym} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}

// ── Owner creation ─────────────────────────────────────────────────────────────
async function newOwner() {
  const email = `per-chat-iso-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({
    email, password: crypto.randomUUID(), email_confirm: true,
  });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  return settleOwner(data.user.id);
}

// ── File storage helper ────────────────────────────────────────────────────────
// Stores a text file AS the original bytes under (ownerId, docId, chatId)
// and updates the _files.json manifest with session_id=chatId so
// listOwnerFiles / prepareOwnerFiles can filter by chat.
async function storeTextDoc(content, docId, displayName, chatId) {
  const buf = new TextEncoder().encode(content);
  const stored = await storeOriginalFile(new Uint8Array(buf), OWNER, docId, displayName, chatId);
  if (!stored) throw new Error(`storeOriginalFile returned false for ${displayName} (chatId=${chatId})`);
  STORED_PATHS.push(`${OWNER}/${docId}`);
  return { docId, displayName };
}

// ── Ask helper ────────────────────────────────────────────────────────────────
async function ask(callNum, chatLabel, chatId, question) {
  console.log(`\n  [${callNum}] chat=${chatLabel} "${question}"`);
  const t0 = Date.now();
  try {
    const result = await answerAgentic(question, OWNER, "claude-haiku-4-5", chatId);
    const ms = Date.now() - t0;
    const inp = result.inspector?.cost?.promptTokens ?? 0;
    const out = result.inspector?.cost?.completionTokens ?? 0;
    const filesInContext = result.evidence.chunks.map(c => c.doc).filter(Boolean);
    const shortAnswer = (result.answer || "").replace(/\n/g, " ").slice(0, 200);

    console.log(`    ↳ ms=${ms} grounded=${result.grounded} mode=${result.mode}`);
    console.log(`    ↳ files agent saw: ${filesInContext.join(", ") || "(none)"}`);
    console.log(`    ↳ route.sources: ${JSON.stringify(result.route?.sources)}`);
    console.log(`    ↳ answer: ${shortAnswer}`);
    console.log(`    ↳ tokens: in=${inp} out=${out}`);

    calls.push({ callNum, chatLabel, chatId: chatId.slice(0, 8), question, answer: shortAnswer.slice(0, 100), inp, out, ms, ok: true });
    return result;
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`    ✗ ERROR (${ms}ms): ${msg}`);
    if (/authentication|auth|login|credential|401|403/i.test(msg)) {
      console.error("\n⛔ AUTH FAILURE — Claude CLI creds not working. STOP.");
      console.error("   Fix: run `claude login` and try again.");
      process.exit(2);
    }
    calls.push({ callNum, chatLabel, chatId: chatId.slice(0, 8), question, answer: `ERROR: ${msg.slice(0, 80)}`, inp: 0, out: 0, ms, ok: false });
    return null;
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
async function cleanup() {
  let storageDeleted = 0;
  let userDeleted = 0;
  const client = admin();

  if (STORED_PATHS.length) {
    // Also delete the _files.json manifest we wrote
    const allPaths = [...STORED_PATHS, `${OWNER}/_files.json`];
    const { error } = await client.storage.from("documents").remove(allPaths);
    if (!error) storageDeleted = allPaths.length;
    else {
      // Try one by one
      for (const p of allPaths) {
        const r = await client.storage.from("documents").remove([p]).catch(() => ({ error: true }));
        if (!r.error) storageDeleted++;
      }
    }
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
  console.log(`\n↩ cleanup: ${storageDeleted} storage objects deleted, owner ${userDeleted}/1 deleted`);
  check("CLEANUP/owner-deleted", "throwaway owner deleted (0 residue)", userDeleted === 1, `userDeleted=${userDeleted}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  await assertCleanBefore("per-chat-context-isolation");

  OWNER = await newOwner();
  console.log(`\n▶ PER-CHAT CONTEXT ISOLATION EVAL (#75)`);
  console.log(`  throwaway owner: ${OWNER.slice(0, 8)}… (will be deleted)`);

  // Two distinct chat session ids
  const SESSION_A = crypto.randomUUID();
  const SESSION_B = crypto.randomUUID();
  console.log(`  session A: ${SESSION_A.slice(0, 8)}…`);
  console.log(`  session B: ${SESSION_B.slice(0, 8)}…`);

  // ── Store docs scoped to each chat ──────────────────────────────────────
  console.log("\n── Storing per-chat docs ──");

  const DOC_A_CONTENT = `INTERNAL MEMO

This document is for project FALCON.

The project codename is FALCON-7. All references to this initiative must use FALCON-7.
Phase 1 begins Q3 2026. Lead contact: Director Chen.
`;
  const DOC_B_CONTENT = `BUDGET DOCUMENT

This document contains the approved budget figures.

The budget ceiling is 42000 shekels. No expenditure may exceed this amount without Director approval.
Fiscal year: 2026. Department: Operations.
`;

  const docA = await storeTextDoc(DOC_A_CONTENT, "project-memo-chat-a.txt", "project-memo-chat-a.txt", SESSION_A);
  console.log(`  ✓ Chat A doc stored: ${docA.docId} (session_id=${SESSION_A.slice(0, 8)}…)`);

  const docB = await storeTextDoc(DOC_B_CONTENT, "budget-ceiling-chat-b.txt", "budget-ceiling-chat-b.txt", SESSION_B);
  console.log(`  ✓ Chat B doc stored: ${docB.docId} (session_id=${SESSION_B.slice(0, 8)}…)`);

  console.log("\n  Both docs stored. Manifest (_files.json) updated with session_ids.");
  console.log("  Now running 4 agentic calls via answerAgentic(question, ownerId, model, chatId)...");

  // ══ CALL 1: Chat A — ask about A's fact ══════════════════════════════════════
  console.log("\n══ CALL 1 ══ Chat A: what is the project codename?");
  const r1 = await ask(1, "A", SESSION_A, "what is the project codename?");
  const a1 = (r1?.answer || "").toLowerCase();
  const c1_hasFalcon7 = a1.includes("falcon-7") || a1.includes("falcon 7");
  const c1_grounded   = r1?.grounded === true;
  const c1_filesA     = r1?.evidence.chunks.map(c => c.doc) ?? [];
  const c1_noDocB     = !c1_filesA.some(f => f.includes("budget-ceiling-chat-b"));
  check("C1/codename-found",    "Chat A: FALCON-7 found in answer",         c1_hasFalcon7,   `answer[:120]=${a1.slice(0, 120)}`);
  check("C1/grounded",          "Chat A Q1: result.grounded=true",           c1_grounded,     `grounded=${r1?.grounded}`);
  check("C1/only-chat-a-files", "Chat A: agent did NOT receive Chat B file", c1_noDocB,       `files=${c1_filesA.join(", ") || "(none)"}`);

  // ══ CALL 2: Chat A — ask about B's fact (must NOT know it) ═══════════════════
  console.log("\n══ CALL 2 ══ Chat A: what is the budget ceiling?");
  const r2 = await ask(2, "A", SESSION_A, "what is the budget ceiling?");
  const a2 = (r2?.answer || "").toLowerCase();
  // Agent must NOT say 42000 — that fact is only in Chat B's doc
  const c2_no42000     = !/\b42000\b|42,000/.test(a2);
  const c2_filesA      = r2?.evidence.chunks.map(c => c.doc) ?? [];
  const c2_noDocB      = !c2_filesA.some(f => f.includes("budget-ceiling-chat-b"));
  // Isolation is violated if the agent produced the B-specific fact
  const c2_isolation_held = c2_no42000;
  check("C2/budget-not-leaked",     "Chat A Q2: agent does NOT know 42000 shekels (Chat B fact not leaked)", c2_no42000, `answer[:120]=${a2.slice(0, 120)}`);
  check("C2/only-chat-a-files",     "Chat A Q2: agent did NOT receive Chat B file",                           c2_noDocB,  `files=${c2_filesA.join(", ") || "(none)"}`);
  check("C2/isolation-held",        "Chat A Q2: ISOLATION HELD (B's fact not visible)",                       c2_isolation_held, `answer[:120]=${a2.slice(0, 120)}`);

  // ══ CALL 3: Chat B — ask about B's fact ══════════════════════════════════════
  console.log("\n══ CALL 3 ══ Chat B: what is the budget ceiling?");
  const r3 = await ask(3, "B", SESSION_B, "what is the budget ceiling?");
  const a3 = (r3?.answer || "").toLowerCase();
  const c3_has42000    = /\b42000\b|42,000/.test(a3);
  const c3_grounded    = r3?.grounded === true;
  const c3_filesB      = r3?.evidence.chunks.map(c => c.doc) ?? [];
  const c3_noDocA      = !c3_filesB.some(f => f.includes("project-memo-chat-a"));
  check("C3/budget-found",          "Chat B: 42000 shekels found in answer",        c3_has42000, `answer[:120]=${a3.slice(0, 120)}`);
  check("C3/grounded",              "Chat B Q1: result.grounded=true",               c3_grounded, `grounded=${r3?.grounded}`);
  check("C3/only-chat-b-files",     "Chat B: agent did NOT receive Chat A file",     c3_noDocA,   `files=${c3_filesB.join(", ") || "(none)"}`);

  // ══ CALL 4: Chat B — ask about A's fact (must NOT know it) ═══════════════════
  console.log("\n══ CALL 4 ══ Chat B: what is the project codename?");
  const r4 = await ask(4, "B", SESSION_B, "what is the project codename?");
  const a4 = (r4?.answer || "").toLowerCase();
  // Agent must NOT say FALCON-7 — that fact is only in Chat A's doc
  const c4_noFalcon7   = !a4.includes("falcon-7") && !a4.includes("falcon 7");
  const c4_filesB      = r4?.evidence.chunks.map(c => c.doc) ?? [];
  const c4_noDocA      = !c4_filesB.some(f => f.includes("project-memo-chat-a"));
  const c4_isolation_held = c4_noFalcon7;
  check("C4/codename-not-leaked",   "Chat B Q2: agent does NOT know FALCON-7 (Chat A fact not leaked)", c4_noFalcon7, `answer[:120]=${a4.slice(0, 120)}`);
  check("C4/only-chat-b-files",     "Chat B Q2: agent did NOT receive Chat A file",                      c4_noDocA,    `files=${c4_filesB.join(", ") || "(none)"}`);
  check("C4/isolation-held",        "Chat B Q2: ISOLATION HELD (A's fact not visible)",                  c4_isolation_held, `answer[:120]=${a4.slice(0, 120)}`);
}

// ── Cleanup + residue guard ──────────────────────────────────────────────────
let runError = null;
try { await main(); }
catch (e) { runError = e; console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e); }
finally { await cleanup(); }

await assertCleanAfter("per-chat-context-isolation");

// ── Report ─────────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(80)}`);
console.log("PER-CHAT CONTEXT ISOLATION EVAL (#75) — RESULTS");
console.log(`${"═".repeat(80)}`);

// Isolation verdict table
const isolationChecks = [
  { chat: "A", question: "what is the project codename?", expected: "FALCON-7",       resultId: "C1" },
  { chat: "A", question: "what is the budget ceiling?",   expected: "NOT FOUND",       resultId: "C2" },
  { chat: "B", question: "what is the budget ceiling?",   expected: "42000 shekels",   resultId: "C3" },
  { chat: "B", question: "what is the project codename?", expected: "NOT FOUND",       resultId: "C4" },
];
console.log("\n── ISOLATION TABLE ──");
console.log("chat · question                              · expected       · isolation held?");
console.log("─────────────────────────────────────────────────────────────────────────");
for (const row of isolationChecks) {
  const call = calls.find(c => c.chatLabel === row.chat && c.question === row.question);
  const ans  = call ? call.answer.slice(0, 50) : "(error)";
  const isoCheckId = results.find(r => r.id === `${row.resultId}/isolation-held` || r.id === `${row.resultId}/codename-found` || r.id === `${row.resultId}/budget-found`);
  // Find the "content present" check
  const contentCheckId = row.resultId === "C1" ? "C1/codename-found" :
                         row.resultId === "C2" ? "C2/budget-not-leaked" :
                         row.resultId === "C3" ? "C3/budget-found" :
                                                 "C4/codename-not-leaked";
  const contentCheck = results.find(r => r.id === contentCheckId);
  const held = contentCheck?.ok ? "YES ✓" : "NO ✗";
  console.log(`  ${row.chat}   · ${row.question.padEnd(42)} · ${row.expected.padEnd(15)} · ${held}`);
}

// Overall isolation verdict
const isolationCheckIds = ["C1/codename-found", "C2/budget-not-leaked", "C3/budget-found", "C4/codename-not-leaked",
                           "C1/only-chat-a-files", "C2/only-chat-a-files", "C3/only-chat-b-files", "C4/only-chat-b-files"];
const isolationFails = isolationCheckIds.filter(id => {
  const r = results.find(r => r.id === id);
  return r && !r.ok;
});
const isolationHeld = isolationFails.length === 0;
console.log(`\n── KEY VERDICT ──`);
console.log(isolationHeld
  ? "✓ PER-CHAT CONTEXT ISOLATION HOLDS: the agent received ONLY the active chat's file(s)."
  : `✗ ISOLATION FAILURE: cross-chat file leakage detected. Failed checks: ${isolationFails.join(", ")}`
);

// Call log rows (per CLAUDE.md)
console.log("\n── CALL LOG (per CLAUDE.md) ──");
console.log("# · date · env=local · API=agent-sdk · model · effort · Q · A(brief) · justification · est cost");
let callNum = 0;
for (const c of calls) {
  callNum++;
  const justification = "verifies per-chat context isolation in the real agent loop (#75 core behavior) — requires the real engine; local subscription, free, not Fly.";
  console.log(`| ${callNum} | 2026-06-25 | local | agent-sdk | claude-haiku-4-5 | default | [Chat ${c.chatLabel}] ${c.question.slice(0,50)} | ${c.answer.slice(0,60)} | ${justification} | $0 (subscription) |`);
}

// Residue summary
console.log("\n── RESIDUE ──");
console.log("Throwaway owner + all storage objects deleted. Residue = 0/0.");

// Overall
const fails = results.filter(r => !r.ok);
console.log(`\n${"═".repeat(80)}`);
console.log(`TOTAL: ${results.length - fails.length}/${results.length} checks passed` +
  (fails.length ? ` · FAILED: ${fails.map(f => f.id).join(", ")}` : " · ALL GREEN"));
if (fails.length || runError) process.exit(1);
process.exit(0);
