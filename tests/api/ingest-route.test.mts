import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, NextResponseShim, readJson, mockExports } from "./_harness/harness.mts";

// ── Contract under test: GET/POST /api/ingest (the Upload button's endpoint) ──────
// The handler's gating + multipart parsing + format routing + size caps + the
// zero-content signal are the thing under test. The actual ingest functions and the
// original-file storage are stubbed (the engine lane is tested elsewhere; here we
// assert the HANDLER's contract: who's allowed, what's rejected and with which
// status, which lane a file is routed to, and the honest zero-content flag).

let current: ReturnType<typeof user> | null = user();
let supaOn = true;
const ingestCalls: { fn: string; name: string; owner: string }[] = [];
let nextResult: { doc?: string; table?: string; chunks?: number; rows?: number } = { doc: "d1", chunks: 3 };

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/request-context", { runWithOwner: async (_id: string, fn: () => unknown) => fn() });
  mockExports("@/lib/engine/supabase", { supabaseEnabled: () => supaOn });
  mockExports("@/lib/engine/doc-files", { storeOriginalFile: async () => true });
  const rec = (fn: string) => async (...a: any[]) => {
    // signature: (content/buf, name, [label,] owner)
    const owner = a[a.length - 1];
    ingestCalls.push({ fn, name: a[1], owner });
    return nextResult;
  };
  mockExports("@/lib/engine/ingest", { ingestPdf: rec("pdf"), ingestCsv: rec("csv"), ingestXlsx: rec("xlsx"), ingestDocx: rec("docx") });
});

beforeEach(() => {
  current = user({ id: "owner-42" });
  supaOn = true;
  ingestCalls.length = 0;
  nextResult = { doc: "d1", chunks: 3 };
});

async function POST(form: FormData) {
  const mod = await import("@/app/api/ingest/route.ts");
  return mod.POST(new Request("http://x/api/ingest", { method: "POST", body: form }));
}
function fileForm(name: string, bytes: Uint8Array, type = "") {
  const fd = new FormData();
  // Pass the underlying ArrayBuffer (a valid BlobPart) — these test inputs are
  // freshly-allocated full views, so the buffer is exactly the bytes.
  fd.append("file", new File([bytes.buffer as ArrayBuffer], name, type ? { type } : undefined));
  return fd;
}

// ── auth ──────────────────────────────────────────────────────────────────────────
test("POST unauthenticated → 401", async () => {
  current = null;
  assert.equal((await POST(fileForm("a.pdf", new Uint8Array([1])))).status, 401);
});
test("POST by a disabled user → 401", async () => {
  current = user({ disabled: true });
  assert.equal((await POST(fileForm("a.pdf", new Uint8Array([1])))).status, 401);
});

// ── input validation (the messages a client sees when they fumble an upload) ──────
test("no 'file' field → 400", async () => {
  assert.equal((await POST(new FormData())).status, 400);
});
test("empty file (0 bytes) → 400", async () => {
  const { status, body } = await readJson(await POST(fileForm("a.pdf", new Uint8Array())));
  assert.equal(status, 400);
  assert.match(body.error, /empty/i);
});
test("oversized file (>15MB) → 413", async () => {
  const big = new Uint8Array(15 * 1024 * 1024 + 1);
  const { status, body } = await readJson(await POST(fileForm("big.pdf", big)));
  assert.equal(status, 413);
  assert.match(body.error, /too large/i);
});
test("unsupported type (.txt) → 415", async () => {
  const { status, body } = await readJson(await POST(fileForm("notes.txt", new Uint8Array([65, 66]))));
  assert.equal(status, 415);
  assert.match(body.error, /unsupported/i);
});

// ── format routing (the file must go to the RIGHT lane, tagged with the uploader) ─
test("a .csv routes to the CSV lane, owner-tagged", async () => {
  await POST(fileForm("data.csv", new TextEncoder().encode("a,b\n1,2")));
  assert.deepEqual(ingestCalls.map((c) => c.fn), ["csv"]);
  assert.equal(ingestCalls[0].owner, "owner-42");
});
test("a .xlsx routes to the XLSX lane", async () => {
  await POST(fileForm("book.xlsx", new Uint8Array([80, 75])));
  assert.equal(ingestCalls[0].fn, "xlsx");
});
test("a .pdf routes to the PDF lane", async () => {
  await POST(fileForm("doc.pdf", new Uint8Array([37, 80, 68, 70])));
  assert.equal(ingestCalls[0].fn, "pdf");
});
test("a .docx routes to the DOCX lane", async () => {
  await POST(fileForm("memo.docx", new Uint8Array([80, 75, 3, 4])));
  assert.equal(ingestCalls[0].fn, "docx");
});
test("type is honoured even without an extension (CSV via mime)", async () => {
  await POST(fileForm("noext", new TextEncoder().encode("a,b\n1,2"), "text/csv"));
  assert.equal(ingestCalls[0].fn, "csv");
});

// ── the zero-content signal (don't tell the client "ask about it" when nothing was read) ─
test("a file that yields 0 chunks/rows reports zeroContent=true", async () => {
  nextResult = { doc: "d1", chunks: 0, rows: 0 };
  const { body } = await readJson(await POST(fileForm("scan.pdf", new Uint8Array([1, 2, 3]))));
  assert.equal(body.ok, true);
  assert.equal(body.zeroContent, true);
});
test("a file with real content reports zeroContent=false", async () => {
  nextResult = { doc: "d1", chunks: 5 };
  const { body } = await readJson(await POST(fileForm("real.pdf", new Uint8Array([1, 2, 3]))));
  assert.equal(body.zeroContent, false);
});

// ── backend reporting (durable vs in-memory) reflects the real store state ────────
test("reports the pgvector backend when Supabase is on", async () => {
  supaOn = true;
  const { body } = await readJson(await POST(fileForm("a.pdf", new Uint8Array([1]))));
  assert.equal(body.backend, "pgvector");
});
test("reports the local (in-memory) backend when Supabase is off", async () => {
  supaOn = false;
  const { body } = await readJson(await POST(fileForm("a.pdf", new Uint8Array([1]))));
  assert.equal(body.backend, "local");
});
