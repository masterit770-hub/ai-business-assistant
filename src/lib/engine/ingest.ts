// Runtime ingestion — turn an UPLOADED file into citable, query-able evidence
// without a rebuild. Reuses the build-time chunking (pagesToChunks) and the same
// local multilingual embedder (embedPassage) the bundled index uses, so an
// uploaded doc is retrieved + cited identically to a bundled one.
//
// PDF text extraction here uses `unpdf` (pure-JS pdf.js, serverless-safe) instead
// of pdftotext — the build path's poppler binary isn't on the Vercel runtime.
import { pagesToChunks } from "./pdf.ts";
import { parseCsv } from "./csv.ts";
import { embedPassage } from "./embeddings.ts";
import type { DocSpec, VectorRecord } from "./documents.ts";
import { storeDocument, storeRows, type Urgency } from "./doc-store.ts";
import { storeUploadedRows, type StorableRow } from "./structured-rows-store.ts";
import { classifyUrgency } from "./urgency.ts";
import { ocrLowTextPages } from "./ocr.ts";
import { storeDocChunks, type StorableChunk } from "./pgvector-store.ts";
import { pdfToken } from "./citations.ts";
import { supabaseEnabled } from "./supabase.ts";
import type { RuntimeSqlRow } from "./runtime-store.ts";

// `||` (not `??`) so an empty env value ("") falls through to the real date.
const TODAY = process.env.ASSISTANT_TODAY || new Date().toISOString().slice(0, 10);

// A stable, citation-safe doc id from a filename: lowercased, non-alphanumerics
// to hyphens. This is the [P:<doc>#page] namespace, so it must be URL/token-safe.
export function docIdFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  const id = base
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return id || "upload";
}

export type IngestResult = {
  kind: "pdf" | "csv" | "xlsx";
  doc?: string;
  label?: string;
  chunks?: number;
  pages?: number;
  table?: string;
  rows?: number;
  sheets?: number;
  urgency?: Urgency; // LLM-classified dashboard badge
  persisted?: number; // chunks written to the durable pgvector store (when Supabase is on)
};

/** Extract per-page text from a PDF buffer using unpdf (serverless-safe). */
async function extractPdfPages(buf: Uint8Array): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return pages.map((p) => (p ?? "").replace(/​/g, "").trim());
}

/**
 * Extract per-page text, then BEST-EFFORT OCR the low-text (scanned/image-only) pages
 * and splice the recovered text back in. The TEXT path is the contract — OCR is pure
 * enrichment and NEVER throws (ocrLowTextPages is bounded + non-throwing): if it can't
 * run (serverless WASM limits) the pages just stay as their text-layer extraction.
 * pdf.js detaches the buffer it reads, so OCR gets its OWN copy of the bytes.
 */
async function extractPdfPagesWithOcr(buf: Uint8Array): Promise<string[]> {
  const ocrCopy = buf.slice(); // keep untouched bytes — extractPdfPages detaches buf
  const pages = await extractPdfPages(buf);
  try {
    const recovered = await ocrLowTextPages(ocrCopy, pages);
    for (const [idxStr, text] of Object.entries(recovered)) {
      const i = Number(idxStr);
      if (text && (pages[i] ?? "").replace(/\s+/g, "").length < text.replace(/\s+/g, "").length) {
        pages[i] = text;
      }
    }
  } catch (e) {
    // OCR is best-effort; a failure must never break a text-PDF ingest.
    console.warn("[ingest] OCR enrichment skipped:", e instanceof Error ? e.message : e);
  }
  return pages;
}

/**
 * Ingest a PDF buffer into the SELF-HOSTED HYBRID document lane (no Gemini):
 *   extract per-page text (unpdf) → OCR low-text/scanned pages (Tesseract,
 *   best-effort) → chunk (printed-pagination aware) → embed each chunk with the
 *   local multilingual e5 model → persist to Supabase pgvector (doc_chunks, the
 *   HYBRID dense+BM25 store) AND the in-memory document store (the dev/offline
 *   fallback). After this resolves, a documents-routed question retrieves these
 *   chunks via the hybrid (dense × BM25 → RRF) search and cites [P:<doc>#page].
 *
 * The TEXT path is the contract; OCR is enrichment that never breaks ingest. If a
 * PDF yields NO text even after OCR, we throw the honest zero-content error (the
 * route surfaces it) rather than store an empty doc.
 * @param ownerId  the uploading user; undefined = shared/single-user.
 */
export async function ingestPdf(
  buf: Uint8Array,
  filename: string,
  label?: string,
  ownerId?: string
): Promise<IngestResult> {
  const doc = docIdFromFilename(filename);
  const docLabel = label || filename;

  // Text path + best-effort OCR for scanned/image-only pages (see ocr.ts: bounded,
  // serverless-safe degradation, never throws).
  const pages = await extractPdfPagesWithOcr(buf);
  const chunks = pagesToChunks(pages, doc);
  if (chunks.length === 0) {
    throw new Error(
      "no extractable text in this PDF. If it's a scanned/image PDF, OCR couldn't read " +
        "it in this environment (OCR is best-effort and may be unavailable on a " +
        "constrained serverless function). Born-digital PDFs, CSV, and XLSX are unaffected."
    );
  }

  // Embed every chunk with the SAME local e5 model the bundled index + the query side
  // use (384-dim) → so an uploaded chunk lands in the same space as a bundled one.
  const records: VectorRecord[] = [];
  const storable: StorableChunk[] = [];
  for (const c of chunks) {
    const embedding = await embedPassage(c.text);
    records.push({ doc: c.doc, page: c.page, text: c.text, embedding });
    storable.push({ page: c.page, text: c.text, token: pdfToken(c.doc, c.page), embedding });
  }

  // Classify urgency from the document's leading text (real LLM call, editable
  // prompt) so the dashboard badge reflects the actual content.
  const urgency = await classifyUrgency(pages.join("\n"), TODAY);
  const spec: DocSpec = { doc, label: docLabel, file: filename };

  // DURABLE per-user store: persist the embedded chunks to Supabase pgvector
  // (doc_chunks). fts is auto-generated → the BM25/lexical lane needs no extra write.
  // Owner-tagged for per-user isolation. Fail-open (storeDocChunks returns 0 on any
  // error, never throws) so a Supabase blip doesn't fail an ingest that still
  // populated the in-memory store below.
  const stored = await storeDocChunks(ownerId, doc, docLabel, storable, urgency);

  // Also register in the in-memory document store so the doc is query-able + listed
  // even when Supabase is off (dev/offline), and the router catalog/dashboard see it.
  await storeDocument(spec, records, ownerId, urgency);

  return {
    kind: "pdf",
    doc,
    label: docLabel,
    chunks: records.length,
    pages: pages.filter((p) => p.length > 0).length,
    urgency,
    persisted: supabaseEnabled() ? stored : undefined,
  };
}

/**
 * Ingest a Word (.docx) document. mammoth extracts the raw text — a .docx has no page
 * structure, so it's treated as one logical page the chunker splits into citable chunks
 * — then the SAME embed + hybrid-store path as a PDF runs, so a Word doc is retrieved
 * and cited just like a PDF ([P:<doc>#1]). Legacy binary .doc isn't supported (save as
 * .docx). NEVER throws on an empty result silently — it surfaces an honest error.
 */
export async function ingestDocx(
  buf: Uint8Array,
  filename: string,
  label?: string,
  ownerId?: string
): Promise<IngestResult> {
  const doc = docIdFromFilename(filename);
  const docLabel = label || filename;
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
  const text = (value ?? "").replace(/​/g, "").trim();
  const chunks = pagesToChunks([text], doc);
  if (chunks.length === 0) {
    throw new Error(
      "no extractable text in this Word file. If it's a legacy .doc, re-save it as .docx; " +
        "born-digital .docx, PDF, CSV, and Excel are supported."
    );
  }
  const records: VectorRecord[] = [];
  const storable: StorableChunk[] = [];
  for (const c of chunks) {
    const embedding = await embedPassage(c.text);
    records.push({ doc: c.doc, page: c.page, text: c.text, embedding });
    storable.push({ page: c.page, text: c.text, token: pdfToken(c.doc, c.page), embedding });
  }
  const urgency = await classifyUrgency(text, TODAY);
  const spec: DocSpec = { doc, label: docLabel, file: filename };
  const stored = await storeDocChunks(ownerId, doc, docLabel, storable, urgency);
  await storeDocument(spec, records, ownerId, urgency);
  return {
    kind: "pdf", // a Word doc is a document source, shown + cited like a PDF
    doc,
    label: docLabel,
    chunks: records.length,
    pages: 1,
    urgency,
    persisted: supabaseEnabled() ? stored : undefined,
  };
}

// Turn one tabular row into a compact, human-readable line — used ONLY to feed the
// urgency classifier a readable sample of the spreadsheet's content (e.g. "Vendor: Acme
// | Amount: 5000 | Status: active"). A blank cell is kept verbatim (graceful). NOTE: a
// spreadsheet's rows are STRUCTURED data — they are answered by text-to-SQL over the
// uploaded_rows table, NOT embedded as RAG/pgvector chunks; this text is only for the
// dashboard urgency badge.
function rowToText(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([k]) => k !== "id")
    .map(([k, v]) => `${k}: ${v ?? ""}`)
    .join(" | ");
}

// Persist an uploaded table's rows to BOTH stores: the in-memory runtime store (the warm
// fast-path, owner-tagged for isolation) AND the DURABLE uploaded_rows table (so the
// text-to-SQL lane survives a Vercel serverless cold start — rehydrated owner-scoped by
// structured-store.hydrateUploadedTables). Returns the durable row count (0 when
// Supabase is off; the warm path still works). storeUploadedRows is FAIL-OPEN so a
// Supabase blip can't break an ingest. Spreadsheets are NEVER written to doc_chunks —
// that is the wrong (document/RAG) lane for structured data.
async function persistStructuredRows(
  table: string,
  label: string,
  rows: RuntimeSqlRow[],
  ownerId?: string
): Promise<number> {
  // Warm path: owner-tagged runtime rows so the materialized SQLite catalog is
  // owner-scoped (per-user isolation under Fluid Compute).
  const tagged: RuntimeSqlRow[] = rows.map((r) => ({ ...r, owner: ownerId ?? null }));
  await storeRows(table, tagged, ownerId);
  // Durable path: persist to uploaded_rows (delete-then-insert, owner-scoped).
  const storable: StorableRow[] = rows.map((r) => ({ table, rowId: r.id, data: r.data }));
  return storeUploadedRows(ownerId, table, label, storable);
}

/**
 * Ingest a CSV buffer. Each row is stored as a STRUCTURED row — in the warm in-memory
 * runtime store AND durably in uploaded_rows — so the text-to-SQL lane answers questions
 * about it with real SQL (counts/sums/filters/lookups) cited to [S:<table>#row], and it
 * survives a serverless cold start. A spreadsheet is structured data; it is NOT embedded
 * as RAG/pgvector chunks. Malformed cells are kept as-is (never crash) — mirroring the
 * build-time loader's graceful policy.
 * @param ownerId  the uploading user; undefined = shared/single-user.
 */
export async function ingestCsv(
  text: string,
  filename: string,
  ownerId?: string
): Promise<IngestResult> {
  const table = docIdFromFilename(filename);
  const label = `${filename} (table)`;
  const parsed = parseCsv(text);
  const rows: RuntimeSqlRow[] = parsed.map((r, i) => ({
    table,
    id: i + 1,
    data: { id: i + 1, ...r },
  }));
  const persisted = await persistStructuredRows(table, label, rows, ownerId);
  // Classify urgency from a readable sample for the dashboard badge (real LLM call).
  let urgency: Urgency | undefined;
  if (rows.length) {
    const sample = rows.map((r) => rowToText(r.data)).filter((t) => t.trim()).join("\n");
    if (sample) urgency = await classifyUrgency(sample, TODAY);
  }
  return {
    kind: "csv",
    table,
    rows: rows.length,
    chunks: 0, // spreadsheets are structured, not RAG chunks
    urgency,
    persisted: supabaseEnabled() ? persisted : undefined,
  };
}

/**
 * Ingest an Excel (.xlsx) buffer. Every sheet's rows are parsed (header row → keyed
 * objects) and stored as STRUCTURED rows — warm in-memory + durable uploaded_rows (same
 * path as CSV) — so they're answered by text-to-SQL and survive a cold start. Multiple
 * sheets are namespaced as <table>-<sheet>. A spreadsheet is structured data; it is NOT
 * embedded as RAG/pgvector chunks.
 * @param ownerId  the uploading user; undefined = shared/single-user.
 */
export async function ingestXlsx(
  buf: Uint8Array,
  filename: string,
  ownerId?: string
): Promise<IngestResult> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buf, { type: "array" });
  const base = docIdFromFilename(filename);
  let totalRows = 0;
  let totalPersisted = 0;
  let lastUrgency: Urgency | undefined;

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    // defval:"" keeps empty cells (graceful); raw:false stringifies for stable text.
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: false,
    });
    if (json.length === 0) continue;
    // One table per sheet (so multi-sheet workbooks don't collide).
    const table =
      wb.SheetNames.length > 1 ? `${base}-${docIdFromFilename(sheetName)}` : base;
    const rows: RuntimeSqlRow[] = json.map((r, i) => ({
      table,
      id: i + 1,
      data: { id: i + 1, ...r },
    }));
    const label = `${filename} · ${sheetName}`;
    totalPersisted += await persistStructuredRows(table, label, rows, ownerId);
    // Urgency badge from a readable sample of the sheet (first sheet sets the badge).
    const sample = rows.map((r) => rowToText(r.data)).filter((t) => t.trim()).join("\n");
    if (sample) {
      const u = await classifyUrgency(sample, TODAY);
      if (!lastUrgency) lastUrgency = u;
    }
    totalRows += rows.length;
  }

  if (totalRows === 0) {
    throw new Error("the spreadsheet has no data rows (is the first row a header?)");
  }
  return {
    kind: "xlsx",
    table: base,
    rows: totalRows,
    chunks: 0, // spreadsheets are structured, not RAG chunks
    sheets: wb.SheetNames.length,
    urgency: lastUrgency,
    persisted: supabaseEnabled() ? totalPersisted : undefined,
  };
}
