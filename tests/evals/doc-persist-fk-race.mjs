// DOC PERSIST under the owner-FK race (#82) — the committed regression gate for the silent doc-chunk
// drop that fabricated "Beyoncé" over her family-court PDF.
//
// THE BUG (verifier-confirmed): a fresh owner ingests a PDF → ingestPdf reports persisted=11, but the
// doc_chunks insert was REJECTED by "violates foreign key constraint doc_chunks_owner_id_fkey" (the
// just-created auth user wasn't yet FK-visible) → 0 rows committed → empty doc catalog → "who is the
// petitioner?" routes to NOTHING → ungrounded general → FABRICATES Beyoncé/Jay-Z (truth: the file says
// Joni Carter / Emma, Noah, Olivia / $1,285). Intermittent (~1/8) — a coin-flip silent drop.
//
// THE FIX (two layers): (1) storeDocChunks RETRIES the insert on the transient owner-FK error (the
// owner becomes visible moments later) so the chunks actually land; (2) the existing post-insert
// READ-BACK makes `persisted` the VERIFIED count (never the requested intent) so a real drop can never
// false-green again. The SAME FK-retry is on storeUploadedRows (the structured lane shares the FK).
//
// THIS GATE: a fresh throwaway owner ingests her Carter PDF WITHOUT any settle (the worst case for the
// race) → asserts doc_chunks has the owner's rows (persisted==DB count, >0) AND the petitioner Q
// grounds in the file (cites [P:], names Joni, never Beyoncé/route=[]). Repeated to catch the ~1/8.
//
// RUN: node tests/evals/doc-persist-fk-race.mjs  (SERIAL; SKIPS LOUDLY without creds; residue-guard
// pre/post-flight; ISOLATED throwaway owner; never her live accounts).

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

const skip = (msg) => skipShared("doc-persist-fk-race", msg);
const haveSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const haveLlm = !!(process.env.LLM_API_KEY && process.env.LLM_API_KEY.length > 8);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — the throwaway-owner ingest path can't run.");
if (!haveLlm) skip("No LLM_API_KEY found — the answer pipeline makes real LLM calls.");

// Her family-court PDF (resolve by a stable substring; the bytes/name can be mangled on disk).
const dataDir = path.join(ROOT, "data");
const PDF = fs.existsSync(dataDir)
  ? fs.readdirSync(dataDir).find((f) => f.toLowerCase().endsWith(".pdf") && /family|court/i.test(f))
  : null;
if (!PDF) skip("Her family-court PDF is not on disk under data/ — cannot run the doc-persist gate.");

const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}

const { answerQuestion } = await import("../../src/lib/engine/answer.ts");
const { ingestPdf } = await import("../../src/lib/engine/ingest.ts");
const { __resetRuntimeStoreForTests } = await import("../../src/lib/engine/runtime-store.ts");
const { resetStore } = await import("../../src/lib/engine/structured-store.ts");
const { admin, supabaseEnabled } = await import("../../src/lib/engine/supabase.ts");

if (!supabaseEnabled()) { console.error("supabaseEnabled() false despite env — aborting"); process.exit(1); }

// DELIBERATELY do NOT FK-settle the owner here — ingesting RIGHT AFTER createUser is the worst case
// that triggers the race. The FIX (storeDocChunks' FK-retry) must make persist land anyway.
async function newRacyOwner() {
  const email = `docfk-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({ email, password: crypto.randomUUID(), email_confirm: true });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  return data.user.id;
}
async function ownerDocCount(ownerId) {
  const { count } = await admin().from("doc_chunks").select("*", { count: "exact", head: true }).eq("owner_id", ownerId);
  return count ?? 0;
}
async function cleanupOwner(ownerId) {
  try { await admin().from("doc_chunks").delete().eq("owner_id", ownerId); } catch { /* noop */ }
  for (let i = 0; i < 4; i++) {
    try { await admin().auth.admin.deleteUser(ownerId); } catch { /* retry */ }
    try {
      const { data, error } = await admin().auth.admin.getUserById(ownerId);
      if ((error && /not found/i.test(error.message)) || !data?.user) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// REPEAT — the race was ~1/8, so one pass would be a coin-flip green.
const REPEAT = 6;

async function main() {
  console.log(`\n▶ DOC PERSIST under the owner-FK race — ${REPEAT} fresh racy owners (ingest immediately after createUser)`);
  const pdfPath = path.join(dataDir, PDF);
  for (let i = 0; i < REPEAT; i++) {
    const OWNER = await newRacyOwner();
    try {
      // INGEST IMMEDIATELY (no settle) — the race window. Read FRESH bytes each iteration: ingestPdf
      // DETACHES the ArrayBuffer (its OCR copy trick), so a reused Uint8Array throws on the 2nd run.
      const r = await ingestPdf(new Uint8Array(fs.readFileSync(pdfPath)), PDF, "Carter case file", OWNER);
      const dbCount = await ownerDocCount(OWNER);
      // (1) persist LANDED + persisted == actual DB count (the fix: FK-retry makes it land; read-back
      //     makes the number honest). The old bug = reported 11 but DB 0.
      check(`persist/landed-run${i}`, `ingest persisted ${r.persisted} chunks AND doc_chunks DB count = ${dbCount} (>0, equal — no silent drop)`,
        (r.persisted ?? 0) > 0 && dbCount > 0 && (r.persisted ?? 0) === dbCount,
        `persisted=${r.persisted} dbCount=${dbCount}`);
      // (2) the petitioner Q grounds in HER file — not route=[], not Beyoncé.
      __resetRuntimeStoreForTests(); resetStore();
      const res = await answerQuestion("who is the petitioner in the divorce case?", { ownerId: OWNER, role: "member", isDemo: false });
      const a = (res.answer ?? "").normalize("NFC");
      check(`ground/run${i}`, `"who is the petitioner?" → grounded, names Joni, cites [P:], NOT route=[] / Beyoncé`,
        res.mode === "grounded" && (res.route?.sources || []).includes("documents") && /joni/i.test(a) && /\[P:/.test(a) && !/beyonc|jay-?z/i.test(a),
        `mode=${res.mode} route=${JSON.stringify(res.route?.sources)} joni=${/joni/i.test(a)} cited=${/\[P:/.test(a)} beyonce=${/beyonc|jay-?z/i.test(a)}`);
    } finally {
      const cleaned = await cleanupOwner(OWNER);
      if (!cleaned) check(`CLEANUP/run${i}`, "throwaway owner deleted (no residue)", false, `owner ${OWNER.slice(0, 8)} not deleted`);
    }
  }
}

await assertCleanBefore("doc-persist-fk-race");
let runError = null;
try { await main(); }
catch (e) { runError = e; console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e); }
await assertCleanAfter("doc-persist-fk-race");

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(`DOC PERSIST FK-RACE: ${results.length - fails.length}/${results.length} passed` + (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN"));
if (fails.length || runError) process.exit(1);
process.exit(0);
