import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, NextResponseShim, readJson, mockExports } from "./_harness/harness.mts";

// ── Contract under test: GET/POST /api/ingest (the Upload button's endpoint) ──────
// The ingest route no longer chunks/indexes at upload time — the agentic engine reads
// the RAW original bytes natively. So the route's job is: gate auth, parse the multipart
// upload, enforce the size cap + supported formats, REQUIRE a chat (session_id) or a
// Knowledge Space (space_id) so a doc is never orphaned, persist the ORIGINAL bytes
// (storeOriginalFile), and — when a chat upload is inside a space — register the
// session→space association. It always reports zeroContent=false (there is no
// extraction gate). The stores + the spaces seam are stubbed; here we assert the
// HANDLER contract a client depends on. ZERO Claude/SDK calls.

let current: ReturnType<typeof user> | null = user();
let supaOn = true;
// Recorders for the seams the route drives.
const storeCalls: { ownerId: string; docId: string; name: string; chatId: string | null; spaceId: string | null }[] = [];
const assignCalls: { ownerId: string; sessionId: string; spaceId: string }[] = [];

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/request-context", { runWithOwner: async (_id: string, fn: () => unknown) => fn() });
  mockExports("@/lib/engine/supabase", { supabaseEnabled: () => supaOn });
  // docIdFromFilename: the real derivation is tested elsewhere; here a simple stub keyed
  // off the base name is enough to assert the doc id the route persists under.
  mockExports("@/lib/engine/ingest", { docIdFromFilename: (n: string) => n.replace(/\.[^.]+$/, "") });
  mockExports("@/lib/engine/doc-files", {
    storeOriginalFile: async (
      _bytes: Uint8Array,
      ownerId: string,
      docId: string,
      name: string,
      chatId: string | null,
      spaceId: string | null,
    ) => {
      storeCalls.push({ ownerId, docId, name, chatId, spaceId });
      return true;
    },
  });
  mockExports("@/lib/engine/spaces", {
    assignSessionToSpace: async (ownerId: string, sessionId: string, spaceId: string) => {
      assignCalls.push({ ownerId, sessionId, spaceId });
    },
  });
});

beforeEach(() => {
  current = user({ id: "owner-42" });
  supaOn = true;
  storeCalls.length = 0;
  assignCalls.length = 0;
});

async function POST(form: FormData) {
  const mod = await import("@/app/api/ingest/route.ts");
  return mod.POST(new Request("http://x/api/ingest", { method: "POST", body: form }));
}
// A file upload form. `fields` carries session_id / space_id when the caller supplies them.
function fileForm(name: string, bytes: Uint8Array, type = "", fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.append("file", new File([bytes.buffer as ArrayBuffer], name, type ? { type } : undefined));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}
// Convenience: a valid in-chat PDF upload (has a session so it clears the orphan guard).
function pdfInChat(name = "doc.pdf", fields: Record<string, string> = { session_id: "sess-1" }) {
  return fileForm(name, new Uint8Array([37, 80, 68, 70]), "application/pdf", fields);
}

// ── auth ──────────────────────────────────────────────────────────────────────────
test("POST unauthenticated → 401", async () => {
  current = null;
  assert.equal((await POST(pdfInChat())).status, 401);
});
test("POST by a disabled user → 401", async () => {
  current = user({ disabled: true });
  assert.equal((await POST(pdfInChat())).status, 401);
});

// ── input validation (the messages a client sees when they fumble an upload) ──────
test("no 'file' field → 400", async () => {
  assert.equal((await POST(new FormData())).status, 400);
});
test("empty file (0 bytes) → 400", async () => {
  const { status, body } = await readJson(await POST(fileForm("a.pdf", new Uint8Array(), "", { session_id: "s" })));
  assert.equal(status, 400);
  assert.match(body.error, /empty/i);
});
test("oversized file (>15MB) → 413", async () => {
  const big = new Uint8Array(15 * 1024 * 1024 + 1);
  const { status, body } = await readJson(await POST(fileForm("big.pdf", big, "", { session_id: "s" })));
  assert.equal(status, 413);
  assert.match(body.error, /too large/i);
});
test("unsupported type (.txt, in a chat) → 415", async () => {
  const { status, body } = await readJson(
    await POST(fileForm("notes.txt", new Uint8Array([65, 66]), "", { session_id: "s" })),
  );
  assert.equal(status, 415);
  assert.match(body.error, /unsupported/i);
});

// ── the orphan guard: a doc must belong to a chat OR a space ──────────────────────
test("neither session_id nor space_id → 400 (a doc must never be orphaned)", async () => {
  const { status, body } = await readJson(await POST(fileForm("doc.pdf", new Uint8Array([37, 80, 68, 70]))));
  assert.equal(status, 400);
  assert.match(body.error, /chat or a Knowledge Space|session_id|space_id/i);
  assert.equal(storeCalls.length, 0, "an orphaned upload is rejected before storage");
});

// ── the happy path: the ORIGINAL bytes are persisted, owner + chat + space tagged ─
test("an in-chat PDF → 200, original bytes stored, owner + chat tagged", async () => {
  const { status, body } = await readJson(await POST(pdfInChat("doc.pdf", { session_id: "sess-1" })));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(storeCalls.length, 1, "the original bytes are persisted");
  assert.equal(storeCalls[0].ownerId, "owner-42", "tagged with the uploader from the session");
  assert.equal(storeCalls[0].docId, "doc");
  assert.equal(storeCalls[0].chatId, "sess-1");
  assert.equal(storeCalls[0].spaceId, null);
});
test("an upload straight into a Knowledge Space (space_id, no chat) → 200, space tagged", async () => {
  const { status } = await readJson(await POST(pdfInChat("doc.pdf", { space_id: "space-1" })));
  assert.equal(status, 200);
  assert.equal(storeCalls[0].chatId, null);
  assert.equal(storeCalls[0].spaceId, "space-1");
});

// ── every supported format is accepted (all go to the same raw-bytes store) ───────
for (const [name, bytes, type] of [
  ["data.csv", new TextEncoder().encode("a,b\n1,2"), "text/csv"],
  ["book.xlsx", new Uint8Array([80, 75]), ""],
  ["doc.pdf", new Uint8Array([37, 80, 68, 70]), ""],
  ["memo.docx", new Uint8Array([80, 75, 3, 4]), ""],
] as const) {
  test(`a ${name.split(".").pop()} upload is accepted → 200, stored`, async () => {
    const { status } = await readJson(await POST(fileForm(name, bytes as Uint8Array, type, { session_id: "sess-1" })));
    assert.equal(status, 200);
    assert.equal(storeCalls.length, 1);
  });
}
test("type is honoured even without an extension (CSV via mime)", async () => {
  const { status } = await readJson(
    await POST(fileForm("noext", new TextEncoder().encode("a,b\n1,2"), "text/csv", { session_id: "sess-1" })),
  );
  assert.equal(status, 200);
  assert.equal(storeCalls.length, 1);
});

// ── the honest content flag: raw-bytes model → always answerable (never zero-content) ─
test("a successful upload reports zeroContent=false (the agent reads raw bytes)", async () => {
  const { body } = await readJson(await POST(pdfInChat()));
  assert.equal(body.zeroContent, false);
});

// ── backend reporting reflects the real store state ───────────────────────────────
test("reports the supabase backend when Supabase is on", async () => {
  supaOn = true;
  const { body } = await readJson(await POST(pdfInChat()));
  assert.equal(body.backend, "supabase");
});
test("reports the local (in-memory) backend when Supabase is off", async () => {
  supaOn = false;
  const { body } = await readJson(await POST(pdfInChat()));
  assert.equal(body.backend, "local");
});

// ── Knowledge Space bookkeeping: a chat upload inside a space registers the association ─
test("session_id + space_id → registers the session→space association", async () => {
  await POST(pdfInChat("doc.pdf", { session_id: "sess-1", space_id: "space-1" }));
  assert.deepEqual(assignCalls, [{ ownerId: "owner-42", sessionId: "sess-1", spaceId: "space-1" }]);
});
test("session_id only (no space) registers nothing", async () => {
  await POST(pdfInChat("doc.pdf", { session_id: "sess-1" }));
  assert.equal(assignCalls.length, 0);
});
test("space_id only (no chat) registers nothing (no session to associate)", async () => {
  await POST(pdfInChat("doc.pdf", { space_id: "space-1" }));
  assert.equal(assignCalls.length, 0);
});

// ── GET exposes the real cap + supported formats (single source of truth) ─────────
test("GET returns the byte cap + supported formats the POST enforces", async () => {
  const mod = await import("@/app/api/ingest/route.ts");
  const { status, body } = await readJson(await mod.GET());
  assert.equal(status, 200);
  assert.equal(body.maxMb, 15);
  assert.ok(Array.isArray(body.formats) && body.formats.includes("PDF"));
});
