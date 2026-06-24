import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, NextResponseShim, readJson, mockExports } from "./_harness/harness.mts";

// ── Contract under test: POST /api/ask (the core Ask endpoint) ────────────────────
// The handler's gating + request shaping + error handling is the thing under test:
//   • auth gate (401), the no-backend gate (503), invalid JSON (400), empty question (400)
//   • it runs the answer under the CALLER's owner context (per-user prompt/model)
//   • it MINTS a session_id on a first turn and ECHOES the caller's on a follow-up
//   • it FILTERS the history array to well-formed {question,answer} turns
//   • a generation failure maps to a FRIENDLY 500, never the raw provider blob
// answerQuestion / logAsk / the LLM gate are stubbed; the engine itself is tested
// elsewhere. Here we assert the HANDLER contract a client depends on.

let current: ReturnType<typeof user> | null = user();
let backendOk = true;
let answerImpl: (q: string, opts: any) => Promise<any> = async (q, opts) => ({ answer: `A:${q}`, _opts: opts });
let lastAnswerOpts: any = null;
let loggedSession: string | null = null;

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/request-context", { runWithOwner: async (id: string, fn: () => unknown) => { lastAnswerOpts = { ownerCtx: id }; return fn(); } });
  mockExports("@/lib/engine/llm", { backendConfigured: async () => backendOk });
  mockExports("@/lib/engine/answer", { answerQuestion: async (q: string, opts: any) => { lastAnswerOpts = opts; return answerImpl(q, opts); } });
  mockExports("@/lib/engine/ask-history", { logAsk: async (_o: string, _r: unknown, sid: string) => { loggedSession = sid; } });
  mockExports("@/lib/engine/error-message", { friendlyAskError: () => "Something went wrong reaching the model. Please try again." });
});

beforeEach(() => {
  current = user({ id: "owner-1", role: "user", isDemo: false });
  backendOk = true;
  answerImpl = async (q, opts) => ({ answer: `A:${q}`, _opts: opts });
  lastAnswerOpts = null;
  loggedSession = null;
});

async function POST(body: unknown) {
  return (await import("@/app/api/ask/route.ts")).POST(
    new Request("http://x/api/ask", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })
  );
}

// ── auth + backend gates ──────────────────────────────────────────────────────────
test("unauthenticated → 401", async () => { current = null; assert.equal((await POST({ question: "hi" })).status, 401); });
test("disabled user → 401", async () => { current = user({ disabled: true }); assert.equal((await POST({ question: "hi" })).status, 401); });
test("no model backend configured → 503 with an actionable message", async () => {
  backendOk = false;
  const { status, body } = await readJson(await POST({ question: "hi" }));
  assert.equal(status, 503);
  assert.match(body.error, /model backend|Settings/i);
});

// ── input validation ───────────────────────────────────────────────────────────────
test("invalid JSON → 400", async () => { assert.equal((await POST("{nope")).status, 400); });
test("empty / whitespace question → 400", async () => {
  assert.equal((await POST({ question: "   " })).status, 400);
});

// ── per-user owner context (the answer runs as the CALLER) ─────────────────────────
test("the answer runs scoped to the caller's id + role + isDemo", async () => {
  current = user({ id: "owner-9", role: "user", isDemo: false });
  await POST({ question: "what's my balance?" });
  assert.equal(lastAnswerOpts.ownerId, "owner-9");
  assert.equal(lastAnswerOpts.role, "user");
  assert.equal(lastAnswerOpts.isDemo, false);
});

// ── session id: minted on a first turn, echoed on a follow-up ──────────────────────
test("a first turn MINTS a session_id and echoes it", async () => {
  const { body } = await readJson(await POST({ question: "hi" }));
  assert.match(body.session_id, /[0-9a-f-]{36}/);
  assert.equal(loggedSession, body.session_id, "the minted id is what gets logged");
});
test("a follow-up REUSES the client's session_id", async () => {
  const { body } = await readJson(await POST({ question: "hi", session_id: "sess-123" }));
  assert.equal(body.session_id, "sess-123");
  assert.equal(loggedSession, "sess-123");
});

// ── history filtering (malformed turns dropped, not passed through) ────────────────
test("malformed history turns are filtered out before the engine sees them", async () => {
  await POST({
    question: "follow up",
    history: [
      { question: "q1", answer: "a1" },        // valid
      { question: "q2" },                        // missing answer → dropped
      "garbage",                                  // not an object → dropped
      { question: 5, answer: "x" },              // wrong type → dropped
    ],
  });
  assert.deepEqual(lastAnswerOpts.history, [{ question: "q1", answer: "a1" }]);
});

// ── generation failure maps to a FRIENDLY 500, never the raw error ─────────────────
test("a thrown generation error → 500 with a friendly, key-free message", async () => {
  answerImpl = async () => { throw new Error("provider 401: sk-LEAKED-KEY invalid; billing blob…"); };
  const { status, body } = await readJson(await POST({ question: "hi" }));
  assert.equal(status, 500);
  assert.doesNotMatch(body.error, /sk-LEAKED-KEY|billing blob/, "the raw provider detail must never reach the client");
  assert.match(body.error, /try again/i);
});
