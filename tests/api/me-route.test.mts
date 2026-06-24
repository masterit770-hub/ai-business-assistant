import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, NextResponseShim, readJson, mockExports } from "./_harness/harness.mts";

// ── Contract under test: GET /api/me ──────────────────────────────────────────────
// The sidebar gates admin-only UI on this. Contract: a signed-out caller gets
// { user: null } with status 200 (NOT a 401 — the UI must render for everyone); a
// signed-in caller gets their id/email/role + the current system_prompt; a failure
// reading the prompt is NON-FATAL (the user payload still returns).

let current: ReturnType<typeof user> | null = user();
let promptImpl: () => Promise<string> = async () => "You are a helpful assistant.";

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/request-context", { runWithOwner: async (_id: string, fn: () => unknown) => fn() });
  mockExports("@/lib/engine/settings", { getSetting: async () => promptImpl() });
});

beforeEach(() => { current = user(); promptImpl = async () => "You are a helpful assistant."; });

async function GET() { return (await import("@/app/api/me/route.ts")).GET(); }

test("signed-out → 200 with { user: null } (so the UI still renders)", async () => {
  current = null;
  const { status, body } = await readJson(await GET());
  assert.equal(status, 200);
  assert.equal(body.user, null);
});
test("signed-in → id/email/role + the current system_prompt", async () => {
  current = user({ id: "u-5", email: "z@x.com", role: "admin" });
  const { status, body } = await readJson(await GET());
  assert.equal(status, 200);
  assert.deepEqual(body.user, { id: "u-5", email: "z@x.com", role: "admin" });
  assert.equal(body.system_prompt, "You are a helpful assistant.");
});
test("a failure reading the prompt is non-fatal (user payload still returns)", async () => {
  promptImpl = async () => { throw new Error("settings store down"); };
  const { status, body } = await readJson(await GET());
  assert.equal(status, 200);
  assert.ok(body.user, "the user must still be returned even if the prompt read failed");
  assert.equal(body.system_prompt, "");
});
