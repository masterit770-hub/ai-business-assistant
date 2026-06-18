import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAnswer } from "../../src/lib/engine/validate-answer.ts";
import { sqlToken, pdfToken } from "../../src/lib/engine/citations.ts";

// Evidence fixtures mirroring real golden retrievals.
const contractEvidence = {
  rows: [
    { table: "contracts", id: 12 },
    { table: "contracts", id: 47 },
  ],
  chunks: [],
};
const courtEvidence = {
  rows: [],
  chunks: [{ doc: "family-court", page: 14 }],
};

// ── GOLDEN answers MUST pass ────────────────────────────────────────────────

test("golden: cited contract answer passes", () => {
  const a = `Two contracts expire within 90 days: contract #12 ${sqlToken(
    "contracts",
    12
  )} and contract #47 ${sqlToken("contracts", 47)}.`;
  const r = validateAnswer(a, contractEvidence);
  assert.equal(r.ok, true, r.reasons.join("; "));
});

test("golden: page-cited court answer passes", () => {
  const a = `The court awarded joint custody and set child support at $1,285/month ${pdfToken(
    "family-court",
    14
  )}.`;
  const r = validateAnswer(a, courtEvidence);
  assert.equal(r.ok, true, r.reasons.join("; "));
});

test("golden: honest 'not in sources' answer passes (no uncited claim)", () => {
  const a =
    "Penalty terms are not present in the available contract sources, which contain only vendor, dates, and annual cost.";
  const r = validateAnswer(a, contractEvidence);
  assert.equal(r.ok, true, r.reasons.join("; "));
});

// ── TOY / bad answers MUST fail ─────────────────────────────────────────────

test("toy: fluent but uncited factual answer is rejected", () => {
  const a =
    "Several contracts are expiring soon and the court ordered child support of $1,285 per month.";
  const r = validateAnswer(a, contractEvidence);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /no citations|ungrounded/i);
});

test("toy: fabricated citation (row not retrieved) is rejected", () => {
  const a = `Contract #999 expires next week ${sqlToken("contracts", 999)}.`;
  const r = validateAnswer(a, contractEvidence);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unresolved, [sqlToken("contracts", 999)]);
});

test("toy: PDF citation cannot stand in for missing SQL evidence", () => {
  // Claims a contract fact but only cites a court page that wasn't even retrieved here.
  const a = `Contract #12 has a penalty clause ${pdfToken("family-court", 14)}.`;
  const r = validateAnswer(a, contractEvidence); // court chunk NOT in evidence
  assert.equal(r.ok, false);
  assert.deepEqual(r.unresolved, [pdfToken("family-court", 14)]);
});
