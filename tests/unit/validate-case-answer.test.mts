import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCaseAnswer } from "../../src/lib/engine/validate-case-answer.ts";

// Mirrors docs/features/case-file-qa/03-tests.md Part 3 — passes goldens A–D, fails toys.

test("golden A: Final Judgment, $1,285 + Joni Carter, Page-24 cited", () => {
  const a = `Per the Final Judgment, the court ordered child support of $1,285/month, with primary residence to Joni Carter and joint legal custody [P:family-court#24].`;
  assert.equal(validateCaseAnswer(a).ok, true);
});

test("golden B: corroborated grounds cite both documents", () => {
  const a = `The grounds were addiction-driven instability [P:family-court#6], corroborated by the case narrative which lists the same reasons [P:carter-story#2].`;
  assert.equal(validateCaseAnswer(a).ok, true);
});

test("golden C: filing-date conflict surfaced with both dates + citations", () => {
  const a = `The sources disagree: the cover sheet lists 10 February 2026 [P:family-court#1], but the narratives state February 3, 2026 [P:carter-story#2]. The sources conflict, so I surface both.`;
  assert.equal(validateCaseAnswer(a).ok, true, validateCaseAnswer(a).reasons.join("; "));
});

test("golden D (Hebrew): $1,285 + Page-24 citation", () => {
  const a = `על פי פסק הדין הסופי, מזונות ילדים בסך $1,285 לחודש, מגורים עיקריים אצל ג'וני קרטר [P:family-court#24].`;
  assert.equal(validateCaseAnswer(a).ok, true);
});

test("golden: honest 'not stated' for an out-of-scope exhibit question", () => {
  const a = `The contents of Exhibit C are not stated in the case file — the exhibit is referenced but its contents aren't in the provided documents.`;
  assert.equal(validateCaseAnswer(a).ok, true);
});

// ── TOYS MUST fail ──────────────────────────────────────────────────────────

test("toy: uncited finding (no page citation)", () => {
  const a = `According to the case file, the court awarded child support of $1,285 and gave custody to the mother.`;
  const r = validateCaseAnswer(a);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /no page-level citation/i);
});

test("toy: hallucinated holding (spousal support — not in the documents)", () => {
  const a = `The judgment awarded child support of $1,285/month and spousal support of $2,000/month [P:family-court#24].`;
  const r = validateCaseAnswer(a);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /not in the case documents/i);
});

test("toy: conflict silently resolved (only one filing date but calls it corroborated)", () => {
  const a = `Joni Carter filed on February 3, 2026 [P:family-court#6], corroborated across documents. The cover sheet says 10 February 2026 too [P:family-court#1].`;
  const r = validateCaseAnswer(a);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /conflict/i);
});

test("toy: structured-table citation in a document-only answer", () => {
  const a = `Child support was $1,285/month [S:contracts#12].`;
  const r = validateCaseAnswer(a);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /structured-table citation/i);
});
