import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, adminUser, NextResponseShim, readJson, makeFakeAdmin, mockExports } from "./_harness/harness.mts";

// ── Contract under test: POST /api/history/bulk-delete ─────────────────────────────
// Asserts the owner-isolation contract (member = owner-scoped, admin = unscoped),
// input validation (empty array, over-limit, bad shape), the Supabase-OFF honest-empty
// branch, and that the correct tables are deleted in the correct scoping. Uses the same
// recording fake-admin harness as the single-delete test so .in() / .eq() calls are
// captured and asserted.
//
// NOTE: the route ONLY forwards valid-UUID and "row:<uuid>" session IDs to the DB (so
// that non-UUID strings never cause a Postgres "invalid input syntax for type uuid" 500).
// All session_id values in these tests are therefore valid v4 UUIDs.

// Stable UUID fixtures for testing (no real DB, these are just tokens for the fake harness).
const UUID_S1 = "11111111-1111-1111-1111-111111111111";
const UUID_S2 = "22222222-2222-2222-2222-222222222222";
const UUID_S3 = "33333333-3333-3333-3333-333333333333";
const UUID_S9 = "99999999-9999-9999-9999-999999999999";

let current: ReturnType<typeof user> | null = user();
let supaOn = true;
let fake = makeFakeAdmin();

// Records calls to the removeOriginalFile stub so tests can assert it was invoked
// with the correct ownerId and docId.
const removeCalls: { ownerId: string; docId: string }[] = [];
// The caller's _files.json manifest, as the route reads it via listManifestEntries().
// The route discovers which docs belong to the deleted sessions FROM THIS LIST (it is
// the single source of truth since the doc_chunks discovery path was removed) — each
// test seeds the entries it needs. listCalls records the owner the route asked for.
let manifestEntries: { docId: string; displayName?: string; type?: string; session_id: string | null }[] = [];
const manifestListCalls: string[] = [];

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/supabase", { supabaseEnabled: () => supaOn, admin: () => fake.client });
  // Stub doc-files with BOTH exports the route imports (a partial mock namespace makes
  // the route's import itself throw). listManifestEntries mirrors the real read contract:
  // owner-scoped, no chat filter → every entry.
  mockExports("@/lib/engine/doc-files", {
    removeOriginalFile: async (ownerId: string, docId: string) => {
      removeCalls.push({ ownerId, docId });
    },
    listManifestEntries: async (ownerId: string) => {
      manifestListCalls.push(ownerId);
      return manifestEntries;
    },
  });
});

beforeEach(() => {
  current = user();
  supaOn = true;
  fake = makeFakeAdmin();
  removeCalls.length = 0;
  manifestEntries = [];
  manifestListCalls.length = 0;
});

async function POST(body: unknown) {
  const mod = await import("@/app/api/history/bulk-delete/route.ts");
  return mod.POST(
    new Request("http://x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

// ── 1. Unauthenticated → 401 ─────────────────────────────────────────────────────
test("unauthenticated → 401", async () => {
  current = null;
  const { status } = await readJson(await POST({ session_ids: [UUID_S1] }));
  assert.equal(status, 401);
});

// ── 2. Supabase OFF → { deleted: 0 }, never 500 ──────────────────────────────────
test("Supabase OFF → honest { deleted: 0 }, never 500", async () => {
  supaOn = false;
  const { status, body } = await readJson(await POST({ session_ids: [UUID_S1, UUID_S2] }));
  assert.equal(status, 200);
  assert.equal(body.deleted, 0);
  // No DB calls should have been made.
  assert.equal(fake.calls.length, 0);
});

// ── 3. Empty array → { deleted: 0 } fast-path, no DB calls ──────────────────────
test("empty session_ids → { deleted: 0 } fast-path with no DB calls", async () => {
  const { status, body } = await readJson(await POST({ session_ids: [] }));
  assert.equal(status, 200);
  assert.equal(body.deleted, 0);
  assert.equal(fake.calls.length, 0, "must not hit the DB for an empty array");
});

// ── 4. Over the 100-id limit → 400 ───────────────────────────────────────────────
test("over 100 session_ids → 400", async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `s${i}`);
  const { status } = await readJson(await POST({ session_ids: ids }));
  assert.equal(status, 400);
});

// ── 5. Invalid body → 400 ────────────────────────────────────────────────────────
test("non-array session_ids → 400", async () => {
  const { status } = await readJson(await POST({ session_ids: "s1" }));
  assert.equal(status, 400);
});

test("missing session_ids field → 400", async () => {
  const { status } = await readJson(await POST({ foo: "bar" }));
  assert.equal(status, 400);
});

// ── 6. MEMBER: ask_history delete IS owner-scoped ────────────────────────────────
test("MEMBER: ask_history delete is scoped by owner_id", async () => {
  current = user({ id: "mem-1", role: "user" });
  fake = makeFakeAdmin({
    on: { "ask_history:delete": () => ({ data: [{ id: "1" }] }) },
  });
  const { status } = await readJson(await POST({ session_ids: [UUID_S1] }));
  assert.equal(status, 200);
  const del = fake.calls.find((c) => c.table === "ask_history" && c.op === "delete");
  assert.ok(del, "must call ask_history delete");
  assert.equal(del!.eq["owner_id"], "mem-1", "member's ask_history delete must be owner-scoped");
  assert.deepEqual(del!.eq["in:session_id"], [UUID_S1], "must use .in('session_id', ids)");
});

// ── 7. MEMBER: session_titles delete IS owner-scoped ─────────────────────────────
test("MEMBER: session_titles delete is scoped by owner_id", async () => {
  current = user({ id: "mem-2", role: "user" });
  const { status } = await readJson(await POST({ session_ids: [UUID_S1, UUID_S2] }));
  assert.equal(status, 200);
  const del = fake.calls.find((c) => c.table === "session_titles" && c.op === "delete");
  assert.ok(del, "must call session_titles delete");
  assert.equal(del!.eq["owner_id"], "mem-2", "member's session_titles delete must be owner-scoped");
  assert.deepEqual(del!.eq["in:session_id"], [UUID_S1, UUID_S2]);
});

// ── 8. Legacy RAG tables are NOT touched (they were removed with the RAG excision) ─
// The route deletes ask_history + session_titles and cleans Storage via the manifest.
// doc_chunks/uploaded_rows writes were removed deliberately — nothing reads them.
// This pin makes any accidental re-introduction visible.
test("bulk-delete does NOT touch the orphaned doc_chunks/uploaded_rows tables", async () => {
  current = user({ id: "mem-3", role: "user" });
  const { status } = await readJson(await POST({ session_ids: [UUID_S9] }));
  assert.equal(status, 200);
  for (const tbl of ["doc_chunks", "uploaded_rows"]) {
    assert.equal(fake.calls.find((c) => c.table === tbl), undefined,
      `${tbl} is orphaned — the route must not touch it`);
  }
});

// ── 9. ADMIN: ask_history delete IS owner-scoped (post-incident fix) ────────────
// RED-FIRST: before the fix, `if (!isAdmin)` guarded the owner filter, so an admin's
// delete had no owner_id constraint → could wipe another user's rows. This test proves
// the fix: admin bulk-delete MUST also carry .eq("owner_id", adminId).
test("ADMIN: ask_history delete IS owner-scoped — admin cannot delete another owner's rows", async () => {
  current = adminUser({ id: "adm-1" });
  fake = makeFakeAdmin({
    on: { "ask_history:delete": () => ({ data: [{ id: "1" }, { id: "2" }] }) },
  });
  const { status } = await readJson(await POST({ session_ids: [UUID_S1, UUID_S2] }));
  assert.equal(status, 200);
  const del = fake.calls.find((c) => c.table === "ask_history" && c.op === "delete");
  assert.ok(del, "must call ask_history delete");
  assert.equal(
    del!.eq["owner_id"],
    "adm-1",
    "admin's ask_history delete MUST be owner-scoped (post-incident fix — no cross-owner wipe)"
  );
});

// ── 11. ADMIN: every table delete scoped by owner_id — no cross-owner wipe ────────
// RED-FIRST heritage: the original code had `if (!isAdmin)` guards on the delete
// operations, letting an admin wipe other owners' rows (the cross-owner-wipe incident).
// The route's tables are ask_history + session_titles now (doc_chunks/uploaded_rows
// were removed with the RAG excision — see the no-touch pin above); EVERY one the
// route deletes from must carry the admin's own owner_id.
test("ADMIN: every table delete is owner-scoped — ask_history, session_titles", async () => {
  current = adminUser({ id: "adm-2" });
  fake = makeFakeAdmin({
    on: { "ask_history:delete": () => ({ data: [{ id: "r1" }] }) },
  });
  const { status } = await readJson(await POST({ session_ids: [UUID_S1] }));
  assert.equal(status, 200);

  const tablesCalled = new Set(fake.calls.map((c) => c.table));
  for (const tbl of ["ask_history", "session_titles"]) {
    assert.ok(tablesCalled.has(tbl), `must attempt delete on ${tbl}`);
    const del = fake.calls.find((c) => c.table === tbl && c.op === "delete");
    assert.equal(
      del!.eq["owner_id"],
      "adm-2",
      `${tbl} delete must carry owner_id=adm-2 (admin cannot cross-wipe)`
    );
  }
});

// ── 10. Returns { deleted: N } from the ask_history delete count ─────────────────
test("returns { deleted: N } equal to the ask_history rows returned", async () => {
  current = user({ id: "mem-4", role: "user" });
  fake = makeFakeAdmin({
    on: {
      "ask_history:delete": () => ({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
    },
  });
  const { status, body } = await readJson(await POST({ session_ids: [UUID_S1, UUID_S2, UUID_S3] }));
  assert.equal(status, 200);
  assert.equal(body.deleted, 3, "deleted count must match the ask_history rows removed");
});

// ── 12. Storage blob + manifest removal is wired into the bulk-delete path ───────────
// RED-FIRST: before this fix, bulk-deleting a chat left the Storage blob and _files.json
// entry intact — so the agentic engine still saw the deleted file. These tests prove
// the wiring: removeOriginalFile is called for each doc_id found in the deleted sessions,
// owner-scoped to the CALLER (never another owner).

test("bulk-delete: removeOriginalFile called for each manifest doc in the deleted sessions — and ONLY those", async () => {
  current = user({ id: "mem-5", role: "user" });
  fake = makeFakeAdmin({
    on: { "ask_history:delete": () => ({ data: [{ id: "h1" }] }) },
  });
  // Two docs tagged to the session being deleted, one tagged to a DIFFERENT session:
  // the survivor must NOT be removed (the session filter is part of the contract).
  manifestEntries = [
    { docId: "file-alpha", session_id: UUID_S1 },
    { docId: "file-beta", session_id: UUID_S1 },
    { docId: "file-survivor", session_id: UUID_S9 },
  ];
  const { status } = await readJson(await POST({ session_ids: [UUID_S1] }));
  assert.equal(status, 200);
  assert.equal(removeCalls.length, 2, "must call removeOriginalFile once per doc in the deleted sessions");
  const docIds = removeCalls.map((c) => c.docId).sort();
  assert.deepEqual(docIds, ["file-alpha", "file-beta"].sort());
  assert.deepEqual(manifestListCalls, ["mem-5"], "manifest must be read for the CALLER");
});

test("bulk-delete: removeOriginalFile is ALWAYS called with the CALLER's owner_id", async () => {
  current = user({ id: "mem-6", role: "user" });
  fake = makeFakeAdmin({
    on: { "ask_history:delete": () => ({ data: [{ id: "h2" }] }) },
  });
  manifestEntries = [{ docId: "some-doc", session_id: UUID_S1 }];
  await readJson(await POST({ session_ids: [UUID_S1] }));
  for (const call of removeCalls) {
    assert.equal(
      call.ownerId,
      "mem-6",
      `removeOriginalFile must use the caller's owner_id, got '${call.ownerId}'`
    );
  }
});

test("bulk-delete: removeOriginalFile NOT called when no doc_ids are tagged to the sessions", async () => {
  current = user({ id: "mem-7", role: "user" });
  fake = makeFakeAdmin({
    on: {
      "ask_history:delete": () => ({ data: [{ id: "h3" }] }),
    },
  });
  // A manifest with docs — but none tagged to the sessions being deleted.
  manifestEntries = [{ docId: "unrelated-doc", session_id: UUID_S9 }];
  await readJson(await POST({ session_ids: [UUID_S1] }));
  assert.equal(removeCalls.length, 0, "must not call removeOriginalFile when no docs are tagged");
});

test("bulk-delete: removeOriginalFile NOT called when Supabase is OFF", async () => {
  supaOn = false;
  current = user({ id: "mem-8", role: "user" });
  await readJson(await POST({ session_ids: [UUID_S1] }));
  assert.equal(removeCalls.length, 0, "must not call removeOriginalFile when Supabase is disabled");
});
