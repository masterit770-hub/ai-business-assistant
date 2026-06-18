import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePlan } from "../../src/lib/engine/router.ts";

// The router's LLM call is integration-tested by the journey suite. Here we pin
// the PURE plan-normalization contract: invalid intents dropped, coherence
// enforced, safe defaults.

test("drops unknown intents, keeps valid ones", () => {
  const p = normalizePlan({
    sources: ["structured"],
    intents: [{ name: "contracts_expiring", params: { days: 90 } }, { name: "made_up" }],
    docFilter: null,
    rationale: "x",
  });
  assert.deepEqual(
    p.intents.map((i) => i.name),
    ["contracts_expiring"]
  );
});

test("coherence: a structured intent forces 'structured' into sources", () => {
  const p = normalizePlan({
    sources: ["documents"],
    intents: [{ name: "contracts_expiring", params: {} }],
    docFilter: null,
    rationale: "x",
  });
  assert.ok(p.sources.includes("structured"));
});

test("empty/garbage plan degrades to querying all sources", () => {
  const p = normalizePlan({ sources: [], intents: [], docFilter: 5, rationale: 7 });
  assert.deepEqual(p.sources.sort(), ["documents", "structured"]);
  assert.equal(p.docFilter, null);
  assert.equal(p.rationale, "");
});

test("invalid source values are filtered out", () => {
  const p = normalizePlan({
    sources: ["structured", "elsewhere"],
    intents: [],
    docFilter: null,
    rationale: "x",
  });
  assert.deepEqual(p.sources, ["structured"]);
});
