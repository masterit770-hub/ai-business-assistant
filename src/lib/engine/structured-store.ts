// THE STRUCTURED STORE — one introspectable, read-only SQLite handle that holds
// EVERY ingested table: the bundled CSV tables (data-index/contracts.sqlite) AND any
// table the user uploaded at runtime (CSV/XLSX → runtime-store rows). The text-to-SQL
// lane works off THIS catalog, so it is general by construction — there is no
// hardcoded table or column anywhere; whatever has been ingested is what's queryable.
//
// How it stays general:
//   • The bundled DB is copied to a WRITABLE temp file (the existing serverless-safe
//     trick) and opened read-write JUST so we can materialize uploaded rows INTO it as
//     real tables. We then run user/model queries through a guard + a read-only
//     discipline (SELECT-only, enforced by sql-guard) — the handle is writable only so
//     uploads become first-class queryable tables, never for model SQL.
//   • Uploaded rows (runtime-store) are inferred into a typed table (REAL when every
//     non-empty value parses as a number, else TEXT) with a stable integer `rowid`
//     citation anchor, so [S:<table>#<rowid>] cites a real uploaded row.
//   • introspectSchema() = PRAGMA table_info per table + a few sample rows. This is
//     the catalog the planner and the SQL guard consume.
import Database from "better-sqlite3";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runtimeRows,
  addRuntimeRows,
  clearRuntimeRowsForTables,
  type RowScope,
  type RuntimeSqlRow,
} from "./runtime-store.ts";
import {
  fetchUploadedRows,
  canReadOwner,
} from "./structured-rows-store.ts";
import type { TableSchema } from "./sql-guard.ts";
import { validateGeneratedSql, type SqlGuardResult } from "./sql-guard.ts";
import { deletedSourceIds } from "./deleted-sources.ts";

// The visibility scope a catalog read runs under (owner-isolation). Re-exported shape:
//   • undefined            → legacy default: include ALL uploaded rows (single-user /
//                            unit tests / admin shared). Bundled inclusion is the
//                            separate includeBundled flag.
//   • { ownerId }          → a MEMBER: only their own uploaded rows (+ shared) are
//                            materialized — the isolation gate.
//   • { isAdmin: true }    → an ADMIN: every owner's uploaded rows.
// Threading this through getStore/introspect/run is what makes the materialized SQLite
// OWNER-SCOPED, so under Fluid Compute one owner can never see another's tables.
export type CatalogScope = RowScope;

const ROOT = process.cwd();
const SQLITE = join(ROOT, "data-index", "contracts.sqlite");

export type SqlRow = { table: string; id: number; data: Record<string, unknown> };

// Internal columns the catalog hides (load bookkeeping) so the model never sees /
// queries them. They still exist physically; we just don't advertise them, and the
// guard's allow-list omits them too.
const HIDDEN_COLUMNS = new Set(["__malformed"]);
const HIDDEN_TABLES = new Set(["_load_report", "sqlite_sequence"]);

// PER-SCOPE handle cache. The materialized SQLite is OWNER-SCOPED: each distinct caller
// scope (a member's ownerId, admin, or the legacy default) gets its OWN handle holding
// ONLY that scope's visible uploaded tables — so concurrent requests from different
// users on one Fluid-Compute instance can never see each other's data. Within a scope
// the handle is reused until that scope's upload signature changes (a new/grown upload).
//
// Why a Map and not one global handle: the prior single global _db materialized EVERY
// uploaded table regardless of owner, so any caller's introspect/query saw every owner's
// rows. Keying by scope is the isolation fix. Entries are cheap (a temp-file SQLite copy)
// and bounded by the number of distinct concurrent scopes an instance serves.
type Handle = { db: Database.Database; sig: string };
const _handles = new Map<string, Handle>();

// A stable cache key for a scope. Admin and the legacy default are distinct keys from
// each member (they materialize different row sets). Two members get distinct keys.
function scopeKey(scope?: CatalogScope): string {
  if (!scope) return "__default__";
  if (scope.isAdmin) return "__admin__";
  return `owner:${scope.ownerId ?? ""}`;
}

/**
 * The read-only-discipline handle FOR A SCOPE. Opened read-WRITE only to materialize
 * that scope's uploaded rows; all MODEL queries go through the guard (SELECT-only).
 * Rebuilt for a scope when its set of visible uploaded tables changes (a new upload).
 *
 * Pass the SAME scope to getStore/introspect/runGeneratedSelect within one request so
 * the catalog the guard validated against is the catalog the query runs against.
 */
export function getStore(scope?: CatalogScope): Database.Database {
  const key = scopeKey(scope);
  const uploads = runtimeRows(scope);
  const sig = uploadSignature(uploads);
  const cached = _handles.get(key);
  if (cached && cached.sig === sig) return cached.db;
  // (Re)build: fresh writable copy of the bundled DB + materialize this scope's uploads.
  if (cached) {
    try { cached.db.close(); } catch { /* already closed */ }
    _handles.delete(key);
  }
  const db = openWritableBundled();
  materializeUploads(db, uploads);
  _handles.set(key, { db, sig });
  return db;
}

function openWritableBundled(): Database.Database {
  if (!existsSync(SQLITE)) {
    throw new Error("data-index/contracts.sqlite missing — run `npm run build:index`");
  }
  // Copy the bundled bytes to a writable temp file (serverless-safe; mirrors the old
  // retrieval.getDb trick) so we can ATTACH uploaded tables to the same handle.
  const bytes = readFileSync(SQLITE);
  const dir = join(tmpdir(), "nucleus-structured");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `store-${process.pid}.sqlite`);
  writeFileSync(path, bytes);
  return new Database(path, { fileMustExist: true });
}

// A change-detection key over the uploaded tables + their row counts, so a NEW upload
// (or a re-upload that grows a table) triggers a rebuild but a no-op call doesn't.
function uploadSignature(uploads: Map<string, SqlRow[]>): string {
  return [...uploads.entries()]
    .map(([t, rows]) => `${t}:${rows.length}`)
    .sort()
    .join("|");
}

// Materialize each uploaded table into the live handle as a real, typed, queryable
// SQLite table with a stable `rowid` (the citation anchor). Column types are INFERRED
// from the data (REAL when every present value is numeric, else TEXT) so aggregates
// like SUM/AVG work on uploaded numeric columns. Messy headers (mixed case, spaces)
// are sanitized to safe SQLite identifiers, and the original header is preserved in a
// per-table column map the planner can show the model.
function materializeUploads(db: Database.Database, uploads: Map<string, SqlRow[]>): void {
  // ONE de-collided name per uploaded table, so two sheets whose names sanitize equal each
  // get their OWN materialized table (the data-loss fix). introspectSchema computes the same
  // map on the same uploads, so the names agree.
  const safeNames = buildSafeTableNames(uploads);
  for (const [table, rows] of uploads) {
    if (rows.length === 0) continue;
    const safeTable = safeNames.get(table)!;
    // Union of all keys across rows (skip the synthetic `id`), in first-seen order.
    const headers: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      for (const k of Object.keys(r.data)) {
        if (k === "id") continue;
        if (!seen.has(k)) { seen.add(k); headers.push(k); }
      }
    }
    // Sanitize headers → unique SQLite column identifiers; keep the mapping.
    const colMap = new Map<string, string>(); // header → safe col
    const usedCols = new Set<string>();
    for (const h of headers) {
      let c = sanitizeIdent(h);
      let n = 1;
      while (usedCols.has(c) || c === "rowid") { c = `${sanitizeIdent(h)}_${n++}`; }
      usedCols.add(c);
      colMap.set(h, c);
    }
    // Infer type per column: REAL if every NON-EMPTY value parses as a finite number.
    const types = new Map<string, "REAL" | "TEXT">();
    for (const h of headers) {
      let numeric = true;
      let anyValue = false;
      for (const r of rows) {
        const v = r.data[h];
        if (v == null || v === "") continue;
        anyValue = true;
        if (!isNumeric(v)) { numeric = false; break; }
      }
      types.set(h, numeric && anyValue ? "REAL" : "TEXT");
    }
    const colDefs = headers.map((h) => `"${colMap.get(h)}" ${types.get(h)}`).join(", ");
    db.exec(`DROP TABLE IF EXISTS "${safeTable}"`);
    db.exec(`CREATE TABLE "${safeTable}" (rowid_anchor INTEGER PRIMARY KEY${colDefs ? ", " + colDefs : ""})`);
    const colList = ["rowid_anchor", ...headers.map((h) => `"${colMap.get(h)}"`)].join(", ");
    const placeholders = ["?", ...headers.map(() => "?")].join(", ");
    const insert = db.prepare(`INSERT INTO "${safeTable}" (${colList}) VALUES (${placeholders})`);
    const tx = db.transaction(() => {
      for (const r of rows) {
        const values: (string | number | null)[] = [r.id];
        for (const h of headers) {
          const v = r.data[h];
          if (v == null || v === "") { values.push(null); continue; }
          if (types.get(h) === "REAL" && isNumeric(v)) values.push(Number(String(v).replace(/[$,]/g, "")));
          else values.push(String(v));
        }
        insert.run(...values);
      }
    });
    tx();
  }
}

/**
 * INTROSPECT the live schema: every queryable table → its columns (name + type) and
 * a few sample rows. This is the general catalog the planner + the SQL guard use; it
 * reflects whatever has been ingested, with ZERO hardcoded names.
 *  - Bundled tables expose their real columns (minus the hidden __malformed flag).
 *  - Uploaded tables expose their sanitized columns; `rowid_anchor` is the citation id.
 */
export function introspectSchema(
  sampleRows = 3,
  // The BUNDLED sample tables (contracts/maintenance, baked into contracts.sqlite) are
  // confined to demo accounts. A non-demo caller passes includeBundled=false → the
  // catalog the planner + SQL guard + router consume excludes them, so a real client
  // user can neither see nor query the sample data (clean bucket). Uploaded tables
  // (materialized from runtime-store) are always kept. Default true = unchanged.
  includeBundled = true,
  // The OWNER-ISOLATION scope (per-user). Undefined = legacy default (all uploaded rows,
  // preserving single-user mode + the existing unit tests). A member scope materializes
  // ONLY that owner's tables; an admin scope sees all. MUST be the same scope passed to
  // the matching runGeneratedSelect/selectWithIds so the guarded catalog == the query DB.
  scope?: CatalogScope
): {
  catalog: TableSchema[];
  samples: Map<string, Record<string, unknown>[]>;
} {
  const db = getStore(scope);
  // Workspace-level soft-delete: a bundled table an admin hid (recorded in
  // deleted_sources) is dropped from the catalog the planner + SQL guard consume, so
  // text-to-SQL can neither plan nor query it → it never appears in an answer. Empty
  // set (nothing hidden / Supabase off) → identical to the prior catalog.
  const hidden = deletedSourceIds();
  // A handle table is BUNDLED iff it is not one of THIS scope's runtime-uploaded tables
  // (whose names are de-collided into unique SQLite identifiers when materialized). MUST use
  // the SAME mapping materializeUploads used, or a de-collided name (foo_2) would be wrongly
  // treated as bundled and hidden from a non-demo caller.
  const uploadedNames = new Set(buildSafeTableNames(runtimeRows(scope)).values());
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .filter((t) => !HIDDEN_TABLES.has(t) && !t.startsWith("sqlite_") && !hidden.has(t))
    .filter((t) => includeBundled || uploadedNames.has(t));

  const catalog: TableSchema[] = [];
  const samples = new Map<string, Record<string, unknown>[]>();
  for (const table of tables) {
    const cols = (
      db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; type: string }[]
    ).filter((c) => !HIDDEN_COLUMNS.has(c.name));
    if (cols.length === 0) continue;
    catalog.push({ table, columns: cols.map((c) => ({ name: c.name, type: c.type || "TEXT" })) });
    // A few representative rows (real values) so the model can see formats.
    const colList = cols.map((c) => `"${c.name}"`).join(", ");
    const rows = db
      .prepare(`SELECT ${colList} FROM "${table}" LIMIT ${Number(sampleRows) || 3}`)
      .all() as Record<string, unknown>[];
    samples.set(table, rows);
  }
  return { catalog, samples };
}

// The integer-PRIMARY-KEY column that anchors a row's [S:table#id] citation: bundled
// tables use `id`; uploaded tables use `rowid_anchor`. We detect it from the schema.
export function idColumnFor(table: string, catalog: TableSchema[]): string {
  const t = catalog.find((c) => c.table.toLowerCase() === table.toLowerCase());
  if (!t) return "rowid";
  if (t.columns.some((c) => c.name.toLowerCase() === "id")) return "id";
  if (t.columns.some((c) => c.name.toLowerCase() === "rowid_anchor")) return "rowid_anchor";
  return "rowid";
}

export type RunResult =
  | { ok: true; rows: SqlRow[] }
  | { ok: false; reason: string };

/**
 * Validate a model-generated SQL against the live catalog, then execute it READ-ONLY.
 * Returns rows tagged with their table + the integer id that anchors the citation
 * ([S:<table>#<id>]). On a guard rejection OR a SQL runtime error this returns
 * {ok:false} with a reason — it NEVER throws and NEVER fabricates.
 *
 * `table` is the primary table the planner chose (for tagging + the id column); the
 * actual SELECT may name it explicitly. We re-read the id column under a stable alias
 * so every result row carries a resolvable citation even when the SELECT projects a
 * subset of columns.
 */
export function runGeneratedSelect(
  rawSql: string,
  primaryTable: string,
  catalog: TableSchema[],
  // Same OWNER-ISOLATION scope passed to the introspectSchema that produced `catalog` —
  // so the query runs against the SAME per-owner handle the guard validated against.
  // Undefined = legacy default (preserves the existing unit tests).
  scope?: CatalogScope
): RunResult {
  const guard: SqlGuardResult = validateGeneratedSql(rawSql, catalog);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  const idCol = idColumnFor(primaryTable, catalog);
  try {
    const db = getStore(scope);
    const stmt = db.prepare(guard.sql);
    // better-sqlite3 throws on a write attempt against a query we expect to be read;
    // sql-guard already guarantees SELECT-only, so .all() is safe + read-only here.
    const raw = stmt.all() as Record<string, unknown>[];
    const rows: SqlRow[] = raw.map((data, i) => {
      // Prefer an id/rowid_anchor present in the projection; else fall back to ordinal.
      const idVal =
        pickNumber(data["id"]) ??
        pickNumber(data["rowid_anchor"]) ??
        pickNumber(data[idCol]) ??
        i + 1;
      return { table: primaryTable, id: idVal, data };
    });
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Run a raw SELECT that augments rows with their citation id column. Used by the
 *  planner to fetch the cited rows for the FINAL result set (so [S:table#id] resolves
 *  to a real row). Read-only; SELECT-only is enforced by the caller's guard. */
export function selectWithIds(
  sql: string,
  table: string,
  catalog: TableSchema[],
  // Same OWNER-ISOLATION scope as the matching introspectSchema (see runGeneratedSelect).
  scope?: CatalogScope
): SqlRow[] {
  const idCol = idColumnFor(table, catalog);
  const db = getStore(scope);
  const rows = db.prepare(sql).all() as Record<string, unknown>[];
  return rows.map((data, i) => ({
    table,
    id: pickNumber(data[idCol]) ?? pickNumber(data["id"]) ?? pickNumber(data["rowid_anchor"]) ?? i + 1,
    data,
  }));
}

// ── small utilities ────────────────────────────────────────────────────────────

// Sanitize an arbitrary header / table name into a SAFE SQLite identifier, PRESERVING
// non-Latin letters (Hebrew, Arabic, CJK, …). We always quote identifiers when we emit
// SQL, so a quoted identifier may contain any character except a double-quote. The old
// version stripped EVERYTHING outside [A-Za-z0-9_], which annihilated a Hebrew table name
// like "שיבוצים-אוגוסט-2024-…" down to "_2024" — so every month's sheet collapsed to the
// same meaningless name (the planner couldn't tell August from June, and distinct sheets
// even COLLIDED and overwrote each other on materialize: the recorded "only 1 row for June"
// bug). Keeping Unicode word characters makes the name meaningful AND distinct again.
//
// What we still normalize: any RUN of characters that is whitespace/punctuation (i.e. not a
// Unicode letter, a digit, or `_`) becomes a single `_`; a double-quote is dropped (it would
// break our quoting); a leading digit is prefixed with `_` (so the identifier is valid even
// unquoted); leading/trailing `_` are trimmed. ASCII is lower-cased (case-insensitive match
// in the guard); non-cased scripts like Hebrew are unaffected by lower-casing. Empty → "col".
function sanitizeIdent(s: string): string {
  const cleaned = s
    .normalize("NFC")
    .trim()
    .replace(/"/g, "") // a double-quote would break our quoted-identifier emission
    .replace(/[^\p{L}\p{N}_]+/gu, "_") // collapse non-(letter|number|_) runs to one _
    .replace(/^_+|_+$/g, "")
    .replace(/^(\p{N})/u, "_$1") // can't start with a digit (valid even unquoted)
    .toLowerCase();
  return cleaned || "col";
}

// Deterministically map EACH uploaded table's original name → a UNIQUE safe SQLite
// identifier. De-collision is essential: two distinct uploaded sheets whose names sanitize
// to the SAME identifier (e.g. two Hebrew month sheets) must NOT share a materialized table,
// or one DROP/CREATE clobbers the other (the data-loss bug). We append _2, _3, … on a clash.
// Iteration order is the uploads map's insertion order, which is stable for a given scope, so
// materializeUploads and introspectSchema (which both call this on the SAME map) agree on the
// name of every table.
function buildSafeTableNames(uploads: Map<string, SqlRow[]>): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const original of uploads.keys()) {
    const base = sanitizeIdent(original);
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name);
    map.set(original, name);
  }
  return map;
}

function isNumeric(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "string") return false;
  const cleaned = v.replace(/[$,\s]/g, "");
  if (cleaned === "") return false;
  return Number.isFinite(Number(cleaned));
}

function pickNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Reset ALL cached per-scope handles (tests / hot-reload). */
export function resetStore(): void {
  for (const { db } of _handles.values()) {
    try { db.close(); } catch { /* noop */ }
  }
  _handles.clear();
}

/**
 * DURABLE REHYDRATION — the cold-start fix for the structured lane.
 *
 * better-sqlite3 (getStore/introspect/runGeneratedSelect) is SYNCHRONOUS, but the
 * durable rows live in Supabase (async). So this ASYNC step runs BEFORE the sync
 * introspect/query: it fetches the caller's durable uploaded rows (owner-scoped) and
 * loads them into the in-memory runtime store (owner-tagged), where the synchronous
 * materializer then picks them up. After a Vercel cold start the in-memory store is
 * empty, so without this the SQL lane has no uploaded tables — this repopulates it from
 * uploaded_rows so the router routes spreadsheet questions to "structured" and
 * text-to-SQL returns grounded, cited rows.
 *
 * OWNER ISOLATION: fetchUploadedRows is fail-closed (a non-admin with no owner id reads
 * NOTHING) and owner-scoped, so we only ever load the CALLER's rows into memory tagged
 * with their owner id — runtimeRows(scope) then filters to exactly that owner. A second
 * owner's hydrate loads only THEIR rows; neither sees the other's.
 *
 * FAIL-OPEN: any Supabase error degrades to "no durable rows loaded" (the warm in-memory
 * rows, if any, still answer) — it never throws into the answer pipeline. Idempotent:
 * re-hydrating clears this scope's in-memory copy of the reloaded tables first, so it
 * can't accumulate stale duplicates.
 *
 * Returns the number of rows hydrated (0 when Supabase is off, the caller is fail-closed,
 * or there are no durable rows for them).
 */
export async function hydrateUploadedTables(
  ownerId: string | undefined,
  isAdmin: boolean
): Promise<number> {
  // Fail-closed: never run an unscoped durable read that could pull another owner's rows.
  if (!canReadOwner(ownerId, isAdmin)) return 0;
  const durable = await fetchUploadedRows(ownerId, isAdmin);
  if (durable.length === 0) return 0;
  const scope: CatalogScope = { ownerId, isAdmin };
  // Drop this scope's in-memory copy of the tables we're reloading, so a warm process
  // that already held some of them doesn't end up with a stale + a fresh set.
  const tables = new Set(durable.map((r) => r.table));
  clearRuntimeRowsForTables(tables, scope);
  // Load the durable rows back into the runtime store, tagged with each row's TRUE owner
  // (from the durable store). For a member hydrate that owner IS the caller (the fetch was
  // owner-scoped); for an ADMIN hydrate each row keeps its real owner — so an admin's
  // hydrate never re-tags another user's rows as "shared" (which would leak them to
  // members via the null-owner visibility rule). runtimeRows(scope) then filters
  // correctly: the member sees only their own; the admin sees all.
  const rows: RuntimeSqlRow[] = durable.map((r) => ({
    table: r.table,
    id: r.rowId,
    data: r.data,
    owner: r.owner,
  }));
  addRuntimeRows(rows);
  // Force this scope's handle to rebuild on the next getStore (the upload signature
  // changed). Close just this scope's handle if present.
  const key = scopeKey(scope);
  const cached = _handles.get(key);
  if (cached) {
    try { cached.db.close(); } catch { /* noop */ }
    _handles.delete(key);
  }
  return rows.length;
}
