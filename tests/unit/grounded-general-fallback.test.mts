import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldFallbackToGeneral } from "../../src/lib/engine/answer.ts";

// NOTE (post-SOURCE-flag refactor): the PRIMARY grounded-vs-general decision is now
// the MODEL's own explicit `SOURCE:` flag (see parseSourceFlag + source-flag.test.mts),
// which replaced the old isUncitedRefusal regex routing branch entirely.
// On a `documents` answer that FAILS a validation gate, the engine first tries a
// grounded RESCUE (a narrow "is this evidence on-topic?" classification + a forced
// evidence-first regeneration — this recovers the named-case golden, e.g. Carter, that
// a modest model occasionally answers from memory). shouldFallbackToGeneral() is the
// LAST-RESORT net for what the rescue can't fix (a genuinely off-topic question, or a
// rejection that re-grounding doesn't resolve): we re-answer via general instead of
// showing the user a red error — while a validation-PASSING answer that carries
// citations / a verified aggregate figure (the designed maintenance honest-refusal,
// contracts, case-file) STAYS grounded. These tests pin that last-resort net.
//
// These tests drive the real branching with crafted answer strings + the validation
// outcome — no LLM, fully deterministic.

// ── THE TARGET: the client's literal cited-refusal → MUST fall back to general ─────

test("TARGET: alimony cited refusal REJECTED by validation → falls back to general", () => {
  // The literal grounded output: a refusal that CITES the Carter case file while
  // declining. validateCaseAnswer's alimony stop-list REJECTS it (validationOk=false).
  const answer =
    "I cannot answer this question because the evidence does not contain any information about Arizona divorce law, alimony, or negotiation strategy — that is not stated in the case file [P:carter-story#3].";
  assert.equal(
    shouldFallbackToGeneral({ answer, validationOk: false, hasVerifiedAggregate: false }),
    true,
    "a rejected grounded refusal (even one that cited docs) must route to general"
  );
});

test("HARD EXCEPTION precedence: a cited refusal that PASSED validation is KEPT grounded (don't fall back off wording alone)", () => {
  // The spec is explicit: key the fallback PRIMARILY off validation REJECTION, NOT off
  // refusal wording alone. So a refusal-shaped answer that carries a citation AND
  // passed validation is treated as a valid grounded reply and STAYS grounded — this
  // is the conservative guard that protects the designed maintenance honest-refusal.
  // (The real client case is REJECTED by validation — see the TARGET test above.)
  const answer =
    "I cannot answer this — the evidence does not contain information about Arizona divorce law [P:carter-story#3].";
  assert.equal(
    shouldFallbackToGeneral({ answer, validationOk: true, hasVerifiedAggregate: false }),
    false,
    "refusal wording + a citation + passed validation → kept grounded (fallback keys off REJECTION)"
  );
});

test("Signal B (uncited refusal that passed validation, no figure) → falls back", () => {
  // No citation token, refusal wording, no grounded figure, validation passed: the
  // HARD EXCEPTION does not apply (no citation/aggregate), so Signal B fires.
  const answer =
    "I cannot answer this — the evidence does not contain information about Arizona divorce law.";
  assert.equal(
    shouldFallbackToGeneral({ answer, validationOk: true, hasVerifiedAggregate: false }),
    true
  );
});

// ── HARD PROTECTIONS: these MUST stay grounded (no fallback) ───────────────────────

test("PROTECTION 1 — contracts answer (38 / $18,924,883.79, cited) STAYS grounded", () => {
  const answer =
    "38 contracts expire in the next 90 days, with a combined annual cost of $18,924,883.79 [S:contracts#269], [S:contracts#270].";
  assert.equal(
    shouldFallbackToGeneral({ answer, validationOk: true, hasVerifiedAggregate: true }),
    false
  );
});

test("PROTECTION 2 — child-support case answer ($1,285, [P:family-court#24]) STAYS grounded", () => {
  const answer =
    "Per the Final Judgment, the court ordered child support of $1,285/month, with primary residence to Joni Carter and joint legal custody [P:family-court#24].";
  assert.equal(
    shouldFallbackToGeneral({ answer, validationOk: true, hasVerifiedAggregate: false }),
    false,
    "a real cited grounded answer that passed validation must never fall back"
  );
});

test("PROTECTION 3 — maintenance spend answer (verified figure + row cites) STAYS grounded", () => {
  const answer =
    "In 2026, maintenance spend was $13,485.66 across 248 tickets. Top vendors by spend: Oyoba $949.94 [S:maintenance#478], Voolith $783.67 [S:maintenance#12]. Total across all tickets: $40,597.00 [S:maintenance#1].";
  assert.equal(
    shouldFallbackToGeneral({ answer, validationOk: true, hasVerifiedAggregate: true }),
    false
  );
});

test("PROTECTION 4 — DESIGNED maintenance honest-refusal ($40,597 pivot, cited) STAYS grounded", () => {
  // This is the critical one: it uses refusal-shaped language ("no payment-status …
  // field", "can't determine overdue") BUT it passes validation and states the
  // verified $40,597.00 pivot figure with a citation. It must NOT fall back — it is a
  // VALID grounded answer the client designed for the trust demo.
  const answer =
    "I can't determine overdue payments from this data — the maintenance table has no payment-status or due-date field; its columns are only Vendor, Invoice, Labor Cost, Parts Cost, Total Cost, Completion Date. The vendors are providers we pay, not customers who owe. What I can tell you: total maintenance spend is $40,597.00 across 750 tickets [S:maintenance#5].";
  assert.equal(
    shouldFallbackToGeneral({ answer, validationOk: true, hasVerifiedAggregate: true }),
    false,
    "the designed honest-refusal passes validation AND states the verified figure — keep it grounded"
  );
});

test("designed maintenance honest-refusal stays grounded on aggregate signal even if it carried no inline token", () => {
  // The deterministic figures block always appends [S:maintenance#…], but assert the
  // HARD EXCEPTION holds on the verified-aggregate signal alone too (defense in depth):
  // validation passed + a verified aggregate exists → grounded.
  const answer =
    "The maintenance data has no payment-status or due-date field, so I can't say who is overdue. Total maintenance spend is $40,597.00 across 750 tickets.";
  assert.equal(
    shouldFallbackToGeneral({ answer, validationOk: true, hasVerifiedAggregate: true }),
    false
  );
});

// ── BRANCHING EDGE CASES ───────────────────────────────────────────────────────────

test("a normal grounded answer with no refusal wording + passed validation → grounded", () => {
  const answer = "The monthly child support amount is $1,285 [P:family-court#24].";
  assert.equal(
    shouldFallbackToGeneral({ answer, validationOk: true, hasVerifiedAggregate: false }),
    false
  );
});

test("validation rejected for a NON-refusal reason (e.g. a bad citation) → falls back rather than show a red error", () => {
  // Per spec: keying primarily off validateAnswer REJECTION. A rejected grounded
  // answer is never surfaced as a red error; general knowledge is the safe fallback.
  const answer = "The penalty clause is $50,000 [S:contracts#999].";
  assert.equal(
    shouldFallbackToGeneral({ answer, validationOk: false, hasVerifiedAggregate: false }),
    true
  );
});

test("refusal wording alone (validation passed, no citation, no figure) → falls back", () => {
  // Belt-and-braces with the uncited-refusal path: a bare 'cannot answer' with no
  // grounded content routes to general.
  const answer = "I cannot answer this question because the evidence does not contain that information.";
  assert.equal(
    shouldFallbackToGeneral({ answer, validationOk: true, hasVerifiedAggregate: false }),
    true
  );
});
