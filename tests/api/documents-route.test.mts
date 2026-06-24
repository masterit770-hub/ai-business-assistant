import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, NextResponseShim, readJson, mockExports } from "./_harness/harness.mts";

// ── Contract under test: GET/DELETE /api/documents ────────────────────────────────
// The privilege + isolation wiring is the thing under test:
//   • a MEMBER may only delete their OWN upload; a bundled (shared) source delete is
//     ADMIN-ONLY (a member → 403) — the privilege-escalation guard.
//   • the uploaded-doc list is OWNER-SCOPED (a member passes their own id; an admin
//     passes undefined = all).
//   • the bundled corpus is gated to DEMO accounts (a real client user → []).
// The engine stores are stubbed; the handler's own decisions are exercised for real.

let current: ReturnType<typeof user> | null = user();
let supaOn = true;
const calls: { fn: string; scopeOwner: unknown; isAdmin?: boolean; doc?: string; kind?: string }[] = [];

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/supabase", { supabaseEnabled: () => supaOn });
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
});

beforeEach(() => { current = user(); supaOn = true; calls.length = 0; });

async function GET() { return (await import("@/app/api/documents/route.ts")).GET(); }
async function DELETE(url: string) {
  return (await import("@/app/api/documents/route.ts")).DELETE(new Request(url, { method: "DELETE" }));
}

// ── auth ──────────────────────────────────────────────────────────────────────────
test("GET unauthenticated → 401", async () => { current = null; assert.equal((await GET()).status, 401); });
test("DELETE unauthenticated → 401", async () => { current = null; assert.equal((await DELETE("http://x?doc=d1")).status, 401); });

// ── owner-scoping of the list (per-user isolation) ────────────────────────────────
test("a MEMBER's list is scoped to their own id", async () => {
  current = user({ id: "mem-7", role: "user" });
  await GET();
  const c = calls.find((c) => c.fn === "listUploadedDocs")!;
  assert.equal(c.scopeOwner, "mem-7");
});
test("an ADMIN's list is unscoped (sees all uploads)", async () => {
  current = user({ id: "adm", role: "admin" });
  await GET();
  const c = calls.find((c) => c.fn === "listUploadedDocs")!;
  assert.equal(c.scopeOwner, undefined);
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
test("a MEMBER's uploaded delete passes their own id + isAdmin=false", async () => {
  current = user({ id: "mem-9", role: "user" });
  await DELETE("http://x?doc=up-1&scope=upload");
  const c = calls.find((c) => c.fn === "deleteUploadedDoc")!;
  assert.equal(c.scopeOwner, "mem-9");
  assert.equal(c.isAdmin, false);
});
test("an ADMIN's uploaded delete is unscoped + isAdmin=true (may delete any)", async () => {
  current = user({ id: "adm", role: "admin" });
  await DELETE("http://x?doc=up-1&scope=upload");
  const c = calls.find((c) => c.fn === "deleteUploadedDoc")!;
  assert.equal(c.scopeOwner, undefined);
  assert.equal(c.isAdmin, true);
});
