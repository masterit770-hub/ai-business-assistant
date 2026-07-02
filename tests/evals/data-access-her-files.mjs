// DATA-ACCESS GROUND-TRUTH (the #81 rewrite's RED-first FOUNDATION) — proves the EXISTING
// data layer returns Jenny's FULL real data BEFORE any agent loop is built. ENGINE-AGNOSTIC:
// it exercises the executor / parsers / retrieval functions DIRECTLY (no router LLM, no
// agent loop, no answer pipeline) — so it isolates the LAYER every bug this session actually
// lived in:
//   • #82 the "Beyoncé" PDF bug   — the doc's original persisted/read EMPTY → the model
//                                    fabricated an answer from nothing.
//   • the CSV truncation bug      — a windowed read returned 1 of N rows → "only one course".
//   • the grid mis-tally          — a partial/windowed grid read → a wrong count.
// Each was a SILENT data-access failure surfacing downstream as a wrong answer. If the data
// layer returns the FULL, EXACT real data here, the loop has a sound floor; if it doesn't,
// THIS file goes RED at the layer — not three turns later as a hallucination.
//
// WHY THESE ASSERTIONS ARE REMOVABLE-HANDLER-PROOF (not ">0"/"non-empty"): every check pins
// an EXACT value computed FROM Jenny's real file (rowCount == the true total; the ranked
// top == physics,93 via a number-boundary regex so "930"/"193" can't pass; COUNT(*)==1000;
// the grid's full persisted row count; the PDF's real strings "Joni"/"$1,285"/the three
// children). A layer that silently truncates to 1 row, reads a window, or returns empty
// bytes FAILS — a presence-only test would sail past all three of this session's bugs.
//
// GROUND TRUTH (recomputed from the files on disk — see the report; locked as constants below):
//   enrollment CSV "school data 2.csv": 1000 data rows · top course = physics (93) · COUNT(*)=1000
//   June grid xlsx (raw range A1:J56): the engine's XLSX.utils.sheet_to_json persists 51 data
//     rows (header consumed; 4 fully-blank rows dropped) → COUNT(*) over the materialized grid = 51
//   family-court MOCK PDF: petitioner "Joni" Carter · child support "$1,285"/mo · children
//     Emma / Noah / Olivia (Carter) — all FICTIONAL (a mock case file)
//
// SECURITY / HYGIENE (non-negotiable, mirrors the certified harnesses):
//   • runs under a THROWAWAY MEMBER owner (admin.createUser, isDemo:false, @nucleus-eval.invalid)
//   • FK-SETTLES the new owner before ingest (settleOwner) — avoids the create-then-ingest FK race
//   • RESIDUE-GUARDS 0/0 orphan uploaded_rows + doc_chunks for the throwaway domain BEFORE and AFTER
//   • deletes the owner at the end (ON DELETE CASCADE clears uploaded_rows + doc_chunks + storage refs)
//   • NEVER touches the live owners 3d1ca025 (demo-admin) or b01c311e (real client)
//   • the Hebrew grid xlsx is gitignored PII — read from disk, NEVER print a roster (only counts +
//     a single non-PII activity token in the report)
//   • SKIPS LOUDLY (non-green, not a false pass) if Supabase/LLM creds or the source files are absent
//
// RUN:  node tests/evals/data-access-her-files.mjs
// Loads creds from .env.local / .secrets/supabase.env / .vercel-prod.env (read, never printed).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { skip as skipShared } from "./_skip.mjs";
import { assertCleanBefore, assertCleanAfter, settleOwner } from "./_residue-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── ENV LOADING (secret-safe: read into process.env, NEVER printed) ──────────────────
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

const skip = (msg) => skipShared("data-access-her-files", msg);
const haveSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
// The RAG test embeds a query with the LOCAL e5 model (no API key) — but ingest's urgency
// classifier makes a real LLM call, so we require the LLM key to run the full ingest faithfully.
const haveLlm = !!(process.env.LLM_API_KEY && process.env.LLM_API_KEY.length > 8);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — the throwaway-owner ingest + durable read can't run.");
if (!haveLlm) skip("No LLM_API_KEY found — ingest's urgency classifier makes a real LLM call.");

// ── RESOLVE Jenny's real source files on disk ─────────────────────────────────────────
const DATA = path.join(ROOT, "data");
// The enrollment CSV is the one with a student_full_name + course_code header (data-driven,
// not a hardcoded filename → if she re-uploads under a new name the resolver still finds it).
function findEnrollmentCsv() {
  if (!fs.existsSync(DATA)) return null;
  for (const name of fs.readdirSync(DATA)) {
    if (!name.toLowerCase().endsWith(".csv")) continue;
    const head = fs.readFileSync(path.join(DATA, name), "utf8").split(/\r?\n/, 1)[0] || "";
    const cols = head.split(",").map((c) => c.trim().toLowerCase());
    if (cols.includes("student_full_name") && cols.includes("course_code")) return path.join(DATA, name);
  }
  return null;
}
// The June grid xlsx — resolved by a STABLE Hebrew month substring (the bytes of the August
// file are mangled on disk; June's name is intact). NFC-normalize both sides.
function findByMonth(monthHe) {
  if (!fs.existsSync(DATA)) return null;
  const wanted = monthHe.normalize("NFC");
  for (const name of fs.readdirSync(DATA)) {
    if (name.normalize("NFC").includes(wanted) && name.toLowerCase().endsWith(".xlsx")) return path.join(DATA, name);
  }
  return null;
}
// The family-court MOCK PDF — resolved by its distinctive token (avoids the emoji in the name).
function findCourtPdf() {
  if (!fs.existsSync(DATA)) return null;
  for (const name of fs.readdirSync(DATA)) {
    if (name.toLowerCase().endsWith(".pdf") && /family court/i.test(name)) return path.join(DATA, name);
  }
  return null;
}
const ENROLL_CSV = findEnrollmentCsv();
const JUNE_XLSX = findByMonth("יוני");
const COURT_PDF = findCourtPdf();
if (!ENROLL_CSV) skip("the enrollment CSV (student_full_name + course_code) is not on disk under data/.");
if (!JUNE_XLSX) skip("the June scheduling xlsx is not on disk under data/.");
if (!COURT_PDF) skip("the family-court MOCK PDF is not on disk under data/.");

// ── GROUND TRUTH (recomputed from the files; the report shows the derivation) ─────────
const ENROLL_TOTAL = 1000;          // true data-row count of the enrollment CSV
const TOP_COURSE = "physics";        // the most-enrolled course_code (a real GROUP BY)
const TOP_COURSE_COUNT = 93;         // its exact enrollment count
const RUNNER_UP_COUNT = 90;          // the 2nd place (bible/biology/photography tie) — proves it's a real ranking
const JUNE_GRID_ROWS = 51;           // rows the engine's xlsx parser persists (raw range A1:J56, header consumed, blanks dropped)
const PETITIONER = "Joni";           // the petitioner's name in the MOCK PDF
const CHILD_SUPPORT = "$1,285";      // the monthly child-support figure
const CHILDREN = ["Emma", "Noah", "Olivia"]; // the three (fictional) children

// ── TEST HARNESS ──────────────────────────────────────────────────────────────────────
const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}
// EXACT number-boundary match: `93` matches but `930`/`193`/`9.3` do NOT — so a silently
// truncated/inflated count can't sneak past a substring test. Used for all count assertions.
const hasExactNum = (s, n) => new RegExp(`(?<![\\d.,])${n}(?![\\d.,])`).test(String(s));

// ── REAL engine entry points (the SAME modules the live route uses) ───────────────────
const { ingestCsv, ingestXlsx, ingestPdf } = await import("../../src/lib/engine/ingest.ts");
const { introspectSchema, runGeneratedSelect, resetStore, hydrateUploadedTables } = await import("../../src/lib/engine/structured-store.ts");
const { listUploadedTables } = await import("../../src/lib/engine/structured-rows-store.ts");
const { storeOriginalFile, fetchOriginalFile } = await import("../../src/lib/engine/doc-files.ts");
const { hybridSearch } = await import("../../src/lib/engine/pgvector-store.ts");
const { embedQuery } = await import("../../src/lib/engine/embeddings.ts");
const { __resetRuntimeStoreForTests } = await import("../../src/lib/engine/runtime-store.ts");
const { supabaseEnabled, admin } = await import("../../src/lib/engine/supabase.ts");

if (!supabaseEnabled()) { console.error("supabaseEnabled() false despite env — aborting"); process.exit(1); }

let OWNER = null;
const SCOPE = () => ({ ownerId: OWNER, isAdmin: false });
let courtDocId = null;

async function newOwner() {
  const email = `dataaccess-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({ email, password: crypto.randomUUID(), email_confirm: true });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  return settleOwner(data.user.id);
}

// SETTLE the DURABLE write before a cold-start wipe. ingestXlsx/ingestCsv can RETURN before the
// uploaded_rows insert is fully visible to an immediate subsequent read (the same eventual-
// consistency / FK-settle window the residue-guard + participation-count harnesses already document).
// If the test wipes the in-memory store and rehydrates BEFORE the durable rows are visible, it reads
// an inconsistent state and a real, persisted table looks "lost" — a HARNESS false-RED, not a data bug.
// We poll listUploadedTables until the owner's TOTAL durable row count reaches the expected total, so
// the cold-start read is over a settled DB. (Proven: the rows DO persist — direct DB counts show 51/51
// every time once settled; only an un-settled immediate re-read races them.)
async function settleDurable(expectedTotalRows, label) {
  // Poll the DIRECT exact COUNT (count:"exact", head:true) — this is NOT subject to PostgREST's
  // row-page cap, so it reflects the TRUE persisted total (unlike listUploadedTables, which IS the
  // capped read this test indicts). We settle on the real persist; the read-back layer is judged
  // separately by the assertions.
  for (let i = 0; i < 25; i++) {
    const r = await admin().from("uploaded_rows").select("id", { count: "exact", head: true }).eq("owner_id", OWNER);
    if ((r.count ?? 0) >= expectedTotalRows) return r.count ?? 0;
    await new Promise((rr) => setTimeout(rr, 300));
  }
  const r = await admin().from("uploaded_rows").select("id", { count: "exact", head: true }).eq("owner_id", OWNER);
  console.log(`  ⚠ settleDurable(${label}): direct DB total=${r.count ?? 0} did not reach ${expectedTotalRows} after polling`);
  return r.count ?? 0;
}

// Find a materialized table in the catalog whose columns include the given header names —
// data-driven discovery of the real (sanitized/Unicode) table name, so no sanitized name is
// hardcoded (it generalizes to a re-upload / a renamed sheet).
function findTableByColumns(catalog, ...needHeaders) {
  const wanted = needHeaders.map((h) => h.toLowerCase());
  for (const t of catalog) {
    const cols = t.columns.map((c) => c.name.toLowerCase());
    if (wanted.every((w) => cols.includes(w))) return t;
  }
  return null;
}

async function main() {
  OWNER = await newOwner();
  console.log(`\n▶ DATA-ACCESS GROUND TRUTH (Jenny's real files) — throwaway owner ${OWNER.slice(0, 8)}… (created + deleted)`);

  // ════════════════════════════════════════════════════════════════════════════════════
  //  TEST 1 — STRUCTURED FULL-READ over the enrollment CSV (the truncation class)
  //  Exercise the EXECUTOR DIRECTLY: ingest → cold-start wipe → hydrate the durable rows →
  //  introspect to get the REAL catalog → runGeneratedSelect with raw SQL. No router LLM.
  // ════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── TEST 1: STRUCTURED full-read (enrollment CSV) ──");
  const csvText = fs.readFileSync(ENROLL_CSV, "utf8");
  const csvRes = await ingestCsv(csvText, `enrollment-${OWNER.slice(0, 8)}.csv`, OWNER);
  console.log(`  ingested enrollment CSV → ${csvRes.rows} rows, persisted ${csvRes.persisted}`);
  check("T1/ingest-full", `the WHOLE CSV ingested — ${ENROLL_TOTAL} data rows, no default truncation at ingest`,
    csvRes.rows === ENROLL_TOTAL && (csvRes.persisted ?? 0) === ENROLL_TOTAL,
    `rows=${csvRes.rows} persisted=${csvRes.persisted} (both must == ${ENROLL_TOTAL})`);

  // SETTLE the durable write, THEN cold-start the in-memory stores so the read goes through the
  // DURABLE rehydrate path (the exact path a real serverless turn uses — and where a partial read
  // would bite). The settle removes the harness eventual-consistency race; it does NOT weaken any
  // assertion (the executor still reads the real durable table).
  await settleDurable(ENROLL_TOTAL, "T1-enrollment");
  __resetRuntimeStoreForTests();
  resetStore();
  await hydrateUploadedTables(OWNER, false);

  const { catalog } = introspectSchema(3, false, SCOPE());
  const enrollTbl = findTableByColumns(catalog, "student_full_name", "course_code");
  check("T1/catalog-has-table", "the enrollment table is in the owner-scoped catalog after cold-start rehydrate",
    !!enrollTbl, enrollTbl ? `table="${enrollTbl.table}" cols=${enrollTbl.columns.length}` : `catalog=[${catalog.map((t) => t.table).join(",")}]`);

  if (enrollTbl) {
    const T = `"${enrollTbl.table}"`;

    // 1a. COUNT(*) — the executor must read ALL rows, not a windowed default.
    const countRes = runGeneratedSelect(`SELECT COUNT(*) AS n FROM ${T}`, enrollTbl.table, catalog, SCOPE());
    const countN = countRes.ok ? Number(countRes.rows?.[0]?.data?.n) : NaN;
    check("T1/count-exact", `COUNT(*) over the durable table == ${ENROLL_TOTAL} (full read, NOT a truncated window)`,
      countRes.ok && countN === ENROLL_TOTAL,
      `ok=${countRes.ok} COUNT(*)=${countN} (must == ${ENROLL_TOTAL}; reason=${countRes.reason ?? "—"})`);

    // 1b. A raw SELECT of ALL rows — assert the executor returns the full set, not a window (the
    //     "only one course" bug was a truncated row-read). This catches a silent LIMIT the
    //     COUNT(*) aggregate alone masks. THE GROUND TRUTH this exposes (see report): the SQL
    //     guard (sql-guard.ts) appends DEFAULT_ROW_LIMIT=50 to a no-LIMIT SELECT and clamps any
    //     LIMIT > HARD_ROW_CAP=200 → a row-RETURNING tool can NEVER read more than 200 of her
    //     1000 rows in one call. This check stays RED on purpose: it is the data-layer ceiling
    //     the #81 enumeration tools must reckon with (page, or aggregate server-side).
    const allRes = runGeneratedSelect(`SELECT student_full_name, course_code FROM ${T}`, enrollTbl.table, catalog, SCOPE());
    const allN = allRes.ok ? (allRes.rows?.length ?? 0) : 0;
    check("T1/select-all-no-truncation", `a plain SELECT returns ALL ${ENROLL_TOTAL} rows (no silent LIMIT/window)`,
      allRes.ok && allN === ENROLL_TOTAL,
      `ok=${allRes.ok} returnedRows=${allN} (must == ${ENROLL_TOTAL}; reason=${allRes.reason ?? "—"})`);

    // 1b-ii. CHARACTERIZE the ceiling precisely so the report is unambiguous (not "some
    //     truncation" — the EXACT contract). A no-LIMIT SELECT returns 50; an explicit
    //     LIMIT 1000 is clamped to 200. Pinning these makes the truncation a known, exact
    //     boundary the #81 tools design against — and turns this RED into actionable ground truth.
    const noLimitN = allN; // the no-LIMIT SELECT above → expect 50 (DEFAULT_ROW_LIMIT)
    const bigLimitRes = runGeneratedSelect(`SELECT student_full_name, course_code FROM ${T} LIMIT 1000`, enrollTbl.table, catalog, SCOPE());
    const bigLimitN = bigLimitRes.ok ? (bigLimitRes.rows?.length ?? 0) : 0;
    check("T1/ceiling-characterized",
      "the executor ceiling is the KNOWN boundary: no-LIMIT→50 (DEFAULT_ROW_LIMIT), LIMIT 1000 clamped→200 (HARD_ROW_CAP)",
      noLimitN === 50 && bigLimitN === 200,
      `noLimitReturned=${noLimitN} (expect 50) · LIMIT-1000-returned=${bigLimitN} (expect clamp to 200)`);

    // 1c. A ranked GROUP BY — "which course has the most students" — must crown the REAL top.
    //     We read the top TWO so we can assert it's a genuine ranking (top=93 strictly > #2=90),
    //     not a coincidental single value. Number-boundary on 93 so "930"/"193" can't pass.
    const grpRes = runGeneratedSelect(
      `SELECT course_code, COUNT(*) AS n FROM ${T} GROUP BY course_code ORDER BY n DESC LIMIT 2`,
      enrollTbl.table, catalog, SCOPE());
    const top = grpRes.ok ? grpRes.rows?.[0]?.data : null;
    const second = grpRes.ok ? grpRes.rows?.[1]?.data : null;
    const topCourse = String(top?.course_code ?? "").toLowerCase();
    const topN = Number(top?.n);
    const secondN = Number(second?.n);
    check("T1/groupby-top-exact",
      `the ranked top course == ${TOP_COURSE} with EXACTLY ${TOP_COURSE_COUNT} (strictly > #2's ${RUNNER_UP_COUNT})`,
      grpRes.ok && topCourse === TOP_COURSE && topN === TOP_COURSE_COUNT && secondN === RUNNER_UP_COUNT && topN > secondN && hasExactNum(topN, TOP_COURSE_COUNT),
      `ok=${grpRes.ok} top=${topCourse}/${topN} second#=${secondN} (want ${TOP_COURSE}/${TOP_COURSE_COUNT} > ${RUNNER_UP_COUNT}; reason=${grpRes.reason ?? "—"})`);
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  //  TEST 2 — GRID FULL-READ over the June scheduling xlsx (the mis-tally / window class)
  //  The grid must come back WHOLE: COUNT(*) over the materialized grid == every persisted row.
  // ════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── TEST 2: GRID full-read (June scheduling xlsx) ──");
  const xlsxBuf = new Uint8Array(fs.readFileSync(JUNE_XLSX));
  const xRes = await ingestXlsx(xlsxBuf, path.basename(JUNE_XLSX), OWNER);
  console.log(`  ingested June grid → ${xRes.rows} rows, ${xRes.sheets} sheet(s), persisted ${xRes.persisted}`);
  check("T2/ingest-grid-full", `the full grid ingested — ${JUNE_GRID_ROWS} data rows persisted (raw range A1:J56, blanks dropped)`,
    xRes.rows === JUNE_GRID_ROWS && (xRes.persisted ?? 0) === JUNE_GRID_ROWS,
    `rows=${xRes.rows} persisted=${xRes.persisted} (both must == ${JUNE_GRID_ROWS})`);

  // GROUND TRUTH (settle the durable write, then read it three ways): the grid's rows ARE in the DB.
  // We poll a DIRECT exact COUNT (head:true, count:"exact" — NOT subject to PostgREST's row-page cap)
  // so we know the persist truly landed before judging the read-back layer.
  await settleDurable(ENROLL_TOTAL + JUNE_GRID_ROWS, "T2-enrollment+grid"); // best-effort; the assertions below ground-truth regardless
  const gridDb = admin().from("uploaded_rows").select("id", { count: "exact", head: true }).eq("owner_id", OWNER);
  // We discover the grid's exact table_name from the DB (the row not belonging to the enrollment
  // table), counting directly — bypassing listUploadedTables on purpose (it is the suspect).
  const enrollDocId = `enrollment-${OWNER.slice(0, 8)}`; // the CSV's docId (its table_name in uploaded_rows)
  const gridExact = await admin().from("uploaded_rows")
    .select("id", { count: "exact", head: true }).eq("owner_id", OWNER).neq("table_name", enrollDocId);
  const gridExactN = gridExact.count ?? 0;
  check("T2/durable-grid-rows-DB-truth", `GROUND TRUTH: the DB holds the WHOLE grid — exactly ${JUNE_GRID_ROWS} rows (direct exact count)`,
    gridExactN === JUNE_GRID_ROWS,
    `directExactGridRows=${gridExactN} (must == ${JUNE_GRID_ROWS} — proves the PERSIST is correct)`);

  // Now the READ-BACK layer the engine actually uses. listUploadedTables (Sources listing) and
  // fetchUploadedRows (cold-start rehydrate source) BOTH do an unbounded `.select()` on uploaded_rows
  // → PostgREST caps the result at its default 1000-row page. With the 1000-row enrollment table
  // present, the grid's 51 rows fall PAST that page → the grid table is INVISIBLE to both. This is
  // the real, load-bearing data-loss bug (the truncation class, one layer below the SQL guard): a
  // user who uploads a ≥1000-row file then a 2nd spreadsheet loses the 2nd table after a cold start.
  const durableTables = await listUploadedTables(OWNER);
  const gridDurable = durableTables.find((t) => t.rows === JUNE_GRID_ROWS);
  check("T2/durable-grid-rows", `listUploadedTables surfaces the grid (NOT dropped past the 1000-row page cap)`,
    !!gridDurable && gridDurable.rows === JUNE_GRID_ROWS,
    `listUploadedTables tables=${durableTables.length} gridRowsSeen=${gridDurable?.rows ?? "—"} (must == ${JUNE_GRID_ROWS}; ` +
    `RED here = the unbounded .select() page cap hid the 2nd table — DB truth above says it IS persisted)`);

  // Cold-start + rehydrate (the real serverless path), then COUNT(*) the materialized grid.
  __resetRuntimeStoreForTests();
  resetStore();
  await hydrateUploadedTables(OWNER, false);
  const { catalog: catalog2 } = introspectSchema(3, false, SCOPE());
  // The grid table in the CATALOG = the catalog table that is NOT the enrollment table (resolve by
  // the enrollment table's stable column signature, not a fragile name match).
  const enrollCatName = findTableByColumns(catalog2, "student_full_name", "course_code")?.table;
  const gridTbl = catalog2.find((t) => t.table !== enrollCatName);
  if (gridTbl) {
    const gridCount = runGeneratedSelect(`SELECT COUNT(*) AS n FROM "${gridTbl.table}"`, gridTbl.table, catalog2, SCOPE());
    const gridN = gridCount.ok ? Number(gridCount.rows?.[0]?.data?.n) : NaN;
    check("T2/grid-count-exact", `COUNT(*) over the materialized June grid == ${JUNE_GRID_ROWS} (full grid, not a window)`,
      gridCount.ok && gridN === JUNE_GRID_ROWS,
      `ok=${gridCount.ok} COUNT(*)=${gridN} (must == ${JUNE_GRID_ROWS}; reason=${gridCount.reason ?? "—"})`);
  } else {
    check("T2/grid-count-exact", `the materialized grid is queryable after cold-start rehydrate (COUNT(*) == ${JUNE_GRID_ROWS})`, false,
      `grid table NOT in the post-rehydrate catalog (catalog=[${catalog2.map((t) => t.table).join(",")}]) — ` +
      `fetchUploadedRows dropped it via the same 1000-row page cap, so the cold-start SQL lane is blind to it`);
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  //  TEST 3 — DOC REAL-CONTENT round-trip over the family-court MOCK PDF (#82 / Beyoncé)
  //  Faithful path: store the original bytes to the bucket (as /api/ingest does), then
  //  fetchOriginalFile() to read them BACK, then parse the FETCHED bytes with unpdf (the
  //  engine's own extractor) and assert the REAL content is present. An empty/partial
  //  persist-or-read is exactly what produced a fabricated "Beyoncé" answer.
  // ════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── TEST 3: DOC real-content round-trip (family-court MOCK PDF) ──");
  const pdfBytes = new Uint8Array(fs.readFileSync(COURT_PDF));
  // Ingest into the doc lane (chunks + embeddings to doc_chunks) AND store the original.
  const pdfRes = await ingestPdf(pdfBytes.slice(), "family-court-mock.pdf", "Family court MOCK", OWNER);
  courtDocId = pdfRes.doc;
  check("T3/pdf-ingest-persisted", "the MOCK PDF's chunks persisted to durable doc_chunks (doc lane)",
    (pdfRes.persisted ?? 0) > 0, `persisted=${pdfRes.persisted} chunks=${pdfRes.chunks} doc=${pdfRes.doc}`);
  // Store original (the /api/ingest route's second step — fetchOriginalFile reads THIS).
  const stored = await storeOriginalFile(pdfBytes.slice(), OWNER, courtDocId, "family-court-mock.pdf");
  check("T3/original-stored", "the PDF's ORIGINAL bytes stored to the documents bucket (download/parse source)",
    stored === true, `storeOriginalFile=${stored}`);

  // Fetch the original BACK from storage (the real data-access read) and assert non-empty bytes.
  const fetched = await fetchOriginalFile(OWNER, courtDocId);
  const fetchedLen = fetched?.bytes?.length ?? 0;
  check("T3/fetch-nonempty-bytes", "fetchOriginalFile returned the FULL original bytes (not empty — the Beyoncé root cause)",
    !!fetched && fetchedLen === pdfBytes.length,
    `fetchedBytes=${fetchedLen} sourceBytes=${pdfBytes.length} (must match exactly)`);

  // Parse the FETCHED bytes with the same extractor the engine uses, and assert REAL content.
  let parsedText = "";
  if (fetched?.bytes) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(fetched.bytes.slice());
    const { text } = await extractText(pdf, { mergePages: true });
    parsedText = (Array.isArray(text) ? text.join("\n") : text || "").replace(/​/g, "");
  }
  const has = (needle) => parsedText.includes(needle);
  const childrenPresent = CHILDREN.filter((c) => has(c));
  check("T3/content-petitioner", `parsed text CONTAINS the real petitioner "${PETITIONER}" (presence-of-real-content)`,
    has(PETITIONER), `found "${PETITIONER}"=${has(PETITIONER)} textLen=${parsedText.length}`);
  check("T3/content-child-support", `parsed text CONTAINS the real child-support figure "${CHILD_SUPPORT}"`,
    has(CHILD_SUPPORT), `found "${CHILD_SUPPORT}"=${has(CHILD_SUPPORT)}`);
  check("T3/content-three-children", `parsed text CONTAINS all three children (${CHILDREN.join(", ")})`,
    childrenPresent.length === CHILDREN.length, `found ${childrenPresent.length}/3: [${childrenPresent.join(", ")}]`);

  // ════════════════════════════════════════════════════════════════════════════════════
  //  TEST 4 — RAG RETRIEVAL QUALITY over the ingested PDF chunks
  //  hybridSearch for "who is the petitioner" must surface the RIGHT chunk (one containing
  //  "petitioner"/"Joni"), not merely "some" chunk — retrieval that returns the wrong chunk
  //  is the upstream of a grounded-but-wrong answer.
  // ════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── TEST 4: RAG retrieval quality (hybridSearch over the PDF) ──");
  const q = "who is the petitioner";
  const emb = await embedQuery(q);
  check("T4/embedding-ok", "the local e5 model produced a 384-dim query embedding",
    Array.isArray(emb) && emb.length === 384, `dim=${Array.isArray(emb) ? emb.length : "n/a"}`);
  const hits = await hybridSearch(OWNER, false, emb, q, 8);
  check("T4/retrieved-some", "hybridSearch returned chunk(s) for the owner (owner-scoped retrieval works)",
    hits.length > 0, `hits=${hits.length}`);
  // The RIGHT chunk: at least one returned chunk's text actually contains the answer evidence.
  const relevant = hits.filter((h) => /petitioner/i.test(h.text || "") || (h.text || "").includes(PETITIONER));
  // And the relevant chunk must be near the TOP (rank ≤ 3) — retrieval that buries the right
  // chunk at #8 would still let a top-k=3 reader miss it.
  const topRankRelevant = hits.slice(0, 3).some((h) => /petitioner/i.test(h.text || "") || (h.text || "").includes(PETITIONER));
  check("T4/right-chunk-retrieved",
    `a chunk containing "petitioner"/"${PETITIONER}" was actually retrieved (right chunk, not just any chunk)`,
    relevant.length > 0, `relevantChunks=${relevant.length}/${hits.length} fromDoc=${[...new Set(hits.map((h) => h.doc))].includes(courtDocId)}`);
  check("T4/right-chunk-near-top",
    `the relevant chunk surfaced in the TOP 3 (retrieval ranks the answer chunk highly, not buried)`,
    topRankRelevant, `topRankRelevant=${topRankRelevant}`);
}

async function cleanup() {
  // Delete the throwaway owner — ON DELETE CASCADE clears uploaded_rows + doc_chunks. The
  // stored original in the bucket is owner-foldered; we also remove it explicitly. Ground
  // truth for "deleted" is getUserById == not-found (a transient error can fire while the
  // delete lands — see the participation-count harness's note).
  let userDeleted = 0;
  if (OWNER) {
    // Remove the stored original (best-effort; CASCADE doesn't touch storage objects).
    try {
      if (courtDocId) await admin().storage.from("documents").remove([`${OWNER}/${courtDocId}`]);
    } catch { /* best-effort */ }
    for (let attempt = 0; attempt < 4 && userDeleted === 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
      try { await admin().auth.admin.deleteUser(OWNER); } catch { /* fall through to existence check */ }
      try {
        const { data, error } = await admin().auth.admin.getUserById(OWNER);
        if ((error && /not found/i.test(error.message)) || !data?.user) userDeleted = 1;
      } catch { /* retry */ }
    }
  }
  console.log(`\n↩ cleanup: owner ${userDeleted}/1 deleted (CASCADE cleared uploaded_rows + doc_chunks)`);
  check("CLEANUP/owner-deleted", "the throwaway owner was deleted (no residue)", userDeleted === 1, `userDeleted=${userDeleted}`);
}

// RESIDUE GUARD (#79): refuse to run over a DB a prior leaked run left dirty (a polluted
// catalog produces a FALSE GREEN); abort loudly. Asserts 0 throwaway orphan rows BEFORE.
await assertCleanBefore("data-access-her-files");
let runError = null;
try { await main(); }
catch (e) { runError = e; console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e); }
finally { await cleanup(); }
// RESIDUE GUARD (#79): this run must leave 0 throwaway residue — fail loudly if its cleanup leaked.
await assertCleanAfter("data-access-her-files");

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(`DATA-ACCESS GROUND TRUTH (her files): ${results.length - fails.length}/${results.length} passed` +
  (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN"));
if (fails.length || runError) process.exit(1);
process.exit(0);
