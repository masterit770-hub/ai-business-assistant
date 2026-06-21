import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldOcrPage, pagesNeedingOcr } from "../../src/lib/engine/ocr.ts";

// OCR is BEST-EFFORT enrichment (Tesseract may not run on a constrained serverless
// function), but the DECISION of WHICH pages are scans needing OCR is pure + must be
// right: we only OCR pages whose text layer is effectively empty, and never more than
// the cap. These tests pin that decision without touching Tesseract/PDF rendering.

// ── shouldOcrPage: a page is a scan candidate when its text layer is near-empty ──
test("an empty / whitespace-only page is a scan candidate", () => {
  assert.equal(shouldOcrPage(""), true);
  assert.equal(shouldOcrPage("   \n\t  "), true);
});

test("a born-digital page with real text is NOT a scan candidate", () => {
  const realPage = "In the Matter of: Joni Carter (Petitioner) vs. Michel Carter (Respondent). ".repeat(3);
  assert.equal(shouldOcrPage(realPage), false);
});

test("a page with only a few stray glyphs (below the threshold) IS a candidate", () => {
  assert.equal(shouldOcrPage("• 1"), true); // 2 non-whitespace chars ≤ 12
});

test("the minChars threshold is configurable", () => {
  const page = "abcdefghij"; // 10 non-whitespace chars
  assert.equal(shouldOcrPage(page, 12), true); // ≤ 12 → candidate
  assert.equal(shouldOcrPage(page, 5), false); // > 5 → not a candidate
});

// ── pagesNeedingOcr: the 0-based indices to OCR, capped at maxPages, in order ──
test("returns the 0-based indices of low-text pages only", () => {
  const pages = ["lots of real text ".repeat(20), "", "more real text ".repeat(20), "  "];
  assert.deepEqual(pagesNeedingOcr(pages, 5), [1, 3]); // indices 1 and 3 are empty
});

test("caps the number of OCR'd pages at maxPages (cheapest: document order)", () => {
  const pages = ["", "", "", "", ""]; // all scans
  assert.deepEqual(pagesNeedingOcr(pages, 2), [0, 1]); // only the first 2
});

test("a fully born-digital document needs no OCR (empty list)", () => {
  const pages = ["real text ".repeat(30), "real text ".repeat(30)];
  assert.deepEqual(pagesNeedingOcr(pages, 5), []);
});
