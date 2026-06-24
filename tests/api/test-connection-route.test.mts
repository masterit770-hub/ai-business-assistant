import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, NextResponseShim, readJson, mockExports } from "./_harness/harness.mts";

// ── Contract under test: POST /api/test-connection ────────────────────────────────
// The owner clicks "Test connection". Contract: auth gate (401); a successful probe →
// { ok:true } naming the provider/model; a "not finished setting up" typed config
// error → { ok:false } with a precise nudge; a real provider failure → { ok:false }
// with a SANITISED, key-free message — and NEVER a 500, never the secret. The LLM
// call is stubbed to drive each branch; the handler's classification + redaction is
// the thing under test.

let current: ReturnType<typeof user> | null = user();
let chatImpl: () => Promise<any> = async () => ({ content: "ok", usage: { provider: "deepseek", model: "deepseek-chat" } });
let configErr: { cloud?: boolean; hipaa?: boolean; localNo?: boolean; localUnreach?: boolean } = {};

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/request-context", { runWithOwner: async (_id: string, fn: () => unknown) => fn() });
  mockExports("@/lib/engine/settings", { getModelConfig: async () => ({ mode: "cloud" }) });
  mockExports("@/lib/engine/llm", {
      chatWithUsage: async () => chatImpl(),
      isCloudProviderNotConfigured: () => !!configErr.cloud,
      isHipaaNotConfigured: () => !!configErr.hipaa,
      isLocalNotConfigured: () => !!configErr.localNo,
      isLocalUnreachable: () => !!configErr.localUnreach,
    });
});

beforeEach(() => {
  current = user();
  chatImpl = async () => ({ content: "ok", usage: { provider: "deepseek", model: "deepseek-chat" } });
  configErr = {};
});

async function POST() { return (await import("@/app/api/test-connection/route.ts")).POST(); }

test("unauthenticated → 401", async () => { current = null; assert.equal((await POST()).status, 401); });
test("disabled user → 401", async () => { current = user({ disabled: true }); assert.equal((await POST()).status, 401); });

test("a successful probe → ok:true naming provider + model", async () => {
  const { status, body } = await readJson(await POST());
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.match(body.message, /deepseek/);
  assert.equal(body.provider, "deepseek");
});

test("a typed cloud-not-configured error → ok:false with a precise nudge (not a 500)", async () => {
  configErr = { cloud: true };
  chatImpl = async () => { throw new Error("cloud not configured"); };
  const { status, body } = await readJson(await POST());
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.match(body.message, /key|Cloud/i);
});

test("a real provider failure → ok:false with a SANITISED, key-free message (never a 500)", async () => {
  chatImpl = async () => { throw new Error("401 Unauthorized: api-key=sk-SECRETSECRETSECRETSECRETSECRET12345 rejected by Bearer abcdefghijklmnop"); };
  const { status, body } = await readJson(await POST());
  assert.equal(status, 200, "a bad key must never surface as a 500");
  assert.equal(body.ok, false);
  assert.doesNotMatch(body.message, /sk-SECRETSECRET|abcdefghijklmnop/, "the key must be redacted");
});
