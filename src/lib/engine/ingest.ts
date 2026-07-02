// Runtime ingestion — turn an UPLOADED file into citable, query-able evidence
// without a rebuild. Reuses the build-time chunking (pagesToChunks) so an
// uploaded doc is listed in the catalog and cited identically to a bundled one.
//
// AGENTIC BUILD NOTE: embeddings are intentionally skipped at ingest time. The
// agentic answer reads raw original files directly (fetchOriginalFile → agent
// Bash/Read tools) and never calls the hybrid_match dense lane. Skipping the slow
// multilingual-e5 / ONNX embedding step makes uploads significantly faster while
// keeping the Sources catalog, per-chat scoping, and the agentic answer intact:
//   • catalog: doc_chunks rows (with embedding=NULL) are still grouped by doc_id
//   • per-chat scoping: the _files.json manifest is written by storeOriginalFile
//     (unchanged) — the agentic path only reads the manifest, not doc_chunks
//   • agentic answer: reads the raw stored file, not doc_chunks / embeddings
// The non-agentic hybrid_match lane already filters `embedding is not null`, so
// NULL-embedded rows are harmlessly skipped there too.
//
// PDF text extraction here uses `unpdf` (pure-JS pdf.js, serverless-safe) instead
// of pdftotext — the build path's poppler binary isn't on the Vercel runtime.
import { pagesToChunks } from "./pdf.ts";
import { parseCsv } from "./csv.ts";
import type { DocSpec, VectorRecord } from "./documents.ts";
import { storeDocument, storeRows, type Urgency } from "./doc-store.ts";
import { storeUploadedRows, type StorableRow } from "./structured-rows-store.ts";
import { classifyUrgency } from "./urgency.ts";
import { ocrLowTextPages } from "./ocr.ts";
import { storeDocChunks, type StorableChunk } from "./pgvector-store.ts";
import { pdfToken } from "./citations.ts";
import { supabaseEnabled } from "./supabase.ts";
import type { RuntimeSqlRow } from "./runtime-store.ts";
import { createHash } from "node:crypto";

// `||` (not `??`) so an empty env value ("") falls through to the real date.
const TODAY = process.env.ASSISTANT_TODAY || new Date().toISOString().slice(0, 10);

// A stable, citation-safe doc id from a filename: lowercased, non-alphanumerics
// to hyphens. This is the [P:<doc>#page] namespace, so it must be URL/token-safe.
//
// `scope` (the upload route passes the chat's session_id, or — for a space-direct
// upload — the space_id): when present, the same filename dropped into a DIFFERENT
// chat/space becomes a DIFFERENT document. The doc id is the Storage-blob key AND the
// _files.json manifest key, so WITHOUT this a report.pdf in chat A and a report.pdf in
// chat B collide on one key — the second blob overwrites the first and the manifest
// entry is re-tagged to chat B, silently losing chat A's document (bug F4). Callers
// with no `scope` (bundled ingest, the multi-sheet namespacer, legacy tests) get the
// historical filename-only id, byte-for-byte unchanged.
export function docIdFromFilename(name: string, scope?: string | null): string {
  const base = name.replace(/\.[^.]+$/, "");
  const id =
    base
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "upload";
  if (!scope) return id;
  // (filename, scope) IS the document identity: same name in the SAME scope re-derives
  // the SAME id (replace semantics preserved); same name in ANOTHER scope gets a
  // distinct id (both coexist, neither steals the other).
  //
  // The scope suffix is derived MECHANICALLY, not by a hardcoded separator convention:
  // 12 hex chars of SHA-256(scope) = 48 bits of entropy over the handful of scopes a
  // single owner has, so two distinct scope ids colliding is astronomically unlikely.
  // The hex alphabet ([0-9a-f]) is a subset of the slug alphabet, so a scoped id
  // `${slug}-${hex}` could in principle equal an UNSCOPED filename that slugified to
  // that exact string — but every ROUTE upload is scoped (session_id or space_id is
  // required), so unscoped ids never share this namespace, and two scoped ids differ
  // iff their (slug, scope-digest) pair differs. The id stays OPAQUE: nothing parses it
  // back into a filename (the manifest carries displayName; the agent writes files by
  // displayName), and existing prod ids (no suffix) keep matching by exact equality.
  const scopeTag = createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 12);
  return `${id}-${scopeTag}`;
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
 * The TEXT path is the contract; OCR is enrichment that never breaks ingest. A PDF
 * that yields NO text even after OCR is STILL accepted (never throws): the agentic
 * answer reads the RAW original file natively (fetchOriginalFile → the multimodal
 * Read tool), so text extraction is best-effort enrichment for the catalog/urgency
 * badge — NEVER a gate on acceptance. A zero-text PDF gets a catalog record with
 * chunks=0; the route then stores its raw bytes and flags `zeroContent` for a soft
 * UI note. (Throwing here used to ABORT the route before storeOriginalFile ran,
 * destroying the one artifact the agent needs — a RAG-era holdover, removed.)
 * @param ownerId  the uploading user; undefined = shared/single-user.
 */
export async function ingestPdf(
  buf: Uint8Array,
  filename: string,
  label?: string,
  ownerId?: string,
  // Per-chat scoping (migration 014): tag chunks with the active chat's session_id.
  chatId?: string | null
): Promise<IngestResult> {
  const doc = docIdFromFilename(filename);
  const docLabel = label || filename;

  // Text path + best-effort OCR for scanned/image-only pages (see ocr.ts: bounded,
  // serverless-safe degradation, never throws). `chunks` may be empty for a
  // scanned/image-only PDF whose text layer is empty AND OCR couldn't read it — that
  // is fine: we still register the doc + (in the route) store its raw bytes, which is
  // what the agentic answer reads. Extraction is enrichment, never a gate.
  const pages = await extractPdfPagesWithOcr(buf);
  const chunks = pagesToChunks(pages, doc);

  // Build catalog records without computing embeddings (agentic build: the agent
  // reads raw files; the dense lane is unused). embedding=null in storable means
  // hybrid_match skips these chunks (its `where embedding is not null` guard), but
  // the catalog listing and per-chat scoping still work because listUploadedDocs
  // groups doc_chunks by doc_id and never reads the embedding column.
  const records: VectorRecord[] = [];
  const storable: StorableChunk[] = [];
  for (const c of chunks) {
    records.push({ doc: c.doc, page: c.page, text: c.text, embedding: [] });
    storable.push({ page: c.page, text: c.text, token: pdfToken(c.doc, c.page), embedding: null });
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
  const stored = await storeDocChunks(ownerId, doc, docLabel, storable, urgency, chatId);

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
 * .docx). A .docx with NO extractable text is STILL accepted (never throws) — the same
 * contract as ingestPdf: extraction is best-effort enrichment for the catalog/urgency
 * badge, the raw file (stored by the route) is what the agentic answer reads, and the
 * route's `zeroContent` flag drives a soft UI note. Throwing here used to abort the
 * route before the raw bytes were stored.
 */
export async function ingestDocx(
  buf: Uint8Array,
  filename: string,
  label?: string,
  ownerId?: string,
  chatId?: string | null
): Promise<IngestResult> {
  const doc = docIdFromFilename(filename);
  const docLabel = label || filename;
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
  const text = (value ?? "").replace(/​/g, "").trim();
  // chunks may be empty (a .docx with no extractable text) — accept it anyway and
  // register a chunks=0 catalog record; the route stores the raw bytes + flags zeroContent.
  const chunks = pagesToChunks([text], doc);
  // Build catalog records without computing embeddings — same rationale as ingestPdf.
  const records: VectorRecord[] = [];
  const storable: StorableChunk[] = [];
  for (const c of chunks) {
    records.push({ doc: c.doc, page: c.page, text: c.text, embedding: [] });
    storable.push({ page: c.page, text: c.text, token: pdfToken(c.doc, c.page), embedding: null });
  }
  const urgency = await classifyUrgency(text, TODAY);
  const spec: DocSpec = { doc, label: docLabel, file: filename };
  const stored = await storeDocChunks(ownerId, doc, docLabel, storable, urgency, chatId);
  await storeDocument(spec, records, ownerId, urgency);
  return {
    kind: "pdf", // a Word doc is a document source, shown + cited like a PDF
    doc,
    label: docLabel,
    chunks: records.length,
    pages: text ? 1 : 0, // a text-less .docx has no readable page
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
  ownerId?: string,
  chatId?: string | null
): Promise<number> {
  // Warm path: owner-tagged runtime rows so the materialized SQLite catalog is
  // owner-scoped (per-user isolation under Fluid Compute).
  const tagged: RuntimeSqlRow[] = rows.map((r) => ({ ...r, owner: ownerId ?? null }));
  await storeRows(table, tagged, ownerId);
  // Durable path: persist to uploaded_rows (delete-then-insert, owner-scoped).
  // Per-chat scoping (migration 014): tag with chatId so retrieval is chat-scoped.
  const storable: StorableRow[] = rows.map((r) => ({ table, rowId: r.id, data: r.data }));
  return storeUploadedRows(ownerId, table, label, storable, chatId);
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
  ownerId?: string,
  chatId?: string | null
): Promise<IngestResult> {
  const table = docIdFromFilename(filename);
  const label = `${filename} (table)`;
  const parsed = parseCsv(text);
  const rows: RuntimeSqlRow[] = parsed.map((r, i) => ({
    table,
    id: i + 1,
    data: { id: i + 1, ...r },
  }));
  const persisted = await persistStructuredRows(table, label, rows, ownerId, chatId);
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
  ownerId?: string,
  chatId?: string | null
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
    totalPersisted += await persistStructuredRows(table, label, rows, ownerId, chatId);
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
