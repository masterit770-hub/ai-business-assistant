// UPLOAD-FORMATS eval — the MOST BASIC promise of the product, proven for EVERY
// supported upload format: upload → ask → CITED grounded answer.
//
// THE CAPABILITY (why this test exists): Nucleus's core contract is "upload a file,
// ask a question about it, get a grounded answer with a traceable citation." That has
// to hold for ALL FOUR supported formats, not just the one the demo happens to use:
//   (1) a born-digital PDF      → document lane → cited [P:<doc>#page]
//   (2) a Word .docx            → document lane → cited [P:<doc>#page]
//   (3) a CSV                   → text-to-SQL  → cited [S:<table>#row]
//   (4) an XLSX                 → text-to-SQL  → cited [S:<table>#row]
// A format that silently fails to round-trip (ingests but can't be answered, or answers
// without a citation, or refuses) is a real product gap — this catches it per-format.
//
// HOW IT PROVES IT (no false-green): for EACH format we mint a fixture carrying a
// KNOWN, UNIQUE, made-up fact (an invented vendor name + a number that exists nowhere
// in the model's training data and nowhere in the bundled demo corpus). We ingest that
// fixture as a FRESH throwaway NON-DEMO owner (isDemo:false) via the REAL ingest
// function for that format — the exact code the live /api/ingest route calls — then ask
// a question whose only possible correct answer is that fact, and assert:
//   • mode === "grounded"                         (answered from the upload, not memory)
//   • the answer CONTAINS the known fact          (it actually read the file)
//   • the answer carries the RIGHT citation       ([P:…] for PDF/Word, [S:…] for CSV/XLSX)
//   • the answer is NOT a refusal                 ("no data / can't find it")
// Because the fact is invented, a "general" answer from model memory CANNOT contain it —
// so a passing answer can only have come from the real upload→retrieve→cite path.
//
// RUN (from the repo root):
//   node tests/evals/upload-formats.mjs
// It loads the LLM key + Supabase creds from local secret files (READ, never printed).
// If either is absent it SKIPS loudly with exit 0 (never a false-green). It uses a
// DISTINCT synthetic non-demo owner per format and DELETES their uploaded rows/docs +
// the throwaway users at the end, leaving no residue.
//
// SECURITY: this file READs .env.local / .secrets/supabase.env / .vercel-prod.env to set
// process.env, but NEVER prints, echoes, logs, or commits any secret value.
//
// Provider-neutral: it speaks to whatever LLM the env configures (DeepSeek / Azure /
// local). There is NO Gemini/GCP dependency anywhere in this file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { skip as skipShared } from "./_skip.mjs";
import { assertCleanBefore, assertCleanAfter } from "./_residue-guard.mjs";

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
const skip = (msg) => skipShared("upload-formats", msg);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — uploads can't persist to the durable lane.");
if (!haveLlm) skip("No LLM_API_KEY found — the router + answer pipeline make real LLM calls and can't run.");

// ── TEST HARNESS ─────────────────────────────────────────────────────────────────
const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}
const docCites = (ans) => [...(ans || "").matchAll(/\[P:[^\]]+\]/g)].map((m) => m[0]);
const sqlCites = (ans) => [...(ans || "").matchAll(/\[S:[^\]]+\]/g)].map((m) => m[0]);
const allCites = (ans) => [...(ans || "").matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]);
// A "refusal" = the answer says it has no data / can't find it. This is the exact shape
// a broken round-trip produces (ingested but unretrievable). EN + HE.
const REFUSAL_RE =
  /\b(there (are|is) no|no (data|records?|information|matching|results?)|do(es)? not have|don'?t have|no relevant|could ?n'?t find|cannot (find|answer|locate)|not available|unable to (find|locate|answer)|i (don'?t|do not) have (any|access|information))\b/i;
const HE_REFUSAL_RE = /(אין לי|לא נמצא|לא קיים|לא זמין|אין נתונים|אין מסמכים|אין טבלה)/;
const isRefusal = (a) => REFUSAL_RE.test(a || "") || HE_REFUSAL_RE.test(a || "");

// Normalize for fact-containment: collapse whitespace, lowercase. The number is checked
// both raw and comma-grouped (the model may render 84217 as "84,217").
function answerContainsFact(answer, vendor, number) {
  const a = (answer || "").toLowerCase();
  const hasVendor = a.includes(vendor.toLowerCase());
  const numStr = String(number);
  const grouped = numStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const hasNumber = a.includes(numStr) || a.includes(grouped);
  return { ok: hasVendor && hasNumber, hasVendor, hasNumber };
}

// Import the REAL engine entry points (same modules the live /api/ingest + /api/ask use).
const { ingestPdf, ingestCsv, ingestXlsx, ingestDocx } = await import("../../src/lib/engine/ingest.ts");
const { routeQuestion } = await import("../../src/lib/engine/router.ts");
const { answerQuestion } = await import("../../src/lib/engine/answer.ts");
const { resetStore } = await import("../../src/lib/engine/structured-store.ts");
const { listUploadedTables, deleteUploadedTable } = await import("../../src/lib/engine/structured-rows-store.ts");
const { listUploadedDocs: listDurableDocs, deleteUploadedDoc } = await import("../../src/lib/engine/pgvector-store.ts");
const { __resetRuntimeStoreForTests } = await import("../../src/lib/engine/runtime-store.ts");
const { supabaseEnabled, admin } = await import("../../src/lib/engine/supabase.ts");

// ── FIXTURE BUILDERS ───────────────────────────────────────────────────────────
// Each fixture carries a DISTINCT invented vendor + number, so an answer that contains
// the fact can ONLY have come from that specific upload (not memory, not a sibling
// fixture, not the demo corpus).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nucleus-upload-eval-"));

// (1) Born-digital PDF via python3 + reportlab (real text layer, NOT a scanned image).
function makePdf(filePath, vendor, number) {
  const py = `
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
c = canvas.Canvas(${JSON.stringify(filePath)}, pagesize=letter)
y = 740
for line in [
    "Vendor Services Agreement",
    "",
    "This agreement is between Nucleus Eval Co and the vendor named below.",
    "Preferred vendor of record: ${vendor}.",
    "The total annual contract value is ${number} dollars.",
    "All payments are due net 30 from the invoice date.",
]:
    c.drawString(72, y, line); y -= 22
c.showPage(); c.save()
`;
  execFileSync("python3", ["-c", py], { stdio: ["ignore", "ignore", "pipe"] });
}

// (2) Word .docx via python3 + python-docx.
function makeDocx(filePath, vendor, number) {
  const py = `
import docx
d = docx.Document()
d.add_heading("Master Services Statement", level=1)
d.add_paragraph("This statement records the engaged supplier and its fee.")
d.add_paragraph("The designated supplier for this project is ${vendor}.")
d.add_paragraph("The negotiated retainer fee is ${number} dollars per quarter.")
d.add_paragraph("Signed and effective as of the date above.")
d.save(${JSON.stringify(filePath)})
`;
  execFileSync("python3", ["-c", py], { stdio: ["ignore", "ignore", "pipe"] });
}

// (3) CSV — plain string (no file needed; ingestCsv takes text).
function makeCsv(vendor, number) {
  return (
    "vendor,category,annual_amount,city\n" +
    "Acme Supplies,office,12000,Boston\n" +
    `${vendor},logistics,${number},Denver\n` +
    "Globex Partners,catering,8000,Austin\n"
  );
}

// (4) XLSX via the repo's `xlsx` node lib — one sheet, header row + data rows.
async function makeXlsx(filePath, vendor, number) {
  const XLSX = await import("xlsx");
  const aoa = [
    ["vendor", "category", "monthly_amount", "city"],
    ["Initech LLC", "software", 4500, "Reno"],
    [vendor, "security", number, "Tucson"],
    ["Umbrella Co", "cleaning", 2200, "Salem"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "vendors");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  fs.writeFileSync(filePath, buf);
}

// ── PER-FORMAT CASES ───────────────────────────────────────────────────────────
// `lane`: "documents" → expect [P:…] cite + chunk evidence; "structured" → [S:…] + rows.
// `unique`: each vendor + number is invented & distinct so a hit is unambiguous.
const CASES = [
  {
    fmt: "pdf",
    lane: "documents",
    vendor: "Quorvath Logistics",
    number: 84217,
    question: "Who is the preferred vendor of record and what is the total annual contract value in dollars?",
    async ingest(owner) {
      const fp = path.join(TMP, "vendor-agreement.pdf");
      makePdf(fp, "Quorvath Logistics", 84217);
      const buf = new Uint8Array(fs.readFileSync(fp));
      return ingestPdf(buf, "vendor-agreement.pdf", "Vendor Agreement", owner);
    },
  },
  {
    fmt: "docx",
    lane: "documents",
    vendor: "Brimstead Supply",
    number: 56930,
    question: "Which supplier is designated for this project and what is the quarterly retainer fee in dollars?",
    async ingest(owner) {
      const fp = path.join(TMP, "services-statement.docx");
      makeDocx(fp, "Brimstead Supply", 56930);
      const buf = new Uint8Array(fs.readFileSync(fp));
      return ingestDocx(buf, "services-statement.docx", "Services Statement", owner);
    },
  },
  {
    fmt: "csv",
    lane: "structured",
    vendor: "Drazenko Freight",
    number: 73450,
    question: "What is the annual_amount for the vendor Drazenko Freight?",
    async ingest(owner) {
      const csv = makeCsv("Drazenko Freight", 73450);
      return ingestCsv(csv, "vendor-spend.csv", owner);
    },
  },
  {
    fmt: "xlsx",
    lane: "structured",
    vendor: "Pelmont Security",
    number: 61875,
    question: "What is the monthly_amount for the vendor Pelmont Security?",
    async ingest(owner) {
      const fp = path.join(TMP, "vendor-budget.xlsx");
      await makeXlsx(fp, "Pelmont Security", 61875);
      const buf = new Uint8Array(fs.readFileSync(fp));
      return ingestXlsx(buf, "vendor-budget.xlsx", owner);
    },
  },
];

// One throwaway NON-DEMO owner PER format (distinct, so a leak across cases is
// impossible by construction). uploaded_rows/doc_chunks.owner_id is a FK to
// auth.users(id), so each owner must be a REAL user (created + deleted here).
async function newOwner(tag) {
  const email = `upload-fmt-${tag}-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({
    email, password: crypto.randomUUID(), email_confirm: true,
  });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  return data.user.id;
}

// Track everything we create so cleanup can remove it all.
const created = []; // { fmt, owner, table?, doc? }

async function runCase(c) {
  console.log(`\n${"─".repeat(72)}\n▶ FORMAT: ${c.fmt.toUpperCase()}  (lane: ${c.lane})`);
  const owner = await newOwner(c.fmt);
  const rec = { fmt: c.fmt, owner, table: null, doc: null };
  created.push(rec);
  console.log(`  owner ${owner.slice(0, 8)}…  fact = "${c.vendor}" / ${c.number}`);

  // ── INGEST via the REAL format function, as a NON-DEMO owner ──────────────────
  const res = await c.ingest(owner);
  if (c.lane === "structured") {
    rec.table = res.table;
    check(`${c.fmt}/ingest-rows`, `${c.fmt}: ingested with structured rows`,
      (res.rows ?? 0) > 0, `rows=${res.rows} table=${res.table}`);
    check(`${c.fmt}/ingest-persisted`, `${c.fmt}: rows PERSISTED to durable uploaded_rows`,
      (res.persisted ?? 0) > 0, `persisted=${res.persisted}`);
    check(`${c.fmt}/ingest-not-ragged`, `${c.fmt}: a spreadsheet is NOT embedded as RAG chunks`,
      (res.chunks ?? 0) === 0, `chunks=${res.chunks} (must be 0 — structured lane)`);
  } else {
    rec.doc = res.doc;
    check(`${c.fmt}/ingest-chunks`, `${c.fmt}: ingested with document chunks`,
      (res.chunks ?? 0) > 0, `chunks=${res.chunks} doc=${res.doc}`);
    check(`${c.fmt}/ingest-persisted`, `${c.fmt}: chunks PERSISTED to durable doc_chunks`,
      (res.persisted ?? 0) > 0, `persisted=${res.persisted}`);
  }

  // Fresh state before query (no cross-case warm-store bleed; proves durable retrieval).
  __resetRuntimeStoreForTests();
  resetStore();

  // ── ROUTE: the question must reach the right lane ─────────────────────────────
  const plan = await routeQuestion(c.question, { ownerId: owner, isDemo: false });
  check(`${c.fmt}/route`, `${c.fmt}: router includes the '${c.lane}' lane`,
    plan.sources.includes(c.lane), `sources=[${plan.sources.join(",")}]`);

  // ── ANSWER end-to-end: grounded + contains the fact + cited + not a refusal ───
  const ans = await answerQuestion(c.question, { ownerId: owner, isDemo: false, role: "member" });
  const a = ans.answer ?? "";
  const preview = a.slice(0, 240).replace(/\n/g, " ");
  const rowsN = ans.evidence?.rows?.length ?? 0;
  const chunksN = ans.evidence?.chunks?.length ?? 0;

  // (a) mode grounded
  check(`${c.fmt}/grounded`, `${c.fmt}: answer mode is "grounded" (answered from the upload, not memory)`,
    ans.mode === "grounded", `mode=${ans.mode} rows=${rowsN} chunks=${chunksN}`);

  // (b) evidence was retrieved from the right lane
  if (c.lane === "structured") {
    check(`${c.fmt}/evidence`, `${c.fmt}: at least one uploaded ROW retrieved (text-to-SQL)`,
      rowsN > 0, `rows=${rowsN}`);
  } else {
    check(`${c.fmt}/evidence`, `${c.fmt}: at least one document CHUNK retrieved (hybrid RAG)`,
      chunksN > 0, `chunks=${chunksN}`);
  }

  // (c) the answer CONTAINS the known unique fact (vendor + number)
  const fact = answerContainsFact(a, c.vendor, c.number);
  check(`${c.fmt}/contains-fact`,
    `${c.fmt}: answer contains the known fact — vendor "${c.vendor}" AND ${c.number}`,
    fact.ok, `vendor=${fact.hasVendor} number=${fact.hasNumber} · "${preview}"`);

  // (d) the RIGHT citation type is present
  if (c.lane === "structured") {
    check(`${c.fmt}/cite`, `${c.fmt}: grounded answer carries an [S:table#row] citation`,
      ans.mode === "grounded" && sqlCites(a).length > 0,
      `cites=${allCites(a).join(" ") || "(none)"}`);
  } else {
    check(`${c.fmt}/cite`, `${c.fmt}: grounded answer carries a [P:doc#page] citation`,
      ans.mode === "grounded" && docCites(a).length > 0,
      `cites=${allCites(a).join(" ") || "(none)"}`);
  }

  // (e) NOT a refusal
  check(`${c.fmt}/not-refusal`, `${c.fmt}: the answer is NOT a 'no data / can't find it' refusal`,
    !isRefusal(a), `"${preview}"`);
}

async function main() {
  check("ENV/supabase", "the engine sees Supabase as configured (durable lane is live)", supabaseEnabled());
  if (!supabaseEnabled()) throw new Error("supabaseEnabled() is false despite env — aborting to avoid a meaningless run");

  for (const c of CASES) {
    await runCase(c);
  }
}

async function cleanup() {
  let rowsRemoved = 0, docsRemoved = 0, usersDeleted = 0, residue = 0;
  for (const rec of created) {
    try {
      if (rec.table) rowsRemoved += await deleteUploadedTable(rec.owner, rec.table, false);
      if (rec.doc) docsRemoved += await deleteUploadedDoc(rec.owner, rec.doc, false);
    } catch (e) {
      console.error("rows/docs cleanup error:", e instanceof Error ? e.message : e);
    }
  }
  for (const rec of created) {
    // Verify nothing of this owner's remains in the durable stores.
    try {
      const tablesLeft = (await listUploadedTables(rec.owner)).length;
      const docsLeft = (await listDurableDocs(rec.owner)).length;
      residue += tablesLeft + docsLeft;
    } catch { /* listing failure shouldn't mask the user delete below */ }
    try {
      const { error } = await admin().auth.admin.deleteUser(rec.owner); // CASCADE clears uploaded_rows + doc_chunks
      if (!error) usersDeleted++; else console.error("user delete error:", error.message);
    } catch (e) {
      console.error("user delete threw:", e instanceof Error ? e.message : e);
    }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir best-effort */ }
  console.log(
    `\n↩ cleanup: deleted ${rowsRemoved} row(s) + ${docsRemoved} doc(s); ` +
    `throwaway users deleted: ${usersDeleted}/${created.length}; residue rows+docs: ${residue}`
  );
  check("CLEANUP/clean",
    "every throwaway owner's rows + docs + user were deleted from the live DB (no residue)",
    residue === 0 && usersDeleted === created.length,
    `residue=${residue} usersDeleted=${usersDeleted}/${created.length}`);
}

// RESIDUE GUARD (#79): refuse to run over a DB a prior leaked run left dirty (a polluted
// catalog produces a FALSE GREEN); abort loudly. Asserts 0 throwaway orphan rows BEFORE the run.
await assertCleanBefore("upload-formats");
let runError = null;
try {
  await main();
} catch (e) {
  runError = e;
  console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e);
} finally {
  await cleanup();
}
// RESIDUE GUARD (#79): this run must leave 0 throwaway residue — fail loudly if its cleanup leaked.
await assertCleanAfter("upload-formats");

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(
  `UPLOAD-FORMATS: ${results.length - fails.length}/${results.length} passed` +
    (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN")
);
if (fails.length || runError) process.exit(1);
process.exit(0);
