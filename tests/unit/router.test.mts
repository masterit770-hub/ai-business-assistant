import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePlan } from "../../src/lib/engine/router.ts";

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

test("empty/garbage plan degrades to querying all sources", () => {
  const p = normalizePlan({ sources: [], docFilter: 5, rationale: 7 });
  assert.deepEqual(p.sources.sort(), ["documents", "structured"]);
  assert.equal(p.docFilter, null);
  assert.equal(p.rationale, "");
});

test("a non-string docFilter is normalized to null", () => {
  const p = normalizePlan({ sources: ["documents"], docFilter: 12, rationale: "x" });
  assert.equal(p.docFilter, null);
});
