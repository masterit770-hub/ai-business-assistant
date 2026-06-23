// COLD-START DURABILITY regression eval — guards the bug where an uploaded SPREADSHEET
// VANISHED after a Vercel serverless cold start.
//
// THE LESSON (why this test exists): uploaded CSV/XLSX rows are STRUCTURED data answered
// by the TEXT-TO-SQL lane. They used to live ONLY in the in-memory runtime store
// (globalThis.__nucleusRuntimeStore.sqlRows). On a serverless COLD START that memory is
// empty, so the SQL lane had no uploaded table AND the router's structured catalog was
// empty → a spreadsheet question routed to nothing and answered "there are no
// apartments/addresses" for a REAL uploaded table. The golden evals never caught it: they
// run IN-PROCESS against the always-present BUNDLED demo corpus on a WARM process, so they
// never (a) ingest as a NON-DEMO owner, nor (b) simulate a cold start (empty in-memory
// store). This test exercises the REAL broken path: ingest a spreadsheet as a non-demo
// owner → WIPE the in-memory store (the cold start) → route + answer, and assert the table
// is STILL found via the DURABLE store, routed to "structured", and answered with an
// [S:table#row] citation — NOT a "there are none" refusal. A run that skips the wipe is a
// false-green.
//
// THE FIX it guards (must stay present):
//   • ingest.ts persists CSV/XLSX rows to the DURABLE uploaded_rows table (migration 012)
//     via structured-rows-store.storeUploadedRows — not just the in-memory store.
//   • structured-store.hydrateUploadedTables(ownerId) rehydrates those rows (owner-scoped)
//     BEFORE the synchronous introspect, so the SQL catalog is non-empty after a cold start.
//   • router.ts + answer.ts thread the owner scope so the structured catalog/query are
//     OWNER-ISOLATED (one owner can never see another's uploaded table).
//
// RUN (from the repo root):
//   node tests/evals/cold-start-durability.mjs
// It loads the LLM key + Supabase creds from local secret files (read, never printed).
// If either is absent it SKIPS loudly with exit 0 (never a false-green). It uses unique
// synthetic non-demo owners and DELETES their uploaded_rows + the throwaway users at the
// end, leaving no test rows behind.
//
// SECURITY: this file READs .env.local / .secrets/supabase.env / .vercel-prod.env to set
// process.env, but NEVER prints, echoes, logs, or commits any secret value.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── ENV LOADING (secret-safe) ──────────────────────────────────────────────────
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
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

function skip(msg) {
  console.log("\n" + "═".repeat(72));
  console.log("⏭  SKIPPED — cold-start-durability eval did NOT run (this is NOT a pass).");
  console.log("   " + msg);
  console.log("═".repeat(72));
  process.exit(0);
}
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — the DURABLE lane can't be exercised.");
if (!haveLlm) skip("No LLM_API_KEY found — the router + answer pipeline make real LLM calls and can't run.");

// ── TEST HARNESS ─────────────────────────────────────────────────────────────────
const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}
const cites = (ans) => [...(ans || "").matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]);
const sqlCites = (ans) => [...(ans || "").matchAll(/\[S:[^\]]+\]/g)].map((m) => m[0]);
// A "there are none / not available" refusal in EN or HE — the exact shape the bug
// produced. If a GROUNDED answer reads like this, the uploaded table was NOT found.
const REFUSAL_RE =
  /\b(there (are|is) no|no (apartments?|addresses?|tables?|data|records?|information)|do(es)? not have|don'?t have|no relevant|cannot (find|answer)|not available|i (don'?t|do not) have (any|access))\b/i;
const HE_REFUSAL_RE = /(אין לי|לא נמצא|לא קיים|לא זמין|אין נתונים|אין מסמכים|אין טבלה)/;
const isRefusal = (a) => REFUSAL_RE.test(a || "") || HE_REFUSAL_RE.test(a || "");

// A Hebrew apartments/addresses fixture (CSV) — Hebrew headers (דירה/כתובת/עיר =
// apartment/address/city) + real-looking Hebrew rows: the client's exact case. These are
// STRUCTURED rows → answered by text-to-SQL over the durable uploaded_rows table, cited
// [S:<table>#row]. After a cold start the SQL lane must rehydrate them durably.
const HEBREW_CSV =
  "דירה,כתובת,עיר\n" +
  "דירה 4,רחוב הרצל 12,תל אביב\n" +
  "דירה 7,שדרות רוטשילד 88,תל אביב\n" +
  "דירה 2,רחוב ויצמן 5,רמת גן\n" +
  "פנטהאוז,רחוב יפו 200,ירושלים\n";

// A small born-digital PDF for the DOCUMENT-lane durability case (it must still route to
// "documents" + be retrieved after a cold start — proving the doc-lane fix stayed intact
// alongside the structured-lane one).
const PDF_PATH = path.join(ROOT, "data", "story if the Carters .pdf");

// Import the REAL engine entry points (same modules the live route uses).
const { ingestCsv, ingestPdf } = await import("../../src/lib/engine/ingest.ts");
const { routeQuestion } = await import("../../src/lib/engine/router.ts");
const { answerQuestion } = await import("../../src/lib/engine/answer.ts");
const { introspectSchema, resetStore } = await import("../../src/lib/engine/structured-store.ts");
const { listUploadedTables, deleteUploadedTable } = await import("../../src/lib/engine/structured-rows-store.ts");
const { listUploadedDocs: listDurableDocs, deleteUploadedDoc } = await import("../../src/lib/engine/pgvector-store.ts");
const { __resetRuntimeStoreForTests } = await import("../../src/lib/engine/runtime-store.ts");
const { supabaseEnabled, admin } = await import("../../src/lib/engine/supabase.ts");

// Two throwaway NON-DEMO owners: OWNER uploads the apartments sheet (+ a PDF); OWNER2
// uploads nothing (the isolation control — must NOT see OWNER's table). uploaded_rows.
// owner_id is a FK to auth.users(id), so each owner must be a REAL user (created + deleted
// here).
let OWNER = null, OWNER2 = null;
let TABLE = null; // the ingested table id
let PDF_DOC = null; // the ingested PDF doc id (doc-lane case)

async function newOwner(tag) {
  const email = `coldstart-${tag}-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({
    email, password: crypto.randomUUID(), email_confirm: true,
  });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  return data.user.id;
}

async function main() {
  check("ENV/supabase", "the engine sees Supabase as configured (durable lane is live)", supabaseEnabled());
  if (!supabaseEnabled()) throw new Error("supabaseEnabled() is false despite env — aborting to avoid a meaningless run");

  OWNER = await newOwner("a");
  OWNER2 = await newOwner("b");
  const FILENAME = `cold-start-apartments-${OWNER.slice(0, 8)}.csv`;
  console.log(`\n▶ COLD-START DURABILITY (structured lane) — owner ${OWNER.slice(0, 8)}… , isolation control ${OWNER2.slice(0, 8)}…`);

  // ── 1. INGEST the spreadsheet as the non-demo owner ──────────────────────────────
  console.log("\n· Ingesting the Hebrew apartments CSV as the non-demo owner …");
  const res = await ingestCsv(HEBREW_CSV, FILENAME, OWNER);
  TABLE = res.table;
  check("INGEST/rows", "CSV ingested with rows", (res.rows ?? 0) > 0, `rows=${res.rows} table=${TABLE}`);
  check("INGEST/persisted", "rows PERSISTED to durable uploaded_rows (the fix) — not just memory",
    (res.persisted ?? 0) > 0, `persisted=${res.persisted} (must be > 0)`);
  check("INGEST/not-ragged", "a spreadsheet is NOT embedded as RAG/pgvector doc chunks",
    (res.chunks ?? 0) === 0, `chunks=${res.chunks} (must be 0 — structured, not documents)`);

  // Also ingest a born-digital PDF as the SAME owner (doc-lane durability control).
  let pdfIngested = false;
  if (fs.existsSync(PDF_PATH)) {
    console.log("\n· Ingesting a born-digital PDF as the same owner (doc-lane durability) …");
    const pdfBuf = new Uint8Array(fs.readFileSync(PDF_PATH));
    const pdfRes = await ingestPdf(pdfBuf, "carter-story.pdf", "Carter story", OWNER);
    PDF_DOC = pdfRes.doc;
    pdfIngested = (pdfRes.persisted ?? 0) > 0;
    check("INGEST/pdf-persisted", "the PDF's chunks PERSISTED to durable doc_chunks (doc-lane)",
      pdfIngested, `persisted=${pdfRes.persisted} doc=${pdfRes.doc}`);
  }

  // ── 2. SIMULATE A SERVERLESS COLD START — wipe ALL in-memory engine state ────────
  // Wipe BOTH the runtime store (sqlRows + doc registry) AND the structured-store's
  // cached per-scope SQLite handles, reproducing the empty-memory state of a fresh
  // serverless instance.
  console.log("\n· Simulating a serverless COLD START (clearing the in-memory runtime store + SQL handles) …");
  __resetRuntimeStoreForTests();
  resetStore();

  // ── 3. REGRESSION VECTOR — in-memory blind, durable still holds the table ────────
  // Right after the wipe, the SYNCHRONOUS introspect (what the OLD code relied on) sees
  // NO uploaded table for this owner — the exact blind spot. The DURABLE store still has
  // it. (introspectSchema does NOT hydrate; only route/answer do — so this is the honest
  // pre-hydrate state.)
  const coldCatalog = introspectSchema(3, false, { ownerId: OWNER, isAdmin: false }).catalog;
  const durableTables = await listUploadedTables(OWNER);
  check("REGRESSION/in-memory-empty",
    "post-cold-start the SYNC structured catalog is EMPTY for this owner (the old blind spot)",
    !coldCatalog.some((t) => t.table === TABLE), `cold catalog=[${coldCatalog.map((t) => t.table).join(",")}]`);
  check("REGRESSION/durable-present",
    "the DURABLE uploaded_rows STILL holds the table (data never lost — only the SQL catalog was blind)",
    durableTables.some((t) => t.table === TABLE), `durable=[${durableTables.map((t) => `${t.table}:${t.rows}`).join(",")}]`);

  // ── 4. THE FIX — router routes the spreadsheet question to "structured" ──────────
  console.log("\n· Routing the failing question (English) post-cold-start …");
  const planEn = await routeQuestion("do you have any apartments and addresses?", { ownerId: OWNER, isDemo: false });
  check("FIX/route-en",
    "router includes 'structured' (it knows the uploaded TABLE exists despite empty memory)",
    planEn.sources.includes("structured"),
    `sources=[${planEn.sources.join(",")}] rationale="${(planEn.rationale || "").slice(0, 80)}"`);

  // ── 5. THE FIX end-to-end — the answer RETRIEVES SQL ROWS + CITES, does NOT refuse ─
  console.log("\n· Answering the failing question (English) end-to-end …");
  const ansEn = await answerQuestion("do you have any apartments and addresses?", { ownerId: OWNER, isDemo: false, role: "member" });
  const aEn = ansEn.answer ?? "";
  const rowsEn = ansEn.evidence?.rows ?? [];
  check("FIX/retrieve-en", "at least one uploaded ROW was retrieved (text-to-SQL over the durable table)",
    rowsEn.length > 0, `rows=${rowsEn.length} mode=${ansEn.mode}`);
  check("FIX/not-refusal-en", "the answer is NOT a 'there are none' refusal (the exact bug symptom)",
    !(ansEn.mode === "grounded" && isRefusal(aEn)), aEn.slice(0, 200).replace(/\n/g, " "));
  check("FIX/grounded-cite-en", "grounded answer carries an [S:table#row] citation to the uploaded table",
    ansEn.mode === "grounded" && sqlCites(aEn).length > 0, `mode=${ansEn.mode} cites=${cites(aEn).join(" ") || "(none)"}`);

  // ── 6. The SAME query in HEBREW (the client's real language) ──────────────────────
  console.log("\n· Answering the same question in HEBREW (post-cold-start) …");
  const ansHe = await answerQuestion("האם יש לך דירות וכתובות?", { ownerId: OWNER, isDemo: false, role: "member" });
  const aHe = ansHe.answer ?? "";
  check("FIX/he-retrieve", "the Hebrew query retrieved uploaded row(s)",
    (ansHe.evidence?.rows ?? []).length > 0, `rows=${(ansHe.evidence?.rows ?? []).length} mode=${ansHe.mode}`);
  check("FIX/he-not-refusal", "the Hebrew grounded answer is NOT an 'אין' / not-found refusal",
    !(ansHe.mode === "grounded" && isRefusal(aHe)), aHe.slice(0, 200).replace(/\n/g, " "));

  // ── 6b. DOC-LANE DURABILITY — the PDF still routes to "documents" + is retrieved ──
  if (pdfIngested) {
    console.log("\n· Routing + answering a PDF question post-cold-start (doc-lane durability) …");
    const planDoc = await routeQuestion("what happened to the Carter family?", { ownerId: OWNER, isDemo: false });
    check("DOC/route-documents",
      "a narrative PDF question routes to 'documents' (doc-lane catalog survived the cold start)",
      planDoc.sources.includes("documents"), `sources=[${planDoc.sources.join(",")}]`);
    const ansDoc = await answerQuestion("what happened to the Carter family?", { ownerId: OWNER, isDemo: false, role: "member" });
    check("DOC/retrieve",
      "the PDF answer retrieved document chunk(s) (the durable doc-lane rehydrate works)",
      (ansDoc.evidence?.chunks ?? []).length > 0, `chunks=${(ansDoc.evidence?.chunks ?? []).length} mode=${ansDoc.mode}`);
  }

  // ── 7. OWNER ISOLATION — a different owner sees NONE of owner-1's table ───────────
  console.log("\n· Owner isolation: a different non-demo owner must NOT see the table …");
  __resetRuntimeStoreForTests(); // fresh cold start for the second owner
  resetStore();
  const iso = await answerQuestion("do you have any apartments and addresses?", { ownerId: OWNER2, isDemo: false, role: "member" });
  const isoRows = iso.evidence?.rows ?? [];
  const leaked = isoRows.some((r) => r.table === TABLE);
  check("ISO/no-leak", "owner-2 retrieved ZERO rows from owner-1's table (per-user isolation holds)",
    !leaked && isoRows.length === 0, `owner2 rows=${isoRows.length} leakedTable=${leaked}`);
  const isoTables = await listUploadedTables(OWNER2);
  check("ISO/listing-scoped", "owner-2's durable table listing is empty (no cross-owner listing)",
    isoTables.length === 0, `owner2 tables=[${isoTables.map((t) => t.table).join(",")}]`);
}

async function cleanup() {
  let removed = 0, after = -1, docsAfter = -1, usersDeleted = 0;
  try {
    if (OWNER && TABLE) removed = await deleteUploadedTable(OWNER, TABLE, false);
    if (OWNER && PDF_DOC) await deleteUploadedDoc(OWNER, PDF_DOC, false);
    if (OWNER) {
      after = (await listUploadedTables(OWNER)).length;
      docsAfter = (await listDurableDocs(OWNER)).length;
    }
  } catch (e) {
    console.error("rows cleanup error:", e instanceof Error ? e.message : e);
  }
  for (const id of [OWNER, OWNER2]) {
    if (!id) continue;
    try {
      const { error } = await admin().auth.admin.deleteUser(id); // ON DELETE CASCADE clears uploaded_rows + doc_chunks
      if (!error) usersDeleted++; else console.error("user delete error:", error.message);
    } catch (e) {
      console.error("user delete threw:", e instanceof Error ? e.message : e);
    }
  }
  console.log(`\n↩ cleanup: deleted ${removed} row(s) (owner-1 tables remaining: ${after}, docs remaining: ${docsAfter}); throwaway users deleted: ${usersDeleted}/2`);
  check("CLEANUP/clean", "the test owners' rows + docs + throwaway users were deleted from the live DB (no residue)",
    after === 0 && docsAfter === 0 && usersDeleted === 2, `tablesRemaining=${after} docsRemaining=${docsAfter} usersDeleted=${usersDeleted}`);
}

let runError = null;
try {
  await main();
} catch (e) {
  runError = e;
  console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e);
} finally {
  await cleanup();
}

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(
  `COLD-START DURABILITY: ${results.length - fails.length}/${results.length} passed` +
    (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN")
);
if (fails.length || runError) process.exit(1);
process.exit(0);
