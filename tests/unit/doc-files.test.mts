import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bundledFileFor,
  readBundledFile,
  mimeForName,
} from "../../src/lib/engine/doc-files.ts";

// The DOWNLOAD/VIEW lane for documents. These drive the REAL bundled-file mapping that
// /api/documents/file uses: a bundled doc id resolves to its committed source file
// under data/, and the bytes read back are the actual PDF (starts with %PDF). An
// unknown id returns null (→ the route falls through to the uploaded-doc path, not a
// crash). (The Supabase-backed uploaded-file path needs live Storage; it's covered by
// the route + integration, not this offline unit.)

test("a bundled doc id maps to its committed source PDF under data/", () => {
  const fc = bundledFileFor("family-court");
  assert.ok(fc, "family-court resolves to a committed file");
  assert.equal(fc!.contentType, "application/pdf");
  assert.match(fc!.filename, /FAMILY COURT/i);

  const story = bundledFileFor("carter-story");
  assert.ok(story, "carter-story resolves to a committed file");
  assert.equal(story!.contentType, "application/pdf");
});

test("reading a bundled file returns the real PDF bytes (%PDF magic)", async () => {
  const fc = bundledFileFor("family-court")!;
  const bytes = await readBundledFile(fc);
  assert.ok(bytes.byteLength > 1000, "non-trivial file size");
  const head = new TextDecoder().decode(bytes.slice(0, 5));
  assert.equal(head, "%PDF-", "the streamed bytes are a real PDF");
});

test("a non-bundled (uploaded) doc id has no bundled file → null (route falls through)", () => {
  assert.equal(bundledFileFor("some-uploaded-doc-123"), null);
  assert.equal(bundledFileFor(""), null);
});

test("mimeForName picks the right content type by extension", () => {
  assert.equal(mimeForName("report.pdf"), "application/pdf");
  assert.equal(mimeForName("data.csv"), "text/csv");
  assert.equal(
    mimeForName("book.xlsx"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  assert.equal(mimeForName("weird.bin"), "application/octet-stream");
});
