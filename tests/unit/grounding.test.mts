import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveGrounding, type GroundingPreparedFile } from "../../src/lib/engine/grounding.ts";
import { pdfToken } from "../../src/lib/engine/citations.ts";

// ── THE FALSE-CITATIONS FIX (F3) ─────────────────────────────────────────────
//
// The Messages engine ends the answer with a mandatory "SOURCES_USED:" line. The grounding
// derivation has a FLOOR backstop: if no evidence was found but files were attached and a
// substantive answer came back, it marks EVERY attached file as evidence — meant to cover a
// weak model that SKIPPED the line entirely.
//
// The bug: the floor could not tell "skipped the line" (absent) from "explicitly declared NONE".
// When the model wrote `SOURCES_USED: NONE` (a deliberate "I used no files" — e.g. a
// general-knowledge answer), the floor fired anyway and claimed ALL attached files as evidence
// → FALSE citations in the panel.
//
// The fix: the floor may fire ONLY when the SOURCES_USED line is ABSENT. An explicit NONE →
// grounded=false, empty evidence — UNLESS the answer carries explicit [P:] citation tokens, which
// are stronger evidence than the NONE line and win. These tests assert the FIXED behavior.

const PDF: GroundingPreparedFile = { name: "annual-report.pdf", isPdf: true };
const CSV: GroundingPreparedFile = { name: "contracts.csv", isPdf: false };
const LONG = "This is a substantive, general-knowledge answer that comfortably clears the floor's length threshold.";

// ── the core fix: explicit NONE must NOT trigger the floor ───────────────────

test("explicit SOURCES_USED: NONE + a PDF attached + long answer → NOT grounded, evidence empty, line stripped", () => {
  const finalAnswer = `${LONG}\n\nSOURCES_USED: NONE`;
  const g = deriveGrounding({ finalAnswer, preparedFiles: [PDF], usedFileTools: false });

  assert.equal(g.sourcesLine, "none", "an explicit NONE is recognized as a declaration, not an absence");
  assert.equal(g.grounded, false, "NONE means no files were used — the floor must NOT fire");
  assert.equal(g.evidenceSourceNames.size, 0, "no file may be claimed as evidence");
  assert.equal(g.declaredSources.length, 0);
  assert.ok(!/SOURCES_USED/i.test(g.displayAnswer), "the SOURCES_USED line is stripped from the shown answer");
  assert.equal(g.displayAnswer, LONG, "display answer is exactly the prose without the trailing line");
});

test("explicit NONE with a spreadsheet + code-exec tool run → still NOT grounded (floor stays down)", () => {
  const finalAnswer = `${LONG}\nSOURCES_USED: NONE`;
  const g = deriveGrounding({ finalAnswer, preparedFiles: [CSV], usedFileTools: true });
  assert.equal(g.grounded, false);
  assert.equal(g.evidenceSourceNames.size, 0);
});

// ── the backstop still works: an ABSENT line lets the floor fire ─────────────

test("SOURCES_USED line ABSENT + PDF attached + long answer → floor fires (all files as evidence)", () => {
  const finalAnswer = LONG; // model skipped the contract line entirely
  const g = deriveGrounding({ finalAnswer, preparedFiles: [PDF], usedFileTools: false });

  assert.equal(g.sourcesLine, "absent");
  assert.equal(g.grounded, true, "the backstop still covers a model that skipped the line");
  assert.deepEqual([...g.evidenceSourceNames], ["annual-report.pdf"]);
});

test("line ABSENT + files attached + NO pdf + usedFileTools=false → floor does NOT fire", () => {
  // A CSV that was never actually read (no code-exec ran, not a PDF) — nothing justifies claiming it.
  const g = deriveGrounding({ finalAnswer: LONG, preparedFiles: [CSV], usedFileTools: false });
  assert.equal(g.sourcesLine, "absent");
  assert.equal(g.grounded, false);
  assert.equal(g.evidenceSourceNames.size, 0);
});

test("line ABSENT + short answer (below the substantive-length floor) → floor does NOT fire", () => {
  const g = deriveGrounding({ finalAnswer: "No.", preparedFiles: [PDF], usedFileTools: true });
  assert.equal(g.sourcesLine, "absent");
  assert.equal(g.grounded, false, "a trivial answer over a file is not evidence of use");
});

// ── declared filenames: exact + basename match ───────────────────────────────

test("declared file names populate evidence — exact match AND basename match", () => {
  const nested: GroundingPreparedFile = { name: "spaces/ops/q1-budget.xlsx", isPdf: false };
  const finalAnswer = `Here are the figures.\nSOURCES_USED: annual-report.pdf, q1-budget.xlsx`;
  const g = deriveGrounding({ finalAnswer, preparedFiles: [PDF, nested], usedFileTools: true });

  assert.equal(g.sourcesLine, "declared");
  assert.deepEqual(g.declaredSources, ["annual-report.pdf", "q1-budget.xlsx"]);
  assert.equal(g.grounded, true);
  // exact match on the PDF's full name, basename match on the nested xlsx → its FULL name is stored.
  assert.ok(g.evidenceSourceNames.has("annual-report.pdf"), "exact filename match");
  assert.ok(g.evidenceSourceNames.has("spaces/ops/q1-budget.xlsx"), "basename match resolves to full stored name");
  assert.equal(g.evidenceSourceNames.size, 2);
});

test("a declared name that matches no attached file is ignored (no floor to backfill it)", () => {
  const finalAnswer = `Answer.\nSOURCES_USED: ghost.pdf`;
  const g = deriveGrounding({ finalAnswer, preparedFiles: [PDF], usedFileTools: false });
  assert.equal(g.sourcesLine, "declared");
  assert.equal(g.grounded, false, "declared line is present (not absent) so the floor cannot fire");
  assert.equal(g.evidenceSourceNames.size, 0);
});

// ── [P:] tokens are the strongest evidence and beat a NONE line ──────────────

test("[P:doc#page] tokens populate evidence", () => {
  const finalAnswer = `The revenue grew ${pdfToken("annual-report.pdf", 4)}.\nSOURCES_USED: annual-report.pdf`;
  const g = deriveGrounding({ finalAnswer, preparedFiles: [PDF], usedFileTools: false });
  assert.ok(g.citedTokens.includes("[P:annual-report.pdf#4]"));
  assert.ok(g.evidenceSourceNames.has("annual-report.pdf"));
  assert.equal(g.grounded, true);
});

test("NONE line but an explicit [P:] token present → the token WINS (grounded=true)", () => {
  // Rule 1 (explicit passage citation) is stronger than rule 2 (the NONE declaration).
  const finalAnswer = `Per the filing, margins improved ${pdfToken("annual-report.pdf", 2)}.\nSOURCES_USED: NONE`;
  const g = deriveGrounding({ finalAnswer, preparedFiles: [PDF, CSV], usedFileTools: false });

  assert.equal(g.sourcesLine, "none");
  assert.equal(g.grounded, true, "an explicit [P:] token outranks a NONE line");
  assert.deepEqual([...g.evidenceSourceNames], ["annual-report.pdf"], "only the cited doc — NOT every attached file");
});

// ── multiline / last-line handling ───────────────────────────────────────────

test("multiline answer with SOURCES_USED as the final line → line stripped, prose preserved", () => {
  const body = "Line one of the answer.\nLine two with more detail.\nLine three concludes it.";
  const finalAnswer = `${body}\nSOURCES_USED: annual-report.pdf`;
  const g = deriveGrounding({ finalAnswer, preparedFiles: [PDF], usedFileTools: false });
  assert.equal(g.displayAnswer, body, "only the trailing contract line is removed");
  assert.equal(g.grounded, true);
});

test("no files attached at all + general answer + no SOURCES_USED → not grounded, empty evidence", () => {
  const g = deriveGrounding({ finalAnswer: LONG, preparedFiles: [], usedFileTools: false });
  assert.equal(g.sourcesLine, "absent");
  assert.equal(g.grounded, false);
  assert.equal(g.evidenceSourceNames.size, 0);
});
