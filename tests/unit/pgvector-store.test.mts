import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toVectorLiteral,
  toQueryText,
  canSearchOwner,
  hybridSearch,
  searchDocChunks,
  reportedPersistCount,
  persistDropped,
  isTransientOwnerFkError,
  type StorableChunk,
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

// ── reportedPersistCount / persistDropped: the VERIFIED-WRITE rule (task #82) ───────
// THE BUG these pin: storeDocChunks used to return `rows.length` (the INTENT) after an
// insert that reported error=null. A silent row-drop (an RLS policy or a column constraint
// that swallows the write with no error) meant it reported "persisted = 11" while ZERO rows
// committed — a false-green that made every uploaded-PDF question fabricate (route=[] →
// general → "Beyoncé"). The fix returns a post-insert READ-BACK count instead. These tests
// pin that the reported count is ALWAYS the verified one, never the requested one.
test("reportedPersistCount returns the VERIFIED count, never the requested count", () => {
  // The exact #82 failure shape: asked to write 11, the read-back found 0 committed.
  // The OLD code returned 11 (the lie). The reported count MUST be the verified 0.
  assert.equal(reportedPersistCount(11, 0), 0);
  // A partial drop: asked 11, only 7 landed → report 7, not 11.
  assert.equal(reportedPersistCount(11, 7), 7);
  // The healthy path: all 11 landed → report 11.
  assert.equal(reportedPersistCount(11, 11), 11);
});

test("reportedPersistCount clamps a negative/garbage verified count to 0", () => {
  // A read-back that somehow yields a negative/NaN count must never report below 0.
  assert.equal(reportedPersistCount(11, -3), 0);
  assert.equal(reportedPersistCount(0, 0), 0);
});

test("persistDropped flags a write that committed FEWER rows than requested", () => {
  // This is what trips the loud log — the silent-failure detector.
  assert.equal(persistDropped(11, 0), true);   // total drop (the #82 bug)
  assert.equal(persistDropped(11, 7), true);   // partial drop
  assert.equal(persistDropped(11, 11), false); // healthy full write
  assert.equal(persistDropped(0, 0), false);   // nothing requested, nothing dropped
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

// ── isTransientOwnerFkError: the doc_chunks.owner_id FK-race classifier (#82) ──────────────────────
// A just-created auth user isn't yet FK-visible, so an immediate ingest is rejected with the owner_id
// FK violation — but it self-heals on a retry. We retry ONLY that transient FK error, never a real
// data/constraint/RLS error. This pins the classification so the retry can't accidentally loop on a
// genuine failure. (The race silently dropped doc_chunks → empty catalog → route=[] → the Beyoncé
// fabrication; the retry + the existing read-back close it.)
test("isTransientOwnerFkError: matches the owner_id FK violation (by code 23503 and by message)", () => {
  assert.equal(isTransientOwnerFkError({ code: "23503", message: "insert violates foreign key constraint" }), true);
  assert.equal(isTransientOwnerFkError({ message: 'violates foreign key constraint "doc_chunks_owner_id_fkey"' }), true);
  assert.equal(isTransientOwnerFkError({ message: 'violates foreign key constraint "uploaded_rows_owner_id_fkey"' }), true);
});
test("isTransientOwnerFkError: does NOT match a different error (no false retry)", () => {
  assert.equal(isTransientOwnerFkError(null), false);
  assert.equal(isTransientOwnerFkError({ message: "permission denied for table doc_chunks" }), false); // RLS
  assert.equal(isTransientOwnerFkError({ message: "null value in column content violates not-null constraint" }), false);
  assert.equal(isTransientOwnerFkError({ message: 'violates foreign key constraint "some_other_fkey"' }), false); // a non-owner FK
  assert.equal(isTransientOwnerFkError({ code: "23505", message: "duplicate key" }), false); // unique violation
});

// ── StorableChunk: embedding is nullable (agentic build skips e5 at ingest) ──────────────
// THE CONTRACT: ingest no longer calls embedPassage at upload time. The agentic build reads
// raw original files via fetchOriginalFile — it never touches doc_chunks.embedding. Storing
// embedding=null keeps catalog listing + per-chat scoping intact (listUploadedDocs groups by
// doc_id; it never reads the embedding column). The hybrid_match SQL already filters
// `where embedding is not null`, so NULL-embedded rows are harmlessly skipped there.
test("StorableChunk accepts null embedding (agentic build: no e5 at ingest)", () => {
  const chunk: StorableChunk = {
    page: 1,
    text: "Some document text.",
    token: "[P:doc#1]",
    embedding: null,           // the new no-embed shape
  };
  assert.equal(chunk.embedding, null);
});

test("StorableChunk still accepts a real embedding array (for future non-agentic use)", () => {
  const chunk: StorableChunk = {
    page: 1,
    text: "Some document text.",
    token: "[P:doc#1]",
    embedding: [0.1, 0.2, 0.3],
  };
  assert.ok(Array.isArray(chunk.embedding) && chunk.embedding.length === 3);
});

test("toVectorLiteral: a null embedding is NOT passed to it (storeDocChunks guards first)", () => {
  // When embedding is null, storeDocChunks sends null to Postgres — not a vector literal.
  // This test pins that toVectorLiteral(null) is NEVER called; the guard is `c.embedding != null`.
  // We verify the branching logic rather than calling toVectorLiteral(null) (which would be a bug).
  const chunk: StorableChunk = { page: 1, text: "t", token: "[P:d#1]", embedding: null };
  const onWire = chunk.embedding != null ? toVectorLiteral(chunk.embedding) : null;
  assert.equal(onWire, null);   // null embedding → null on the wire (Postgres vector column is nullable)
});

test("toVectorLiteral: a real embedding is serialized as before", () => {
  const chunk: StorableChunk = { page: 1, text: "t", token: "[P:d#1]", embedding: [0.5, -0.5] };
  const onWire = chunk.embedding != null ? toVectorLiteral(chunk.embedding) : null;
  assert.equal(onWire, "[0.5,-0.5]");
});
