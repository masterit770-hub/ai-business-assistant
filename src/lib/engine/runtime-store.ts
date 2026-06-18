// In-process registry of ingested documents — id + label + classified urgency,
// for the router catalog and the dashboard badges.
//
// This is NOT a vector store. Document CONTENT lives elsewhere:
//   * UPLOADS  → Gemini File Search (Google-managed; durable across cold starts).
//   * BUNDLED  → the static index (data-index/vectors.json).
// We keep only lightweight metadata here so the router knows an uploaded doc
// exists and the dashboard can show its urgency badge. (The former in-memory /
// pgvector DOCUMENT vector backends were removed — see docs/log.md.)
import type { DocSpec, VectorRecord } from "./documents.ts";

export type RuntimeSqlRow = {
  table: string;
  id: number;
  data: Record<string, unknown>;
};

type RuntimeStore = {
  // Doc specs for the router catalog (id + human label).
  docs: DocSpec[];
  // Structured rows from uploaded CSV/XLSX (local fallback; not yet queryable —
  // structured-upload querying is parked).
  sqlRows: RuntimeSqlRow[];
  // LLM-classified urgency per doc id (for the dashboard badge).
  urgency: Record<string, "high" | "medium" | "low">;
  // Gemini File Search file id per doc id (the store document's displayName is
  // this file id, so deletion looks the doc up by it).
  fileIds: Record<string, string>;
};

// A single process-wide registry. On globalThis so Next.js dev's module reloading
// doesn't silently create a second, empty copy.
const g = globalThis as unknown as { __nucleusRuntimeStore?: RuntimeStore };
function store(): RuntimeStore {
  if (!g.__nucleusRuntimeStore) {
    g.__nucleusRuntimeStore = { docs: [], sqlRows: [], urgency: {}, fileIds: {} };
  }
  if (!g.__nucleusRuntimeStore.fileIds) g.__nucleusRuntimeStore.fileIds = {};
  return g.__nucleusRuntimeStore;
}

/** Record the Gemini file id for a doc (used to delete it from the store). */
export function setDocFileId(docId: string, fileId: string): void {
  store().fileIds[docId] = fileId;
}
/** The Gemini file id for a doc, if known. */
export function getDocFileId(docId: string): string | undefined {
  return store().fileIds[docId];
}

/** All registered doc specs (for the router catalog). */
export function runtimeDocs(): DocSpec[] {
  return store().docs;
}

/** All registered docs with their label + urgency (for the dashboard). */
export function runtimeDocMeta(): { doc: string; label: string; urgency: "high" | "medium" | "low" | null }[] {
  const s = store();
  return s.docs.map((d) => ({ doc: d.doc, label: d.label, urgency: s.urgency[d.doc] ?? null }));
}

/**
 * Register an ingested document (id + label + urgency). The local fallback passes
 * its chunk records too, but they are not retained (the local fallback handles
 * born-digital PDFs whose text the engine re-derives; uploads go to File Search).
 */
export function addRuntimeDocument(
  spec: DocSpec,
  _records: VectorRecord[],
  urgency?: "high" | "medium" | "low"
): void {
  upsertDoc(spec, urgency);
}

/**
 * Register a doc that lives in Gemini File Search — its chunks/embeddings are
 * managed by Gemini, so we track only its spec + urgency for the catalog/badge.
 */
export function registerFileSearchDoc(
  spec: DocSpec,
  urgency?: "high" | "medium" | "low"
): void {
  upsertDoc(spec, urgency);
}

function upsertDoc(spec: DocSpec, urgency?: "high" | "medium" | "low"): void {
  const s = store();
  s.docs = s.docs.filter((d) => d.doc !== spec.doc); // re-upload overwrites
  s.docs.push(spec);
  if (urgency) s.urgency[spec.doc] = urgency;
}

/** Remove a doc from the registry (after it's deleted from the File Search store). */
export function removeRuntimeDoc(docId: string): void {
  const s = store();
  s.docs = s.docs.filter((d) => d.doc !== docId);
  delete s.urgency[docId];
  delete s.fileIds[docId];
}

/** Register ingested structured rows (CSV/XLSX local fallback). */
export function addRuntimeRows(rows: RuntimeSqlRow[]): void {
  store().sqlRows.push(...rows);
}
