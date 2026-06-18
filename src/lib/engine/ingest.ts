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
import { classifyUrgency } from "./urgency.ts";
import { fileSearchEnabled, uploadToStore, registerTitleMapping } from "./file-search.ts";
import { registerFileSearchDoc, setDocFileId } from "./runtime-store.ts";
import type { RuntimeSqlRow } from "./runtime-store.ts";

const TODAY = process.env.ASSISTANT_TODAY ?? new Date().toISOString().slice(0, 10);

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
 * Ingest a PDF buffer: extract → chunk (printed-pagination aware) → embed each
 * chunk with the local multilingual model → persist to the document store
 * (Supabase pgvector, or in-memory fallback). After this resolves, a
 * documents-routed question can retrieve and cite [P:<doc>#page].
 * @param ownerId  the uploading user (Phase C); undefined = shared/single-user.
 */
export async function ingestPdf(
  buf: Uint8Array,
  filename: string,
  label?: string,
  ownerId?: string
): Promise<IngestResult> {
  const doc = docIdFromFilename(filename);

  // This LOCAL fallback path handles born-digital PDFs (text layer present). It
  // runs only when Gemini File Search is NOT configured (a dev/offline mode).
  //
  // SCANNED / image-only PDFs are NOT handled here by design: Gemini's multimodal
  // models read scans natively, so scanned-document support lives in the File
  // Search doc lane (the production path), NOT a separate local OCR pipeline.
  const pages = await extractPdfPages(buf);
  const chunks = pagesToChunks(pages, doc);
  if (chunks.length === 0) {
    throw new Error(
      "no extractable text in this PDF. If it's a scanned/image PDF, ingest it via " +
        "the Gemini File Search path (set GEMINI_API_KEY) — Gemini reads scans natively; " +
        "this local fallback handles born-digital PDFs only."
    );
  }
  const records: VectorRecord[] = [];
  for (const c of chunks) {
    const embedding = await embedPassage(c.text);
    records.push({ doc: c.doc, page: c.page, text: c.text, embedding });
  }
  // Classify urgency from the document's leading text (real LLM call, editable
  // prompt) so the dashboard badge reflects the actual content.
  const urgency = await classifyUrgency(pages.join("\n"), TODAY);
  const spec: DocSpec = { doc, label: label || filename, file: filename };
  await storeDocument(spec, records, ownerId, urgency);
  return {
    kind: "pdf",
    doc,
    label: spec.label,
    chunks: records.length,
    pages: pages.filter((p) => p.length > 0).length,
    urgency,
  };
}

/**
 * Ingest a document into Gemini File Search (the managed, durable doc store).
 * Gemini chunks/embeds/persists the file and reads scans/Office formats natively,
 * so this path needs no local OCR/chunking. We still classify urgency from the
 * file's text (best-effort) and register the doc id so the router catalog + the
 * dashboard see it. The citation namespace [P:<doc>#page] is derived from the
 * filename so File Search grounding chunks map back to the same chips.
 */
export async function ingestDocumentToFileSearch(
  buf: Uint8Array,
  filename: string,
  mimeType?: string,
  ownerId?: string
): Promise<IngestResult> {
  const doc = docIdFromFilename(filename);

  // pdf.js detaches the buffer it reads, so keep an untouched copy for the upload
  // before local text extraction (for urgency) consumes the original.
  const uploadCopy = buf.slice();

  // Best-effort urgency: extract text locally just for classification (a scanned
  // PDF may yield nothing — then we leave urgency unset rather than guess wrong).
  let urgency: Urgency | undefined;
  try {
    const pages = await extractPdfPages(buf);
    const text = pages.join("\n");
    if (text.replace(/\s/g, "").length > 0) urgency = await classifyUrgency(text, TODAY);
  } catch {
    // non-PDF or unreadable for local extraction — skip urgency, File Search still indexes it
  }

  // Index the file into Gemini File Search. Store doc_id / label / urgency in the
  // file's custom_metadata so the dashboard list + delete are rebuilt DURABLY from
  // the store (survive cold starts), not the per-Lambda in-memory registry.
  const { fileId } = await uploadToStore(uploadCopy, doc, mimeType ?? "application/pdf", ownerId, {
    docId: doc,
    label: filename,
    urgency,
  });
  registerTitleMapping(fileId, doc);
  setDocFileId(doc, fileId);

  // Also register in-process (router catalog + same-instance dashboard fallback).
  registerFileSearchDoc({ doc, label: filename, file: filename }, urgency);
  return { kind: "pdf", doc, label: filename, urgency };
}

// Turn one tabular row into a compact, human-readable line so it can be embedded
// and retrieved by RAG (e.g. "Vendor: Acme | Amount: 5000 | Status: active"). A
// blank/"error" cell is kept verbatim (graceful — see CLAUDE.md landmine #4).
function rowToText(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([k]) => k !== "id")
    .map(([k, v]) => `${k}: ${v ?? ""}`)
    .join(" | ");
}

// Embed each tabular row as a citable doc chunk under `table`, so a question
// about an uploaded spreadsheet/CSV gets a grounded, cited answer via the RAG
// path — citation token [P:<table>#<rowId>]. (Structured-intent SQL over uploads
// is a separate, larger feature; this makes the data answerable NOW.)
async function rowsToChunks(table: string, rows: RuntimeSqlRow[]): Promise<VectorRecord[]> {
  const records: VectorRecord[] = [];
  for (const r of rows) {
    const text = rowToText(r.data);
    if (!text.trim()) continue;
    const embedding = await embedPassage(text);
    records.push({ doc: table, page: r.id, text, embedding });
  }
  return records;
}

/**
 * Ingest a CSV buffer. Each row is stored BOTH as a structured row (for future
 * SQL-over-uploads) AND as a citable, embedded RAG chunk so the data is queryable
 * NOW with citations ([P:<table>#row]). Malformed cells are kept as-is (never
 * crash) — mirroring the build-time loader's graceful policy.
 * @param ownerId  the uploading user (Phase C); undefined = shared/single-user.
 */
export async function ingestCsv(
  text: string,
  filename: string,
  ownerId?: string
): Promise<IngestResult> {
  const table = docIdFromFilename(filename);
  const parsed = parseCsv(text);
  const rows: RuntimeSqlRow[] = parsed.map((r, i) => ({
    table,
    id: i + 1,
    data: { id: i + 1, ...r },
  }));
  await storeRows(table, rows, ownerId);
  const records = await rowsToChunks(table, rows);
  let urgency: Urgency | undefined;
  if (records.length) {
    urgency = await classifyUrgency(records.map((r) => r.text).join("\n"), TODAY);
    await storeDocument(
      { doc: table, label: `${filename} (table)`, file: filename },
      records,
      ownerId,
      urgency
    );
  }
  return { kind: "csv", table, rows: rows.length, chunks: records.length, urgency };
}

/**
 * Ingest an Excel (.xlsx) buffer. Every sheet's rows are parsed (header row →
 * keyed objects), stored as structured rows, and embedded as citable RAG chunks
 * (same path as CSV). Multiple sheets are namespaced as <table>-<sheet>.
 * @param ownerId  the uploading user (Phase C); undefined = shared/single-user.
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
  let totalChunks = 0;
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
    await storeRows(table, rows, ownerId);
    const records = await rowsToChunks(table, rows);
    if (records.length) {
      const u = await classifyUrgency(records.map((r) => r.text).join("\n"), TODAY);
      if (!lastUrgency) lastUrgency = u;
      await storeDocument(
        { doc: table, label: `${filename} · ${sheetName}`, file: filename },
        records,
        ownerId,
        u
      );
    }
    totalRows += rows.length;
    totalChunks += records.length;
  }

  if (totalRows === 0) {
    throw new Error("the spreadsheet has no data rows (is the first row a header?)");
  }
  return {
    kind: "xlsx",
    table: base,
    rows: totalRows,
    chunks: totalChunks,
    sheets: wb.SheetNames.length,
    urgency: lastUrgency,
  };
}
