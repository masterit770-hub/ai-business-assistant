import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, NextResponseShim, readJson, mockExports } from "./_harness/harness.mts";

// ── Contract under test: PUT/GET /api/settings ────────────────────────────────────
// The handler's own wiring is the thing under test. Only the I/O seams are stubbed:
// the auth resolver, the request-context owner wrapper, and the settings store. The
// real handler runs its auth gate, model_mode/cloud_provider validation, the
// keyless-provider block, and the WRITE-ONLY-KEY protection (a blank submit must not
// wipe a stored key; "__clear__" clears it). These are the exact bugs a client hits.

let current: ReturnType<typeof user> | null = user({ role: "admin" });
let store: Record<string, string> = {};

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", {
      getCurrentUser: async () => current,
      requireAdmin: async () => (current && current.role === "admin" && !current.disabled ? current : null),
    });
  mockExports("@/lib/engine/request-context", { runWithOwner: async (_id: string, fn: () => unknown) => fn() });
  mockExports("@/lib/engine/settings", {
      getSettings: async () => ({ ...store }),
      getSetting: async (k: string) => store[k] ?? "",
      setSetting: async (k: string, v: string) => { store[k] = v; },
    });
});

beforeEach(() => {
  current = user({ role: "admin" });
  store = {};
});

async function PUT(body: unknown) {
  const mod = await import("@/app/api/settings/route.ts");
  return mod.PUT(new Request("http://x/api/settings", { method: "PUT", body: JSON.stringify(body) }));
}
async function GET() {
  const mod = await import("@/app/api/settings/route.ts");
  return mod.GET();
}

// ── auth ──────────────────────────────────────────────────────────────────────────
test("GET unauthenticated → 401", async () => {
  current = null;
  assert.equal((await GET()).status, 401);
});
test("PUT unauthenticated → 401", async () => {
  current = null;
  assert.equal((await PUT({ system_prompt: "x" })).status, 401);
});
test("PUT by a disabled user → 401", async () => {
  current = user({ role: "admin", disabled: true });
  assert.equal((await PUT({ system_prompt: "x" })).status, 401);
});

// ── validation ──────────────────────────────────────────────────────────────────
test("invalid JSON body → 400", async () => {
  const mod = await import("@/app/api/settings/route.ts");
  const res = await mod.PUT(new Request("http://x", { method: "PUT", body: "{not json" }));
  assert.equal(res.status, 400);
});
test("model_mode must be cloud|hipaa|local → 400 on garbage", async () => {
  const { status, body } = await readJson(await PUT({ model_mode: "banana" }));
  assert.equal(status, 400);
  assert.match(body.error, /model_mode/);
  assert.equal(store.model_mode, undefined, "an invalid mode must not be persisted");
});
test("model_mode is normalised (trim+lowercase) then persisted", async () => {
  await PUT({ model_mode: "  Local  " });
  assert.equal(store.model_mode, "local");
});
test("cloud_provider must be a known provider → 400 on unknown", async () => {
  const { status } = await PUT({ cloud_provider: "anthropic", cloud_api_key: "k" });
  assert.equal(status, 400);
});

// ── the WRITE-ONLY-KEY contract (the bug class the discipline doc names) ──────────
test("blank cloud_api_key submit does NOT clobber a stored key", async () => {
  store = { cloud_provider: "openai", cloud_api_key: "STORED" };
  await PUT({ cloud_provider: "openai", cloud_api_key: "" });
  assert.equal(store.cloud_api_key, "STORED");
});
test("a non-blank cloud_api_key DOES overwrite (write branch is live)", async () => {
  store = { cloud_provider: "openai", cloud_api_key: "STORED" };
  await PUT({ cloud_provider: "openai", cloud_api_key: "NEW" });
  assert.equal(store.cloud_api_key, "NEW");
});
test("__clear__ sentinel clears the stored cloud_api_key", async () => {
  // Clearing the provider too (a keyless non-default provider would be blocked first).
  store = { cloud_provider: "openai", cloud_api_key: "STORED" };
  await PUT({ cloud_provider: "", cloud_api_key: "__clear__" });
  assert.equal(store.cloud_api_key, "");
});
test("hipaa_api_key is an INDEPENDENT slot — never overwrites cloud_api_key", async () => {
  store = { cloud_api_key: "CLOUD" };
  await PUT({ hipaa_api_key: "HIPAA-KEY" });
  assert.equal(store.cloud_api_key, "CLOUD", "the HIPAA key must not touch the cloud key");
  assert.equal(store.hipaa_api_key, "HIPAA-KEY");
});

// ── the keyless-provider block (told at SAVE time, not at first failed ask) ────────
test("selecting a non-default provider with NO key (none stored, none submitted) → 400", async () => {
  store = {};
  const { status, body } = await readJson(await PUT({ cloud_provider: "openai" }));
  assert.equal(status, 400);
  assert.match(body.error, /Set a key/i);
  assert.equal(store.cloud_provider, undefined, "the keyless provider must not be persisted");
});
test("a non-default provider WITH a submitted key is accepted", async () => {
  store = {};
  const { status } = await PUT({ cloud_provider: "openai", cloud_api_key: "sk-real" });
  assert.equal(status, 200);
  assert.equal(store.cloud_provider, "openai");
  assert.equal(store.cloud_api_key, "sk-real");
});
test("a non-default provider with a key ALREADY stored is accepted (no re-type needed)", async () => {
  store = { cloud_api_key: "STORED" };
  const { status } = await PUT({ cloud_provider: "openai" });
  assert.equal(status, 200);
  assert.equal(store.cloud_provider, "openai");
});
test("clearing the key (__clear__) while keeping a non-default provider is BLOCKED → 400", async () => {
  store = { cloud_provider: "openai", cloud_api_key: "STORED" };
  const { status } = await PUT({ cloud_provider: "openai", cloud_api_key: "__clear__" });
  assert.equal(status, 400);
  assert.equal(store.cloud_api_key, "STORED", "the block must run before any write");
});
test("the DEFAULT provider ('') is never blocked (uses the env model)", async () => {
  store = {};
  const { status } = await PUT({ cloud_provider: "" });
  assert.equal(status, 200);
});
