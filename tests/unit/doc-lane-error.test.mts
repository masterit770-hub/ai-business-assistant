import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSurfaceDocLaneError } from "../../src/lib/engine/answer.ts";

// QA #4: when File Search (the uploaded-doc lane) fails, an UPLOADED-doc question
// must surface the honest "couldn't search your uploaded documents" error — NOT a
// silent answer from the always-returned bundled Carter chunks. A genuine bundled
// question still answers despite a blip; a structured-backed turn still answers.

const E = "Gemini quota exhausted";

test("uploaded-doc question + File Search failed → honest error (even with bundled chunks present)", () => {
  // local index always returns its top-k Carter chunks, so chunkCount>0 here.
  assert.equal(
    shouldSurfaceDocLaneError({ fileSearchError: E, rowCount: 0, chunkCount: 8, targetedUploadedDoc: true }),
    true
  );
});

test("File Search failed + NO evidence at all → honest error", () => {
  assert.equal(
    shouldSurfaceDocLaneError({ fileSearchError: E, rowCount: 0, chunkCount: 0, targetedUploadedDoc: false }),
    true
  );
});

test("genuine bundled (Carter) question + File Search blip → still answers (NOT an error)", () => {
  // no uploaded-doc target → the bundled chunks are a valid answer despite the blip.
  assert.equal(
    shouldSurfaceDocLaneError({ fileSearchError: E, rowCount: 0, chunkCount: 8, targetedUploadedDoc: false }),
    false
  );
});

test("structured-backed turn + File Search blip → still answers (rows present)", () => {
  assert.equal(
    shouldSurfaceDocLaneError({ fileSearchError: E, rowCount: 5, chunkCount: 0, targetedUploadedDoc: true }),
    false
  );
});

test("File Search succeeded (no error) → never the honest-error path", () => {
  assert.equal(
    shouldSurfaceDocLaneError({ fileSearchError: null, rowCount: 0, chunkCount: 0, targetedUploadedDoc: true }),
    false
  );
});
