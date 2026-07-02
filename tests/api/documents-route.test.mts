import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, adminUser, NextResponseShim, readJson, mockExports, makeFakeAdmin } from "./_harness/harness.mts";

// ── Contract under test: GET/DELETE /api/documents ────────────────────────────────
// The privilege + isolation wiring is the thing under test:
//   • a MEMBER may only delete their OWN upload; a bundled (shared) source delete is
//     ADMIN-ONLY (a member → 403) — the privilege-escalation guard.
//   • the uploaded-doc list is OWNER-SCOPED (a member passes their own id; an admin
//     passes undefined = all).
//   • the bundled corpus is gated to DEMO accounts (a real client user → []).
// The engine stores are stubbed; the handler's own decisions are exercised for real.
//
// NOTE: the GET handler (migration 014) uses admin() for chat-label resolution ONLY
// when supabaseEnabled() is true AND the uploaded-doc / structured-table lists contain
// non-null session_ids. Since both stores are stubbed to return [] here, the admin()
// call-path (sessionIds = [], guarded by `if (sessionIds.length > 0)`) is never reached
// at runtime — but the module import requires `admin` to be a named export in the mock
// or Node's ESM loader throws SyntaxError at instantiation time.

let current: ReturnType<typeof user> | null = user();
let supaOn = true;
// A no-op fake admin client for the chat-label resolution path (only called when
// listUploadedDocs/listUploadedTables return docs with non-null session_ids, which
// these tests never do — but the named export must exist).
let fakeAdminClient = makeFakeAdmin().client;
const calls: { fn: string; scopeOwner: unknown; isAdmin?: boolean; doc?: string; kind?: string; ownerId?: string; docId?: string }[] = [];
// The caller's _files.json manifest as the route reads it (uploaded-docs list source).
let manifestEntries: { docId: string; displayName: string; type: string; session_id?: string | null; space_id?: string | null }[] = [];

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/supabase", { supabaseEnabled: () => supaOn, admin: () => fakeAdminClient });
  mockExports("@/lib/engine/deleted-sources", {
      refreshDeletedSources: async () => {},
      markSourceDeleted: async (doc: string, kind: string) => { calls.push({ fn: "markSourceDeleted", scopeOwner: undefined, doc, kind }); },
    });
  mockExports("@/lib/engine/doc-store", { listDocsWithMeta: async () => [] });
  mockExports("@/lib/engine/pgvector-store", {
      listUploadedDocs: async (scopeOwner: unknown) => { calls.push({ fn: "listUploadedDocs", scopeOwner }); return []; },
      deleteUploadedDoc: async (scopeOwner: unknown, doc: string, isAdmin: boolean) => { calls.push({ fn: "deleteUploadedDoc", scopeOwner, isAdmin, doc }); return 1; },
    });
  mockExports("@/lib/engine/structured-rows-store", {
      listUploadedTables: async (scopeOwner: unknown) => { calls.push({ fn: "listUploadedTables", scopeOwner }); return []; },
      deleteUploadedTable: async () => 0,
    });
  mockExports("@/lib/engine/runtime-store", { removeRuntimeDoc: () => {} });
  mockExports("@/lib/engine/bundled-sources", { bundledSources: () => [{ doc: "contracts", kind: "structured", label: "Contracts" }], enrichBundledUrgency: async (s: unknown) => s });
  // doc-files — stub BOTH exports the route imports (a partial mock namespace makes the
  // route's import itself throw). removeOriginalFile records calls so tests can assert it
  // was invoked with the correct owner_id (the caller's id, always — never another
  // owner's); listManifestEntries records the owner it was scoped to and returns the
  // per-test `manifestEntries` fixture.
  mockExports("@/lib/engine/doc-files", {
    removeOriginalFile: async (ownerId: string, docId: string) => {
      calls.push({ fn: "removeOriginalFile", scopeOwner: ownerId, ownerId, docId });
    },
    listManifestEntries: async (ownerId: string) => {
      calls.push({ fn: "listManifestEntries", scopeOwner: ownerId });
      return manifestEntries;
    },
  });
});

beforeEach(() => { current = user(); supaOn = true; calls.length = 0; manifestEntries = []; fakeAdminClient = makeFakeAdmin().client; });

async function GET(url = "http://localhost/api/documents") { return (await import("@/app/api/documents/route.ts")).GET(new Request(url)); }
async function DELETE(url: string) {
  return (await import("@/app/api/documents/route.ts")).DELETE(new Request(url, { method: "DELETE" }));
}

// ── auth ──────────────────────────────────────────────────────────────────────────
test("GET unauthenticated → 401", async () => { current = null; assert.equal((await GET()).status, 401); });
test("DELETE unauthenticated → 401", async () => { current = null; assert.equal((await DELETE("http://x?doc=d1")).status, 401); });

// ── owner-scoping of the list (per-user isolation) ────────────────────────────────
// The list source is the caller's _files.json manifest (listManifestEntries), which is
// owner-keyed by folder — so EVERYONE, admin included, reads only their own manifest.
// (The pgvector-era "admin sees all uploads" list is gone by design — the route comments
// this: cross-user admin listing is not in scope for the manifest path.)
test("a MEMBER's list is scoped to their own id", async () => {
  current = user({ id: "mem-7", role: "user" });
  await GET();
  const c = calls.find((c) => c.fn === "listManifestEntries")!;
  assert.ok(c, "the list must come from the caller's manifest");
  assert.equal(c.scopeOwner, "mem-7");
});
test("an ADMIN's list is scoped to the admin's OWN manifest (no cross-user listing)", async () => {
  current = user({ id: "adm", role: "admin" });
  await GET();
  const c = calls.find((c) => c.fn === "listManifestEntries")!;
  assert.ok(c, "the list must come from the caller's manifest");
  assert.equal(c.scopeOwner, "adm");
});

// ── the bundled corpus is DEMO-gated (a real client user gets a clean bucket) ─────
test("a NON-demo user gets an empty bundled list", async () => {
  current = user({ isDemo: false });
  const { body } = await readJson(await GET());
  assert.deepEqual(body.bundled, []);
});
test("a DEMO user gets the bundled sample corpus", async () => {
  current = user({ isDemo: true });
  const { body } = await readJson(await GET());
  assert.ok(Array.isArray(body.bundled) && body.bundled.length > 0);
});

// ── delete validation ─────────────────────────────────────────────────────────────
test("DELETE without ?doc → 400", async () => {
  const { status } = await readJson(await DELETE("http://x/api/documents"));
  assert.equal(status, 400);
});

// ── the PRIVILEGE-ESCALATION guard (a member can't remove a shared source) ────────
test("a MEMBER deleting a BUNDLED source → 403 (admin-only)", async () => {
  current = user({ role: "user" });
  const { status, body } = await readJson(await DELETE("http://x?doc=contracts&scope=bundled"));
  assert.equal(status, 403);
  assert.match(body.error, /admin/i);
  assert.equal(calls.find((c) => c.fn === "markSourceDeleted"), undefined, "no soft-delete must have run");
});
test("an ADMIN may delete a BUNDLED source (soft-delete recorded)", async () => {
  current = user({ role: "admin" });
  supaOn = true;
  const { status } = await readJson(await DELETE("http://x?doc=contracts&scope=bundled&kind=structured"));
  assert.equal(status, 200);
  const c = calls.find((c) => c.fn === "markSourceDeleted")!;
  assert.equal(c.doc, "contracts");
  assert.equal(c.kind, "structured");
});
test("a bundled delete with Supabase OFF → 503 (can't hide a shared source)", async () => {
  current = user({ role: "admin" });
  supaOn = false;
  assert.equal((await DELETE("http://x?doc=contracts&scope=bundled")).status, 503);
});

// ── uploaded delete is owner-scoped (a member can only purge their OWN) ────────────
// Deletion goes through removeOriginalFile(user.id, doc) — the Storage blob + manifest
// entry of the CALLER only. There is no unscoped/admin variant on this path anymore
// (removeOriginalFile hard-asserts the Storage path starts with `${ownerId}/`).
test("a MEMBER's uploaded delete removes only from their OWN storage/manifest", async () => {
  current = user({ id: "mem-9", role: "user" });
  await DELETE("http://x?doc=up-1&scope=upload");
  const c = calls.find((c) => c.fn === "removeOriginalFile")!;
  assert.ok(c, "uploaded delete must go through removeOriginalFile");
  assert.equal(c.ownerId, "mem-9");
  assert.equal(c.docId, "up-1");
});
test("an ADMIN's uploaded delete is ALSO scoped to the admin's own id (no cross-owner delete)", async () => {
  current = user({ id: "adm", role: "admin" });
  await DELETE("http://x?doc=up-1&scope=upload");
  const c = calls.find((c) => c.fn === "removeOriginalFile")!;
  assert.ok(c, "uploaded delete must go through removeOriginalFile");
  assert.equal(c.ownerId, "adm");
});

// ── Storage + manifest removal is wired into the uploaded DELETE path ────────────────
// RED-FIRST: before this fix, deleting a doc only removed DB rows (doc_chunks/uploaded_rows)
// but left the Storage blob and _files.json entry intact — so the agentic engine still
// read the deleted file. These tests prove the fix: removeOriginalFile is called with the
// CALLER's owner_id + the doc id on every uploaded delete.
test("DELETE uploaded: removeOriginalFile is called with caller's owner_id and doc id", async () => {
  current = user({ id: "mem-42", role: "user" });
  await DELETE("http://x?doc=my-doc.pdf&scope=upload");
  const c = calls.find((c) => c.fn === "removeOriginalFile");
  assert.ok(c, "removeOriginalFile must be called on an uploaded delete");
  assert.equal(c!.ownerId, "mem-42", "removeOriginalFile must receive the CALLER's owner_id");
  assert.equal(c!.docId, "my-doc.pdf", "removeOriginalFile must receive the correct doc id");
});

test("DELETE uploaded: removeOriginalFile is NOT called when Supabase is OFF (no storage ops)", async () => {
  current = user({ id: "mem-43", role: "user" });
  supaOn = false;
  await DELETE("http://x?doc=my-doc.pdf&scope=upload");
  const c = calls.find((c) => c.fn === "removeOriginalFile");
  assert.equal(c, undefined, "removeOriginalFile must not be called when Supabase is disabled");
});

test("DELETE uploaded: admin removeOriginalFile uses the admin's own id (caller-scoped)", async () => {
  current = adminUser({ id: "adm-99" });
  await DELETE("http://x?doc=admin-doc.pdf&scope=upload");
  const c = calls.find((c) => c.fn === "removeOriginalFile");
  assert.ok(c, "removeOriginalFile must be called on an admin uploaded delete");
  assert.equal(c!.ownerId, "adm-99", "removeOriginalFile must use the admin's own id, not undefined");
});
