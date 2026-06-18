import { test } from "node:test";
import assert from "node:assert/strict";
import { pdfToChunks } from "../../src/lib/engine/pdf.ts";
import { join } from "node:path";
import { DOCUMENTS } from "../../src/lib/engine/documents.ts";

// docs/features/case-file-qa/03-tests.md Part 5: the page labels citations use
// must exist in the parsed document, and the $1,285 finding must live on Page 24
// of the court file (so [P:family-court#24] resolves to a real, correct page).

const DATA = join(process.cwd(), "data");
const fc = DOCUMENTS.find((d) => d.doc === "family-court")!;

test("the Final Judgment ($1,285) is on the court file's printed Page 24", () => {
  const chunks = pdfToChunks(join(DATA, fc.file), "family-court");
  const page24 = chunks.filter((c) => c.page === 24);
  assert.ok(page24.length > 0, "a Page-24 chunk exists");
  assert.ok(
    page24.some((c) => c.text.includes("1,285")),
    "the $1,285 child-support finding is on Page 24"
  );
});

test("citations use the document's own printed pages (not physical pdftotext pages)", () => {
  const chunks = pdfToChunks(join(DATA, fc.file), "family-court");
  const pages = new Set(chunks.map((c) => c.page));
  // The court file prints Page labels up to 24; physical pdftotext pages are ~8.
  assert.ok(pages.has(24), "page 24 is a citable page");
  assert.ok(Math.max(...pages) >= 24, "printed pagination (not the 8 physical pages) is used");
});

test("the Final Judgment is NOT in the narrative story PDF (C2 — no misattribution)", () => {
  const story = DOCUMENTS.find((d) => d.doc === "carter-story")!;
  const chunks = pdfToChunks(join(DATA, story.file), "carter-story");
  assert.ok(
    !chunks.some((c) => c.text.includes("1,285")),
    "the $1,285 Final-Judgment figure must not appear in the story PDF"
  );
});
