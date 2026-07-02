import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mockExports } from "./_harness/harness.mts";

// ── Contract under test: answerLocal() — the Local (Ollama) chat-only engine (v0.5) ──
// It reads the owner's local_endpoint/local_model, calls their OpenAI-compatible chat
// endpoint, and returns an AnswerResult that is ALWAYS grounded:false, mode:"general",
// model:"local:<name>". It NEVER throws: an unset endpoint → friendly not-configured
// guidance; an unreachable/erroring endpoint → friendly "unreachable" guidance. The
// HONESTY GUARDRAIL is prompt-level: the system prompt names in-scope files and tells
// the model it cannot read them (no keyword filters). We mock the I/O seams (settings,
// supabase gate, the file lister, the inspector builder) and global fetch, then assert
// answerLocal's own logic + the exact request it sends.

let settingsMap: Record<string, string> = {};
let supaEnabled = true;
let filesVar: { docId: string; displayName: string; type: string }[] = [];
let lastFetch: { url: string; init: any } | null = null;
let fetchImpl: (url: string, init: any) => Promise<Response> = async () =>
  new Response(JSON.stringify(cannedCompletion("hi")), { status: 200 });

function cannedCompletion(text: string) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

before(() => {
  mockExports("@/lib/engine/settings", {
    getSetting: async (key: string) => settingsMap[key] ?? "",
  });
  mockExports("@/lib/engine/supabase", { supabaseEnabled: () => supaEnabled });
  mockExports("@/lib/engine/answer-agentic", {
    listOwnerFiles: async () => filesVar,
    // The real inspector builder is pure; a passthrough stub keeps this a unit test.
    buildAgenticInspector: (o: Record<string, unknown>) => ({ _stub: true, ...o }),
  });
});

const realFetch = globalThis.fetch;
beforeEach(() => {
  settingsMap = { local_endpoint: "http://localhost:11434/v1", local_model: "llama3.2:3b" };
  supaEnabled = true;
  filesVar = [];
  lastFetch = null;
  fetchImpl = async () => new Response(JSON.stringify(cannedCompletion("hi")), { status: 200 });
  globalThis.fetch = (async (url: string, init: any) => {
    lastFetch = { url, init };
    return fetchImpl(url, init);
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

async function answerLocal(...args: Parameters<typeof import("@/lib/engine/answer-local.ts")["answerLocal"]>) {
  const mod = await import("@/lib/engine/answer-local.ts");
  return mod.answerLocal(...args);
}

// ── happy path: a real reply, grounded:false, model:"local:<name>" ──────────────────
test("happy path — returns the model's reply, grounded:false, mode:general, model local:<name>", async () => {
  fetchImpl = async () => new Response(JSON.stringify(cannedCompletion("The capital of France is Paris.")), { status: 200 });
  const r = await answerLocal("What is the capital of France?", "owner-1");
  assert.equal(r.answer, "The capital of France is Paris.");
  assert.equal(r.grounded, false, "Local mode is NEVER grounded (no documents read)");
  assert.equal(r.mode, "general");
  assert.equal(r.model, "local:llama3.2:3b");
  assert.deepEqual(r.evidence, { rows: [], chunks: [] });
  // It POSTed to the OpenAI-compatible chat route with the configured model.
  assert.equal(lastFetch?.url, "http://localhost:11434/v1/chat/completions");
  const sent = JSON.parse(lastFetch!.init.body);
  assert.equal(sent.model, "llama3.2:3b");
  assert.equal(sent.messages[0].role, "system");
  assert.equal(sent.messages.at(-1).content, "What is the capital of France?");
  // Honest cost: a Local call runs on the owner's own hardware — $0, attributed to the
  // local model/provider (never Anthropic/Haiku).
  assert.equal((r.inspector as any)?.cost?.usd, 0);
  assert.equal((r.inspector as any)?.cost?.provider, "local");
  assert.equal((r.inspector as any)?.cost?.model, "llama3.2:3b");
});

// ── no endpoint configured → friendly not-configured guidance, no fetch ─────────────
test("no endpoint set — friendly not-configured guidance, localGuidance='not-configured', NO fetch", async () => {
  settingsMap = { local_endpoint: "", local_model: "llama3.2:3b" };
  const r = await answerLocal("hi", "owner-1");
  assert.equal(r.localGuidance, "not-configured");
  assert.equal(r.grounded, false);
  assert.equal(r.mode, "general");
  assert.match(r.answer, /Settings → Model/);
  assert.equal(lastFetch, null, "a missing endpoint must NOT trigger a network call");
});

// ── unreachable endpoint (fetch rejects) → friendly guidance, never a throw ─────────
test("fetch rejects — friendly 'unreachable' guidance, no throw", async () => {
  fetchImpl = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:11434"); };
  const r = await answerLocal("hi", "owner-1"); // must resolve, not reject
  assert.equal(r.localGuidance, "unreachable");
  assert.equal(r.grounded, false);
  assert.match(r.answer, /unreachable/i);
  assert.match(r.answer, /localhost:11434/);
});

// ── HTTP error from a reachable server → also friendly 'unreachable' ────────────────
test("HTTP error from the endpoint — friendly 'unreachable' guidance, no throw", async () => {
  fetchImpl = async () => new Response("model not found", { status: 404 });
  const r = await answerLocal("hi", "owner-1");
  assert.equal(r.localGuidance, "unreachable");
  assert.equal(r.grounded, false);
});

// ── HONESTY GUARDRAIL: files in scope are NAMED + a cannot-read instruction is set ──
test("files in scope — system prompt NAMES the files and forbids reading them in Local mode", async () => {
  filesVar = [
    { docId: "d1", displayName: "vendor-contracts.xlsx", type: "spreadsheet" },
    { docId: "d2", displayName: "office-lease.pdf", type: "pdf" },
  ];
  await answerLocal("What do my documents say?", "owner-1");
  const sent = JSON.parse(lastFetch!.init.body);
  const system = sent.messages[0].content as string;
  assert.match(system, /vendor-contracts\.xlsx/, "the system prompt names the first file");
  assert.match(system, /office-lease\.pdf/, "the system prompt names the second file");
  assert.match(system, /cannot read uploaded documents/i, "it instructs the model it cannot read docs");
  assert.match(system, /general knowledge/i);
});
