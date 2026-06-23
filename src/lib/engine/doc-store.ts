// Document registry — tracks ingested docs (id + label + urgency) for the router
// catalog and the dashboard, plus structured rows from the local CSV/XLSX
// fallback. It is an in-process registry, NOT a vector store:
//   * UPLOADED documents live in Gemini File Search (lib/engine/file-search.ts);
//     ingest registers them here for the catalog/dashboard via registerFileSearchDoc.
//   * BUNDLED documents are the static index (data-index/vectors.json).
// (The earlier pgvector/in-memory DOCUMENT vector backends were removed — docs
// are File Search; no pgvector for documents.)
import type { DocSpec, VectorRecord } from "./documents.ts";
import {
  addRuntimeDocument,
  addRuntimeRows,
  runtimeDocs,
  runtimeDocMeta,
  type RuntimeSqlRow,
} from "./runtime-store.ts";

export type Urgency = "high" | "medium" | "low";
export type DocMeta = { doc: string; label: string; urgency: Urgency | null };

/**
 * Register an ingested document (spec + chunks + urgency). Used by the LOCAL
 * fallback (born-digital PDF when no Gemini key); File Search uploads register
 * via registerFileSearchDoc directly. Chunks are kept only for the local path.
 */
export async function storeDocument(
  spec: DocSpec,
  records: VectorRecord[],
  _ownerId?: string,
  urgency?: Urgency
): Promise<void> {
  addRuntimeDocument(spec, records, urgency);
}

/** Register ingested structured (CSV/XLSX) rows in the WARM in-memory runtime store
 *  (the fast-path). The rows are expected to already carry their `owner` tag (set by the
 *  ingest path) so the materialized SQLite catalog is owner-scoped; addRuntimeRows
 *  replaces per (owner, table). The DURABLE copy is written separately to uploaded_rows
 *  (structured-rows-store) — that is what survives a serverless cold start. */
export async function storeRows(
  _table: string,
  rows: RuntimeSqlRow[],
  _ownerId?: string
): Promise<void> {
  addRuntimeRows(rows);
}

/** Uploaded docs for the router catalog. */
export async function listUploadedDocs(_ownerId?: string): Promise<DocSpec[]> {
  return runtimeDocs();
}

/** Uploaded docs + their classified urgency, for the dashboard badges. */
export async function listDocsWithMeta(_ownerId?: string): Promise<DocMeta[]> {
  return runtimeDocMeta();
}
