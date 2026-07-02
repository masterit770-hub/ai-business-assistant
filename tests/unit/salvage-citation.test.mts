import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAnswer,
  flaggedBadTokens,
  stripFlaggedCitations,
  salvageGroundedAnswer,
  type Evidence,
} from "../../src/lib/engine/validate-answer.ts";
import { sqlToken, pdfToken, extractCitationTokens } from "../../src/lib/engine/citations.ts";

// ── THE SALVAGE FIX (the reliability/adoption gate) ──────────────────────────────
//
// With the citation gate RELAXED to fail only genuine fabrication (a right value on the
// wrong page, or a derived number, no longer rejects an answer), the salvage's remaining
// job is small: strip a genuinely-UNRESOLVABLE citation token (rule 1 — a token pointing
// at evidence not retrieved this turn) so the figure beside it becomes uncited prose, then
// re-validate and adopt iff clean AND still cites ≥1 real evidence token. These tests prove
// the helper is (a) DISCRIMINATING — it salvages a real answer with one stray UNRESOLVABLE
// cite but does NOT rescue a fabrication or a stripped-bare answer — and (b) keyed ONLY off
// validation state. (The old rule-4 "right value, wrong page" case is no longer a failure,
// so there is no rule-4 token to flag — see the placement test below.)
//
// Evidence fixture carrying real values so the claim-support cross-check (rule 4) runs.
const evidence: Evidence = {
  rows: [
    { table: "maintenance", id: 1, data: { id: 1, total_spend: 40597 } },
  ],
  chunks: [
    {
      doc: "bluefalcon",
      page: 1,
      text: "Project codename BLUEFALCON. Approved budget $42,000. Project lead Dana Whitfield.",
    },
    {
      doc: "bluefalcon",
      page: 2,
      text: "Timeline and milestones for the next quarter are listed here.",
    },
  ],
  aggregates: [40597],
};

// ── flaggedBadTokens: recovers the bad tokens from a validation result ───────────

test("flaggedBadTokens: an unresolved (rule-1) token is flagged", () => {
  // [P:bluefalcon#9] resolves to no retrieved page → rule 1 unresolved.
  const a = `The lead is Dana Whitfield ${pdfToken("bluefalcon", 1)} and the budget is $42,000 ${pdfToken("bluefalcon", 9)}.`;
  const v = validateAnswer(a, evidence);
  assert.equal(v.ok, false);
  const bad = flaggedBadTokens(v);
  assert.ok(bad.has("[P:bluefalcon#9]"), "unresolved token must be flagged");
  assert.ok(!bad.has("[P:bluefalcon#1]"), "the valid token must NOT be flagged");
});

test("RELAXED: a right value cited to the WRONG page is NOT a failure (placement, not fabrication)", () => {
  // $42,000 is on page 1; pinning it to page 2 (also retrieved) is a placement slip. The
  // relaxed gate accepts it — the figure IS in the evidence this turn — so there is no
  // rule-4 failure and nothing for the salvage to flag. This is the over-strictness the
  // reliability fix removed.
  const a = `The approved budget is $42,000 ${pdfToken("bluefalcon", 2)}.`;
  const v = validateAnswer(a, evidence);
  assert.equal(v.ok, true, "right value on the wrong (still-retrieved) page must pass: " + v.reasons.join("; "));
  assert.equal(flaggedBadTokens(v).size, 0, "nothing flagged — placement is not a failure");
});

// ── stripFlaggedCitations: removes ONLY the bad tokens, keeps the valid ones ─────

test("stripFlaggedCitations: removes the bad token, keeps the good one, leaves clean prose", () => {
  const a = `The lead is Dana Whitfield ${pdfToken("bluefalcon", 1)} and the budget is $42,000 ${pdfToken("bluefalcon", 9)}.`;
  const v = validateAnswer(a, evidence);
  const { text, removed } = stripFlaggedCitations(a, v);
  assert.deepEqual(removed, ["[P:bluefalcon#9]"]);
  assert.ok(text.includes("[P:bluefalcon#1]"), "valid citation kept");
  assert.ok(!text.includes("[P:bluefalcon#9]"), "bad citation removed");
  assert.ok(!/ {2,}/.test(text), "no double spaces left behind");
  assert.ok(!/ \./.test(text), "no dangling space before a period");
});

// ── salvageGroundedAnswer: the adopt/reject decision ─────────────────────────────

test("SALVAGE: a real answer with ONE stray bad cite IS salvaged (clean + still cites)", () => {
  // Good answer: states the real lead+budget, cites page 1 (valid). One stray bad cite on
  // a sibling page. This is the EXACT bluefalcon failure mode.
  const a = `SOURCE notwithstanding, the codename is BLUEFALCON, the approved budget is $42,000, and the lead is Dana Whitfield ${pdfToken("bluefalcon", 1)}. (See also ${pdfToken("bluefalcon", 9)}.)`;
  const out = salvageGroundedAnswer(a, evidence);
  assert.ok(out, "must be salvageable");
  const v = validateAnswer(out!.text, evidence);
  assert.equal(v.ok, true, "salvaged text must be fidelity-clean: " + v.reasons.join("; "));
  assert.ok(extractCitationTokens(out!.text).length >= 1, "salvaged answer still cites real evidence");
  assert.ok(out!.text.includes("[P:bluefalcon#1]"), "the VALID citation is preserved");
});

test("SALVAGE: a FABRICATED figure is NOT salvaged (stripping the cite leaves an uncited fabrication... which validateAnswer permits ONLY if it still cites real evidence)", () => {
  // The ONLY citation is on a fabricated figure ($999,999 not in any row). Stripping it
  // leaves an answer with ZERO real citations → must NOT adopt (not genuinely grounded).
  const a = `The total maintenance spend is $999,999 ${sqlToken("maintenance", 1)}.`;
  const out = salvageGroundedAnswer(a, evidence);
  assert.equal(out, null, "must NOT salvage to a citationless answer");
});

test("SALVAGE: a one-bad-cite answer whose REMAINING text is still factual but uncited is rejected (rule-2 would re-fail)", () => {
  // Two bad cites: a derived sum cited to a row + an unresolved page. After stripping both
  // there is no valid citation left → rejected (not genuinely grounded).
  const a = `The combined figure is $83,000 ${sqlToken("maintenance", 1)} per the memo ${pdfToken("bluefalcon", 9)}.`;
  const out = salvageGroundedAnswer(a, evidence);
  assert.equal(out, null, "no valid citation remains after stripping → not adopted");
});

test("SALVAGE: an already-clean answer is returned unchanged (no-op salvage)", () => {
  const a = `The lead is Dana Whitfield and the budget is $42,000 ${pdfToken("bluefalcon", 1)}.`;
  const out = salvageGroundedAnswer(a, evidence);
  assert.ok(out, "an already-clean cited answer is kept");
  assert.equal(out!.removed.length, 0);
  assert.equal(out!.text, a);
});

test("SALVAGE is GENERAL: keyed only off validation state, never the question/domain", () => {
  // A structured answer: total cited to a sibling-row token but stated value is a real
  // aggregate (40597). Add ONE stray bad page cite. Salvage must drop only the bad one.
  const a = `Total maintenance spend is $40,597 ${sqlToken("maintenance", 1)}, summarized ${pdfToken("bluefalcon", 9)}.`;
  const out = salvageGroundedAnswer(a, evidence);
  assert.ok(out, "salvageable: the figure is a verified aggregate, only the page cite is bad");
  assert.ok(out!.text.includes("[S:maintenance#1]"), "the valid structured cite is kept");
  assert.ok(!out!.text.includes("[P:bluefalcon#9]"), "the bad page cite is dropped");
  assert.ok(validateAnswer(out!.text, evidence).ok, "result is clean");
});
