import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSourceFlag } from "../../src/lib/engine/answer.ts";

// THE CHANGE: the MODEL now decides grounded-vs-general by BEGINNING its grounded
// reply with exactly one flag line — `SOURCE: documents` or `SOURCE: general`. The
// engine parses that first line, STRIPS it so the user never sees the raw flag, and
// routes on the model's decision (replacing the old isUncitedRefusal regex guess).
//
// parseSourceFlag is the pure parse/strip contract. These tests pin: correct flag
// extraction, the flag never leaking into the visible answer, tolerance for the small
// formatting variations a modest model (DeepSeek) produces, and the safe default
// (treat a missing flag as `documents` so a real grounded answer is never lost).

test("SOURCE: documents → flag=documents, line stripped from the answer", () => {
  const raw =
    "SOURCE: documents\n38 contracts expire in the next 90 days, totaling $18,924,883.79 [S:contracts#269].";
  const { flag, text } = parseSourceFlag(raw);
  assert.equal(flag, "documents");
  assert.match(text, /38 contracts expire/);
  assert.doesNotMatch(text, /SOURCE:/i); // NO raw flag leaks into the visible answer
});

test("SOURCE: general → flag=general, line stripped", () => {
  const raw = "SOURCE: general\nThe capital of Australia is Canberra.";
  const { flag, text } = parseSourceFlag(raw);
  assert.equal(flag, "general");
  assert.equal(text, "The capital of Australia is Canberra.");
  assert.doesNotMatch(text, /SOURCE:/i);
});

test("the maintenance honest-refusal flags documents (it reports the verified figure)", () => {
  const raw =
    "SOURCE: documents\nThe maintenance table has no payment-status field, so I can't say who is overdue. Total maintenance spend is $40,597.00 across 750 tickets [S:maintenance#5].";
  const { flag, text } = parseSourceFlag(raw);
  assert.equal(flag, "documents", "an honest answer that reports real figures is a documents answer");
  assert.match(text, /\$40,597\.00/);
  assert.doesNotMatch(text, /SOURCE:/i);
});

test("missing flag → defaults to documents and keeps the whole answer (never lose a grounded reply)", () => {
  const raw = "The monthly child support amount is $1,285 [P:family-court#24].";
  const { flag, text } = parseSourceFlag(raw);
  assert.equal(flag, "documents");
  assert.equal(text, raw);
});

test("tolerates leading blank lines before the flag", () => {
  const raw = "\n\nSOURCE: general\n\nCanberra is the capital.";
  const { flag, text } = parseSourceFlag(raw);
  assert.equal(flag, "general");
  assert.equal(text, "Canberra is the capital.");
  assert.doesNotMatch(text, /SOURCE:/i);
});

test("tolerates markdown emphasis / case / trailing punctuation around the flag", () => {
  for (const first of ["**SOURCE: general**", "`SOURCE: General`", "Source: general."]) {
    const { flag, text } = parseSourceFlag(`${first}\nCanberra.`);
    assert.equal(flag, "general", `failed to parse "${first}"`);
    assert.equal(text, "Canberra.");
    assert.doesNotMatch(text, /SOURCE:/i);
  }
});

test("a flag-shaped phrase deeper in the prose is NOT treated as the flag (only the first line counts)", () => {
  // The model answered properly (no leading flag); a later mention of the word source
  // must not strip mid-answer text. Defaults to documents, answer kept verbatim.
  const raw = "Per the case file, custody was decided [P:family-court#24]. (The SOURCE: documents below corroborate.)";
  const { flag, text } = parseSourceFlag(raw);
  assert.equal(flag, "documents");
  assert.equal(text, raw);
});

test("multi-line answer body is preserved after stripping the flag", () => {
  const raw = "SOURCE: documents\nLine one [S:contracts#1].\n\nLine two [S:contracts#2].";
  const { flag, text } = parseSourceFlag(raw);
  assert.equal(flag, "documents");
  assert.equal(text, "Line one [S:contracts#1].\n\nLine two [S:contracts#2].");
});
