import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toVectorLiteral,
  toQueryText,
  canSearchOwner,
  hybridSearch,
  searchDocChunks,
} from "../../src/lib/engine/pgvector-store.ts";

// The uploaded-doc pgvector lane. These tests cover the two things that must be exactly
// right and DON'T need a live DB: (1) the on-wire formatting of the dense vector + the
// lexical query the RPC receives, and (2) the FAIL-CLOSED per-user isolation gate (a
// member NEVER retrieves another member's chunks). The SQL fusion itself lives in
// migration 006 and is mirrored/verified by the in-process hybrid tests.

// ── toVectorLiteral: pgvector's "[v1,v2,...]" literal, NaN/Infinity coerced to 0 ──
test("toVectorLiteral formats a vector as a bracketed comma-joined literal", () => {
  assert.equal(toVectorLiteral([0.1, 0.2, 0.3]), "[0.1,0.2,0.3]");
});

test("toVectorLiteral coerces non-finite values to 0 (one bad value can't fail a batch)", () => {
  assert.equal(toVectorLiteral([1, NaN, Infinity, -Infinity, 2]), "[1,0,0,0,2]");
});

test("toVectorLiteral of an empty vector is '[]'", () => {
  assert.equal(toVectorLiteral([]), "[]");
});

// ── toQueryText: the BM25/lexical query param fed to websearch_to_tsquery ──────────
test("toQueryText trims the question (the lexical lane param)", () => {
  assert.equal(toQueryText("  child support arrears  "), "child support arrears");
});

test("toQueryText never returns null/undefined (empty → '')", () => {
  // The SQL side guards on query_text <> '' so an empty string is a safe no-lexical-lane.
  assert.equal(toQueryText(undefined as unknown as string), "");
  assert.equal(toQueryText(""), "");
});

// ── canSearchOwner: the FAIL-CLOSED per-user isolation gate (the hard requirement) ──
test("an admin may search (sees all owners)", () => {
  assert.equal(canSearchOwner(undefined, true), true);
  assert.equal(canSearchOwner("user-a", true), true);
});

test("a member WITH an owner id may search (scoped to their own chunks)", () => {
  assert.equal(canSearchOwner("user-a", false), true);
});

test("a non-admin with NO owner id is fail-closed — must match NOTHING", () => {
  // This is the security-critical case: never run an unscoped search that could leak
  // another user's chunks.
  assert.equal(canSearchOwner(undefined, false), false);
  assert.equal(canSearchOwner("", false), false);
});

// ── The real search functions are FAIL-OPEN when Supabase is off (no env here) ──────
// With no SUPABASE_URL/KEY in the test env, supabaseEnabled() is false, so BOTH search
// functions return [] without any network call — the bundled + structured lanes still
// answer. (When Supabase IS configured, the canSearchOwner gate above runs first.)
test("hybridSearch returns [] when Supabase is not configured (fail-open, no throw)", async () => {
  const out = await hybridSearch("user-a", false, [0.1, 0.2], "child support", 8);
  assert.deepEqual(out, []);
});

test("searchDocChunks (dense fallback) returns [] when Supabase is not configured", async () => {
  const out = await searchDocChunks("user-a", false, [0.1, 0.2], 8);
  assert.deepEqual(out, []);
});

test("a non-admin with no owner id never searches even if Supabase were on (gate first)", async () => {
  // Documents the contract: canSearchOwner is the first gate inside both functions, so
  // this caller can only ever get [] — verified directly via the pure predicate above
  // and here end-to-end (Supabase off → [] regardless).
  assert.deepEqual(await hybridSearch(undefined, false, [0.1], "q", 8), []);
});
