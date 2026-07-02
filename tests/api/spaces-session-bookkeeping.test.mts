import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, NextResponseShim, readJson, mockExports, makeFakeAdmin } from "./_harness/harness.mts";
// The GET sessions route uses the REAL (pure) session-merge helpers — we import them
// here BEFORE the mocks are installed (top-level runs before `before()`), then pass
// them straight through the ask-history mock so the merge contract runs for real while
// logAsk stays a stub. This is what lets case (c) prove the ACTUAL doc-only merge, not a
// re-implemented proxy.
import { groupSessions, mergeSessionSources } from "@/lib/engine/ask-history";

// ── Contract under test: Knowledge Space SESSION BOOKKEEPING across four routes ──────
// These drive the REAL route handlers; only the I/O seams (auth, the spaces engine, the
// manifest reader, the Supabase client) are mocked. They pin the F1/F2/F7 fixes:
//   (a) POST /api/ask with space_id registers the session→space association
//   (b) POST /api/ingest with session_id + space_id registers it
//   (c) GET  /api/spaces/sessions surfaces MANIFEST-derived sessions when session_spaces
//       is empty (F1 regression — the list must not be permanently empty for real users)
//   (d) DELETE /api/spaces cleans ask_history/session_titles for manifest-derived sessions
//       (F2 regression — deleting a space must not orphan its chats' history)
//   (e) POST /api/spaces/sessions rejects a foreign/unknown space with 404 and writes
//       nothing (F7 — ownership check, no existence leak)

// ── Mutable per-test state (the harness pattern: mocks read these) ──────────────────
let current: ReturnType<typeof user> | null = user();
// Recorder: every assignSessionToSpace(owner, session, space) the routes make.
let assignCalls: { ownerId: string; sessionId: string; spaceId: string }[] = [];
// sessionsInSpace() result — the session_spaces table contents (empty = the F1/F2 bug condition).
let sessionsInSpaceResult: string[] = [];
// spaceExistsForOwner() result — whether the caller owns the target space (F7 gate).
let spaceOwned = true;
// listManifestEntries() result — the _files.json manifest rows for the queried space.
let manifestEntries: {
  docId: string;
  displayName: string;
  type: string;
  session_id: string | null;
  space_id: string | null;
}[] = [];
// removeOriginalFile() recorder (DELETE path).
let removedDocs: string[] = [];
// The recording fake Supabase admin for this test (rebuilt each test with its responders).
let fake = makeFakeAdmin();

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/request-context", {
    runWithOwner: async (_id: string, fn: () => unknown) => fn(),
    currentOwner: () => current?.id,
  });
  mockExports("@/lib/engine/llm", { backendConfigured: async () => true });
  // Answer lanes are stubbed — this suite tests bookkeeping, never answer quality (zero SDK).
  mockExports("@/lib/engine/answer", { answerQuestion: async (q: string) => ({ question: q, answer: `A:${q}` }) });
  mockExports("@/lib/engine/answer-agentic", { answerAgentic: async (q: string) => ({ question: q, answer: `A:${q}` }) });
  mockExports("@/lib/engine/answer-messages", { answerMessages: async (q: string) => ({ question: q, answer: `A:${q}` }) });
  // The ask route imports answer-local at the top level (model_mode routing); stub it so the
  // real module (+ its answer-agentic imports) doesn't load. This suite runs the cloud lane.
  mockExports("@/lib/engine/answer-local", { answerLocal: async (q: string) => ({ question: q, answer: `A:${q}` }) });
  mockExports("@/lib/engine/error-message", { friendlyAskError: () => "try again" });
  // ask-history: real merge helpers (case c), stubbed logAsk (best-effort, irrelevant here).
  mockExports("@/lib/engine/ask-history", { logAsk: async () => {}, groupSessions, mergeSessionSources });
  // The spaces engine seam — assign is RECORDED so we can prove a real registration happened;
  // sessionsInSpace / spaceExistsForOwner are controllable; CRUD is stubbed.
  mockExports("@/lib/engine/spaces", {
    assignSessionToSpace: async (ownerId: string, sessionId: string, spaceId: string) => {
      assignCalls.push({ ownerId, sessionId, spaceId });
    },
    sessionsInSpace: async () => sessionsInSpaceResult,
    spaceExistsForOwner: async () => spaceOwned,
    createSpace: async () => ({ id: "s", owner_id: "o", name: "n", created_at: "" }),
    listSpaces: async () => [],
    deleteSpace: async () => {},
  });
  mockExports("@/lib/engine/doc-files", {
    listManifestEntries: async () => manifestEntries,
    removeOriginalFile: async (_owner: string, docId: string) => { removedDocs.push(docId); },
    storeOriginalFile: async () => true,
  });
  mockExports("@/lib/engine/supabase", { admin: () => fake.client, supabaseEnabled: () => true });
  mockExports("@/lib/engine/ingest", { docIdFromFilename: (n: string) => n.replace(/\.[^.]+$/, "") });
});

beforeEach(() => {
  current = user({ id: "owner-1", role: "user", isDemo: false });
  assignCalls = [];
  sessionsInSpaceResult = [];
  spaceOwned = true;
  manifestEntries = [];
  removedDocs = [];
  fake = makeFakeAdmin();
});

// ── Route drivers ───────────────────────────────────────────────────────────────────
async function askPOST(body: unknown) {
  const mod = await import("@/app/api/ask/route.ts");
  return mod.POST(new Request("http://x/api/ask", { method: "POST", body: JSON.stringify(body) }));
}
async function ingestPOST(form: FormData) {
  const mod = await import("@/app/api/ingest/route.ts");
  return mod.POST(new Request("http://x/api/ingest", { method: "POST", body: form }));
}
async function sessionsGET(space: string | null) {
  const mod = await import("@/app/api/spaces/sessions/route.ts");
  const url = space === null ? "http://x/api/spaces/sessions" : `http://x/api/spaces/sessions?space=${space}`;
  return mod.GET(new Request(url));
}
async function sessionsPOST(body: unknown) {
  const mod = await import("@/app/api/spaces/sessions/route.ts");
  return mod.POST(new Request("http://x/api/spaces/sessions", { method: "POST", body: JSON.stringify(body) }));
}
async function spacesDELETE(space: string) {
  const mod = await import("@/app/api/spaces/route.ts");
  return mod.DELETE(new Request(`http://x/api/spaces?space=${space}`, { method: "DELETE" }));
}
function fileForm(name: string, fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([37, 80, 68, 70]).buffer as ArrayBuffer], name, { type: "application/pdf" }));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

// ── (a) POST /api/ask registers the session→space association ────────────────────────
test("(a) ask with a space_id registers session→space (owner, session, space)", async () => {
  await askPOST({ question: "hi", session_id: "sess-a", space_id: "space-1" });
  assert.deepEqual(assignCalls, [{ ownerId: "owner-1", sessionId: "sess-a", spaceId: "space-1" }]);
});
test("(a) ask with NO space_id registers nothing (unspaced chats are untouched)", async () => {
  await askPOST({ question: "hi", session_id: "sess-a" });
  assert.equal(assignCalls.length, 0);
});
test("(a) ask in GLOBAL mode registers nothing (global is not a space)", async () => {
  await askPOST({ question: "hi", session_id: "sess-a", space_id: "space-1", global_mode: true });
  assert.equal(assignCalls.length, 0);
});

// ── (b) POST /api/ingest registers when BOTH session_id + space_id are present ───────
test("(b) ingest with session_id + space_id registers session→space", async () => {
  await ingestPOST(fileForm("q1.pdf", { session_id: "sess-b", space_id: "space-1" }));
  assert.deepEqual(assignCalls, [{ ownerId: "owner-1", sessionId: "sess-b", spaceId: "space-1" }]);
});
test("(b) ingest with only session_id (no space) registers nothing", async () => {
  await ingestPOST(fileForm("q1.pdf", { session_id: "sess-b" }));
  assert.equal(assignCalls.length, 0);
});
test("(b) ingest with only space_id (no session) registers nothing", async () => {
  await ingestPOST(fileForm("q1.pdf", { space_id: "space-1" }));
  assert.equal(assignCalls.length, 0);
});

// ── (c) GET /api/spaces/sessions surfaces manifest-derived sessions (F1) ─────────────
test("(c) F1: with session_spaces EMPTY, a manifest doc's session still lists as a chat", async () => {
  sessionsInSpaceResult = []; // the real-user bug condition: nothing in session_spaces
  manifestEntries = [
    { docId: "d1", displayName: "budget.xlsx", type: "spreadsheet", session_id: "doc-sess-1", space_id: "space-1" },
  ];
  // No ask rows / titles for this session — it is known ONLY from the manifest.
  fake = makeFakeAdmin({
    on: {
      "ask_history:select": () => ({ data: [] }),
      "session_titles:select": () => ({ data: [] }),
    },
  });
  const { status, body } = await readJson(await sessionsGET("space-1"));
  assert.equal(status, 200);
  assert.equal(body.sessions.length, 1, "the doc-only session must appear even though session_spaces is empty");
  assert.equal(body.sessions[0].session_id, "doc-sess-1");
});
test("(c) with BOTH sources empty, the list is still an empty array (shape preserved)", async () => {
  sessionsInSpaceResult = [];
  manifestEntries = [];
  fake = makeFakeAdmin({
    on: { "ask_history:select": () => ({ data: [] }), "session_titles:select": () => ({ data: [] }) },
  });
  const { status, body } = await readJson(await sessionsGET("space-1"));
  assert.equal(status, 200);
  assert.deepEqual(body.sessions, []);
});

// ── (d) DELETE /api/spaces cleans manifest-derived sessions' history (F2) ────────────
test("(d) F2: deleting a space cleans ask_history + session_titles for a manifest-derived session", async () => {
  sessionsInSpaceResult = []; // session_spaces empty (the F1/F2 pre-fix reality)
  manifestEntries = [
    { docId: "d1", displayName: "budget.xlsx", type: "spreadsheet", session_id: "doc-sess-1", space_id: "space-1" },
  ];
  await spacesDELETE("space-1");
  const askDelete = fake.calls.find((c) => c.table === "ask_history" && c.op === "delete");
  const titleDelete = fake.calls.find((c) => c.table === "session_titles" && c.op === "delete");
  assert.ok(askDelete, "ask_history rows for the manifest-derived session must be deleted");
  assert.deepEqual(askDelete!.eq["in:session_id"], ["doc-sess-1"]);
  assert.ok(titleDelete, "session_titles rows for the manifest-derived session must be deleted");
  assert.deepEqual(titleDelete!.eq["in:session_id"], ["doc-sess-1"]);
});
test("(d) delete still removes the space's files (union does not regress the file cleanup)", async () => {
  manifestEntries = [
    { docId: "d1", displayName: "a.pdf", type: "pdf", session_id: "doc-sess-1", space_id: "space-1" },
  ];
  await spacesDELETE("space-1");
  assert.deepEqual(removedDocs, ["d1"]);
});

// ── (e) POST /api/spaces/sessions ownership check (F7) ───────────────────────────────
test("(e) F7: assigning a session to a FOREIGN/unknown space → 404 and writes nothing", async () => {
  spaceOwned = false;
  const { status } = await readJson(await sessionsPOST({ sessionId: "sess-e", spaceId: "not-mine" }));
  assert.equal(status, 404);
  assert.equal(assignCalls.length, 0, "no session_spaces row may be written for a space the caller doesn't own");
});
test("(e) assigning to an OWNED space still succeeds (200) and writes the row", async () => {
  spaceOwned = true;
  const { status } = await readJson(await sessionsPOST({ sessionId: "sess-e", spaceId: "space-1" }));
  assert.equal(status, 200);
  assert.deepEqual(assignCalls, [{ ownerId: "owner-1", sessionId: "sess-e", spaceId: "space-1" }]);
});
