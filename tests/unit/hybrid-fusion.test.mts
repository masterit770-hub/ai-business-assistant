import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RRF_K,
  lexTokens,
  bm25Scores,
  ranksFromScores,
  rrfScore,
  reciprocalRankFusion,
} from "../../src/lib/engine/hybrid.ts";

// The fusion math is the HEART of the hybrid retrieval (dense × BM25 → RRF). These
// tests pin the EXACT formula the engine computes — the same k=60 the SQL hybrid_match
// RPC uses — so the inspector's RRF numbers are verifiable, not hand-waved.

// ── RRF constant ──────────────────────────────────────────────────────────────
test("RRF_K is 60 (the standard constant, shared with the SQL RPC)", () => {
  assert.equal(RRF_K, 60);
});

// ── rrfScore: 1/(k+rank) summed across lanes, 0-rank = unranked = no contribution ──
test("rrfScore sums 1/(60+rank) across the lanes that ranked the item", () => {
  // dense rank 1 + bm25 rank 1 → 1/61 + 1/61.
  assert.ok(Math.abs(rrfScore([1, 1]) - (1 / 61 + 1 / 61)) < 1e-12);
  // dense rank 2 + bm25 rank 5 → 1/62 + 1/65.
  assert.ok(Math.abs(rrfScore([2, 5]) - (1 / 62 + 1 / 65)) < 1e-12);
});

test("a rank of 0 means 'this lane did not rank it' → contributes 0 (NOT 1/(60+0))", () => {
  // Only the dense lane ranked it (bm25 rank 0) → just 1/61.
  assert.ok(Math.abs(rrfScore([1, 0]) - 1 / 61) < 1e-12);
  // Neither lane ranked it → 0.
  assert.equal(rrfScore([0, 0]), 0);
});

test("a custom k changes the smoothing as expected", () => {
  assert.ok(Math.abs(rrfScore([1, 1], 10) - (1 / 11 + 1 / 11)) < 1e-12);
});

// ── ranksFromScores: highest score → rank 1, ties stable, 0 optionally unranked ──
test("ranksFromScores assigns rank 1 to the highest score (1-based)", () => {
  // scores by index: [0.2, 0.9, 0.5] → ranks: [3, 1, 2].
  assert.deepEqual(ranksFromScores([0.2, 0.9, 0.5]), [3, 1, 2]);
});

test("ties are ranked in input order (stable)", () => {
  // equal scores → consecutive ranks in index order.
  assert.deepEqual(ranksFromScores([0.5, 0.5, 0.5]), [1, 2, 3]);
});

test("zeroIsUnranked maps a 0 (or negative) score to rank 0 (unranked)", () => {
  // index 1 has score 0 → rank 0 (it gets no lexical rank, like a non-matching row).
  assert.deepEqual(ranksFromScores([0.8, 0, 0.3], { zeroIsUnranked: true }), [1, 0, 2]);
});

// ── reciprocalRankFusion: fuse two parallel rank arrays into sorted FusedRank rows ──
test("reciprocalRankFusion fuses dense + bm25 ranks and sorts by RRF desc", () => {
  // 3 candidates. dense ranks [1,2,3]; bm25 ranks [3,1,0] (cand 2 unranked lexically).
  const fused = reciprocalRankFusion([1, 2, 3], [3, 1, 0]);
  // Candidate 1 (index 1): dense#2 + bm25#1 = 1/62 + 1/61  (the strongest fusion)
  // Candidate 0 (index 0): dense#1 + bm25#3 = 1/61 + 1/63
  // Candidate 2 (index 2): dense#3 + bm25#0 = 1/63 + 0      (the weakest)
  assert.equal(fused[0].index, 1);
  assert.equal(fused[2].index, 2);
  // The real per-lane ranks are carried through verbatim.
  assert.equal(fused[0].denseRank, 2);
  assert.equal(fused[0].bm25Rank, 1);
  assert.ok(Math.abs(fused[0].rrf - (1 / 62 + 1 / 61)) < 1e-12);
  // The unranked-lexical candidate keeps bm25Rank 0 and a dense-only RRF.
  const cand2 = fused.find((f) => f.index === 2)!;
  assert.equal(cand2.bm25Rank, 0);
  assert.ok(Math.abs(cand2.rrf - 1 / 63) < 1e-12);
});

// ── lexTokens: lowercase, Unicode-aware split (Hebrew included), drop empties ──
test("lexTokens lowercases and splits on non-alphanumerics", () => {
  assert.deepEqual(lexTokens("Annual Cost: $48,000!"), ["annual", "cost", "48", "000"]);
});

test("lexTokens keeps Hebrew (Unicode) tokens — the multilingual seam", () => {
  const toks = lexTokens("מזונות ילדים child support");
  assert.deepEqual(toks, ["מזונות", "ילדים", "child", "support"]);
});

// ── bm25Scores: real Okapi BM25 — keyword overlap ranks higher; no overlap = 0 ──
test("bm25Scores ranks the doc with the query term above one without it", () => {
  const docs = [
    "the custody arrangement grants primary residence to the petitioner",
    "the annual maintenance cost of the facility contract",
  ];
  const scores = bm25Scores("custody petitioner", docs);
  assert.ok(scores[0] > scores[1], "the custody passage should out-score the unrelated one");
  assert.equal(scores[1], 0, "a doc with no query-term overlap scores exactly 0");
});

test("bm25Scores over an empty corpus is an empty array (no crash)", () => {
  assert.deepEqual(bm25Scores("anything", []), []);
});

test("bm25 rewards rarer terms (IDF): a term in fewer docs lifts its doc more", () => {
  const docs = [
    "alimony alimony alimony",       // contains the rare query term
    "contract contract contract",    // common filler
    "contract contract contract",
    "contract contract contract",
  ];
  const scores = bm25Scores("alimony", docs);
  assert.ok(scores[0] > 0);
  assert.equal(scores[1], 0);
});
