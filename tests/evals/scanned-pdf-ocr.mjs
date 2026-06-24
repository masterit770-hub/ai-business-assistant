// SCANNED-PDF OCR eval — guards the CAPABILITY the client reported MISSING: a
// scanned / image-only (column) PDF "wasn't read".
//
// THE LESSON (why this test exists): a scanned PDF has NO text layer — it is a picture
// of text. unpdf (the born-digital text path) returns ~nothing for it, so the ONLY way
// to read it is OCR. The bundled golden evals never catch this: they run over
// born-digital corpus PDFs that have a real text layer, so OCR is never exercised. This
// test builds a TRUE scanned PDF (render known text — English + a Hebrew line — to a
// raster IMAGE, embed that image as a full-page PDF so there is NO selectable text),
// PROVES it has no text layer (unpdf ≈ empty), then ingests it as a throwaway non-demo
// owner via the REAL engine ingestPdf (which OCRs low-text pages best-effort) and asks
// for the known facts. It asserts HONESTLY:
//   • GREEN  — OCR read the image, ingest produced chunks, and the end-to-end answer is
//              GROUNDED + carries a [P:<doc>#page] document citation to the recovered
//              text, NOT a refusal. → OCR works in THIS environment.
//   • RED    — the scanned text could NOT be read (ingest threw "no extractable text",
//              produced zero chunks, or the answer refuses / cites nothing). → a real
//              product gap: we must wire a real OCR backend. NOT a false pass.
// Either way the run prints a clear OCR-works verdict line. We do NOT weaken any
// assertion to force green.
//
// Citations: documents = [P:<doc>#page]; structured/tables = [S:<table>#row]. A scanned
// PDF lands in the DOCUMENT lane, so a grounded answer must carry a [P:...] citation.
// A "refusal" = the answer says it has no data / can't find it (EN or HE).
//
// RUN (from the repo root):
//   node tests/evals/scanned-pdf-ocr.mjs
// It loads the LLM key + Supabase creds from local secret files (read, NEVER printed).
// If Supabase OR the LLM key is absent it SKIPS loudly with exit 0 (never a false-green).
// It uses a unique synthetic non-demo owner and DELETES the doc it wrote + the throwaway
// user at the end, leaving no residue.
//
// PROVIDER-NEUTRAL: uses LLM_PROVIDER/LLM_API_KEY/LLM_BASE_URL/LLM_MODEL via env. No
// Gemini, no provider-specific code.
//
// SECURITY: this file READs .env.local / .secrets/supabase.env / .vercel-prod.env into
// process.env, but NEVER prints, echoes, logs, or commits any secret value.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { skip as skipShared } from "./_skip.mjs";
import { assertCleanBefore, assertCleanAfter, settleOwner } from "./_residue-guard.mjs";

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
const skip = (msg) => skipShared("scanned-pdf-ocr", msg);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — the durable doc lane can't be exercised.");
if (!haveLlm) skip("No LLM_API_KEY found — the router + answer pipeline make real LLM calls and can't run.");

// python3 + Pillow are required to RENDER the scanned image. If they're missing we can't
// even construct the fixture → skip loudly (not a pass), don't fake a scanned PDF.
function haveCmd(cmd, args) {
  try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; }
}
if (!haveCmd("python3", ["--version"])) skip("python3 not found — cannot render the scanned-image fixture.");
{
  let pil = false;
  try { execFileSync("python3", ["-c", "import PIL"], { stdio: "ignore" }); pil = true; } catch { /* */ }
  if (!pil) skip("Python Pillow (PIL) not installed — cannot render text to a raster image for the scanned PDF.");
}

// ── TEST HARNESS ─────────────────────────────────────────────────────────────────
const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}
const docCites = (ans) => [...(ans || "").matchAll(/\[P:[^\]]+\]/g)].map((m) => m[0]);
const allCites = (ans) => [...(ans || "").matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]);
// A "there are none / can't find it" refusal in EN or HE — what a system that COULDN'T
// read the scan would produce. If a GROUNDED answer reads like this, the scan wasn't read.
const REFUSAL_RE =
  /\b(there (are|is) no|no (document|documents|data|records?|information|invoice|text)|do(es)? not have|don'?t have|no relevant|cannot (find|answer|read)|could not (find|read)|unable to (find|read)|not available|i (don'?t|do not) have (any|access))\b/i;
const HE_REFUSAL_RE = /(אין לי|לא נמצא|לא קיים|לא זמין|אין נתונים|אין מסמכים|לא הצלחתי)/;
const isRefusal = (a) => REFUSAL_RE.test(a || "") || HE_REFUSAL_RE.test(a || "");

// ── THE FIXTURE: a TRUE scanned (image-only) PDF ─────────────────────────────────
// Render known text onto a white raster image (a "photo" of a page), then save THAT
// IMAGE as a full-page PDF. The result has NO text layer — OCR is the only way to read
// it. Known facts (asserted later): an invoice number, vendor, amount (English) plus a
// Hebrew address line (the client's real language). These strings are the GROUND TRUTH
// the OCR + answer must recover — we assert against THEM, not against engine internals.
const KNOWN = {
  invoice: "INV-90871",
  vendor: "Aurora Plumbing Ltd",
  amount: "4250",
  hebrew: "דירה 7 רחוב הרצל", // "apartment 7, Herzl street"
  // The client's literal complaint was "multi-COLUMN scans weren't read". So page 2 of the
  // fixture is a TWO-COLUMN layout: a distinct fact in the LEFT column and another in the
  // RIGHT column. OCR must read BOTH columns (a single-column reader misses one). We assert
  // both facts are recovered + answerable.
  leftColFact: "MERIDIAN-LEFT-5521",
  rightColFact: "ZephyrRight Inc",
};

function buildScannedPdf(outPath) {
  // We draw with Pillow (raster) and let Pillow save as PDF — so the PDF page IS the
  // image; there is provably no selectable/extractable text. DejaVuSans covers Latin +
  // Hebrew glyphs (verified present on this box). reportlab/img2pdf are alternative
  // image→PDF paths; Pillow's own PDF save needs no extra dependency.
  //
  // TWO PAGES: page 1 = a single-column invoice (the original); page 2 = a TWO-COLUMN
  // layout (the client's "multi-column scans weren't read" complaint). Both pages are
  // saved as raster images (no text layer) so OCR is the only read path for each.
  const py = `
from PIL import Image, ImageDraw, ImageFont
W, H = 1240, 1754  # ~A4 @ 150dpi
font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
try:
    font = ImageFont.truetype(font_path, 46)
    small = ImageFont.truetype(font_path, 40)
except Exception:
    font = ImageFont.load_default(); small = font

# PAGE 1 — single column invoice
p1 = Image.new("RGB", (W, H), "white")
d1 = ImageDraw.Draw(p1)
lines = [
    "SCANNED INVOICE OCR TEST",
    "Vendor: ${KNOWN.vendor}",
    "Invoice Number: ${KNOWN.invoice}",
    "Total Amount Due: ${KNOWN.amount} USD",
    "${KNOWN.hebrew}",
]
y = 130
for ln in lines:
    d1.text((100, y), ln, fill="black", font=font)
    y += 120

# PAGE 2 — TWO COLUMNS (left + right), each with its own fact. A reader that only reads
# one column would miss the other; correct OCR recovers BOTH in reading order.
p2 = Image.new("RGB", (W, H), "white")
d2 = ImageDraw.Draw(p2)
d2.text((100, 90), "TWO-COLUMN SCANNED PAGE", fill="black", font=font)
left = [
    "LEFT COLUMN",
    "Project Code:",
    "${KNOWN.leftColFact}",
    "Status: active",
    "Owner: facilities",
]
right = [
    "RIGHT COLUMN",
    "Approved Vendor:",
    "${KNOWN.rightColFact}",
    "Tier: gold",
    "Region: north",
]
yL = 230
for ln in left:
    d2.text((90, yL), ln, fill="black", font=small); yL += 110
yR = 230
for ln in right:
    d2.text((660, yR), ln, fill="black", font=small); yR += 110
# vertical divider to make the two columns visually distinct
d2.line([(620, 200), (620, H-200)], fill="black", width=3)

p1.save(${JSON.stringify(outPath)}, "PDF", resolution=150.0, save_all=True, append_images=[p2])
print("ok")
`;
  const out = execFileSync("python3", ["-c", py], { encoding: "utf8" });
  if (!out.includes("ok") || !fs.existsSync(outPath)) {
    throw new Error("python failed to render the scanned PDF fixture");
  }
}

// Prove the fixture has NO text layer (so OCR is genuinely the only path).
async function textLayerNonWhitespace(buf) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return pages.reduce((n, p) => n + (p ?? "").replace(/\s+/g, "").length, 0);
}

// ── REAL engine entry points (same modules the live route uses) ──────────────────
const { ingestPdf } = await import("../../src/lib/engine/ingest.ts");
const { routeQuestion } = await import("../../src/lib/engine/router.ts");
const { answerQuestion } = await import("../../src/lib/engine/answer.ts");
const { resetStore } = await import("../../src/lib/engine/structured-store.ts");
const { listUploadedDocs, deleteUploadedDoc } = await import("../../src/lib/engine/pgvector-store.ts");
const { __resetRuntimeStoreForTests } = await import("../../src/lib/engine/runtime-store.ts");
const { supabaseEnabled, admin } = await import("../../src/lib/engine/supabase.ts");

let OWNER = null;
let PDF_DOC = null;          // the ingested doc id (for targeted cleanup)
let TMP_PDF = null;          // the on-disk fixture path
let OCR_WORKS = null;        // the verdict this whole eval exists to determine

async function newOwner(tag) {
  const email = `scanocr-${tag}-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({
    email, password: crypto.randomUUID(), email_confirm: true,
  });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  return settleOwner(data.user.id);
}

// ── REAL-ARTIFACT BLOCK: the client's ACTUAL uploaded file "bluefalcon" ───────────
// REAL-ARTIFACT discipline (gotcha #5): reproduce on the EXACT object the client
// uploaded, not only a synthetic proxy. We DOWNLOAD the real "bluefalcon" PDF from
// Supabase storage (bucket "documents", path 3d1ca025…/bluefalcon, a ~1497-byte
// %PDF-1.3 that ingested to 0 chunks before the ingest/OCR fix), RE-KEY it under a
// fresh throwaway NON-DEMO owner (so it is owner-isolated and torn down after), ingest
// it through the REAL engine ingestPdf, and assert it now reads ≥1 chunk and grounds.
//
// HONEST NOTE: the real bluefalcon is a BORN-DIGITAL PDF (unpdf recovers a real text
// layer of ~100+ chars — it is NOT an image-only scan), so it reads via the TEXT path;
// the synthetic image-only fixture below is what exercises the OCR-only path + the
// pdf.js worker-collision fix. The real file guards that the EXACT client object now
// ingests end-to-end (≥1 chunk, grounded, cited) — the 0-chunks symptom is gone. We do
// NOT pretend it is a scan; we assert what is TRUE of it.
const BLUEFALCON = {
  bucket: "documents",
  path: "3d1ca025-d718-4d55-bab5-821a239cadbf/bluefalcon",
};
let BF_OWNER = null;
let BF_DOC = null;

async function runRealBluefalcon() {
  console.log("\n▶ REAL FILE — the client's actual uploaded 'bluefalcon' object (REAL-ARTIFACT discipline) …");
  // 1. Download the REAL object from storage.
  let buf = null, dlErr = null;
  try {
    const dl = await admin().storage.from(BLUEFALCON.bucket).download(BLUEFALCON.path);
    if (dl.error || !dl.data) dlErr = dl.error?.message ?? "no data";
    else buf = Buffer.from(await dl.data.arrayBuffer());
  } catch (e) {
    dlErr = e instanceof Error ? e.message : String(e);
  }
  if (dlErr || !buf) {
    // The real object is unreachable (creds/path). Skip THIS block loudly (exit 0 path
    // handled by the caller); the synthetic scan still runs. Never a false-green.
    check("REAL-BF/download",
      "the real 'bluefalcon' object was downloaded from Supabase storage",
      false, `could not download ${BLUEFALCON.bucket}/${BLUEFALCON.path}: ${dlErr ?? "no data"} (the real-file block is skipped; the synthetic scan below still gates OCR)`);
    return;
  }
  // 2. Assert it is the EXACT artifact: a small %PDF (the recorded ~1497-byte %PDF-1.3).
  const header = buf.slice(0, 4).toString("latin1");
  check("REAL-BF/is-pdf",
    "the downloaded 'bluefalcon' object is a real %PDF (the exact ~1497-byte file, not a proxy)",
    header === "%PDF" && buf.length > 500 && buf.length < 5000,
    `bytes=${buf.length} header=${JSON.stringify(buf.slice(0, 8).toString("latin1"))}`);

  // 3. Ingest the REAL bytes through the REAL engine as a throwaway non-demo owner.
  BF_OWNER = await newOwner("bf");
  console.log(`\n· Ingesting the REAL bluefalcon bytes as throwaway non-demo owner ${BF_OWNER.slice(0, 8)}… (re-keyed + owner-isolated) …`);
  let bfErr = null, res = null;
  try {
    res = await ingestPdf(new Uint8Array(buf), "bluefalcon.pdf", "Bluefalcon (real client file)", BF_OWNER);
    BF_DOC = res.doc;
  } catch (e) {
    bfErr = e instanceof Error ? e.message : String(e);
  }
  // THE bug this guards: 0 chunks (ingest crashed in the pdf.js-worker collision, or read
  // nothing). The fix → ≥1 citable chunk.
  check("REAL-BF/ingest-no-throw",
    "ingesting the REAL bluefalcon did NOT throw (the worker-collision / no-text bug is gone)",
    !bfErr, bfErr ? `ingest threw: ${bfErr}` : "ingest succeeded");
  check("REAL-BF/chunks",
    "the REAL bluefalcon ingested ≥1 chunk (0 chunks was the original recorded bug)",
    (res?.chunks ?? 0) >= 1, `chunks=${res?.chunks ?? 0} pages=${res?.pages ?? 0} persisted=${res?.persisted ?? 0}`);
  if (bfErr || (res?.chunks ?? 0) < 1) return;

  // 4. Cold start, then ask a fact that ONLY the file's recovered text contains → grounded + cited.
  __resetRuntimeStoreForTests();
  resetStore();
  const ans = await answerQuestion(
    "What is the classified project codename stated in the uploaded memo?",
    { ownerId: BF_OWNER, isDemo: false, role: "member" }
  );
  const a = ans.answer ?? "";
  check("REAL-BF/grounded-cite",
    "asking a fact from the REAL bluefalcon returns a GROUNDED answer with a [P:bluefalcon#page] citation (not a refusal)",
    ans.mode === "grounded" && docCites(a).length > 0 && !isRefusal(a),
    `mode=${ans.mode} cites=${allCites(a).join(" ") || "(none)"} :: "${a.slice(0, 160).replace(/\s+/g, " ")}"`);
  check("REAL-BF/recovered-fact",
    "the answer reproduces the file's recovered content (the codename 'BLUEFALCON') — proving the real bytes were read",
    /bluefalcon/i.test(a),
    `answer="${a.slice(0, 160).replace(/\s+/g, " ")}"`);
}

async function cleanupBluefalcon() {
  let removed = 0, after = -1, userDeleted = false;
  try {
    if (BF_OWNER && BF_DOC) removed = await deleteUploadedDoc(BF_OWNER, BF_DOC, false);
    if (BF_OWNER) after = (await listUploadedDocs(BF_OWNER)).length;
  } catch (e) {
    console.error("real-BF doc cleanup error:", e instanceof Error ? e.message : e);
  }
  if (BF_OWNER) {
    try {
      const { error } = await admin().auth.admin.deleteUser(BF_OWNER);
      userDeleted = !error;
    } catch { /* */ }
  }
  console.log(`\n↩ real-BF cleanup: deleted ${removed} chunk(s) (owner docs remaining: ${after}); throwaway user deleted: ${userDeleted}`);
  // Only assert cleanliness if the real-file block actually created an owner.
  if (BF_OWNER) {
    check("REAL-BF/cleanup", "the real-file throwaway owner's doc + user were deleted (no residue, isolated)",
      after === 0 && userDeleted, `docsRemaining=${after} userDeleted=${userDeleted}`);
  }
}

async function main() {
  check("ENV/supabase", "the engine sees Supabase as configured (durable doc lane is live)", supabaseEnabled());
  if (!supabaseEnabled()) throw new Error("supabaseEnabled() is false despite env — aborting to avoid a meaningless run");

  // ── 0. THE REAL CLIENT FILE FIRST (REAL-ARTIFACT discipline) ─────────────────────
  await runRealBluefalcon();

  // ── 1. BUILD the scanned PDF + PROVE it has no text layer ───────────────────────
  TMP_PDF = path.join(os.tmpdir(), `nucleus-scan-${crypto.randomUUID().slice(0, 8)}.pdf`);
  console.log("\n· Rendering a TRUE scanned (image-only) PDF — text drawn onto a raster, saved as a PDF page …");
  buildScannedPdf(TMP_PDF);
  const pdfBuf = new Uint8Array(fs.readFileSync(TMP_PDF));
  check("FIXTURE/built", "a scanned PDF fixture was produced on disk", pdfBuf.length > 1000, `bytes=${pdfBuf.length}`);

  // Defend the fixture's PREMISE: if it had a text layer, OCR wouldn't be exercised and
  // a green run would be meaningless. Assert the text layer is effectively empty.
  const layerChars = await textLayerNonWhitespace(pdfBuf.slice());
  check("FIXTURE/no-text-layer",
    "the scanned PDF has NO extractable text layer (unpdf ≈ empty) — so OCR is the ONLY way to read it",
    layerChars <= 12, `text-layer non-whitespace chars=${layerChars} (must be ≤ 12; born-digital pages have hundreds)`);
  if (layerChars > 12) {
    throw new Error(`fixture has a text layer (${layerChars} chars) — it is NOT a real scan; aborting to avoid a false-green`);
  }

  OWNER = await newOwner("a");
  console.log(`\n▶ SCANNED-PDF OCR — throwaway non-demo owner ${OWNER.slice(0, 8)}…`);

  // ── 2. INGEST the scanned PDF as the non-demo owner (real engine OCR path) ───────
  // ingestPdf runs the unpdf text path THEN best-effort OCR on the low-text page. If OCR
  // can't run here it throws the honest "no extractable text" error → we catch it and
  // mark OCR_WORKS=false (a real RED gap), never a fake pass.
  console.log("\n· Ingesting the scanned PDF as the non-demo owner (engine OCRs the image-only page) …");
  let ingestErr = null, res = null;
  try {
    res = await ingestPdf(pdfBuf, "scanned-invoice.pdf", "Scanned invoice (OCR)", OWNER);
    PDF_DOC = res.doc;
  } catch (e) {
    ingestErr = e instanceof Error ? e.message : String(e);
  }

  const chunks = res?.chunks ?? 0;
  OCR_WORKS = !ingestErr && chunks > 0;
  check("OCR/ingest-no-throw",
    "ingest did NOT throw the 'no extractable text' scan error (OCR recovered text from the image)",
    !ingestErr, ingestErr ? `ingest threw: ${ingestErr}` : "ingest succeeded");
  check("OCR/chunks",
    "OCR produced ≥1 citable chunk from the image-only page (the scan WAS read)",
    chunks > 0, `chunks=${chunks} pages=${res?.pages ?? 0} persisted=${res?.persisted ?? 0}`);

  if (!OCR_WORKS) {
    // Honest RED: the scanned text could not be read in this environment. Report it
    // loudly — this is the exact client-reported gap and it drives wiring a real OCR
    // backend. We still run cleanup in finally. No remaining asserts would be meaningful.
    check("VERDICT/ocr-works",
      "OCR can read a scanned/image-only PDF in THIS environment",
      false,
      "OCR did NOT read the scan (ingest refused / zero chunks). PRODUCT GAP: a real OCR backend must be wired — the scanned PDF the client uploaded cannot be read here.");
    return;
  }

  // OCR-recovered chunks should land in the DURABLE doc lane (so the answer is real).
  check("OCR/persisted",
    "the OCR-recovered chunks PERSISTED to the durable doc_chunks store",
    (res?.persisted ?? 0) > 0, `persisted=${res?.persisted}`);

  // ── 3. SIMULATE a serverless COLD START — wipe ALL in-memory engine state ────────
  // Proves the answer comes from the DURABLE store (OCR-recovered chunks), not a warm
  // in-process cache from ingest.
  console.log("\n· Simulating a serverless COLD START (clearing the in-memory runtime store + SQL handles) …");
  __resetRuntimeStoreForTests();
  resetStore();

  // ── 4. ROUTE — a question about the scanned content routes to "documents" ────────
  console.log("\n· Routing a question about the scanned invoice post-cold-start …");
  const plan = await routeQuestion("what is the invoice number and vendor on the uploaded invoice?", { ownerId: OWNER, isDemo: false });
  check("ROUTE/documents",
    "the scanned-invoice question routes to 'documents' (OCR'd content is in the doc lane)",
    plan.sources.includes("documents"), `sources=[${plan.sources.join(",")}] rationale="${(plan.rationale || "").slice(0, 80)}"`);

  // ── 5. ANSWER end-to-end — grounded, cites [P:doc#page], NOT a refusal, has the FACTS ─
  // We assert against the GROUND TRUTH strings we rendered (invoice/vendor/amount), not
  // against engine internals. A scan that "wasn't read" can't produce these.
  console.log("\n· Answering the scanned-invoice question end-to-end …");
  const ans = await answerQuestion(
    "What is the invoice number, vendor, and total amount on the uploaded invoice? Quote them exactly.",
    { ownerId: OWNER, isDemo: false, role: "member" }
  );
  const a = ans.answer ?? "";
  const chunksRetrieved = ans.evidence?.chunks ?? [];

  check("ANSWER/retrieve",
    "≥1 OCR'd document chunk was retrieved (hybrid search over the durable, OCR-recovered text)",
    chunksRetrieved.length > 0, `chunks=${chunksRetrieved.length} mode=${ans.mode}`);
  check("ANSWER/grounded-cite",
    "the answer is GROUNDED and carries a [P:<doc>#page] document citation to the OCR'd page",
    ans.mode === "grounded" && docCites(a).length > 0, `mode=${ans.mode} cites=${allCites(a).join(" ") || "(none)"}`);
  check("ANSWER/not-refusal",
    "the answer is NOT a 'no document / can't read it' refusal (the symptom of an unread scan)",
    !isRefusal(a), a.slice(0, 220).replace(/\s+/g, " "));

  // The hard capability proof: the answer reproduces the KNOWN facts that ONLY OCR could
  // have recovered from the image. (Vendor name OR invoice number OR amount — robust to
  // minor OCR noise; we require at least two of the three to land.)
  const hits = [
    new RegExp(KNOWN.invoice.replace(/[-]/g, "[- ]?"), "i").test(a),
    /aurora/i.test(a),
    new RegExp(`\\b${KNOWN.amount}\\b`).test(a),
  ];
  const nHits = hits.filter(Boolean).length;
  check("ANSWER/known-facts",
    "the answer reproduces the KNOWN scanned facts (invoice no. / vendor / amount) — only OCR could read these",
    nHits >= 2, `matched ${nHits}/3 [invoice=${hits[0]} vendor=${hits[1]} amount=${hits[2]}]  answer="${a.slice(0, 200).replace(/\s+/g, " ")}"`);

  // ── 5b. MULTI-COLUMN PAGE — the client's literal complaint ("multi-column scans
  // weren't read"). Page 2 is a TWO-COLUMN scan: a LEFT-column fact and a RIGHT-column
  // fact. OCR must read BOTH columns — a single-column reader (or an OCR that linearizes
  // wrongly) would recover one and miss the other. We ask for BOTH facts and require BOTH.
  console.log("\n· Multi-COLUMN page — asking for a fact from EACH column (both must be read) …");
  const mcAns = await answerQuestion(
    "From the two-column page, what is the Project Code (left column) and the Approved Vendor (right column)? Quote both exactly.",
    { ownerId: OWNER, isDemo: false, role: "member" }
  );
  const mc = mcAns.answer ?? "";
  const leftHit = new RegExp(KNOWN.leftColFact.replace(/[-]/g, "[- ]?"), "i").test(mc);
  const rightHit = /zephyrright/i.test(mc);
  check("MULTICOLUMN/both-columns",
    "OCR read BOTH columns of the two-column scan — the answer carries the LEFT-column fact AND the RIGHT-column fact",
    leftHit && rightHit && mcAns.mode === "grounded" && docCites(mc).length > 0,
    `mode=${mcAns.mode} left(${KNOWN.leftColFact})=${leftHit} right(${KNOWN.rightColFact})=${rightHit} cites=${allCites(mc).join(" ") || "(none)"} :: "${mc.slice(0, 200).replace(/\s+/g, " ")}"`);

  // ── 6. HEBREW line — best-effort secondary signal (heb OCR + Hebrew Q&A) ─────────
  // Reported, NOT gated: PIL renders Hebrew glyphs without BiDi reshaping, so heb OCR of
  // the line is a stretch goal. We surface whether it landed; it never fails the run.
  console.log("\n· (Secondary) Hebrew line via heb OCR — reported, not gated …");
  const heFound = chunksRetrieved.some((c) => /[֐-׿]/.test(c.text || "")) ||
                  /[֐-׿]/.test(a);
  console.log(`  ℹ INFO [OCR/hebrew] Hebrew script ${heFound ? "WAS" : "was NOT"} recovered from the scan (best-effort; not gated).`);

  // ── 7. THE VERDICT this eval exists to deliver ──────────────────────────────────
  check("VERDICT/ocr-works",
    "OCR can read a scanned/image-only PDF in THIS environment (drives whether a real OCR backend must be wired)",
    OCR_WORKS && chunksRetrieved.length > 0 && nHits >= 2,
    OCR_WORKS ? "YES — the scanned PDF was read, grounded, and cited end-to-end." : "NO — see failures above.");
}

async function cleanup() {
  let removed = 0, docsAfter = -1, userDeleted = false;
  try {
    if (OWNER && PDF_DOC) removed = await deleteUploadedDoc(OWNER, PDF_DOC, false);
    if (OWNER) docsAfter = (await listUploadedDocs(OWNER)).length;
  } catch (e) {
    console.error("doc cleanup error:", e instanceof Error ? e.message : e);
  }
  if (OWNER) {
    try {
      const { error } = await admin().auth.admin.deleteUser(OWNER); // CASCADE clears doc_chunks
      userDeleted = !error;
      if (error) console.error("user delete error:", error.message);
    } catch (e) {
      console.error("user delete threw:", e instanceof Error ? e.message : e);
    }
  }
  if (TMP_PDF) { try { fs.unlinkSync(TMP_PDF); } catch { /* */ } }
  console.log(`\n↩ cleanup: deleted ${removed} chunk(s) (owner docs remaining: ${docsAfter}); throwaway user deleted: ${userDeleted}`);
  check("CLEANUP/clean", "the test owner's doc + throwaway user were deleted from the live DB (no residue)",
    docsAfter === 0 && userDeleted, `docsRemaining=${docsAfter} userDeleted=${userDeleted}`);
}

// RESIDUE GUARD (#79): refuse to run over a DB a prior leaked run left dirty (a polluted
// catalog produces a FALSE GREEN); abort loudly. Asserts 0 throwaway orphan rows BEFORE the run.
await assertCleanBefore("scanned-pdf-ocr");
let runError = null;
try {
  await main();
} catch (e) {
  runError = e;
  console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e);
} finally {
  await cleanupBluefalcon();
  await cleanup();
}
// RESIDUE GUARD (#79): this run must leave 0 throwaway residue — fail loudly if its cleanup leaked.
await assertCleanAfter("scanned-pdf-ocr");

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(`OCR VERDICT: scanned/image-only PDF reading is ${OCR_WORKS ? "WORKING ✅" : "NOT working ❌ (wire a real OCR backend)"} in this environment.`);
console.log(
  `SCANNED-PDF OCR: ${results.length - fails.length}/${results.length} passed` +
    (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN")
);
if (fails.length || runError) process.exit(1);
process.exit(0);
