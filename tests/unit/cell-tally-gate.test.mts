import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCellTallyAnswer,
  type VerifiedTopGroup,
} from "../../src/lib/engine/validate-answer.ts";

// ── THE CELL-TALLY CONTENT-FIDELITY GATE ─────────────────────────────────────────────────────
// The live regression that motivated this gate: a COUNT answer from the cell-tally lane could
// COLLAPSE A TIE (crown one leader, demote the co-leaders) or report a NON-MAX AS THE MAX and
// still get a GREEN check — because the general citation gate only checks that a cited figure
// appears SOMEWHERE in the evidence, and the wrong number (5) is itself a real evidence value.
// validateCellTallyAnswer closes that gap: given the code-computed verified top group (the exact
// extreme count + the FULL list of tied leaders), an answer PASSES only if it states that exact
// count AND names EVERY tied leader. These tests pin both failure modes RED and the faithful PASS.

// Ground-truth shaped fixtures (mirroring her real sheets):
const TIE_AT_10: VerifiedTopGroup = {
  maxCount: 10,
  leaders: ["אילת ברזין", "נעה כהן צמח", "שירה ליאור", "אילה רוט", "יעל לוי", "ליבי רוטמן", "שני שרת"],
};
const SOLE_MAX_29: VerifiedTopGroup = { maxCount: 29, leaders: ["נגה מאירסון"] };

// ── FAILURE MODE 1: TIE COLLAPSE ─────────────────────────────────────────────────────────────
test("FAILS a tie-collapsed answer (crowns one leader, demotes the co-leaders)", () => {
  // States 10 but names only ONE of the seven tied leaders — the live RED #1.
  const collapsed = "המשובצת הכי הרבה היא אילת ברזין עם 10 שיבוצים. השאר עם פחות.";
  const r = validateCellTallyAnswer(collapsed, TIE_AT_10);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /tie was collapsed/.test(x)), r.reasons.join("; "));
});

// ── FAILURE MODE 2: NON-MAX REPORTED AS THE MAX (the DANGEROUS green-check) ───────────────────
test("FAILS a non-max-as-max answer (reports 5 when the verified max is 10)", () => {
  // The system-wide RED #2: confidently states a non-maximum (5) as the most.
  const nonMax = "המשובצת הכי הרבה במערכת היא רינה אנטוב עם 5 שיבוצים.";
  const r = validateCellTallyAnswer(nonMax, TIE_AT_10);
  assert.equal(r.ok, false);
  assert.ok(
    r.reasons.some((x) => /verified extreme occurrence count \(10\)/.test(x)),
    r.reasons.join("; ")
  );
});

// ── THE FAITHFUL PASS: full tie + exact max ──────────────────────────────────────────────────
test("PASSES a faithful answer that names the FULL tie at the exact max count", () => {
  const faithful =
    "המשובצות ביותר (תיקו) עם 10 שיבוצים כל אחת: " +
    TIE_AT_10.leaders.join(", ") +
    ". מדובר בתיקו בין כולן.";
  const r = validateCellTallyAnswer(faithful, TIE_AT_10);
  assert.equal(r.ok, true, r.reasons.join("; "));
});

// ── SOLE LEADER: names the one, states 29 (no fabricated tie needed) ──────────────────────────
test("PASSES a sole-leader answer that names the one leader + the exact max", () => {
  assert.equal(validateCellTallyAnswer("האדם המשובץ הכי הרבה הוא נגה מאירסון עם 29 שיבוצים.", SOLE_MAX_29).ok, true);
});

test("FAILS a sole-leader answer that states the WRONG (non-max) count", () => {
  // Names the right person but a wrong, smaller count — still unfaithful to the verified tally.
  const r = validateCellTallyAnswer("נגה מאירסון משובצת הכי הרבה, עם 5 שיבוצים.", SOLE_MAX_29);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /extreme occurrence count \(29\)/.test(x)), r.reasons.join("; "));
});

// ── NUMBER-BOUNDARY ROBUSTNESS: the exact integer, not a substring of a larger number ─────────
test("the max-count check matches a standalone integer, not a substring or a decimal", () => {
  // "29." at a sentence end MUST satisfy 29 (a trailing period is punctuation, not a decimal).
  assert.equal(validateCellTallyAnswer("נגה מאירסון, 29.", SOLE_MAX_29).ok, true);
  // "291" must NOT satisfy 29 (substring of a larger number).
  assert.equal(
    validateCellTallyAnswer("נגה מאירסון, 291.", SOLE_MAX_29).ok,
    false
  );
  // "29.5" (a real decimal) must NOT satisfy the integer 29.
  assert.equal(validateCellTallyAnswer("נגה מאירסון, 29.5.", SOLE_MAX_29).ok, false);
});

// ── DEGENERATE GUARD: an empty verified group enforces nothing (defensive no-op) ──────────────
test("an empty verified top group is a no-op (never fails an answer)", () => {
  assert.equal(validateCellTallyAnswer("anything at all", { maxCount: NaN, leaders: [] }).ok, true);
  assert.equal(validateCellTallyAnswer("anything", { maxCount: 5, leaders: [] }).ok, true);
});
