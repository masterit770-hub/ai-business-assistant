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
import { runtimeRows } from "./runtime-store.ts";
import type { TableSchema } from "./sql-guard.ts";
import { validateGeneratedSql, type SqlGuardResult } from "./sql-guard.ts";
import { deletedSourceIds } from "./deleted-sources.ts";

const ROOT = process.cwd();
const SQLITE = join(ROOT, "data-index", "contracts.sqlite");

export type SqlRow = { table: string; id: number; data: Record<string, unknown> };

// Internal columns the catalog hides (load bookkeeping) so the model never sees /
// queries them. They still exist physically; we just don't advertise them, and the
// guard's allow-list omits them too.
const HIDDEN_COLUMNS = new Set(["__malformed"]);
const HIDDEN_TABLES = new Set(["_load_report", "sqlite_sequence"]);

// A signature of which uploaded tables are materialized into the current handle, so a
// new upload (changing the set) forces a rebuild. Bundled tables are static.
let _db: Database.Database | null = null;
let _materializedSig = "";

/**
 * The shared read-only-discipline handle. Opened read-WRITE only to materialize
 * uploaded rows; all MODEL queries go through runSelect()/the guard (SELECT-only).
 * Rebuilt when the set of uploaded tables changes (a new CSV/XLSX upload).
 */
export function getStore(): Database.Database {
  const uploads = runtimeRows();
  const sig = uploadSignature(uploads);
  if (_db && sig === _materializedSig) return _db;
  // (Re)build: fresh writable copy of the bundled DB + materialize current uploads.
  if (_db) {
    try { _db.close(); } catch { /* already closed */ }
    _db = null;
  }
  _db = openWritableBundled();
  materializeUploads(_db, uploads);
  _materializedSig = sig;
  return _db;
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
  for (const [table, rows] of uploads) {
    if (rows.length === 0) continue;
    const safeTable = sanitizeIdent(table);
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
export function introspectSchema(sampleRows = 3): {
  catalog: TableSchema[];
  samples: Map<string, Record<string, unknown>[]>;
} {
  const db = getStore();
  // Workspace-level soft-delete: a bundled table an admin hid (recorded in
  // deleted_sources) is dropped from the catalog the planner + SQL guard consume, so
  // text-to-SQL can neither plan nor query it → it never appears in an answer. Empty
  // set (nothing hidden / Supabase off) → identical to the prior catalog.
  const hidden = deletedSourceIds();
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .filter((t) => !HIDDEN_TABLES.has(t) && !t.startsWith("sqlite_") && !hidden.has(t));

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
  catalog: TableSchema[]
): RunResult {
  const guard: SqlGuardResult = validateGeneratedSql(rawSql, catalog);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  const idCol = idColumnFor(primaryTable, catalog);
  try {
    const db = getStore();
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
  catalog: TableSchema[]
): SqlRow[] {
  const idCol = idColumnFor(table, catalog);
  const db = getStore();
  const rows = db.prepare(sql).all() as Record<string, unknown>[];
  return rows.map((data, i) => ({
    table,
    id: pickNumber(data[idCol]) ?? pickNumber(data["id"]) ?? pickNumber(data["rowid_anchor"]) ?? i + 1,
    data,
  }));
}

// ── small utilities ────────────────────────────────────────────────────────────

function sanitizeIdent(s: string): string {
  const cleaned = s
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "_$1") // can't start with a digit
    .toLowerCase();
  return cleaned || "col";
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

/** Reset the cached handle (tests / hot-reload). */
export function resetStore(): void {
  if (_db) { try { _db.close(); } catch { /* noop */ } }
  _db = null;
  _materializedSig = "";
}
