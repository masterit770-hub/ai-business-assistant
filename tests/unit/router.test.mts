import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePlan, guardEmptyCatalogs } from "../../src/lib/engine/router.ts";

// The router's LLM call is integration-tested by the journey suite. Here we pin the
// PURE plan-normalization contract: only valid sources kept, safe defaults. (The
// router no longer carries hand-written intents — table selection + SQL generation is
// the text-to-SQL lane's job, off the live schema — so there is no intent contract.)

test("keeps only valid source values", () => {
  const p = normalizePlan({
    sources: ["structured", "elsewhere"],
    docFilter: null,
    rationale: "x",
  });
  assert.deepEqual(p.sources, ["structured"]);
});

test("keeps both sources for a hybrid question", () => {
  const p = normalizePlan({
    sources: ["structured", "documents"],
    docFilter: "family-court",
    rationale: "spans both",
  });
  assert.deepEqual(p.sources.sort(), ["documents", "structured"]);
  assert.equal(p.docFilter, "family-court");
});

test("a DELIBERATE empty sources array is HONORED (no retrieval) — a greeting/pure-general question", () => {
  // The router prompt instructs the model to return an empty `sources` array when
  // NEITHER source is relevant. That is a real decision (skip retrieval, answer from
  // general knowledge) and must NOT be silently overridden to query both — otherwise a
  // greeting retrieves passages the router said it didn't need (an incoherent trace).
  const p = normalizePlan({ sources: [], docFilter: 5, rationale: 7 });
  assert.deepEqual(p.sources, []);
  assert.equal(p.docFilter, null);
  assert.equal(p.rationale, "");
});

test("a MALFORMED plan (no usable sources field) degrades to querying all sources", () => {
  // No `sources` field at all → we can't tell what the model wanted → query both and
  // let relevance decide (the safe fallback). Same for a non-array `sources`.
  assert.deepEqual(normalizePlan({ docFilter: null, rationale: "x" }).sources.sort(), [
    "documents",
    "structured",
  ]);
  assert.deepEqual(normalizePlan({ sources: "documents" }).sources.sort(), [
    "documents",
    "structured",
  ]);
});

test("a non-empty but all-garbage sources array degrades to querying all sources", () => {
  // The model tried to pick something but named nothing valid → treat as malformed.
  assert.deepEqual(normalizePlan({ sources: ["nope", "elsewhere"] }).sources.sort(), [
    "documents",
    "structured",
  ]);
});

test("a non-string docFilter is normalized to null", () => {
  const p = normalizePlan({ sources: ["documents"], docFilter: 12, rationale: "x" });
  assert.equal(p.docFilter, null);
});

// ── guardEmptyCatalogs: the deterministic no-hallucinated-source net (RED #3) ──────
// Independent of the LLM: a source whose catalog is empty for this caller is dropped,
// so the router can never route to "documents"/"structured" the caller cannot access.

test("guard DROPS 'documents' when the caller has NO accessible documents", () => {
  // The recorded RED #3: a non-demo owner with only a table; the model guessed
  // ["documents"]. The guard must strip it → empty (no hallucinated source).
  const p = guardEmptyCatalogs(
    { sources: ["documents"], docFilter: "castle", rationale: "guessed" },
    /* hasAccessibleDocs */ false,
    /* hasAccessibleTables */ true
  );
  assert.deepEqual(p.sources, []);
  assert.equal(p.docFilter, null, "docFilter is cleared when documents is dropped");
});

test("guard DROPS 'structured' when there are no tables, keeping a valid 'documents'", () => {
  const p = guardEmptyCatalogs(
    { sources: ["structured", "documents"], docFilter: null, rationale: "x" },
    /* hasAccessibleDocs */ true,
    /* hasAccessibleTables */ false
  );
  assert.deepEqual(p.sources, ["documents"]);
});

test("guard DROPS both when both catalogs are empty → empty route", () => {
  const p = guardEmptyCatalogs(
    { sources: ["structured", "documents"], docFilter: null, rationale: "x" },
    false,
    false
  );
  assert.deepEqual(p.sources, []);
});

test("guard is a NO-OP when every chosen source is accessible", () => {
  const plan = { sources: ["documents"] as ("structured" | "documents")[], docFilter: "d1", rationale: "ok" };
  const p = guardEmptyCatalogs(plan, true, true);
  assert.equal(p, plan, "returns the same plan object unchanged when nothing is dropped");
});

test("guard leaves an already-empty route empty (a greeting stays empty)", () => {
  const p = guardEmptyCatalogs({ sources: [], docFilter: null, rationale: "greeting" }, true, true);
  assert.deepEqual(p.sources, []);
});
