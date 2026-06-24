import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSummaryQuestion,
  guardSummaryOverOwnData,
  type RoutePlan,
} from "../../src/lib/engine/router.ts";
import { isEnumerationOrSummaryQuestion } from "../../src/lib/engine/answer.ts";

// DETERMINISTIC guards for the two GENERAL (retrieval-side) "her data" fixes — no LLM/DB — so the
// pure detectors that gate them can't silently drift. These cover ONLY the general fixes the lead
// kept: the summary-over-own-data router guard (BUG4 source routing) and the enumeration/summary
// recall-depth detector (BUG2 MENDA depth). The intake-template and plan-period misreads are MODEL
// REASONING issues handled by a light general prompt nudge (no format-specific code/detector), so
// there is nothing format-specific to unit-test here — by design. The LLM-in-the-loop behavior is
// proven by tests/evals/her-data-retrieval.mjs.

// ── BUG4 (source routing): isSummaryQuestion + guardSummaryOverOwnData — a summary of own data must
//    reach the structured lane, phrasing-robust, general (no file shape special-cased). ───────────
test("isSummaryQuestion: summary/overview phrasings fire (EN + HE), a plain lookup does not", () => {
  assert.equal(isSummaryQuestion("summarize the Danieli track"), true);
  assert.equal(isSummaryQuestion("give me an overview of the program"), true);
  assert.equal(isSummaryQuestion("סכם את מסלול דניאלי"), true);
  assert.equal(isSummaryQuestion("מה כולל התיק הצעיר?"), true);
  assert.equal(isSummaryQuestion("what is the total on the invoice?"), false);
});
test("guardSummaryOverOwnData: a documents-only summary gains 'structured' when the caller HAS tables", () => {
  const plan: RoutePlan = { sources: ["documents"], docFilter: null, rationale: "x" };
  const out = guardSummaryOverOwnData(plan, "summarize the Danieli track", true);
  assert.deepEqual(out.sources.sort(), ["documents", "structured"]);
});
test("guardSummaryOverOwnData: a NON-summary question is untouched", () => {
  const plan: RoutePlan = { sources: ["documents"], docFilter: null, rationale: "x" };
  const out = guardSummaryOverOwnData(plan, "what is the supplier on the invoice?", true);
  assert.deepEqual(out.sources, ["documents"]);
});
test("guardSummaryOverOwnData: a caller with NO tables is untouched (never invents a structured source)", () => {
  const plan: RoutePlan = { sources: ["documents"], docFilter: null, rationale: "x" };
  const out = guardSummaryOverOwnData(plan, "summarize the Danieli track", false);
  assert.deepEqual(out.sources, ["documents"]);
});
test("guardSummaryOverOwnData: an already-structured route is left as-is (no duplicate)", () => {
  const plan: RoutePlan = { sources: ["structured"], docFilter: null, rationale: "x" };
  const out = guardSummaryOverOwnData(plan, "summarize the plan", true);
  assert.deepEqual(out.sources, ["structured"]);
});

// ── BUG2 (retrieval depth): isEnumerationOrSummaryQuestion — gates the whole-doc recall boost so a
//    summarize-or-enumerate question over ANY document retrieves enough to answer. General. ───────
test("isEnumerationOrSummaryQuestion: enumerations + 'which is preferred' + summaries fire", () => {
  assert.equal(isEnumerationOrSummaryQuestion("how many options does the memo present, and which is preferred?"), true);
  assert.equal(isEnumerationOrSummaryQuestion("list the options in the strategy doc"), true);
  assert.equal(isEnumerationOrSummaryQuestion("summarize the MENDA memo"), true);
  assert.equal(isEnumerationOrSummaryQuestion("כמה אופציות יש במסמך ומה המומלצת?"), true);
  assert.equal(isEnumerationOrSummaryQuestion("מה האופציות במסמך?"), true);
});
test("isEnumerationOrSummaryQuestion: a single narrow fact lookup does NOT fire", () => {
  assert.equal(isEnumerationOrSummaryQuestion("what is the supplier name on the invoice?"), false);
  assert.equal(isEnumerationOrSummaryQuestion("who is the petitioner?"), false);
});
