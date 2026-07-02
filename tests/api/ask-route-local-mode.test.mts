import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, NextResponseShim, readJson, mockExports } from "./_harness/harness.mts";

// ── Contract under test: POST /api/ask MODEL-MODE routing (Local mode v0.5) ─────────
// The route resolves the owner's model_mode (Settings → Model) and picks the answer lane:
//   • mode "local" → answerLocal() runs IN-PROCESS; the cloud/messages/fly lanes are NOT used.
//   • mode "hipaa" → a 503 with an HONEST message (Azure/BAA backend not wired here); NO answer.
//   • mode "cloud" (default) → the EXISTING behavior (answerQuestion), unchanged.
// The session→space registration and logAsk must still run for a Local answer.
// answerLocal / answerQuestion / the other lanes are stubbed; here we assert the HANDLER's
// lane-selection contract, not the engines themselves.

let current: ReturnType<typeof user> | null = user();
let mode: "cloud" | "hipaa" | "local" = "cloud";
let calls: Record<string, number>;
let lastLocalArgs: any[] | null = null;
let loggedSession: string | null = null;
let assignedSpace: { sid: string; spaceId: string } | null = null;

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/request-context", {
    runWithOwner: async (_id: string, fn: () => unknown) => fn(),
    currentOwner: () => current?.id,
  });
  mockExports("@/lib/engine/llm", { backendConfigured: async () => true });
  // The per-owner model-mode getter the route now consults to pick the lane.
  mockExports("@/lib/engine/settings", { getModelMode: async () => mode });
  // Each lane records that it ran, so a test can assert EXACTLY one fired.
  mockExports("@/lib/engine/answer", { answerQuestion: async () => { calls.cloud++; return { answer: "cloud" }; } });
  mockExports("@/lib/engine/answer-agentic", { answerAgentic: async () => { calls.agentic++; return { answer: "agentic" }; } });
  mockExports("@/lib/engine/answer-messages", { answerMessages: async () => { calls.messages++; return { answer: "messages" }; } });
  mockExports("@/lib/engine/answer-local", {
    answerLocal: async (...args: any[]) => { calls.local++; lastLocalArgs = args; return { answer: "LOCAL-REPLY", mode: "general", grounded: false, model: "local:llama3.2:3b" }; },
  });
  mockExports("@/lib/engine/spaces", { assignSessionToSpace: async (_o: string, sid: string, spaceId: string) => { assignedSpace = { sid, spaceId }; } });
  mockExports("@/lib/engine/ask-history", { logAsk: async (_o: string, _r: unknown, sid: string) => { loggedSession = sid; } });
  mockExports("@/lib/engine/error-message", { friendlyAskError: () => "friendly error" });
});

beforeEach(() => {
  current = user({ id: "owner-1", role: "user", isDemo: false });
  mode = "cloud";
  calls = { cloud: 0, agentic: 0, messages: 0, local: 0 };
  lastLocalArgs = null;
  loggedSession = null;
  assignedSpace = null;
});

async function POST(body: unknown) {
  return (await import("@/app/api/ask/route.ts")).POST(
    new Request("http://x/api/ask", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })
  );
}

// ── mode "local" → answerLocal, NOT the cloud/messages/agentic lanes ────────────────
test("mode=local routes to answerLocal and NOT the other lanes", async () => {
  mode = "local";
  const { status, body } = await readJson(await POST({ question: "hello", session_id: "sess-L" }));
  assert.equal(status, 200);
  assert.equal(calls.local, 1, "answerLocal fired");
  assert.equal(calls.cloud, 0, "the cloud RAG lane did NOT fire");
  assert.equal(calls.messages, 0, "the messages lane did NOT fire");
  assert.equal(calls.agentic, 0, "the agentic lane did NOT fire");
  assert.equal(body.answer, "LOCAL-REPLY");
  assert.equal(body.model, "local:llama3.2:3b");
  assert.equal(body._engine.lane, "local", "the diagnostic lane is stamped 'local'");
});

test("mode=local passes (question, ownerId, sessionId, history, spaceOpts) to answerLocal", async () => {
  mode = "local";
  await POST({
    question: "hi", session_id: "sess-L2",
    history: [{ question: "q", answer: "a" }],
    space_id: "space-9",
  });
  assert.deepEqual(lastLocalArgs?.[0], "hi");
  assert.equal(lastLocalArgs?.[1], "owner-1");
  assert.equal(lastLocalArgs?.[2], "sess-L2");
  assert.deepEqual(lastLocalArgs?.[3], [{ question: "q", answer: "a" }]);
  assert.deepEqual(lastLocalArgs?.[4], { spaceId: "space-9", globalMode: false });
});

test("a Local answer STILL runs session→space registration and logAsk", async () => {
  mode = "local";
  await POST({ question: "hi", session_id: "sess-L3", space_id: "space-7" });
  assert.deepEqual(assignedSpace, { sid: "sess-L3", spaceId: "space-7" }, "session was registered to its space");
  assert.equal(loggedSession, "sess-L3", "the Local turn was logged to history");
});

// ── mode "hipaa" → 503 with an honest, key-free message, NO answer produced ─────────
test("mode=hipaa returns a 503 with an honest message and produces NO answer", async () => {
  mode = "hipaa";
  const { status, body } = await readJson(await POST({ question: "hi" }));
  assert.equal(status, 503);
  assert.match(body.error, /HIPAA/);
  assert.match(body.error, /Azure|not available|Cloud or Local/i);
  assert.equal(calls.local, 0);
  assert.equal(calls.cloud, 0);
  assert.equal(loggedSession, null, "a 503 is not a logged answer");
});

// ── mode "cloud" → the existing default lane, unchanged ─────────────────────────────
test("mode=cloud uses the existing default (RAG) lane, not answerLocal", async () => {
  mode = "cloud";
  const { status, body } = await readJson(await POST({ question: "hi" }));
  assert.equal(status, 200);
  assert.equal(calls.cloud, 1, "the default cloud lane fired");
  assert.equal(calls.local, 0, "answerLocal did NOT fire");
  assert.equal(body.answer, "cloud");
});
