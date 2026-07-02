import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAnswer, type Evidence } from "../../src/lib/engine/validate-answer.ts";
import { sqlToken, pdfToken } from "../../src/lib/engine/citations.ts";

// Claim-support cross-check (validateAnswer rule 4) — the RELAXED, fabrication-only gate.
//
// The gate is intentionally placement-agnostic now: a cited factual figure is supported
// if it appears ANYWHERE in the retrieved evidence this turn, NOT on the exact cited
// page/row. So the only RED is genuine FABRICATION — a figure stated as a document fact
// that appears in NO retrieved chunk/row. A RIGHT value cited to the WRONG page is a
// PLACEMENT slip and PASSES; a DERIVED number (a sum/gap the model computed) beside a real
// citation is reasoning and PASSES. These tests pin exactly that contract: the anti-
// fabrication REDs stay RED; placement/derivation cases that used to be RED are now GREEN.

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

test("RED: $999,999.00 [S:contracts#269] — fabricated value, absent from ALL evidence (row says $25,629.50)", () => {
  const a = `The Skalith contract is worth $999,999.00 ${sqlToken("contracts", 269)}.`;
  const r = validateAnswer(a, contractEvidence);
  assert.equal(r.ok, false, "must be rejected — $999,999.00 is in no retrieved evidence");
  assert.match(r.reasons.join(" "), /nowhere in the retrieved evidence|ungrounded|fabricated/i);
});

test("RED: $5,000 [P:family-court#24] — fabricated value, absent from ALL evidence (the page says $1,285)", () => {
  const a = `The court set child support at $5,000 per month ${pdfToken("family-court", 24)}.`;
  const r = validateAnswer(a, familyCourtEvidence);
  assert.equal(r.ok, false, "must be rejected — $5,000 is in no retrieved evidence");
  assert.match(r.reasons.join(" "), /nowhere in the retrieved evidence|ungrounded|fabricated/i);
});

test("GREEN (relaxed): $1,285 [P:carter-story#7] — RIGHT value, WRONG page now PASSES (placement, not fabrication)", () => {
  // $1,285 is real evidence this turn (it lives in family-court#24, also retrieved). Pinning
  // it to carter-story#7 is a PLACEMENT slip, not a fabricated figure → no longer rejected.
  const a = `Child support was $1,285 per month ${pdfToken("carter-story", 7)}.`;
  const r = validateAnswer(a, carterStoryEvidence);
  assert.equal(r.ok, true, "a right value cited to the wrong page is placement, not fabrication: " + r.reasons.join("; "));
});

test("GREEN (relaxed): a DERIVED number beside a real citation passes (reasoning, not a doc fact)", () => {
  // The page carries $1,285; the model also states a derived annual figure ($15,420 = 1285×12)
  // beside the citation. That figure is in NO chunk — it is reasoning, not a claimed doc fact —
  // and the answer ALSO restates the real $1,285, so the answer is grounded and passes.
  const a = `Child support is $1,285 per month, about $15,420 per year ${pdfToken("family-court", 24)}.`;
  const r = validateAnswer(a, familyCourtEvidence);
  assert.equal(r.ok, true, "a derived number must not fail a grounded answer: " + r.reasons.join("; "));
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

test("RED: a DOLLAR amount absent from ALL evidence is still rejected (fabrication)", () => {
  const ev: Evidence = {
    rows: [],
    chunks: [{ doc: "family-court", page: 24, text: "child support of $1,285 per month" }],
  };
  const a = `Child support was $9,999 ${pdfToken("family-court", 24)}.`;
  const r = validateAnswer(a, ev);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /nowhere in the retrieved evidence|ungrounded|fabricated/i);
});

test("RED: a maintenance figure that is in NO row and NO aggregate is rejected (fabrication)", () => {
  const maintenanceEvidence: Evidence = {
    rows: [{ table: "maintenance", id: 5, data: { id: 5, vendor: "Oyoba", total_cost: 549.98 } }],
    chunks: [],
    aggregates: [40597, 549.98],
  };
  const a = `Total maintenance spend is $88,888.00 ${sqlToken("maintenance", 5)}.`;
  const r = validateAnswer(a, maintenanceEvidence);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /nowhere in the retrieved evidence|ungrounded|fabricated/i);
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
  assert.match(r.reasons.join(" "), /nowhere in the retrieved evidence|ungrounded|fabricated/i);
});

// ── INCIDENTAL QUERY-PARAMETER (window) NUMBER GUARD ─────────────────────────────
// A date-filtered COUNT answer echoes the WINDOW number ("next 90 days") right before the
// citation, but the citation backs the COUNT (40), not the window. The window number, being
// a bare integer followed by a time-unit word, must NOT be treated as the cited claim — so
// a correct grounded count is not false-rejected. (This was a real false-positive: the
// engine's own gate rejected "40 contracts expiring in the next 90 days [S:contracts#1]".)

test("GREEN: a date-window number ('next 90 days') is not the cited claim — the COUNT is", () => {
  const ev: Evidence = {
    // The COUNT(*) result row: the value 40 is the answer, in data + aggregates.
    rows: [{ table: "contracts", id: 1, data: { "COUNT(*)": 40 } }],
    chunks: [],
    aggregates: [40],
  };
  const a = `There are 40 contracts expiring in the next 90 days ${sqlToken("contracts", 1)}.`;
  const r = validateAnswer(a, ev);
  assert.equal(r.ok, true, "the 40 is backed; '90 days' is the window, not a cited figure: " + r.reasons.join("; "));
});

test("GREEN (relaxed): a real cited count alongside a stray fabricated $ figure no longer hard-fails", () => {
  // RELAXED CONTRACT: the answer also cites the REAL count (40, in aggregates), so it IS
  // grounded — placement/derivation/extra figures never sink a grounded answer. The strict
  // gate used to RED this on the stray $999,999; the relaxed gate fails ONLY when EVERY
  // cited figure is absent (see the SOLE-fabrication RED below).
  const ev: Evidence = {
    rows: [{ table: "contracts", id: 1, data: { "COUNT(*)": 40 } }],
    chunks: [],
    aggregates: [40],
  };
  const a = `Those 40 contracts are worth $999,999 over the next 90 days ${sqlToken("contracts", 1)}.`;
  const r = validateAnswer(a, ev);
  assert.equal(r.ok, true, "the real count 40 grounds the answer; the relaxed gate doesn't hard-fail the stray $: " + r.reasons.join("; "));
});

test("RED: a SOLE fabricated COUNT (every cited figure absent from evidence) is still rejected", () => {
  // The window number ('90 days') is dropped as a window, and the ONLY remaining cited
  // figure (999) is NOT the real count (40) → NO cited figure resolves → fabrication.
  const ev: Evidence = {
    rows: [{ table: "contracts", id: 1, data: { "COUNT(*)": 40 } }],
    chunks: [],
    aggregates: [40],
  };
  const a = `There are 999 contracts expiring in the next 90 days ${sqlToken("contracts", 1)}.`;
  const r = validateAnswer(a, ev);
  assert.equal(r.ok, false, "999 is not the real count (40) and is the only cited figure → must fail");
  assert.match(r.reasons.join(" "), /nowhere in the retrieved evidence|ungrounded|fabricated/i);
});
