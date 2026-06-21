// Retrieval — the SQL side (structured) and the RAG side (documents).
// Both return EVIDENCE with stable citation anchors so the grounding layer can
// cite every fact. No join between the two — composition only.
import Database from "better-sqlite3";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cosineSim } from "./embeddings.ts";
import type { VectorIndex } from "./documents.ts";
import { deletedSourceIds } from "./deleted-sources.ts";
import { bm25Scores, ranksFromScores, reciprocalRankFusion } from "./hybrid.ts";

const ROOT = process.cwd();
const SQLITE = join(ROOT, "data-index", "contracts.sqlite");
const VECTORS = join(ROOT, "data-index", "vectors.json");

export type SqlRow = { table: string; id: number; data: Record<string, unknown> };
// A retrieved document chunk. `score` is the headline relevance (the RRF fused score
// for a hybrid result; cosine similarity for a legacy dense-only result) so existing
// sort/threshold/confidence code keeps working unchanged. The optional hybrid fields
// carry the REAL per-lane ranks + fused score so the inspector shows honest
// dense / BM25 / RRF numbers. They're undefined only on a pure-dense legacy path.
export type DocChunk = {
  doc: string;
  page: number;
  text: string;
  score: number;
  // Hybrid retrieval breakdown (dense × BM25 → RRF). Present on every hybrid result
  // (bundled in-process AND uploaded via pgvector). A rank of 0 = "that lane did not
  // rank this chunk" (e.g. no lexical/keyword overlap → no BM25 rank).
  denseRank?: number;
  bm25Rank?: number;
  rrfScore?: number;
  // The raw DENSE cosine similarity (0..1) for this chunk — kept ONLY on the bundled
  // in-process lane (where we have the vectors) to drive the confidence signal on the
  // existing cosine scale. Not surfaced by the uploaded lane (the SQL RPC returns
  // ranks, not raw cosine), so the inspector relies on ranks, not this.
  denseScore?: number;
};

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

/** RAG: embed-free cosine search over the BUNDLED vector index (the Carter
 *  corpus — data-index/vectors.json). This is the verified local path for the
 *  bundled docs ONLY; user UPLOADS now live in Gemini File Search (see
 *  lib/engine/file-search.ts), not here. */
export function vectorSearch(queryEmbedding: number[], k = 5, docFilter?: string): DocChunk[] {
  const idx = getVectors();
  // Workspace-level soft-delete: a bundled doc an admin hid (recorded in
  // deleted_sources, snapshotted by refreshDeletedSources at the top of the request)
  // is excluded so it never appears in an answer. Empty set (nothing hidden, or
  // Supabase off) → identical to the prior behavior.
  const hidden = deletedSourceIds();
  const scored = idx.records
    .filter((r) => !hidden.has(r.doc))
    .filter((r) => !docFilter || r.doc === docFilter)
    .map((r) => ({ doc: r.doc, page: r.page, text: r.text, score: cosineSim(queryEmbedding, r.embedding) }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** HYBRID RAG over the BUNDLED vector index (the Carter corpus — vectors.json),
 *  done IN-PROCESS so it matches the uploaded-doc pgvector lane: a DENSE cosine
 *  ranking × a LEXICAL BM25 ranking, fused with the SAME Reciprocal Rank Fusion
 *  (k=60) the SQL `hybrid_match` RPC uses. Returns DocChunks carrying the REAL
 *  per-chunk dense rank, BM25 rank, and RRF score so the inspector shows honest
 *  hybrid numbers for bundled docs exactly as it does for uploaded ones.
 *
 *  `queryText` is the raw question (drives the lexical lane); `queryEmbedding` is
 *  its e5 query vector (drives the dense lane). The candidate set is the full
 *  bundled corpus (minus admin-hidden docs / an optional docFilter); both lanes
 *  rank that same set, then RRF fuses + truncates to top-k. */
export function hybridVectorSearch(
  queryEmbedding: number[],
  queryText: string,
  k = 8,
  docFilter?: string
): DocChunk[] {
  const idx = getVectors();
  const hidden = deletedSourceIds();
  // The shared candidate set both lanes rank (stable order → ranks line up 1:1).
  const candidates = idx.records
    .filter((r) => !hidden.has(r.doc))
    .filter((r) => !docFilter || r.doc === docFilter);
  if (candidates.length === 0) return [];

  // DENSE lane — cosine similarity; higher = better → rank 1 is the nearest.
  const denseScores = candidates.map((r) => cosineSim(queryEmbedding, r.embedding));
  const denseRanks = ranksFromScores(denseScores);

  // LEXICAL lane — BM25 over the chunk texts. A chunk with no query-term overlap
  // scores 0 → rank 0 (unranked) so it contributes nothing to its RRF, mirroring the
  // SQL lane where a non-matching row simply has no bm25_rank.
  const bmScores = bm25Scores(queryText, candidates.map((r) => r.text));
  const bm25Ranks = ranksFromScores(bmScores, { zeroIsUnranked: true });

  // FUSE — Reciprocal Rank Fusion (same k=60 as hybrid_match). Sorted by RRF desc.
  const fused = reciprocalRankFusion(denseRanks, bm25Ranks);
  return fused.slice(0, k).map((f) => {
    const r = candidates[f.index];
    return {
      doc: r.doc,
      page: r.page,
      text: r.text,
      // The headline score IS the fused RRF score (what the result is ranked by), so
      // downstream sort/threshold/confidence stay consistent with the uploaded lane.
      score: f.rrf,
      denseRank: f.denseRank,
      bm25Rank: f.bm25Rank,
      rrfScore: f.rrf,
      // The raw cosine (0..1) carried through for the confidence signal.
      denseScore: denseScores[f.index],
    };
  });
}

/** Data-quality report (surfaced honestly in the UI). `table` is a reserved word,
 *  so the alias is double-quoted. */
export function loadReport(): { table: string; rows: number; malformed_cells: number }[] {
  return getDb()
    .prepare(`SELECT table_name as "table", rows, malformed_cells FROM _load_report`)
    .all() as any;
}
