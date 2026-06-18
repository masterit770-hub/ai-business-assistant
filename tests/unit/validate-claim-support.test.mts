import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAnswer, type Evidence } from "../../src/lib/engine/validate-answer.ts";
import { sqlToken, pdfToken } from "../../src/lib/engine/citations.ts";

// Claim-support cross-check (validateAnswer rule 4).
//
// These are RED-PROBE tests: each "fabricated" case MUST be rejected by the
// cross-check and would PASS the old resolvability-only gate (the citation
// resolves, but the number it carries is not backed by the cited evidence). The
// matching "honest" case — same shape, a number the row/page actually supports —
// MUST pass, so the gate is discriminating, not just strict.

// ── Evidence fixtures carrying real values (the cross-check only runs with these) ──
const contractEvidence: Evidence = {
  rows: [
    // The real row 269: annual cost 25,629.50 (NOT 999,999).
    { table: "contracts", id: 269, data: { id: 269, vendor: "Skalith", annual_cost: 25629.5 } },
  ],
  chunks: [],
  aggregates: [],
};

const familyCourtEvidence: Evidence = {
  rows: [],
  chunks: [
    // Page 24 of the court file says child support is $1,285 (NOT $5,000).
    {
      doc: "family-court",
      page: 24,
      text: "Final Judgment. The court orders child support of $1,285 per month, payable to Joni Carter.",
    },
  ],
  aggregates: [],
};

const carterStoryEvidence: Evidence = {
  rows: [],
  chunks: [
    // The $1,285 figure lives in family-court, NOT in carter-story.
    {
      doc: "carter-story",
      page: 7,
      text: "Joni recounts the long road to the divorce and the strain it placed on the family.",
    },
    { doc: "family-court", page: 24, text: "child support of $1,285 per month" },
  ],
  aggregates: [],
};

// ── RED PROBES — fabricated figure hung on a resolving citation MUST be rejected ──

test("RED: $999,999.00 [S:contracts#269] — wrong value, citation resolves but row says $25,629.50", () => {
  const a = `The Skalith contract is worth $999,999.00 ${sqlToken("contracts", 269)}.`;
  const r = validateAnswer(a, contractEvidence);
  assert.equal(r.ok, false, "must be rejected — the row does not hold $999,999.00");
  assert.match(r.reasons.join(" "), /not supported by/i);
});

test("RED: $5,000 [P:family-court#24] — wrong value, the page says $1,285", () => {
  const a = `The court set child support at $5,000 per month ${pdfToken("family-court", 24)}.`;
  const r = validateAnswer(a, familyCourtEvidence);
  assert.equal(r.ok, false, "must be rejected — $5,000 is not on page 24");
  assert.match(r.reasons.join(" "), /does not appear in that page/i);
});

test("RED: $1,285 [P:carter-story#7] — right value, WRONG doc (it lives in family-court)", () => {
  const a = `Child support was $1,285 per month ${pdfToken("carter-story", 7)}.`;
  const r = validateAnswer(a, carterStoryEvidence);
  assert.equal(r.ok, false, "must be rejected — $1,285 is not in carter-story page 7");
  assert.match(r.reasons.join(" "), /does not appear in that page/i);
});

// ── HONEST TWINS — same shape, a figure the cited evidence actually supports ──

test("GREEN: $25,629.50 [S:contracts#269] — the row's real annual cost passes", () => {
  const a = `The Skalith contract's annual cost is $25,629.50 ${sqlToken("contracts", 269)}.`;
  const r = validateAnswer(a, contractEvidence);
  assert.equal(r.ok, true, r.reasons.join("; "));
});

test("GREEN: $1,285 [P:family-court#24] — the figure is literally on the cited page", () => {
  const a = `The court set child support at $1,285 per month ${pdfToken("family-court", 24)}.`;
  const r = validateAnswer(a, familyCourtEvidence);
  assert.equal(r.ok, true, r.reasons.join("; "));
});

test("GREEN: a verified aggregate may be row-cited even though no single row holds it", () => {
  // $40,597.00 is the all-time maintenance total — not in any single row, but a
  // verified server-side aggregate, anchored to a real retrieved row.
  const maintenanceEvidence: Evidence = {
    rows: [{ table: "maintenance", id: 5, data: { id: 5, vendor: "Oyoba", total_cost: 549.98 } }],
    chunks: [],
    // The verified aggregate set mirrors collectAggregates(): total + count + the
    // per-figure value (750 is the verified ticket count).
    aggregates: [40597, 750, 549.98],
  };
  const a = `Total maintenance spend is $40,597.00 across 750 tickets ${sqlToken("maintenance", 5)}.`;
  const r = validateAnswer(a, maintenanceEvidence);
  assert.equal(r.ok, true, r.reasons.join("; "));
});

test("GREEN: a calendar year on a DIFFERENT page of the SAME doc may be cited (conflict answer)", () => {
  // The filing-conflict answer surfaces "2026" (a year on the cover sheet, page 1)
  // while pinning a [P:family-court#6] citation. The year is real document evidence;
  // only a fabricated VALUE (a $ amount absent from the page) is rejected.
  const ev: Evidence = {
    rows: [],
    chunks: [
      { doc: "family-court", page: 1, text: "Cover sheet. Filed: 10 February 2026." },
      { doc: "family-court", page: 6, text: "PAGE 6 — CHILDREN INFORMATION. Emma Carter — 11." },
    ],
  };
  const a = `Joni filed in 2026 ${pdfToken("family-court", 6)}.`;
  const r = validateAnswer(a, ev);
  assert.equal(r.ok, true, r.reasons.join("; "));
});

test("RED: a DOLLAR amount absent from the cited page is still rejected (no year latitude)", () => {
  const ev: Evidence = {
    rows: [],
    chunks: [{ doc: "family-court", page: 24, text: "child support of $1,285 per month" }],
  };
  const a = `Child support was $9,999 ${pdfToken("family-court", 24)}.`;
  const r = validateAnswer(a, ev);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /does not appear in that page/i);
});

test("RED: a maintenance figure that is neither the row value nor an aggregate is rejected", () => {
  const maintenanceEvidence: Evidence = {
    rows: [{ table: "maintenance", id: 5, data: { id: 5, vendor: "Oyoba", total_cost: 549.98 } }],
    chunks: [],
    aggregates: [40597, 549.98],
  };
  const a = `Total maintenance spend is $88,888.00 ${sqlToken("maintenance", 5)}.`;
  const r = validateAnswer(a, maintenanceEvidence);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /not supported by/i);
});

test("GREEN: a real value paired with a SIBLING row's citation passes (breakdown listing)", () => {
  // A breakdown sometimes pins a real retrieved value to a sibling row's token.
  // $499.98 is row #685's value; cited beside #5 it is still genuine evidence.
  const ev: Evidence = {
    rows: [
      { table: "maintenance", id: 5, data: { id: 5, vendor: "Oyoba", total_cost: 549.98 } },
      { table: "maintenance", id: 685, data: { id: 685, vendor: "Zoovu", total_cost: 499.98 } },
    ],
    chunks: [],
    aggregates: [40597],
  };
  const a = `Sample: $499.98 ${sqlToken("maintenance", 5)}.`;
  assert.equal(validateAnswer(a, ev).ok, true, validateAnswer(a, ev).reasons.join("; "));
});

test("RED: a value in NO retrieved row of the table is still rejected (real fabrication)", () => {
  const ev: Evidence = {
    rows: [
      { table: "maintenance", id: 5, data: { id: 5, vendor: "Oyoba", total_cost: 549.98 } },
      { table: "maintenance", id: 685, data: { id: 685, vendor: "Zoovu", total_cost: 499.98 } },
    ],
    chunks: [],
    aggregates: [40597],
  };
  const a = `Sample: $123,456.78 ${sqlToken("maintenance", 5)}.`;
  const r = validateAnswer(a, ev);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /not supported by/i);
});
