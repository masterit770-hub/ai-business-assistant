import { test } from "node:test";
import assert from "node:assert/strict";
import { hybridVectorSearch } from "../../src/lib/engine/retrieval.ts";
import { getVectors } from "../../src/lib/engine/retrieval.ts";

// The bundled lane does the SAME hybrid (dense × BM25 → RRF) IN-PROCESS as the uploaded
// pgvector lane. These tests drive the REAL hybridVectorSearch over the REAL bundled
// index (data-index/vectors.json) — no mocks, no model: we use a bundled record's OWN
// 384-dim embedding as the query vector (so the dense lane has a guaranteed top match),
// and the bundled record's own text words as the lexical query.

const idx = getVectors();
const sample = idx.records[0]; // a real Carter chunk with a real 384-dim embedding

test("bundled hybrid returns DocChunks carrying REAL dense / BM25 / RRF fields", () => {
  // Query with the sample's own embedding + a couple of its own words → both lanes hit.
  const queryText = sample.text.split(/\s+/).slice(0, 4).join(" ");
  const out = hybridVectorSearch(sample.embedding, queryText, 8);
  assert.ok(out.length > 0, "hybrid search should return chunks");
  for (const c of out) {
    assert.equal(typeof c.doc, "string");
    assert.equal(typeof c.page, "number");
    // Every hybrid result carries the real breakdown the inspector shows.
    assert.equal(typeof c.denseRank, "number");
    assert.equal(typeof c.bm25Rank, "number");
    assert.equal(typeof c.rrfScore, "number");
    // The headline score IS the fused RRF score (what it's ranked by).
    assert.equal(c.score, c.rrfScore);
  }
});

test("results are sorted by RRF score (descending)", () => {
  const queryText = sample.text.split(/\s+/).slice(0, 6).join(" ");
  const out = hybridVectorSearch(sample.embedding, queryText, 8);
  for (let i = 1; i < out.length; i++) {
    assert.ok(
      (out[i - 1].rrfScore ?? 0) >= (out[i].rrfScore ?? 0),
      "each chunk's RRF score must be >= the next one's"
    );
  }
});

test("the dense lane ranks the query's own chunk #1 (cosine self-match)", () => {
  // Querying by a chunk's own vector → that chunk is the nearest (dense rank 1) and its
  // denseScore is ~1.0 (cosine of a vector with itself, e5 L2-normalized).
  const out = hybridVectorSearch(sample.embedding, "zzzznonsensezzz", 12); // no lexical hits
  const self = out.find((c) => c.doc === sample.doc && c.page === sample.page);
  assert.ok(self, "the query's own chunk should be retrieved");
  assert.equal(self!.denseRank, 1, "its dense (cosine) rank is 1");
  assert.ok((self!.denseScore ?? 0) > 0.99, "its cosine self-similarity is ~1.0");
});

test("a query with NO lexical overlap leaves every chunk's BM25 rank at 0 (dense-only)", () => {
  // A made-up token that appears in no bundled chunk → the lexical lane ranks nothing,
  // so RRF reduces to the dense contribution alone (bm25Rank 0 on every result).
  const out = hybridVectorSearch(sample.embedding, "qwxzqwxz nonsensetoken", 8);
  assert.ok(out.length > 0);
  for (const c of out) assert.equal(c.bm25Rank, 0, "no keyword overlap → no BM25 rank");
});

test("a lexically-matching query produces at least one non-zero BM25 rank", () => {
  // Pull a distinctive word from the sample chunk → the lexical lane must rank a chunk.
  const word =
    sample.text
      .split(/[^\p{L}\p{N}]+/u)
      .find((w) => w.length >= 6) ?? sample.text.split(/\s+/)[0];
  const out = hybridVectorSearch(sample.embedding, word, 12);
  assert.ok(
    out.some((c) => (c.bm25Rank ?? 0) > 0),
    `the keyword "${word}" should give some chunk a BM25 rank`
  );
});

test("a docFilter restricts the candidate set to that doc only", () => {
  const out = hybridVectorSearch(sample.embedding, sample.text.slice(0, 30), 12, sample.doc);
  assert.ok(out.length > 0);
  for (const c of out) assert.equal(c.doc, sample.doc);
});
