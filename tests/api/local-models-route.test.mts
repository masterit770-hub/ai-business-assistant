import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { user, NextResponseShim, readJson, mockExports } from "./_harness/harness.mts";

// ── Contract under test: GET /api/local-models ────────────────────────────────────
// The Local-model picker probes the owner's Ollama box. CONTRACT: this route must
// NEVER 500 — every failure mode (no endpoint, non-200, bad JSON, timeout, connection
// refused) returns a calm { models: [], reachable: false, reason } so the admin still
// gets a free-text fallback. We stub the settings + the URL helper, and replace the
// global fetch to drive each failure path; the handler's never-500 contract + reason
// classification is the thing under test.

let current: ReturnType<typeof user> | null = user();
let endpoint = "http://localhost:11434/v1";
let fetchImpl: (url: string, init?: any) => Promise<any> = async () =>
  ({ ok: true, json: async () => ({ models: [{ name: "llama3" }, { name: "qwen2" }] }) });

const realFetch = globalThis.fetch;

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/request-context", { runWithOwner: async (_id: string, fn: () => unknown) => fn() });
  mockExports("@/lib/engine/settings", { getSetting: async () => endpoint });
  mockExports("@/lib/engine/local-models", {
      // Real helper behavior: empty endpoint → null; otherwise derive the /api/tags URL.
      ollamaTagsUrl: (ep: string) => (ep ? ep.replace(/\/v1\/?$/, "") + "/api/tags" : null),
      extractModelNames: (body: any) => (body?.models ?? []).map((m: any) => m.name),
    });
  // @ts-expect-error override global for the probe
  globalThis.fetch = (url: string, init?: any) => fetchImpl(url, init);
});

afterEach(() => {
  current = user();
  endpoint = "http://localhost:11434/v1";
  fetchImpl = async () => ({ ok: true, json: async () => ({ models: [{ name: "llama3" }, { name: "qwen2" }] }) });
});

// restore the global after the suite via a final test hook
test.after(() => { globalThis.fetch = realFetch; });

async function GET() { return (await import("@/app/api/local-models/route.ts")).GET(); }

test("unauthenticated → 401", async () => { current = null; assert.equal((await GET()).status, 401); });

test("a reachable endpoint lists the installed model names", async () => {
  const { status, body } = await readJson(await GET());
  assert.equal(status, 200);
  assert.equal(body.reachable, true);
  assert.deepEqual(body.models, ["llama3", "qwen2"]);
});

test("no endpoint set → calm { reachable:false } (never a 500)", async () => {
  endpoint = "";
  const { status, body } = await readJson(await GET());
  assert.equal(status, 200);
  assert.equal(body.reachable, false);
  assert.match(body.reason, /no endpoint/i);
  assert.deepEqual(body.models, []);
});

test("a non-200 from the endpoint → reachable:false, reason names the status (never a 500)", async () => {
  fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const { status, body } = await readJson(await GET());
  assert.equal(status, 200);
  assert.equal(body.reachable, false);
  assert.match(body.reason, /503/);
});

test("a non-JSON body → reachable:false (never a 500)", async () => {
  fetchImpl = async () => ({ ok: true, json: async () => { throw new Error("invalid json"); } });
  const { status, body } = await readJson(await GET());
  assert.equal(status, 200);
  assert.equal(body.reachable, false);
  assert.match(body.reason, /JSON/i);
});

test("a connection error → reachable:false (never a 500)", async () => {
  fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const { status, body } = await readJson(await GET());
  assert.equal(status, 200);
  assert.equal(body.reachable, false);
  assert.match(body.reason, /connect/i);
});

test("an aborted (timed-out) probe → reachable:false, reason 'timed out' (never a 500)", async () => {
  fetchImpl = async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  const { status, body } = await readJson(await GET());
  assert.equal(status, 200);
  assert.equal(body.reachable, false);
  assert.match(body.reason, /timed out/i);
});
