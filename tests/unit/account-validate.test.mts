import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validatePassword,
  validateDisplayName,
  resolveDisplayLabel,
  MIN_PASSWORD_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
} from "../../src/lib/account/validate.ts";

// These drive the SAME validators the live Account panel calls before it hits
// Supabase — a green here means the form gates the way these assert.

// ── password ────────────────────────────────────────────────────────────────

test("password: empty new OR empty confirm is rejected with the enter/confirm message", () => {
  assert.deepEqual(validatePassword("", ""), {
    ok: false,
    error: "Enter and confirm your new password.",
  });
  assert.equal(validatePassword("longenough", "").ok, false);
  assert.equal(validatePassword("", "longenough").ok, false);
});

test("password: shorter than the minimum is rejected (and the floor is 6)", () => {
  assert.equal(MIN_PASSWORD_LENGTH, 6);
  const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
  const r = validatePassword(short, short);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /at least 6 characters/);
});

test("password: a length-mismatch passes length but fails on mismatch", () => {
  const r = validatePassword("correct-horse", "battery-staple");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /don’t match/);
});

test("password: a long, matching pair is accepted", () => {
  assert.deepEqual(validatePassword("hunter2hunter2", "hunter2hunter2"), { ok: true });
});

test("password: exactly the minimum length, matching, is accepted (boundary)", () => {
  const exact = "x".repeat(MIN_PASSWORD_LENGTH);
  assert.deepEqual(validatePassword(exact, exact), { ok: true });
});

// ── display name ──────────────────────────────────────────────────────────────

test("display name: blank / whitespace-only is rejected", () => {
  assert.equal(validateDisplayName("").ok, false);
  assert.equal(validateDisplayName("   ").ok, false);
});

test("display name: a valid name is trimmed and returned", () => {
  assert.deepEqual(validateDisplayName("  Jenny Cohen  "), { ok: true, value: "Jenny Cohen" });
});

test("display name: over the max length is rejected", () => {
  const tooLong = "n".repeat(MAX_DISPLAY_NAME_LENGTH + 1);
  const r = validateDisplayName(tooLong);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /80 characters or fewer/);
});

test("display name: exactly the max length is accepted (boundary)", () => {
  const exact = "n".repeat(MAX_DISPLAY_NAME_LENGTH);
  assert.deepEqual(validateDisplayName(exact), { ok: true, value: exact });
});

// ── resolveDisplayLabel (shared by the user menu + account page) ────────────────

test("resolveDisplayLabel: prefers a non-empty display name", () => {
  assert.equal(resolveDisplayLabel("Jenny", "jenny@acme.com"), "Jenny");
});

test("resolveDisplayLabel: a blank/whitespace name falls back to email", () => {
  assert.equal(resolveDisplayLabel("", "jenny@acme.com"), "jenny@acme.com");
  assert.equal(resolveDisplayLabel("   ", "jenny@acme.com"), "jenny@acme.com");
  assert.equal(resolveDisplayLabel(null, "jenny@acme.com"), "jenny@acme.com");
});

test("resolveDisplayLabel: no name and no email → the neutral placeholder", () => {
  assert.equal(resolveDisplayLabel(null, null), "Not signed in");
  assert.equal(resolveDisplayLabel(undefined, undefined), "Not signed in");
});
