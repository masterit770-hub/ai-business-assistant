// Retrieval — the SQL side (structured) and the RAG side (documents).
// Both return EVIDENCE with stable citation anchors so the grounding layer can
// cite every fact. No join between the two — composition only.
import Database from "better-sqlite3";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cosineSim } from "./embeddings.ts";
import type { VectorIndex } from "./documents.ts";
import { TABLES } from "./schema.ts";

const ROOT = process.cwd();
const SQLITE = join(ROOT, "data-index", "contracts.sqlite");
const VECTORS = join(ROOT, "data-index", "vectors.json");

export type SqlRow = { table: string; id: number; data: Record<string, unknown> };
export type DocChunk = { doc: string; page: number; text: string; score: number };

// ── Singletons (the index is read-only + bundled) ───────────────────────────
let _db: Database.Database | null = null;
let _vectors: VectorIndex | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  if (!existsSync(SQLITE)) throw new Error("data-index/contracts.sqlite missing — run `npm run build:index`");
  // On serverless (Vercel) the bundled .sqlite is reachable via readFileSync
  // (it traces like a static asset), but better-sqlite3's read-only file-open of
  // that traced path fails ("unable to open database file"). Copy the bytes to
  // the writable /tmp and open from there — robust on Lambda and locally alike.
  const bytes = readFileSync(SQLITE);
  const tmpDir = join(tmpdir(), "contract-rag");
  mkdirSync(tmpDir, { recursive: true });
  const tmpDb = join(tmpDir, "contracts.sqlite");
  writeFileSync(tmpDb, bytes);
  _db = new Database(tmpDb, { readonly: true, fileMustExist: true });
  return _db;
}
export function getVectors(): VectorIndex {
  if (_vectors) return _vectors;
  if (!existsSync(VECTORS)) throw new Error("data-index/vectors.json missing — run `npm run build:index`");
  _vectors = JSON.parse(readFileSync(VECTORS, "utf8")) as VectorIndex;
  return _vectors;
}

const TABLE_NAMES = new Set(TABLES.map((t) => t.table));

/** Run a read-only SELECT and tag each row with its table + id (citation anchor). */
export function sqlSelect(table: string, sql: string, params: unknown[] = []): SqlRow[] {
  if (!TABLE_NAMES.has(table)) throw new Error(`unknown table: ${table}`);
  // Hard guard: only SELECT statements run against the read-only DB.
  if (!/^\s*select/i.test(sql)) throw new Error("only SELECT is allowed");
  const stmt = getDb().prepare(sql);
  const rows = stmt.all(...(params as any[])) as Record<string, unknown>[];
  return rows.map((r) => ({ table, id: Number(r.id), data: r }));
}

/** RAG: embed-free cosine search over the BUNDLED vector index (the Carter
 *  corpus — data-index/vectors.json). This is the verified local path for the
 *  bundled docs ONLY; user UPLOADS now live in Gemini File Search (see
 *  lib/engine/file-search.ts), not here. */
export function vectorSearch(queryEmbedding: number[], k = 5, docFilter?: string): DocChunk[] {
  const idx = getVectors();
  const scored = idx.records
    .filter((r) => !docFilter || r.doc === docFilter)
    .map((r) => ({ doc: r.doc, page: r.page, text: r.text, score: cosineSim(queryEmbedding, r.embedding) }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** Data-quality report (surfaced honestly in the UI). `table` is a reserved word,
 *  so the alias is double-quoted. */
export function loadReport(): { table: string; rows: number; malformed_cells: number }[] {
  return getDb()
    .prepare(`SELECT table_name as "table", rows, malformed_cells FROM _load_report`)
    .all() as any;
}
