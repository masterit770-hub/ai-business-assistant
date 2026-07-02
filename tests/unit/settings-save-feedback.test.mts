import { test } from "node:test";
import assert from "node:assert/strict";
import {
  interpretSaveResponse,
  interpretSaveThrow,
  GENERIC_SAVE_ERROR,
} from "../../src/lib/settings/save-feedback.ts";

// These drive the SAME save-feedback interpreter the live Answer Setup strip and the
// Settings → Prompts panel route their PUT result through. A green here means a failed
// save can NEVER be reported as "Saved" — the exact bug ("changing the prompt doesn't
// get saved" — a silent failure that showed a fake "Saved") this fix closes.

// ── the REGRESSION: a non-2xx response must be a failure, never a success ──────────

test("a 4xx response is a failure (NOT saved) and carries the route's error", () => {
  const out = interpretSaveResponse({
    ok: false,
    status: 400,
    body: { error: "Set a key for openai — selecting a cloud provider with no API key would leave the model unable to run." },
  });
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /Set a key for openai/);
});

test("a 500 response is a failure (NOT saved)", () => {
  const out = interpretSaveResponse({ ok: false, status: 500, body: { error: "failed to save settings" } });
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /failed to save settings/);
});

test("a non-ok response with NO usable error body falls back to the generic message (still a failure)", () => {
  // The exact silent-failure shape: the server rejected but gave no JSON error. The OLD
  // code swallowed this and showed "Saved"; the interpreter must report a failure.
  assert.deepEqual(interpretSaveResponse({ ok: false, status: 502, body: undefined }), {
    ok: false,
    error: GENERIC_SAVE_ERROR,
  });
  assert.deepEqual(interpretSaveResponse({ ok: false, status: 403, body: { not_error: "x" } }), {
    ok: false,
    error: GENERIC_SAVE_ERROR,
  });
  assert.deepEqual(interpretSaveResponse({ ok: false, status: 400, body: "plain text error page" }), {
    ok: false,
    error: GENERIC_SAVE_ERROR,
  });
});

test("an empty-string error in the body does NOT masquerade as a real message", () => {
  // A blank error must not surface as an empty error chip — fall back to the generic.
  assert.deepEqual(interpretSaveResponse({ ok: false, status: 400, body: { error: "   " } }), {
    ok: false,
    error: GENERIC_SAVE_ERROR,
  });
});

// ── success is ONLY a 2xx ──────────────────────────────────────────────────────────

test("a 2xx response is the ONLY success — and only then is 'Saved' shown", () => {
  assert.deepEqual(interpretSaveResponse({ ok: true, status: 200, body: { system_prompt: "x" } }), { ok: true });
  assert.deepEqual(interpretSaveResponse({ ok: true, status: 200 }), { ok: true });
});

// ── a thrown fetch (network failure / offline) is ALWAYS a failure ─────────────────

test("a thrown network error is a failure, surfacing its message", () => {
  const out = interpretSaveThrow(new Error("NetworkError when attempting to fetch resource."));
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /NetworkError/);
});

test("a thrown non-Error (or message-less error) falls back to the generic failure", () => {
  assert.deepEqual(interpretSaveThrow("boom"), { ok: false, error: GENERIC_SAVE_ERROR });
  assert.deepEqual(interpretSaveThrow(new Error("")), { ok: false, error: GENERIC_SAVE_ERROR });
  assert.deepEqual(interpretSaveThrow(undefined), { ok: false, error: GENERIC_SAVE_ERROR });
});
