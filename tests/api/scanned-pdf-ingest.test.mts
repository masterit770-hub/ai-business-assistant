import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, NextResponseShim, readJson, mockExports } from "./_harness/harness.mts";

// ── BUG 1 — a SCANNED / text-less PDF must NEVER be rejected at upload ─────────────
//
// REAL BEHAVIOR under test: the agentic answer reads the RAW original file natively
// (the multimodal Read tool), so text extraction at ingest is best-effort enrichment
// for the catalog/urgency badge — it is NOT the substrate the agent reads. Therefore a
// scanned/image-only PDF whose text layer is empty AND whose OCR recovered nothing must:
//   1. ingest SUCCESSFULLY (ingestPdf does NOT throw),
//   2. still produce a CATALOG record (storeDocument is called so the doc is listed),
//   3. and — crucially — through the real /api/ingest route, its RAW BYTES are stored
//      (storeOriginalFile runs). The old `throw` on zero chunks aborted the route's try
//      block BEFORE storeOriginalFile ran, destroying the one artifact the agent needs.
//
// This drives the REAL ingest functions + the REAL route handler; only the I/O seams
// (unpdf text extraction, the urgency LLM, the durable stores) are mock.module()'d.
// ZERO Claude/SDK calls — the urgency classifier (the only LLM caller in this path) is
// stubbed, so the test is fully deterministic and offline.

// What unpdf "extracts" — set per-test. A scanned PDF → empty per-page text.
let extractedPages: string[] = [""];
// What mammoth "extracts" for a .docx — empty string = a text-less Word file.
let extractedDocxText = "";

// Recorders for the seams we assert on.
const storeDocumentCalls: { doc: string; recordCount: number }[] = [];
const storeOriginalFileCalls: { ownerId: string; docId: string; name: string }[] = [];
let classifyUrgencyCalled = false;

let current: ReturnType<typeof user> | null = user({ id: "owner-7" });
let supaOn = true;

before(() => {
  // ── HTTP / auth / context seams (route handler) ──
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/request-context", {
    runWithOwner: async (_id: string, fn: () => unknown) => fn(),
  });
  mockExports("@/lib/engine/supabase", { supabaseEnabled: () => supaOn });
  // The route registers a session→space association when a chat upload is in a space;
  // stub the seam (this suite is about raw-bytes storage, not space bookkeeping).
  mockExports("@/lib/engine/spaces", { assignSessionToSpace: async () => {} });

  // ── raw-file storage seam — RECORD the call so we can prove it RAN even for a
  //    zero-text scan (the heart of the ordering bug). ──
  mockExports("@/lib/engine/doc-files", {
    storeOriginalFile: async (
      _bytes: Uint8Array,
      ownerId: string,
      docId: string,
      name: string,
    ) => {
      storeOriginalFileCalls.push({ ownerId, docId, name });
      return true;
    },
  });

  // ── text-extraction seams: a SCANNED PDF yields empty page text; a text-less
  //    .docx yields "". These stand in for "OCR recovered nothing". ──
  mockExports("unpdf", {
    getDocumentProxy: async (_buf: Uint8Array) => ({}),
    extractText: async (_pdf: unknown, _opts: unknown) => ({ text: extractedPages }),
  });
  mockExports("mammoth", {
    extractRawText: async (_o: unknown) => ({ value: extractedDocxText }),
  });

  // ── OCR is best-effort; stub it to a no-op (recovers nothing) so the scan stays
  //    text-less without touching Tesseract/WASM. ──
  mockExports("@/lib/engine/ocr.ts", { ocrLowTextPages: async () => ({}) });

  // ── urgency = the ONLY LLM call in this path. Stub it (no Claude/SDK call). ──
  mockExports("@/lib/engine/urgency.ts", {
    classifyUrgency: async () => {
      classifyUrgencyCalled = true;
      return "medium";
    },
  });

  // ── durable + in-memory stores: RECORD storeDocument (the catalog record), no-op
  //    the rest. storeDocChunks/storeDocument must NOT throw for a zero-chunk doc. ──
  mockExports("@/lib/engine/doc-store.ts", {
    storeDocument: async (spec: { doc: string }, records: unknown[]) => {
      storeDocumentCalls.push({ doc: spec.doc, recordCount: records.length });
    },
    storeRows: async () => {},
  });
  mockExports("@/lib/engine/pgvector-store.ts", {
    storeDocChunks: async () => 0,
  });
  mockExports("@/lib/engine/structured-rows-store.ts", {
    storeUploadedRows: async () => 0,
  });
});

beforeEach(() => {
  current = user({ id: "owner-7" });
  supaOn = true;
  extractedPages = [""]; // a scanned PDF: one image-only page, empty text layer
  extractedDocxText = "";
  storeDocumentCalls.length = 0;
  storeOriginalFileCalls.length = 0;
  classifyUrgencyCalled = false;
});

// Import the REAL ingest functions (their internal `./` deps are mock.module()'d above).
async function ingestMod() {
  return import("@/lib/engine/ingest.ts");
}
async function POST(form: FormData) {
  const mod = await import("@/app/api/ingest/route.ts");
  return mod.POST(new Request("http://x/api/ingest", { method: "POST", body: form }));
}
function fileForm(name: string, bytes: Uint8Array, type = "", fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.append("file", new File([bytes.buffer as ArrayBuffer], name, type ? { type } : undefined));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

// ── UNIT: ingestPdf on a text-less scan does NOT throw + registers a catalog record ──
test("ingestPdf: a scanned/text-less PDF ingests successfully (no throw), chunks=0", async () => {
  const { ingestPdf } = await ingestMod();
  const result = await ingestPdf(new Uint8Array([37, 80, 68, 70]), "scan.pdf", "Scan", "owner-7", null);
  // (RED-first: with the old `throw chunks.length===0`, this line threw "no extractable text".)
  assert.equal(result.kind, "pdf");
  assert.equal(result.chunks, 0, "a text-less scan yields zero chunks but is still accepted");
  assert.equal(result.doc, "scan");
  // The doc still appears in the catalog (storeDocument ran with an empty record set).
  assert.equal(storeDocumentCalls.length, 1, "the scan is registered in the catalog");
  assert.equal(storeDocumentCalls[0].doc, "scan");
  assert.equal(storeDocumentCalls[0].recordCount, 0);
});

// ── UNIT: ingestDocx symmetry — a text-less .docx is accepted too ──
test("ingestDocx: a text-less .docx ingests successfully (no throw), chunks=0", async () => {
  const { ingestDocx } = await ingestMod();
  const result = await ingestDocx(new Uint8Array([80, 75, 3, 4]), "empty.docx", "Empty", "owner-7", null);
  assert.equal(result.chunks, 0);
  assert.equal(result.doc, "empty");
  assert.equal(storeDocumentCalls.length, 1, "the doc is registered in the catalog");
});

// ── UNIT: a born-digital PDF still chunks normally (the fix didn't break the happy path) ──
test("ingestPdf: a born-digital PDF still produces chunks (no regression)", async () => {
  extractedPages = ["In the Matter of the parties. ".repeat(40)];
  const { ingestPdf } = await ingestMod();
  const result = await ingestPdf(new Uint8Array([37, 80, 68, 70]), "real.pdf", "Real", "owner-7", null);
  assert.ok((result.chunks ?? 0) > 0, "real text → real chunks");
  assert.equal(storeDocumentCalls[0].recordCount, result.chunks);
});

// ── ROUTE: the WHOLE upload path — the scan is accepted (200) and its RAW BYTES are stored.
//    Raw-bytes model: the route never extracts text or gates on it, so a scanned PDF is
//    stored exactly like any other file and zeroContent is always false (the agent reads
//    the raw bytes natively). A chat/space context is required so the doc is never orphaned. ──
test("POST /api/ingest: a scanned PDF (with a chat) → 200, raw file STORED, zeroContent=false", async () => {
  const { status, body } = await readJson(
    await POST(fileForm("scan.pdf", new Uint8Array([37, 80, 68, 70]), "", { session_id: "sess-1" })),
  );
  assert.equal(status, 200, "a scanned PDF upload succeeds, not a 500 rejection");
  assert.equal(body.ok, true);
  assert.equal(body.zeroContent, false, "raw-bytes model: no text-extraction gate on upload");
  // THE artifact the agent reads: its raw bytes must have been stored.
  assert.equal(storeOriginalFileCalls.length, 1, "the raw scan bytes were stored");
  assert.equal(storeOriginalFileCalls[0].ownerId, "owner-7");
  // F4 fix: the route now stores under a SCOPE-QUALIFIED id derived from (filename,
  // session_id), so the same filename in another chat can't collide. Assert against the
  // REAL derivation (not a hardcoded hash) so the test tracks the function, not a magic string.
  const { docIdFromFilename } = await ingestMod();
  assert.equal(storeOriginalFileCalls[0].docId, docIdFromFilename("scan.pdf", "sess-1"));
});

// ── ROUTE: a born-digital PDF is unaffected (200, raw stored, zeroContent=false). ──
test("POST /api/ingest: a born-digital PDF (with a chat) → 200, raw stored, zeroContent=false", async () => {
  extractedPages = ["Real born-digital content. ".repeat(40)];
  const { status, body } = await readJson(
    await POST(fileForm("real.pdf", new Uint8Array([37, 80, 68, 70]), "", { session_id: "sess-1" })),
  );
  assert.equal(status, 200);
  assert.equal(body.zeroContent, false);
  assert.equal(storeOriginalFileCalls.length, 1);
});
