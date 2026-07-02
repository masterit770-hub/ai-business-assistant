import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  bundledFileFor,
  readBundledFile,
  mimeForName,
  storageKeyForDocId,
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

// ── Storage key encoding — Hebrew (non-ASCII) filename round-trip ──────────────
//
// ROOT CAUSE: Supabase Storage rejects object keys containing non-ASCII bytes.
// Her scheduling files have Hebrew names (e.g. שיבוצים-יוני-2024.xlsx) → the
// docId is Hebrew → storagePath() produced a raw Hebrew key → Storage rejected it
// silently → no bytes reached Storage → the agentic engine's workdir was EMPTY →
// "who participates the most?" returned "no files in working directory".
//
// NOTE: percent-encoding (encodeURIComponent) is NOT sufficient — the Supabase
// Storage REST API framework URL-decodes path parameters before the key validator
// runs, so "%D7%A9..." → Hebrew → still rejected. The fix uses SHA-256 hex digest
// of the docId as the Storage key — 64 lowercase hex chars, purely ASCII.
//
// FIX: storageKeyForDocId(docId) returns SHA-256(docId) as a 64-char hex string.
// The key is deterministic (same docId → same key always). The original Hebrew
// filename is preserved separately as displayName in the _files.json manifest.
//
// RED-FIRST PROOF: with the OLD code (raw docId as key), the key WAS Hebrew →
// /[^\x00-\x7F]/.test(oldKey) was TRUE (non-ASCII). With the NEW code (SHA-256
// hex digest), all chars are hex digits — /[^\x00-\x7F]/.test(newKey) is FALSE.

function sha256hex(str: string): string {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

test("storageKeyForDocId: Hebrew docId produces ASCII-only Storage key (non-ASCII round-trip)", () => {
  // The real filename she uploaded — docIdFromFilename strips the extension and
  // normalizes: "שיבוצים יוני 2024 - סיון תשפד (1).xlsx" → docId "שיבוצים-יוני-2024-סיון-תשפד-1"
  const hebrewDocId = "שיבוצים-יוני-2024-סיון-תשפד-1";

  // OLD behaviour (what caused the bug): raw docId used as the Storage key.
  // Demonstrates the bug is real — the old key CONTAINS non-ASCII bytes.
  const oldBuggyKey = hebrewDocId; // what storagePath() returned before this fix
  assert.ok(
    /[^\x00-\x7F]/.test(oldBuggyKey),
    "OLD (buggy) key contains non-ASCII chars — would be rejected by Supabase Storage"
  );

  // NEW behaviour after the fix: SHA-256 hex produces an ASCII-only key.
  const newKey = storageKeyForDocId(hebrewDocId);
  assert.ok(
    !/[^\x00-\x7F]/.test(newKey),
    "NEW key is ASCII-only — safe for Supabase Storage object keys"
  );
  // The key must be exactly 64 hex chars (SHA-256 output).
  assert.equal(newKey.length, 64, "SHA-256 key is 64 hex chars");
  assert.match(newKey, /^[0-9a-f]{64}$/, "key is lowercase hex only");
  // The key must be deterministic — same docId always produces the same key.
  assert.equal(
    storageKeyForDocId(hebrewDocId),
    sha256hex(hebrewDocId),
    "key matches expected SHA-256 of the Hebrew docId"
  );
});

test("storageKeyForDocId: different docIds produce different keys (collision resistance)", () => {
  // SHA-256 must produce distinct keys for distinct docIds.
  const key1 = storageKeyForDocId("שיבוצים-יוני-2024");
  const key2 = storageKeyForDocId("שיבוצים-אוגוסט-2024");
  const key3 = storageKeyForDocId("family-court");
  assert.notEqual(key1, key2, "different Hebrew docIds → different keys");
  assert.notEqual(key1, key3, "Hebrew vs ASCII docId → different keys");
  // All must still be ASCII-only 64-char hex strings.
  [key1, key2, key3].forEach((k) => {
    assert.match(k, /^[0-9a-f]{64}$/, "all keys are 64-char lowercase hex");
  });
});

test("storageKeyForDocId: CJK and Arabic filenames also produce ASCII-safe keys (general fix)", () => {
  // Confirm the fix is general, not Hebrew-specific.
  const arabicDocId = "تقرير-2024";
  const cjkDocId = "报告-2024";
  [arabicDocId, cjkDocId].forEach((id) => {
    const key = storageKeyForDocId(id);
    assert.ok(
      !/[^\x00-\x7F]/.test(key),
      `${id}: encoded key must be ASCII-only`
    );
    assert.match(key, /^[0-9a-f]{64}$/, `${id}: key is 64-char lowercase hex`);
    // Determinism: calling again returns same key.
    assert.equal(storageKeyForDocId(id), key, `${id}: key is deterministic`);
  });
});
