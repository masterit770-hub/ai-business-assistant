// EDGE-JOURNEYS eval — the real-path guards for the client edge cases a non-technical
// user WILL trigger, that no other eval pins. Each is a distinct failure mode, run over
// the REAL engine as a throwaway NON-DEMO owner (is_demo=false), cold-started between
// write and read, and torn down after. NONE is a shape/presence check — every assertion
// is against a golden VALUE or a real isolation property.
//
// Journeys guarded here (each maps to a registry row):
//   • empty-bucket-new-user       — a brand-new user with NO uploads asks → honest "no
//                                     documents", NO bundled demo corpus leaks, no source.
//   • genuinely-unanswerable-idk  — a question whose answer is in NO uploaded content →
//                                     honest IDK (general), never a fabricated figure.
//   • aggregation-over-sheet      — SUM/COUNT/AVG over an uploaded sheet → the correct
//                                     COMPUTED figure backed by a real result row + [S:].
//   • re-upload-replace           — re-uploading a doc (same id) REPLACES its chunks: the
//                                     OLD fact is gone, the answer reflects ONLY the NEW one.
//   • delete-document             — deleting a doc purges it from retrieval AND survives a
//                                     cold start (a later question no longer cites it).
//   • zero-content-upload         — a 0-byte / no-text upload fails SOFT (ingest throws the
//                                     honest "no extractable text", does NOT crash) and a
//                                     question over the empty bucket yields honest IDK.
//   • mixed-doc-plus-table        — a question spanning BOTH lanes → ONE answer citing BOTH
//                                     a [P:doc#page] AND an [S:table#row].
//   • cross-user-isolation        — user B never retrieves/cites/aggregates user A's doc OR
//                                     table, after a cold start (RLS + owner-scoped RPC).
//
// RUN:  node tests/evals/edge-journeys.mjs
// Loads the LLM key + Supabase creds from local secret files (READ, never printed). Skips
// loudly (exit 0) if either is absent. PROVIDER-NEUTRAL (LLM_* env). No Gemini.
//
// SECURITY: READs .env.local / .secrets/supabase.env / .vercel-prod.env into process.env,
// but NEVER prints, echoes, logs, or commits any secret value.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { skip as skipShared } from "./_skip.mjs";

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

// Exit code is honest under CI_STRICT/REQUIRE_CREDS: a creds-skip in CI is a FAILURE
// (exit 1), never a silent pass. The loud "NOT a pass" banner prints in either mode. See _skip.mjs.
const skip = (msg) => skipShared("edge-journeys", msg);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — the durable doc/table lanes can't run.");
if (!haveLlm) skip("No LLM_API_KEY found — the router + answer pipeline make real LLM calls and can't run.");

// ── TEST HARNESS ─────────────────────────────────────────────────────────────────
const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}
const docCites = (a) => [...(a || "").matchAll(/\[P:[^\]]+\]/g)].map((m) => m[0]);
const sqlCites = (a) => [...(a || "").matchAll(/\[S:[^\]]+\]/g)].map((m) => m[0]);
const allCites = (a) => [...(a || "").matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]);
// An honest "you have no documents / I don't have that" — what an empty-bucket or
// unanswerable question must yield. We assert the answer is NOT grounded + cites nothing.
const isHonestIdk = (res) =>
  res.mode !== "grounded" && allCites(res.answer).length === 0;

// ── REAL engine entry points ─────────────────────────────────────────────────────
const { ingestPdf, ingestCsv } = await import("../../src/lib/engine/ingest.ts");
const { routeQuestion } = await import("../../src/lib/engine/router.ts");
const { answerQuestion } = await import("../../src/lib/engine/answer.ts");
const { resetStore } = await import("../../src/lib/engine/structured-store.ts");
const { listUploadedTables, deleteUploadedTable } = await import("../../src/lib/engine/structured-rows-store.ts");
const { listUploadedDocs, deleteUploadedDoc } = await import("../../src/lib/engine/pgvector-store.ts");
const { __resetRuntimeStoreForTests } = await import("../../src/lib/engine/runtime-store.ts");
const { supabaseEnabled, admin } = await import("../../src/lib/engine/supabase.ts");
void routeQuestion;

// Cold start: wipe ALL in-memory engine state so the next read proves the DURABLE store.
function coldStart() { __resetRuntimeStoreForTests(); resetStore(); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nucleus-edge-eval-"));
function makePdf(filePath, lines) {
  const py = `
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
c = canvas.Canvas(${JSON.stringify(filePath)}, pagesize=letter)
y = 740
for line in ${JSON.stringify(lines)}:
    c.drawString(72, y, line); y -= 22
c.showPage(); c.save()
`;
  execFileSync("python3", ["-c", py], { stdio: ["ignore", "ignore", "pipe"] });
}
function haveReportlab() {
  try { execFileSync("python3", ["-c", "import reportlab"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

// Throwaway non-demo owners we create + tear down.
const OWNERS = [];
const DOC_CLEANUP = []; // {owner, doc}
const TABLE_CLEANUP = []; // {owner, table}
async function newOwner(tag) {
  const email = `edge-${tag}-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({
    email, password: crypto.randomUUID(), email_confirm: true,
  });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  OWNERS.push(data.user.id);
  return data.user.id;
}
// A non-demo member asks over ONLY their own content (bundled demo corpus excluded).
const askAs = (q, owner) => answerQuestion(q, { ownerId: owner, isDemo: false, role: "member" });

const VENDORS_CSV =
  "vendor,annual_cost\n" +
  "Acme Supplies,1200\n" +
  "Globex Corp,3400\n" +
  "Initech LLC,560\n" +
  "Umbrella Co,7800\n"; // SUM=12960, COUNT=4, AVG=3240

async function main() {
  check("ENV/supabase", "the engine sees Supabase as configured", supabaseEnabled());
  if (!supabaseEnabled()) throw new Error("supabaseEnabled() is false despite env — aborting");
  if (!haveReportlab()) skip("python3 + reportlab not available — cannot build the born-digital PDF fixtures.");

  // ── 1. EMPTY-BUCKET NEW USER — no uploads → honest IDK, NO bundled demo leak ──────
  console.log("\n· [empty-bucket] a brand-new non-demo user with NO uploads asks a question …");
  const empty = await newOwner("empty");
  coldStart();
  const ebRes = await askAs("What does my contract say about the renewal terms?", empty);
  check("EMPTY-BUCKET/honest-idk",
    "a new user with NO uploads gets an honest non-grounded answer, citing NOTHING (no bundled demo leak)",
    isHonestIdk(ebRes),
    `mode=${ebRes.mode} cites=${allCites(ebRes.answer).join(" ") || "(none)"} :: "${ebRes.answer.slice(0, 140).replace(/\n/g, " ")}"`);
  // It must NOT have retrieved the bundled Carter corpus (a non-demo user is isolated from it).
  const ebCitesCarter = /carter|family-court/i.test(allCites(ebRes.answer).join(" "));
  check("EMPTY-BUCKET/no-demo-leak",
    "the empty-bucket answer does NOT cite the bundled demo corpus (Carter/family-court) to a non-demo user",
    !ebCitesCarter, `cites=${allCites(ebRes.answer).join(" ") || "(none)"}`);

  // ── 2. AGGREGATION OVER A SHEET — SUM/COUNT/AVG via text-to-SQL ───────────────────
  console.log("\n· [aggregation] upload a vendors sheet → ask a SUM/COUNT/AVG → computed figure + [S:] …");
  const agg = await newOwner("agg");
  const aggCsv = await ingestCsv(VENDORS_CSV, `vendors-${agg.slice(0, 6)}.csv`, agg);
  TABLE_CLEANUP.push({ owner: agg, table: aggCsv.table });
  check("AGG/ingest", "the vendors sheet ingested + persisted rows", (aggCsv.rows ?? 0) > 0 && (aggCsv.persisted ?? 0) > 0,
    `rows=${aggCsv.rows} persisted=${aggCsv.persisted}`);
  coldStart();
  const sumRes = await askAs("What is the total annual cost across all vendor contracts in my sheet?", agg);
  const aSum = sumRes.answer ?? "";
  // SUM=12960. Accept comma/space variants.
  check("AGG/sum",
    "the total (SUM=12,960) is computed and cited to a real result row [S:table#row]",
    /12[\s,]?960/.test(aSum) && sqlCites(aSum).length > 0 && sumRes.mode === "grounded",
    `mode=${sumRes.mode} sum12960=${/12[\s,]?960/.test(aSum)} cites=${allCites(aSum).join(" ") || "(none)"} :: "${aSum.slice(0, 160).replace(/\n/g, " ")}"`);
  coldStart();
  const cntRes = await askAs("How many vendors are in my sheet?", agg);
  check("AGG/count",
    "the COUNT (4 vendors) is computed correctly",
    /\b4\b|four/i.test(cntRes.answer ?? "") && cntRes.mode === "grounded",
    `mode=${cntRes.mode} :: "${(cntRes.answer ?? "").slice(0, 140).replace(/\n/g, " ")}"`);

  // ── 2b. GENUINELY-UNANSWERABLE → honest IDK (answer layer), not a fabrication ─────
  // The user HAS a doc, but asks something genuinely NOT in any of their content. The
  // answer must be an honest "not in your documents / I don't know" — never a fabricated
  // figure and never a refusal-of-known. (Distinct from empty-bucket: here content EXISTS,
  // it just doesn't answer THIS question.)
  console.log("\n· [unanswerable] a user WITH a sheet asks something genuinely not in any of their content …");
  // `agg` owns only the vendors sheet → a 14th-century castle question is unanswerable.
  coldStart();
  const unRes = await askAs("What is the moat depth described in the 14th-century castle restoration report?", agg);
  const aUn = unRes.answer ?? "";
  // Honest: not grounded to the vendors sheet (no fabricated castle figure cited to it).
  check("UNANSWERABLE/honest-idk",
    "a genuinely-unanswerable question yields an honest non-grounded answer (no fabricated figure cited to the user's unrelated sheet)",
    unRes.mode !== "grounded" && !sqlCites(aUn).length,
    `mode=${unRes.mode} cites=${allCites(aUn).join(" ") || "(none)"} :: "${aUn.slice(0, 140).replace(/\n/g, " ")}"`);

  // ── 3. RE-UPLOAD / REPLACE — new content replaces old; no stale chunks ────────────
  console.log("\n· [re-upload] upload a doc, then RE-upload the SAME id with NEW content → old fact gone …");
  const reup = await newOwner("reup");
  const docName = `policy-${reup.slice(0, 6)}.pdf`;
  const v1 = path.join(TMP, "v1.pdf");
  makePdf(v1, ["Company Policy Memo", "", "The annual travel budget is 11111 dollars.", "This is version ONE of the policy."]);
  const ing1 = await ingestPdf(new Uint8Array(fs.readFileSync(v1)), docName, "Policy memo", reup);
  DOC_CLEANUP.push({ owner: reup, doc: ing1.doc });
  // Re-upload the SAME filename (→ same doc id) with a DIFFERENT figure.
  const v2 = path.join(TMP, "v2.pdf");
  makePdf(v2, ["Company Policy Memo", "", "The annual travel budget is 22222 dollars.", "This is version TWO of the policy."]);
  const ing2 = await ingestPdf(new Uint8Array(fs.readFileSync(v2)), docName, "Policy memo", reup);
  check("REUPLOAD/same-doc", "re-upload kept the SAME doc id (a replace, not a 2nd doc)", ing1.doc === ing2.doc,
    `v1=${ing1.doc} v2=${ing2.doc}`);
  coldStart();
  const reupRes = await askAs("What is the annual travel budget in my policy memo?", reup);
  const aReup = reupRes.answer ?? "";
  check("REUPLOAD/new-content",
    "the answer reflects ONLY the NEW figure (22,222) and NOT the stale old one (11,111)",
    /22[\s,]?222/.test(aReup) && !/11[\s,]?111/.test(aReup),
    `new22222=${/22[\s,]?222/.test(aReup)} stale11111=${/11[\s,]?111/.test(aReup)} :: "${aReup.slice(0, 160).replace(/\n/g, " ")}"`);
  // Belt-and-suspenders: the durable store has exactly ONE copy of the doc (no duplicate).
  const reupDocs = await listUploadedDocs(reup);
  check("REUPLOAD/single-copy",
    "the durable store lists the doc exactly ONCE after replace (no duplicate doc rows)",
    reupDocs.filter((d) => d.doc === ing2.doc).length === 1, `copies=${reupDocs.filter((d) => d.doc === ing2.doc).length}`);

  // ── 4. DELETE — a deleted doc is purged from retrieval, surviving a cold start ────
  console.log("\n· [delete] upload a doc, delete it, cold-start, ask → no longer retrieved/cited …");
  const del = await newOwner("del");
  const delName = `secret-${del.slice(0, 6)}.pdf`;
  const dpdf = path.join(TMP, "del.pdf");
  makePdf(dpdf, ["Confidential Note", "", "The launch codeword is ZEPHYR77.", "Destroy after reading."]);
  const ingD = await ingestPdf(new Uint8Array(fs.readFileSync(dpdf)), delName, "Secret note", del);
  // Sanity: before delete it IS retrievable.
  coldStart();
  const before = await askAs("What is the launch codeword in my note?", del);
  check("DELETE/before", "before delete, the doc IS retrieved + cited (the codeword grounds)",
    /zephyr77/i.test(before.answer ?? "") && docCites(before.answer).length > 0,
    `found=${/zephyr77/i.test(before.answer ?? "")} cites=${allCites(before.answer).join(" ") || "(none)"}`);
  const removed = await deleteUploadedDoc(del, ingD.doc, false);
  check("DELETE/purged-rows", "deleteUploadedDoc removed the durable chunks", removed > 0, `removed=${removed}`);
  coldStart(); // a deleted doc must be gone from the DURABLE store, not just warm memory
  const after = await askAs("What is the launch codeword in my note?", del);
  check("DELETE/after",
    "after delete + cold start, the doc is NO longer retrieved and the codeword is gone (honest IDK)",
    !/zephyr77/i.test(after.answer ?? "") && !docCites(after.answer).some((c) => c.includes(ingD.doc)),
    `mode=${after.mode} found=${/zephyr77/i.test(after.answer ?? "")} cites=${allCites(after.answer).join(" ") || "(none)"}`);

  // ── 5. ZERO-CONTENT UPLOAD — fails SOFT (honest throw, no crash), then honest IDK ─
  console.log("\n· [zero-content] upload an empty/no-text PDF → ingest fails soft (honest 'no extractable text') …");
  const zero = await newOwner("zero");
  const emptyPdf = path.join(TMP, "empty.pdf");
  makePdf(emptyPdf, [" "]); // a page with no real text → 0 chunks → honest throw
  let zeroErr = null;
  try {
    await ingestPdf(new Uint8Array(fs.readFileSync(emptyPdf)), `empty-${zero.slice(0, 6)}.pdf`, "Empty", zero);
  } catch (e) {
    zeroErr = e instanceof Error ? e.message : String(e);
  }
  check("ZERO/honest-throw",
    "ingesting a no-text PDF throws the HONEST 'no extractable text' error (fails soft, does not crash silently)",
    zeroErr != null && /no extractable text/i.test(zeroErr), `err=${zeroErr ? zeroErr.slice(0, 80) : "(none — it did NOT surface the honest error)"}`);
  coldStart();
  const zeroAsk = await askAs("What does my uploaded file say?", zero);
  check("ZERO/honest-idk",
    "asking over the empty bucket (the failed upload stored nothing) yields honest IDK, never a fabricated answer",
    isHonestIdk(zeroAsk), `mode=${zeroAsk.mode} cites=${allCites(zeroAsk.answer).join(" ") || "(none)"}`);

  // ── 6. MIXED DOC + TABLE — one answer citing BOTH a [P:] and an [S:] ──────────────
  console.log("\n· [mixed] a question spanning a doc AND a table → ONE answer citing BOTH [P:] and [S:] …");
  const mix = await newOwner("mix");
  const mixPdf = path.join(TMP, "mix.pdf");
  makePdf(mixPdf, ["Project Brief", "", "The project codename is ORCHID.", "It summarizes the vendor engagement."]);
  const mixDoc = await ingestPdf(new Uint8Array(fs.readFileSync(mixPdf)), `brief-${mix.slice(0, 6)}.pdf`, "Project brief", mix);
  DOC_CLEANUP.push({ owner: mix, doc: mixDoc.doc });
  const mixCsv = await ingestCsv(VENDORS_CSV, `vendors-${mix.slice(0, 6)}.csv`, mix);
  TABLE_CLEANUP.push({ owner: mix, table: mixCsv.table });
  coldStart();
  const mixRes = await askAs(
    "What is the project codename in my brief, and what is the total annual cost across all vendors in my sheet?",
    mix
  );
  const aMix = mixRes.answer ?? "";
  check("MIXED/dual-citation",
    "the single answer cites BOTH a [P:doc#page] (the brief) AND an [S:table#row] (the sheet total)",
    docCites(aMix).length > 0 && sqlCites(aMix).length > 0 && mixRes.mode === "grounded",
    `mode=${mixRes.mode} docCites=${docCites(aMix).length} sqlCites=${sqlCites(aMix).length} :: "${aMix.slice(0, 180).replace(/\n/g, " ")}"`);
  check("MIXED/both-facts",
    "the answer carries BOTH facts (the codename ORCHID and the total 12,960)",
    /orchid/i.test(aMix) && /12[\s,]?960/.test(aMix),
    `orchid=${/orchid/i.test(aMix)} total=${/12[\s,]?960/.test(aMix)}`);

  // ── 6b. CROSS-LINGUAL HE-over-EN — a Hebrew question over an ENGLISH doc grounds ──
  // The embeddings are multilingual (e5), so a Hebrew question must still retrieve and
  // ground in an ENGLISH document. This is a distinct path from same-language Hebrew Q&A.
  console.log("\n· [cross-lingual] a HEBREW question over an ENGLISH uploaded doc → grounded + cited …");
  const xl = await newOwner("xling");
  const xlPdf = path.join(TMP, "warranty.pdf");
  makePdf(xlPdf, ["Product Warranty Terms", "", "The warranty period for the Falcon X1 device is 36 months.", "Coverage includes parts and labor."]);
  const xlDoc = await ingestPdf(new Uint8Array(fs.readFileSync(xlPdf)), `warranty-${xl.slice(0, 6)}.pdf`, "Warranty", xl);
  DOC_CLEANUP.push({ owner: xl, doc: xlDoc.doc });
  coldStart();
  // Hebrew: "What is the warranty period of the Falcon X1 device?"
  const xlRes = await askAs("מהי תקופת האחריות של מכשיר ה-Falcon X1?", xl);
  const aXl = xlRes.answer ?? "";
  check("CROSS-LINGUAL/grounded",
    "a Hebrew question over the English warranty doc grounds + cites the recovered fact (36 months)",
    xlRes.mode === "grounded" && /\b36\b/.test(aXl) && docCites(aXl).length > 0,
    `mode=${xlRes.mode} has36=${/\b36\b/.test(aXl)} cites=${allCites(aXl).join(" ") || "(none)"} :: "${aXl.slice(0, 140).replace(/\n/g, " ")}"`);

  // ── 7. CROSS-USER ISOLATION — B never sees A's doc OR table, after a cold start ───
  console.log("\n· [isolation] user B must NEVER retrieve/cite/aggregate user A's doc or table …");
  // Reuse: A = the `del`-style owner with a unique doc; create A fresh + a table too.
  const A = await newOwner("isoA");
  const aPdf = path.join(TMP, "isoA.pdf");
  makePdf(aPdf, ["Owner A Private Memo", "", "Owner A's secret token is ALPHA-7731.", "Private to A only."]);
  const aDoc = await ingestPdf(new Uint8Array(fs.readFileSync(aPdf)), `aprivate-${A.slice(0, 6)}.pdf`, "A private", A);
  DOC_CLEANUP.push({ owner: A, doc: aDoc.doc });
  const aTbl = await ingestCsv("widget,units\nAlphaWidget,9999\n", `aunits-${A.slice(0, 6)}.csv`, A);
  TABLE_CLEANUP.push({ owner: A, table: aTbl.table });
  const B = await newOwner("isoB");
  coldStart();
  // The question must NOT contain the secret (or the model could echo it from the prompt).
  // It asks B for A's private fact by description; a leak would surface the token FROM A's
  // retrieved doc — which must never happen for B.
  const bAsksADoc = await askAs("What is the secret token in the private memo I uploaded?", B);
  check("ISOLATION/doc",
    "user B does NOT retrieve or cite user A's private DOC (no ALPHA-7731 leaked, no A citation)",
    !/alpha-?7731/i.test(bAsksADoc.answer ?? "") && !allCites(bAsksADoc.answer).some((c) => c.includes(aDoc.doc)),
    `leaked=${/alpha-?7731/i.test(bAsksADoc.answer ?? "")} cites=${allCites(bAsksADoc.answer).join(" ") || "(none)"}`);
  coldStart();
  const bAsksATbl = await askAs("How many AlphaWidget units are there in the sheet?", B);
  check("ISOLATION/table",
    "user B does NOT aggregate/cite user A's private TABLE (no 9999, no A table citation)",
    !/9999/.test(bAsksATbl.answer ?? "") && !sqlCites(bAsksATbl.answer).some((c) => c.includes(aTbl.table)),
    `leaked=${/9999/.test(bAsksATbl.answer ?? "")} cites=${allCites(bAsksATbl.answer).join(" ") || "(none)"}`);
  // B's router catalog must not list A's table either (catalog-level isolation).
  const bTables = await listUploadedTables(B);
  check("ISOLATION/catalog",
    "user B's durable table catalog does NOT include user A's table (catalog-level isolation)",
    !bTables.some((t) => t.table === aTbl.table), `bTables=[${bTables.map((t) => t.table).join(",")}]`);
}

async function cleanup() {
  let chunksRemoved = 0, rowsRemoved = 0, usersDeleted = 0;
  for (const { owner, doc } of DOC_CLEANUP) {
    try { chunksRemoved += await deleteUploadedDoc(owner, doc, false); } catch { /* */ }
  }
  for (const { owner, table } of TABLE_CLEANUP) {
    try { rowsRemoved += await deleteUploadedTable(owner, table, false); } catch { /* */ }
  }
  for (const owner of OWNERS) {
    try {
      const { error } = await admin().auth.admin.deleteUser(owner); // CASCADE clears any residual rows
      if (!error) usersDeleted++;
    } catch { /* */ }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
  console.log(`\n↩ cleanup: chunks ${chunksRemoved}, rows ${rowsRemoved}, users ${usersDeleted}/${OWNERS.length}`);
  check("CLEANUP/clean", "every throwaway owner + their docs/tables were deleted (no residue)",
    usersDeleted === OWNERS.length, `usersDeleted=${usersDeleted}/${OWNERS.length}`);
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
  `EDGE JOURNEYS: ${results.length - fails.length}/${results.length} passed` +
    (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN")
);
if (fails.length || runError) process.exit(1);
process.exit(0);
