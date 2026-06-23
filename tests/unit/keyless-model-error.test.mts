import { test } from "node:test";
import assert from "node:assert/strict";
import { friendlyAskError } from "../../src/lib/engine/error-message.ts";
import {
  CloudProviderNotConfiguredError,
  CloudProviderAuthError,
  HipaaNotConfiguredError,
  LocalUnreachableError,
  isCloudProviderAuth,
  isCloudProviderNotConfigured,
  isModelRunFailure,
} from "../../src/lib/engine/llm.ts";

// ── THE NEW REQUIREMENT (the bug class this pins) ────────────────────────────────
// A misconfigured / keyless / bad-key MODEL must surface a CLEAR, actionable error and
// produce NO answer — it must NOT silently degrade to a generic 'general' answer (a
// failed model masquerading as a real reply). These tests pin the two pieces that live
// in pure, unit-testable code:
//   1. The TYPED errors (keyless = CloudProviderNotConfiguredError; rejected key 401/403
//      = CloudProviderAuthError) and the isModelRunFailure() predicate the answer
//      pipeline keys off to RE-THROW (never swallow into 'general').
//   2. friendlyAskError() turning those into the clear "set/fix your model key in
//      Settings → Models. No answer was generated." line — never the calm generic
//      "something went wrong" (which would hide the real cause), and never a fake answer.

test("keyless cloud provider → typed CloudProviderNotConfiguredError, recognized as a model-run failure", () => {
  const e = new CloudProviderNotConfiguredError("openai");
  assert.equal(isCloudProviderNotConfigured(e), true);
  assert.equal(isModelRunFailure(e), true, "a keyless provider must be treated as a model-run failure (re-thrown, never swallowed)");
});

test("rejected key (401) → typed CloudProviderAuthError, recognized as a model-run failure", () => {
  const e = new CloudProviderAuthError("gemini", 401);
  assert.equal(isCloudProviderAuth(e), true);
  assert.equal(e.status, 401);
  assert.equal(isModelRunFailure(e), true);
});

test("rejected key (403) → typed CloudProviderAuthError", () => {
  const e = new CloudProviderAuthError("azure", 403);
  assert.equal(isCloudProviderAuth(e), true);
  assert.equal(e.status, 403);
});

test("HIPAA-not-configured and Local-unreachable are ALSO model-run failures (must propagate, not 'general')", () => {
  assert.equal(isModelRunFailure(new HipaaNotConfiguredError("no Azure key is saved")), true);
  assert.equal(isModelRunFailure(new LocalUnreachableError("http://localhost:11434/v1", "ECONNREFUSED")), true);
});

test("a plain non-model error is NOT a model-run failure (so an ordinary glitch is not mistaken for a config error)", () => {
  assert.equal(isModelRunFailure(new Error("structured query failed: bad SQL")), false);
  assert.equal(isModelRunFailure(new Error("something random")), false);
});

// ── friendlyAskError: the CLEAR, actionable line (never the generic punt) ─────────

test("friendlyAskError(keyless cloud) → names the fix location + says NO answer was generated, and NAMES the provider", () => {
  const line = friendlyAskError(new CloudProviderNotConfiguredError("openai"));
  assert.match(line, /Settings → Models/i, "must point the user to the fix location");
  assert.match(line, /no answer/i, "must make plain that no answer was produced (not a fake answer)");
  assert.match(line, /openai/, "should name the selected provider");
  assert.doesNotMatch(line, /something went wrong/i, "must NOT be the calm generic line that hides the cause");
});

test("friendlyAskError(rejected key 401) → the SAME clear 'key isn't working' guidance", () => {
  const line = friendlyAskError(new CloudProviderAuthError("gemini", 401));
  assert.match(line, /key isn'?t set or isn'?t working/i);
  assert.match(line, /Settings → Models/i);
  assert.match(line, /gemini/);
});

test("friendlyAskError(blob-shaped 401 from an untyped path) → still the clear key guidance, NOT a raw blob", () => {
  // An older/untyped path can still throw the "<provider> (<model>) 401: <body>" string.
  const line = friendlyAskError(new Error("deepseek (deepseek-chat) 401: {\"error\":\"invalid key\"}"));
  assert.match(line, /Settings → Models/i);
  // The raw provider body must never reach the user.
  assert.doesNotMatch(line, /\{|invalid key/i);
});

test("friendlyAskError(rate limit) is unchanged (a 429 is NOT a key problem)", () => {
  const line = friendlyAskError(new Error("deepseek (deepseek-chat) 429: rate limit"));
  assert.match(line, /rate limit/i);
  assert.doesNotMatch(line, /Settings → Models/i);
});

test("friendlyAskError(unknown error) stays the calm generic line (no false key blame)", () => {
  const line = friendlyAskError(new Error("ECONNRESET while streaming"));
  assert.match(line, /something went wrong/i);
});
