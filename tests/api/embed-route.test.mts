import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readJson, mockExports } from "./_harness/harness.mts";

// ── Contract under test: GET/POST /api/embed ──────────────────────────────────────
// The internal embedding microfunction. Contract:
//   • GET (warmup) → ok (never blocks); a warmup failure still returns 200
//   • POST is gated by a shared secret (INTERNAL_EMBED_TOKEN): a wrong/absent token
//     when one IS configured → 403; the right token passes
//   • invalid JSON → 400; empty text → 400; a real call returns the embedding
// embedText is stubbed (the model itself is heavy + tested via the engine); the
// handler's token gate + validation + warmup-never-blocks contract is the real thing.

let embedImpl: (text: string, prefix: string) => Promise<number[]> = async () => [0.1, 0.2, 0.3];
const savedToken = process.env.INTERNAL_EMBED_TOKEN;

before(() => {
  mockExports("@/lib/engine/embed-core", { embedText: async (t: string, p: string) => embedImpl(t, p) });
});

beforeEach(() => { embedImpl = async () => [0.1, 0.2, 0.3]; delete process.env.INTERNAL_EMBED_TOKEN; });
afterEach(() => { if (savedToken === undefined) delete process.env.INTERNAL_EMBED_TOKEN; else process.env.INTERNAL_EMBED_TOKEN = savedToken; });

async function GET() { return (await import("@/app/api/embed/route.ts")).GET(); }
async function POST(body: unknown, headers: Record<string, string> = {}) {
  return (await import("@/app/api/embed/route.ts")).POST(
    new Request("http://x/api/embed", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) })
  );
}

// ── warmup never blocks ─────────────────────────────────────────────────────────────
test("GET warmup → ok:true when the model loads", async () => {
  const { status, body } = await readJson(await GET());
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});
test("GET warmup FAILURE still returns 200 (warmup must never block the app)", async () => {
  embedImpl = async () => { throw new Error("WASM load failed"); };
  const { status, body } = await readJson(await GET());
  assert.equal(status, 200, "a warmup failure must not surface as an error status");
  assert.equal(body.ok, false);
});

// ── the shared-secret gate ──────────────────────────────────────────────────────────
test("POST with a token configured + WRONG token → 403", async () => {
  process.env.INTERNAL_EMBED_TOKEN = "secret-123";
  assert.equal((await POST({ text: "hi" }, { "x-internal-token": "wrong" })).status, 403);
});
test("POST with a token configured + NO token header → 403", async () => {
  process.env.INTERNAL_EMBED_TOKEN = "secret-123";
  assert.equal((await POST({ text: "hi" })).status, 403);
});
test("POST with the RIGHT token passes the gate", async () => {
  process.env.INTERNAL_EMBED_TOKEN = "secret-123";
  const { status, body } = await readJson(await POST({ text: "hi" }, { "x-internal-token": "secret-123" }));
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.embedding));
});

// ── validation ──────────────────────────────────────────────────────────────────────
test("POST invalid JSON → 400", async () => { assert.equal((await POST("{nope")).status, 400); });
test("POST empty text → 400", async () => { assert.equal((await POST({ text: "" })).status, 400); });
test("POST a real text → the embedding vector", async () => {
  const { status, body } = await readJson(await POST({ text: "embed me", prefix: "passage" }));
  assert.equal(status, 200);
  assert.deepEqual(body.embedding, [0.1, 0.2, 0.3]);
});
