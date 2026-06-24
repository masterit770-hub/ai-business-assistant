import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, NextResponseShim, readJson, makeFakeAdmin, mockExports } from "./_harness/harness.mts";

// ── Contract under test: GET /api/history + the [session_id] turns/rename/delete ──
// THE per-user-isolation contract at the HTTP boundary: a MEMBER's reads/writes must
// be scoped to .eq("owner_id", <self>); an ADMIN's must NOT be (sees everyone's). A
// member who guesses another user's session_id must get an empty/404 result, never
// another user's turns. We stub the Supabase client with a recording fake builder so
// the EXACT owner-scoping the handler applies is asserted; groupSessions is the real
// pure function. supabaseEnabled is toggled to exercise the honest-empty branches.

let current: ReturnType<typeof user> | null = user();
let supaOn = true;
let fake = makeFakeAdmin();

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/supabase", { supabaseEnabled: () => supaOn, admin: () => fake.client });
});

beforeEach(() => { current = user(); supaOn = true; });

function withRows(rows: any[]) {
  return makeFakeAdmin({
    on: {
      "ask_history:select": () => ({ data: rows }),
      "profiles:select": () => ({ data: [] }),
      "session_titles:select": () => ({ data: [] }),
    },
  });
}

async function GETlist() { return (await import("@/app/api/history/route.ts")).GET(); }

// ── /api/history list ──────────────────────────────────────────────────────────────
test("list unauthenticated → 401", async () => { current = null; assert.equal((await GETlist()).status, 401); });

test("Supabase OFF → honest empty history (never a 500)", async () => {
  supaOn = false;
  const { status, body } = await readJson(await GETlist());
  assert.equal(status, 200);
  assert.deepEqual(body.sessions, []);
});

test("a MEMBER's listing is scoped to .eq('owner_id', self)", async () => {
  current = user({ id: "mem-1", role: "user" });
  fake = withRows([{ id: "1", owner_id: "mem-1", session_id: "s1", question: "q", created_at: "2026-01-01" }]);
  await GETlist();
  const askRead = fake.calls.find((c) => c.table === "ask_history" && c.op === "select")!;
  assert.equal(askRead.eq["owner_id"], "mem-1", "a member must be owner-scoped");
});

test("an ADMIN's listing is NOT owner-scoped (sees everyone)", async () => {
  current = user({ id: "adm", role: "admin" });
  fake = withRows([{ id: "1", owner_id: "someone-else", session_id: "s1", question: "q", created_at: "2026-01-01" }]);
  await GETlist();
  const askRead = fake.calls.find((c) => c.table === "ask_history" && c.op === "select")!;
  assert.equal(askRead.eq["owner_id"], undefined, "an admin must NOT be owner-scoped");
});

// ── /api/history/[session_id] — turns / rename / delete ───────────────────────────
async function GETturns(sessionId: string) {
  const mod = await import("@/app/api/history/[session_id]/route.ts");
  return mod.GET(new Request("http://x"), { params: Promise.resolve({ session_id: sessionId }) });
}
async function PATCH(sessionId: string, body: unknown) {
  const mod = await import("@/app/api/history/[session_id]/route.ts");
  return mod.PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ session_id: sessionId }) });
}
async function DEL(sessionId: string) {
  const mod = await import("@/app/api/history/[session_id]/route.ts");
  return mod.DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ session_id: sessionId }) });
}

test("turns: a MEMBER loading a session they DON'T own → empty turns (never another user's thread)", async () => {
  current = user({ id: "mem-2", role: "user" });
  // The owner-scoped query returns no rows for a session that isn't theirs.
  fake = makeFakeAdmin({ on: { "ask_history:select": () => ({ data: [] }) } });
  const { status, body } = await readJson(await GETturns("not-mine"));
  assert.equal(status, 200);
  assert.deepEqual(body.turns, []);
  const read = fake.calls.find((c) => c.table === "ask_history")!;
  assert.equal(read.eq["owner_id"], "mem-2", "the member's turns read must be owner-scoped");
  assert.equal(read.eq["session_id"], "not-mine");
});

test("rename: blank title → 400", async () => {
  const { status } = await readJson(await PATCH("s1", { title: "   " }));
  assert.equal(status, 400);
});
test("rename: an over-long title → 400", async () => {
  const { status } = await readJson(await PATCH("s1", { title: "x".repeat(201) }));
  assert.equal(status, 400);
});
test("rename: a session not owned by the member → 404 (resolves to no owner)", async () => {
  current = user({ id: "mem-3", role: "user" });
  fake = makeFakeAdmin({ on: { "ask_history:select": () => ({ data: [] }) } });
  const { status } = await readJson(await PATCH("not-mine", { title: "New name" }));
  assert.equal(status, 404);
});
test("rename: a member's OWN session upserts the title under the resolved owner", async () => {
  current = user({ id: "mem-4", role: "user" });
  fake = makeFakeAdmin({
    on: {
      "ask_history:select": () => ({ data: [{ owner_id: "mem-4" }] }),
      "session_titles:upsert": () => ({ data: null }),
    },
  });
  const { status, body } = await readJson(await PATCH("s1", { title: "My Title" }));
  assert.equal(status, 200);
  assert.equal(body.title, "My Title");
  const up = fake.calls.find((c) => c.table === "session_titles" && c.op === "upsert");
  assert.ok(up, "the rename must upsert a session_titles override");
});

test("delete: a MEMBER's delete is owner-scoped (can't delete another user's thread)", async () => {
  current = user({ id: "mem-5", role: "user" });
  fake = makeFakeAdmin({ on: { "ask_history:delete": () => ({ data: [{ id: "1" }] }) } });
  const { status, body } = await readJson(await DEL("s9"));
  assert.equal(status, 200);
  assert.equal(body.deleted, 1);
  const del = fake.calls.find((c) => c.table === "ask_history" && c.op === "delete")!;
  assert.equal(del.eq["owner_id"], "mem-5", "a member's delete must be owner-scoped");
});
test("delete: an ADMIN's delete is NOT owner-scoped (may delete any)", async () => {
  current = user({ id: "adm", role: "admin" });
  fake = makeFakeAdmin({ on: { "ask_history:delete": () => ({ data: [{ id: "1" }] }) } });
  await DEL("s9");
  const del = fake.calls.find((c) => c.table === "ask_history" && c.op === "delete")!;
  assert.equal(del.eq["owner_id"], undefined, "an admin's delete must NOT be owner-scoped");
});
