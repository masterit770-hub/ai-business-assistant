// Hybrid retrieval fusion — the SHARED math behind BOTH document lanes.
//
// The target (the client's reference UI): document retrieval is a HYBRID of a DENSE
// (vector/cosine) ranking and a LEXICAL (BM25-style keyword) ranking, fused with
// Reciprocal Rank Fusion (RRF). The inspector shows the REAL per-chunk dense rank,
// BM25 rank, and RRF score — never a fabricated label.
//
// This module is the single source of truth for that fusion so the two lanes agree:
//   • UPLOADED docs → Supabase pgvector. The dense + BM25 rankings + RRF are computed
//     in SQL (migration 006's hybrid_match RPC). This module is NOT used there; the
//     SQL mirrors the SAME formula (k=60) so the numbers are comparable.
//   • BUNDLED docs (static vectors.json) → the SAME hybrid IN-PROCESS, using exactly
//     these functions: cosine for the dense ranking, bm25Scores for the lexical
//     ranking, and reciprocalRankFusion to fuse them.
//
// Pure + dependency-free so the fusion math, the BM25 scorer, and the tokenizer are
// all unit-tested directly (no DB, no model).

// RRF's smoothing constant. The standard value from Cormack et al. (2009); the SQL
// RPC uses the SAME 60 so an uploaded-doc RRF score is on the same scale as a
// bundled-doc one. A larger k flattens the contribution of top ranks.
export const RRF_K = 60;

// ── Lexical tokenizer ───────────────────────────────────────────────────────────
// Lowercase, split on any non-alphanumeric run (Unicode-aware so Hebrew/accented
// text tokenizes too), drop empties. Deliberately simple + matches the SPIRIT of
// Postgres `to_tsvector('simple', …)` on the SQL side (no stemming, no stop-list):
// 'simple' does no language stemming either, so the two lanes tokenize comparably.
export function lexTokens(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

// ── BM25 lexical scorer ───────────────────────────────────────────────────────────
// Okapi BM25 over a small in-memory corpus (the bundled chunk texts). Returns a raw
// BM25 score per document — only its RANK feeds RRF, so the absolute scale doesn't
// matter, but a real BM25 (IDF × saturating TF, length-normalized) ranks keyword
// matches the way the reference UI's lexical lane does. Standard params k1=1.5, b=0.75.
//
// `query` is the raw question; `docs` are the candidate chunk texts in a STABLE order
// (the returned scores are 1:1 with `docs` by index). A document with no query-term
// overlap scores 0 (so it never out-ranks a real lexical match by accident).
export function bm25Scores(query: string, docs: string[], k1 = 1.5, b = 0.75): number[] {
  const N = docs.length;
  if (N === 0) return [];
  const docTokens = docs.map(lexTokens);
  const docLen = docTokens.map((t) => t.length);
  const avgdl = docLen.reduce((s, l) => s + l, 0) / N || 1;

  // Per-document term frequencies.
  const tf: Map<string, number>[] = docTokens.map((tokens) => {
    const m = new Map<string, number>();
    for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });

  // Document frequency per query term (how many docs contain it) → IDF.
  const qTerms = [...new Set(lexTokens(query))];
  const df = new Map<string, number>();
  for (const term of qTerms) {
    let n = 0;
    for (const m of tf) if (m.has(term)) n++;
    df.set(term, n);
  }

  const scores = new Array<number>(N).fill(0);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (const term of qTerms) {
      const f = tf[i].get(term) ?? 0;
      if (f === 0) continue;
      const n = df.get(term) ?? 0;
      // BM25 IDF with the +1 inside the log so it's always ≥ 0 (never negative for a
      // term in >half the corpus — keeps a match from ever lowering a score).
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const denom = f + k1 * (1 - b + (b * docLen[i]) / avgdl);
      s += idf * ((f * (k1 + 1)) / denom);
    }
    scores[i] = s;
  }
  return scores;
}

// ── Ranking helper ──────────────────────────────────────────────────────────────
// Turn a parallel score array into a 1-based rank per index (highest score = rank 1).
// Ties get consecutive ranks in input order (stable). An item that should not be
// ranked at all (e.g. BM25 score 0 — no lexical overlap) gets rank 0 → it contributes
// NOTHING to RRF (0 is treated as "unranked" by reciprocalRankFusion). This matches
// the SQL side, where a row absent from a lexical-match CTE has no bm25_rank.
export function ranksFromScores(scores: number[], opts: { zeroIsUnranked?: boolean } = {}): number[] {
  const { zeroIsUnranked = false } = opts;
  const order = scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const ranks = new Array<number>(scores.length).fill(0);
  let rank = 0;
  for (const { score, index } of order) {
    rank++;
    ranks[index] = zeroIsUnranked && score <= 0 ? 0 : rank;
  }
  return ranks;
}

// ── Reciprocal Rank Fusion ─────────────────────────────────────────────────────────
// rrf(d) = Σ_lanes 1/(k + rank_lane(d)). A rank of 0 means "this lane did not rank the
// document" → that lane contributes 0 for it (NOT 1/(k+0)). This is the exact formula
// the SQL hybrid_match RPC computes, with the same k=RRF_K, so an uploaded-doc RRF and
// a bundled-doc RRF are directly comparable.
export function rrfScore(ranks: number[], k = RRF_K): number {
  let s = 0;
  for (const r of ranks) if (r > 0) s += 1 / (k + r);
  return s;
}

// One candidate's fused result: its rank in each lane + the fused RRF score. `denseRank`
// and `bm25Rank` are the REAL per-lane ranks the inspector shows; `rrf` is the fused
// score it sorts + displays. 0 ranks mean "not ranked by that lane".
export type FusedRank = { index: number; denseRank: number; bm25Rank: number; rrf: number };

// Fuse two parallel rank arrays (dense + bm25, both 1:1 with the same candidate list)
// into per-candidate FusedRank rows, sorted by RRF score desc. This is the in-process
// twin of the SQL RPC: same inputs (two rankings), same output (dense/bm25/rrf per row).
export function reciprocalRankFusion(
  denseRanks: number[],
  bm25Ranks: number[],
  k = RRF_K
): FusedRank[] {
  const n = Math.max(denseRanks.length, bm25Ranks.length);
  const out: FusedRank[] = [];
  for (let i = 0; i < n; i++) {
    const denseRank = denseRanks[i] ?? 0;
    const bm25Rank = bm25Ranks[i] ?? 0;
    out.push({ index: i, denseRank, bm25Rank, rrf: rrfScore([denseRank, bm25Rank], k) });
  }
  return out.sort((a, b) => b.rrf - a.rrf || a.index - b.index);
}
