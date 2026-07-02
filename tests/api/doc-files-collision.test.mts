import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mockExports } from "./_harness/harness.mts";

// ── Bug under test: F4 — docId collision across chats/spaces (LIVE DATA LOSS) ─────────
//
// The upload route derives a doc id from the filename; that id is BOTH the Storage-blob
// key (owner/sha256(docId)) AND the _files.json manifest key. If the id is filename-only,
// uploading report.pdf into chat A and then report.pdf into chat B collides on ONE id:
//   • the second blob OVERWRITES the first (chat A's bytes are gone), and
//   • the manifest upsert RE-TAGS the single entry to chat B (chat A's doc vanishes).
//
// FIX: docIdFromFilename(name, scope) folds the upload scope (session_id, or space_id for
// a space-direct upload) into the id, so the SAME name in a DIFFERENT scope → a DIFFERENT
// id (both coexist), while the SAME name in the SAME scope → the SAME id (replace kept).
//
// We drive the REAL seam the route drives: docIdFromFilename(name, scope) → storeOriginalFile
// (blob store + manifest upsert) over a faithful in-memory Storage fake, then read the
// manifest back through the REAL filterFilesForChat. RED-FIRST: against the unfixed
// filename-only id, the two chats collide → this suite fails.
//
// ZERO Claude/SDK calls. All Supabase Storage I/O is an in-memory fake; the module logic
// (docIdFromFilename, storeOriginalFile, updateFilesManifest, filterFilesForChat) runs for real.

const OWNER = "owner-collision-1";
const BUCKET = "documents";

// ── Faithful in-memory Storage fake — mirrors the Supabase Storage contract the code uses ──
type Store = { manifest: string | null; blobs: Map<string, Uint8Array> };
let store: Store;
let supaOn: boolean;

function makeStore(): Store {
  return { manifest: null, blobs: new Map() };
}

function makeClient(s: Store) {
  const bucketApi = {
    upload: async (path: string, body: Blob) => {
      const bytes = new Uint8Array(await body.arrayBuffer());
      if (path.endsWith("/_files.json")) {
        s.manifest = new TextDecoder().decode(bytes); // the manifest object
      } else {
        s.blobs.set(path, bytes); // an original-file blob
      }
      return { error: null };
    },
    download: async (path: string) => {
      if (path.endsWith("/_files.json")) {
        if (s.manifest == null) return { data: null, error: { message: "not found" } };
        const text = s.manifest;
        return { data: { text: async () => text }, error: null };
      }
      const b = s.blobs.get(path);
      if (b == null) return { data: null, error: { message: "not found" } };
      return { data: { text: async () => new TextDecoder().decode(b) }, error: null };
    },
    remove: async (_paths: string[]) => ({ error: null }),
  };
  return {
    storage: {
      from: (_bucket: string) => bucketApi,
      createBucket: async () => ({ error: null }),
    },
  };
}

before(() => {
  mockExports("@/lib/engine/supabase", {
    supabaseEnabled: () => supaOn,
    admin: () => makeClient(store),
  });
});

beforeEach(() => {
  supaOn = true;
  store = makeStore();
});

// Import the REAL modules under test (mocks are live).
async function mods() {
  const ingest = await import("@/lib/engine/ingest.ts");
  const docFiles = await import("@/lib/engine/doc-files.ts");
  const scope = await import("@/lib/engine/file-scope.ts");
  return { ingest, docFiles, scope };
}
function readManifest(): Array<{ docId: string; displayName: string; session_id: string | null }> {
  return store.manifest ? JSON.parse(store.manifest) : [];
}

// ── 1. The core collision: same filename, two DIFFERENT chats → two coexisting docs ───
test("F4: report.pdf in chat A and report.pdf in chat B do NOT collide — both survive", async () => {
  const { ingest, docFiles, scope } = await mods();
  const bytesA = new TextEncoder().encode("CHAT-A ORIGINAL REPORT BYTES");
  const bytesB = new TextEncoder().encode("chat-b totally different report");

  // Exactly what the route does: derive the id from (filename, scope=session_id), then store.
  const docIdA = ingest.docIdFromFilename("report.pdf", "chat-A");
  await docFiles.storeOriginalFile(bytesA, OWNER, docIdA, "report.pdf", "chat-A");
  const docIdB = ingest.docIdFromFilename("report.pdf", "chat-B");
  await docFiles.storeOriginalFile(bytesB, OWNER, docIdB, "report.pdf", "chat-B");

  const entries = readManifest();
  // Two coexisting manifest entries (unfixed → ONE re-tagged entry).
  assert.equal(entries.length, 2, `manifest must hold BOTH docs, got ${JSON.stringify(entries)}`);

  // The REAL per-chat scoper still sees chat A's file after chat B's upload.
  const forA = scope.filterFilesForChat(entries, "chat-A");
  const forB = scope.filterFilesForChat(entries, "chat-B");
  assert.equal(forA.length, 1, "chat A must still see exactly its own file");
  assert.equal(forA[0]!.displayName, "report.pdf");
  assert.equal(forB.length, 1, "chat B sees its own file");
  assert.notEqual(forA[0]!.docId, forB[0]!.docId, "the two chats' docs have distinct ids");

  // The two blobs land on DIFFERENT Storage keys, and chat A's bytes were NOT overwritten.
  const pathA = `${OWNER}/${docFiles.storageKeyForDocId(docIdA)}`;
  const pathB = `${OWNER}/${docFiles.storageKeyForDocId(docIdB)}`;
  assert.notEqual(pathA, pathB, "the two blobs must have different Storage keys");
  assert.deepEqual(store.blobs.get(pathA), bytesA, "chat A's original bytes must survive");
  assert.deepEqual(store.blobs.get(pathB), bytesB, "chat B's bytes are its own");
});

// ── 2. Twin: same BASE name, different EXTENSION, different chats → coexist ────────────
// The id strips the extension, so report.pdf and report.csv share a base — WITHOUT scope
// they'd collide across chats exactly like the pdf/pdf case. With scope they coexist.
test("F4 twin: report.pdf (chat A) and report.csv (chat B) coexist (same base, different scope)", async () => {
  const { ingest, docFiles, scope } = await mods();
  const pdfBytes = new TextEncoder().encode("PDF in chat A");
  const csvBytes = new TextEncoder().encode("a,b\n1,2");

  const idPdf = ingest.docIdFromFilename("report.pdf", "chat-A");
  await docFiles.storeOriginalFile(pdfBytes, OWNER, idPdf, "report.pdf", "chat-A");
  const idCsv = ingest.docIdFromFilename("report.csv", "chat-B");
  await docFiles.storeOriginalFile(csvBytes, OWNER, idCsv, "report.csv", "chat-B");

  const entries = readManifest();
  assert.equal(entries.length, 2, "the .pdf and the .csv must both persist");
  assert.equal(scope.filterFilesForChat(entries, "chat-A")[0]!.displayName, "report.pdf");
  assert.equal(scope.filterFilesForChat(entries, "chat-B")[0]!.displayName, "report.csv");
  const pathPdf = `${OWNER}/${docFiles.storageKeyForDocId(idPdf)}`;
  assert.deepEqual(store.blobs.get(pathPdf), pdfBytes, "the pdf's bytes survive the csv upload");
});

// ── 3. Control: same filename, SAME chat → REPLACE (one entry, latest bytes) ──────────
// This must be GREEN before AND after the fix — the scope-aware id must NOT break the
// replace semantics that an updated re-upload depends on (edge-journeys REUPLOAD).
test("control: report.pdf re-uploaded into the SAME chat REPLACES (one entry, new bytes)", async () => {
  const { ingest, docFiles } = await mods();
  const v1 = new TextEncoder().encode("VERSION ONE");
  const v2 = new TextEncoder().encode("VERSION TWO — the update");

  const id1 = ingest.docIdFromFilename("report.pdf", "chat-A");
  await docFiles.storeOriginalFile(v1, OWNER, id1, "report.pdf", "chat-A");
  const id2 = ingest.docIdFromFilename("report.pdf", "chat-A");
  await docFiles.storeOriginalFile(v2, OWNER, id2, "report.pdf", "chat-A");

  assert.equal(id1, id2, "same name + same scope must re-derive the SAME id (replace)");
  const entries = readManifest();
  assert.equal(entries.length, 1, "a same-scope re-upload replaces — it does not add a 2nd entry");
  const path = `${OWNER}/${docFiles.storageKeyForDocId(id1)}`;
  assert.deepEqual(store.blobs.get(path), v2, "the blob holds the NEW version's bytes");
});
