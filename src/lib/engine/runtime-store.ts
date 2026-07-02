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
  // The uploading user (per-user isolation). Undefined/null = a shared/single-user
  // upload. Owner-tagged so the structured store can materialize an OWNER-SCOPED SQLite
  // catalog — critical under Fluid Compute, where one instance serves concurrent
  // requests from different users and must NEVER leak one owner's tables to another.
  owner?: string | null;
};

// The scope a structured-catalog read runs under. `ownerId` undefined = an admin (sees
// every owner's uploaded rows) or a legacy shared/single-user caller. A concrete
// `ownerId` = a member, who sees ONLY rows tagged with that owner (plus null-owner
// shared rows). Used to filter runtimeRows so the materialized SQLite is owner-scoped.
export type RowScope = { ownerId?: string; isAdmin?: boolean };

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

/** Register ingested structured rows (CSV/XLSX). These are materialized into the
 *  queryable structured store so the text-to-SQL lane can query uploaded tables. A
 *  re-upload of the same table REPLACES its prior rows (mirrors the doc upsert), so a
 *  re-ingest doesn't double-count. The replace is scoped to the (owner, table) pair so
 *  two different owners' uploads of a same-named table never clobber each other. */
export function addRuntimeRows(rows: RuntimeSqlRow[]): void {
  const s = store();
  // Replace only the (owner, table) pairs this batch carries — never a different owner's
  // rows for the same table name.
  const pairs = new Set(rows.map((r) => `${r.owner ?? ""}::${r.table}`));
  if (pairs.size) s.sqlRows = s.sqlRows.filter((r) => !pairs.has(`${r.owner ?? ""}::${r.table}`));
  s.sqlRows.push(...rows);
}

/** Uploaded structured rows grouped by their table name — the input the structured
 *  store materializes into real, queryable SQLite tables. Returns a fresh Map each
 *  call (the store keys its rebuild off the row counts here).
 *
 *  OWNER-SCOPED: when a scope is passed, only rows VISIBLE to that scope are returned —
 *  a member (concrete ownerId, not admin) sees ONLY their own rows plus shared
 *  (null-owner) rows; an admin (isAdmin) sees every owner's rows; no scope (the legacy
 *  default) returns everything (preserves the existing unit tests + single-user mode).
 *  This is the isolation gate: the materialized SQLite catalog only ever contains the
 *  caller's visible tables, so one owner can never query another's uploaded data. */
export function runtimeRows(scope?: RowScope): Map<string, RuntimeSqlRow[]> {
  const byTable = new Map<string, RuntimeSqlRow[]>();
  for (const r of store().sqlRows) {
    if (!rowVisibleTo(r, scope)) continue;
    const list = byTable.get(r.table) ?? [];
    list.push(r);
    byTable.set(r.table, list);
  }
  return byTable;
}

// Is this row visible to the given scope? No scope → everything (legacy/default).
// Admin → everything. Member (concrete ownerId, not admin) → only their own rows +
// shared (null-owner) rows. A member with no ownerId would be fail-closed at the call
// site (the scope is only built for an authenticated caller), but defensively a member
// scope with no ownerId sees only shared rows here.
function rowVisibleTo(r: RuntimeSqlRow, scope?: RowScope): boolean {
  if (!scope) return true;
  if (scope.isAdmin) return true;
  const owner = r.owner ?? null;
  if (owner === null) return true; // shared/single-user rows are visible to all
  return owner === scope.ownerId;
}

/** Test/hot-reload helper: drop all registered uploaded rows. */
export function clearRuntimeRows(): void {
  store().sqlRows = [];
}

/** Drop the in-memory rows for ONE scope's tables before a rehydrate, so reloading an
 *  owner's durable rows can't leave a stale duplicate set. Scoped to (owner, table) like
 *  addRuntimeRows: a member clears only their own (and shared) tables; an admin clears
 *  any owner's. Pass the table names to clear (the durable set being reloaded). */
export function clearRuntimeRowsForTables(tables: Iterable<string>, scope?: RowScope): void {
  const s = store();
  const names = new Set(tables);
  s.sqlRows = s.sqlRows.filter((r) => {
    if (!names.has(r.table)) return true; // a table we're not reloading — keep
    return !rowVisibleTo(r, scope); // within scope → drop (it's being reloaded)
  });
}

/**
 * TEST-ONLY: reset the in-memory runtime store to the exact empty shape a FRESH
 * serverless process boots with ({docs:[], sqlRows:[], urgency:{}, fileIds:{}}).
 *
 * This exists to let the cold-start durability regression eval simulate a Vercel
 * serverless COLD START in-process: after ingesting as a non-demo owner (which
 * populates BOTH this in-memory store AND the durable Supabase doc_chunks), the eval
 * calls this to wipe the in-memory catalog — reproducing the exact state in which the
 * router used to see "(no documents loaded)" and answer "there are none" for a real
 * uploaded doc. The fix (router unions the DURABLE catalog) must still find the doc.
 *
 * NOT used by production code — only by tests/evals. Keep it test-only.
 */
export function __resetRuntimeStoreForTests(): void {
  g.__nucleusRuntimeStore = { docs: [], sqlRows: [], urgency: {}, fileIds: {} };
}
