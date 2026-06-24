// DOC-PERSIST + GROUNDING eval — the committed regression gate for task #82 (the
// "route=[] → ungrounded general → Beyoncé" fabrication bug over an UPLOADED PDF).
//
// THE BUG this guards (verifier-diagnosed): an uploaded PDF's chunks were reported as
// `persisted = N` while ZERO rows actually committed to doc_chunks (a SILENT write failure
// — the insert returned error=null but nothing landed, and storeDocChunks reported
// `rows.length`, the INTENT, not a verified write). Empty doc_chunks → the doc lane finds
// nothing → route=[] → the engine answers in ungrounded "general" mode → it FABRICATES
// ("who are the Carters" → Beyoncé and Jay-Z). The fix (#82) makes `persisted` a READ-BACK
// count, so it can never over-claim; and this eval proves the WHOLE path end-to-end over
// HER real Carter case-file PDF under an ISOLATED throwaway owner.
//
// THE REAL FACTS (from data/"📄 FAMILY COURT CASE FILE (MOCK) – FINAL VERSION.pdf",
// pre-extracted in data/pdf-pages.json doc "family-court"):
//   • Joni Carter = Petitioner; Michel Carter = Respondent; Maricopa County, FC-2026-10458.
//   • 3 children: Emma, Noah, Olivia. NO alimony award (only $1,285/mo child support).
// The petitioner question must ground to the file (cite [P:family-court…]) and name Joni —
// NEVER answer "Beyoncé / Jay-Z" (the recorded fabrication) and NEVER fall to route=[].
//
// REALISTIC MULTI-FILE CONTEXT: it also ingests the enrollment CSV (school data 2) into the
// SAME owner — the competing structured table that was implicated in the cross-corpus
// mis-routing. The doc question must STILL route to documents with the CSV present.
//
// HARD GUARDRAILS:
//   • ISOLATED throwaway owner (create auth user → ingest → assert → delete). NEVER her live
//     accounts (3d1ca025 / b01c311e).
//   • RESIDUE GUARD (task #79): assertCleanBefore() refuses to run over a dirty DB (a false
//     green); assertCleanAfter() fails the run if THIS run leaked. Pre/post 0 orphans.
//   • PII: prints only the single load-bearing fact (Joni = petitioner) + chunk counts —
//     never a roster. The divorce file is explicitly MOCK/fictional.
//
// RUN: node tests/evals/doc-persist-grounding.mjs  (SERIAL; SKIPS LOUDLY without creds or if
// the Carter PDF is not on disk — never a false green). Reads creds from .env.local /
// .secrets/supabase.env / .vercel-prod.env (read, NEVER printed/committed).

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

const skip = (msg) => skipShared("doc-persist-grounding", msg);
const haveSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const haveLlm = !!(process.env.LLM_API_KEY && process.env.LLM_API_KEY.length > 8);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — the throwaway-owner ingest path can't run.");
if (!haveLlm) skip("No LLM_API_KEY found — the answer pipeline makes real LLM calls.");

// Resolve the Carter case-file PDF by a stable substring (the emoji-prefixed filename).
function findPdf() {
  const dir = path.join(ROOT, "data");
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    if (/family court case file/i.test(name) && name.toLowerCase().endsWith(".pdf")) return path.join(dir, name);
  }
  return null;
}
const PDF = findPdf();
const CSV = path.join(ROOT, "data", "school data 2.csv"); // the competing enrollment table
if (!PDF) skip("The Carter case-file PDF is not on disk under data/ — cannot run the real-data #82 gate.");

const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}

const { answerQuestion } = await import("../../src/lib/engine/answer.ts");
const { ingestPdf, ingestCsv } = await import("../../src/lib/engine/ingest.ts");
const { __resetRuntimeStoreForTests } = await import("../../src/lib/engine/runtime-store.ts");
const { resetStore } = await import("../../src/lib/engine/structured-store.ts");
const { admin, supabaseEnabled } = await import("../../src/lib/engine/supabase.ts");
if (!supabaseEnabled()) { console.error("supabaseEnabled() false despite env — aborting"); process.exit(1); }

let OWNER = null;

async function newOwner() {
  const email = `docpersist-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({ email, password: crypto.randomUUID(), email_confirm: true });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  return data.user.id;
}

async function main() {
  // RESIDUE GUARD (task #79): never run over a polluted DB — that's the false-green.
  await assertCleanBefore("doc-persist-grounding");
  OWNER = await newOwner();
  console.log(`\n▶ DOC-PERSIST + GROUNDING (real Carter PDF) — throwaway owner ${OWNER.slice(0, 8)}… (created + deleted)`);

  // ── INGEST: the real PDF + the competing CSV into the SAME owner ──────────────────
  const r = await ingestPdf(new Uint8Array(fs.readFileSync(PDF)), "FAMILY COURT CASE FILE.pdf", "Carter case file", OWNER);
  console.log(`  ingestPdf → chunks=${r.chunks}, persisted=${r.persisted}`);
  await ingestCsv(fs.readFileSync(CSV, "utf8"), "school data 2.csv", OWNER);

  // (1) VERIFIED PERSIST: persisted must EQUAL the real owner-scoped doc_chunks count, and be > 0.
  // This is the heart of #82 — `persisted` is now a read-back, so persisted=N MEANS N rows committed.
  const back = await admin().from("doc_chunks").select("id", { count: "exact", head: true }).eq("owner_id", OWNER);
  const actual = back.count ?? 0;
  check("persist/rows-landed", `doc_chunks has the owner's rows (actual=${actual} > 0)`, actual > 0, `actual=${actual}`);
  check("persist/verified-count-matches", `persisted (${r.persisted}) equals the actual committed rows (${actual}) — no false-green`,
    r.persisted === actual && r.persisted > 0, `persisted=${r.persisted} actual=${actual}`);

  // ── ASK: the petitioner question, cold-start, 3x serial (the live non-determinism the bug rode) ──
  __resetRuntimeStoreForTests();
  resetStore();
  const Q = "who is the petitioner in the divorce case?";
  for (let i = 1; i <= 3; i++) {
    const res = await answerQuestion(Q, { ownerId: OWNER, role: "member", isDemo: false });
    const a = (res.answer || "").normalize("NFC");
    const oneLine = a.replace(/\n/g, " ");
    const sources = res.route?.sources || [];
    console.log(`\n[run ${i}] route=${JSON.stringify(sources)} mode=${res.mode}\n   ${oneLine.slice(0, 240)}`);
    check(`ground/run${i}-routes-documents`, `"${Q}" routes to documents (not route=[])`, sources.includes("documents"), `route=${JSON.stringify(sources)}`);
    check(`ground/run${i}-grounded`, `answered in grounded mode (read the PDF), not ungrounded general`, res.mode === "grounded", `mode=${res.mode}`);
    check(`ground/run${i}-names-joni`, `names Joni Carter (the real petitioner from the file)`, /joni/i.test(a), "");
    check(`ground/run${i}-no-fabrication`, `does NOT fabricate (no Beyoncé / Jay-Z — the recorded hallucination)`, !/beyonc|jay-?z/i.test(a), "");
  }
}

async function cleanup() {
  let docDel = 0, rowDel = 0, userDeleted = 0;
  if (OWNER) {
    try { const d = await admin().from("doc_chunks").delete({ count: "exact" }).eq("owner_id", OWNER); docDel = d.count ?? 0; } catch { /* noop */ }
    try { const d = await admin().from("uploaded_rows").delete({ count: "exact" }).eq("owner_id", OWNER); rowDel = d.count ?? 0; } catch { /* noop */ }
    for (let attempt = 0; attempt < 4 && userDeleted === 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
      try { await admin().auth.admin.deleteUser(OWNER); } catch { /* fall through to the existence check */ }
      try {
        const { data, error } = await admin().auth.admin.getUserById(OWNER);
        if ((error && /not found/i.test(error.message)) || !data?.user) userDeleted = 1;
      } catch { /* retry */ }
    }
  }
  console.log(`\n↩ cleanup: doc_chunks ${docDel} deleted, uploaded_rows ${rowDel} deleted, owner ${userDeleted}/1 deleted`);
  check("CLEANUP/owner-deleted", "the throwaway owner was deleted (no residue)", userDeleted === 1, `userDeleted=${userDeleted}`);
}

let runError = null;
try { await main(); }
catch (e) { runError = e; console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e); }
finally { await cleanup(); }

// RESIDUE GUARD (task #79): assert THIS run left zero residue (else it corrupts the next run).
await assertCleanAfter("doc-persist-grounding");

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(`DOC-PERSIST + GROUNDING (#82): ${results.length - fails.length}/${results.length} passed` + (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN"));
if (fails.length || runError) process.exit(1);
process.exit(0);
