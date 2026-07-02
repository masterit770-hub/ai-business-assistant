// ── Contract under test: answerMessages (the Messages-API answer engine) ──────────
//
// The engine's REAL logic runs; only its I/O SEAMS are mock.module()'d. Crucially the
// Anthropic SDK is a RECORDING FAKE — this suite makes ZERO real Claude/Anthropic calls
// (Rule #0); the fake records uploads + create calls and returns a canned reply.
//
// What we prove:
//   1. THE LEAK INVARIANT — the same files are uploaded to the Files API exactly ONCE and
//      then reused across every later ask (before the fix: N files × M asks re-uploads).
//   2. STALENESS RECOVERY — if create fails because a cached file_id is gone, the engine
//      invalidates it, re-uploads fresh, and retries the create ONCE (so a cache never
//      makes answering less reliable than today).
//   3. MODEL ECHO — result.model reflects the model actually sent to messages.create
//      (the "prod silently ran Haiku" false-green class).
//   4. CACHE MUST NOT BREAK ANSWERING — a throwing cache still yields a normal answer.
//
// The cache module is mocked by an in-memory map keyed EXACTLY like the real table
// (owner_id, doc_id, content_sha256) — a faithful fake, so a hit/miss here means a hit/miss
// in prod.

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mockExports } from "./_harness/harness.mts";

// makeClient() needs a credential to construct the (mocked) SDK. A fake subscription bearer
// with the billed API key UNSET — the SDK is fully mocked, so NO real call is ever made.
delete process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_AUTH_TOKEN = "test-token-not-a-real-credential";

// ── Recording fake Anthropic SDK state (reset each test) ──────────────────────────
let uploadCalls: { name: string }[] = [];
let uploadCounter = 0;
let createCalls: { model: string; content: unknown }[] = [];
let failCreateWithStaleFileOnce = false;

class FakeAnthropic {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_opts: unknown) {}
  beta = {
    files: {
      upload: async (args: { file?: { name?: string } }) => {
        uploadCalls.push({ name: args?.file?.name ?? "?" });
        return { id: `file_${++uploadCounter}` };
      },
    },
    messages: {
      create: async (args: { model: string; messages: { content: unknown }[] }) => {
        const last = args.messages[args.messages.length - 1];
        createCalls.push({ model: args.model, content: last?.content });
        if (failCreateWithStaleFileOnce) {
          failCreateWithStaleFileOnce = false;
          const err = new Error("input references file_gone which was not found") as Error & { status?: number };
          err.status = 404;
          throw err;
        }
        return {
          content: [{ type: "text", text: "Here is your answer.\n\nSOURCES_USED: NONE" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  };
}

// toFile passthrough — the real one wraps bytes into an uploadable; we only carry the name
// so the upload ledger can identify a file.
async function fakeToFile(_bytes: unknown, name: string, _opts: unknown) {
  return { name };
}

// ── Faithful in-memory cache (keyed exactly like the real anthropic_file_cache table) ──
let cacheStore: Map<string, string>;
let cacheGetThrows = false;
let cachePutThrows = false;
const cacheKey = (owner: string, doc: string, sha: string) => `${owner}::${doc}::${sha}`;

const cacheModuleMock = {
  getCachedFileId: async (ownerId: string, docId: string, sha: string) => {
    if (cacheGetThrows) throw new Error("cache get boom");
    return cacheStore.get(cacheKey(ownerId, docId, sha)) ?? null;
  },
  putCachedFileId: async (ownerId: string, docId: string, sha: string, fileId: string) => {
    if (cachePutThrows) throw new Error("cache put boom");
    cacheStore.set(cacheKey(ownerId, docId, sha), fileId);
  },
  invalidateFileIds: async (ownerId: string, docIds: string[]) => {
    for (const key of [...cacheStore.keys()]) {
      const [o, d] = key.split("::");
      if (o === ownerId && docIds.includes(d)) cacheStore.delete(key);
    }
  },
};

// A fixed 2-file manifest (one PDF + one spreadsheet) for the owner.
const OWNER = "owner-1";
const MANIFEST = [
  { docId: "doc-a", displayName: "a.pdf", type: "pdf", space_id: null },
  { docId: "doc-b", displayName: "b.xlsx", type: "spreadsheet", space_id: null },
];

before(() => {
  mockExports("@anthropic-ai/sdk", { default: FakeAnthropic, toFile: fakeToFile });
  mockExports("@/lib/engine/supabase", { supabaseEnabled: () => true, admin: () => { throw new Error("admin() must not be called — cache is mocked"); } });
  mockExports("@/lib/engine/answer-agentic", {
    listOwnerFiles: async () => MANIFEST,
    buildAgenticInspector: (o: unknown) => o,
  });
  mockExports("@/lib/engine/doc-files", {
    fetchOriginalFile: async (_owner: string, docId: string) => ({
      // Stable bytes per docId → stable sha256 → stable cache key across asks.
      bytes: new TextEncoder().encode(`stable-bytes-of-${docId}`),
      contentType: docId === "doc-a" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: docId,
    }),
  });
  mockExports("@/lib/engine/settings", { getSetting: async () => null });
  mockExports("@/lib/engine/spaces", { listSpaces: async () => [] });
  mockExports("@/lib/engine/anthropic-file-cache", cacheModuleMock);
});

beforeEach(() => {
  uploadCalls = [];
  uploadCounter = 0;
  createCalls = [];
  failCreateWithStaleFileOnce = false;
  cacheStore = new Map();
  cacheGetThrows = false;
  cachePutThrows = false;
});

async function answer(model = "claude-haiku-4-5", question = "how many files?") {
  const { answerMessages } = await import("@/lib/engine/answer-messages.ts");
  return answerMessages(question, OWNER, model, "chat-1");
}

// ── 1. THE LEAK INVARIANT ───────────────────────────────────────────────────────────
test("3 asks over the SAME 2 files upload to the Files API exactly ONCE (asks 2-3 are cache hits)", async () => {
  await answer();
  await answer();
  await answer();
  assert.equal(
    uploadCalls.length,
    2,
    `expected 2 total uploads (first ask only); got ${uploadCalls.length} — the per-ask re-upload leak`
  );
});

// ── 2. STALENESS RECOVERY ─────────────────────────────────────────────────────────
test("a stale cached file_id → invalidate + re-upload + retry the create ONCE, then a normal answer", async () => {
  await answer(); // ask 1 populates the cache (2 uploads)
  const uploadsAfterWarm = uploadCalls.length;
  const createsAfterWarm = createCalls.length;
  assert.equal(uploadsAfterWarm, 2);

  failCreateWithStaleFileOnce = true; // ask 2's first create throws a file-not-found (404)
  const res = await answer();

  assert.equal(res.answer, "Here is your answer.", "recovered to a normal answer, not the engine-error text");
  assert.equal(uploadCalls.length - uploadsAfterWarm, 2, "the 2 stale-hit files are re-uploaded fresh");
  assert.equal(createCalls.length - createsAfterWarm, 2, "exactly ONE retry (failed create + one retry)");
});

// ── 3. MODEL ECHO ─────────────────────────────────────────────────────────────────
test("result.model reflects the model actually sent to messages.create", async () => {
  const res = await answer("claude-sonnet-4-6");
  assert.equal(res.model, "claude-sonnet-4-6", "the AnswerResult echoes the resolved model");
  assert.equal(createCalls.at(-1)?.model, "claude-sonnet-4-6", "…and that is the model actually sent");
});

// ── 4. CACHE MUST NOT BREAK ANSWERING ──────────────────────────────────────────────
test("a throwing cache (get + put) still returns a normal answer; uploads happen as before", async () => {
  cacheGetThrows = true;
  cachePutThrows = true;
  const res = await answer();
  assert.equal(res.answer, "Here is your answer.", "a throwing cache never breaks answering");
  assert.equal(uploadCalls.length, 2, "with an unusable cache every file uploads (today's behavior)");
});
