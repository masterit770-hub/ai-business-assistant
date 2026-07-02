import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mockExports } from "./_harness/harness.mts";

// ── Bug under test: F5 — _files.json read-modify-write race (LOST UPDATE) ─────────────
//
// updateFilesManifest (and removeOriginalFile's manifest step) is a read-modify-write on
// one Storage object with NO compare-and-swap: download → merge → upload. Two concurrent
// mutations for the SAME owner both download the OLD manifest, both merge, both write →
// last writer wins → one file's entry vanishes (the blob exists but the engine, which
// reads only the manifest, can't see it).
//
// FIX: a per-owner in-process async mutex (promise chain, keyed by ownerId) around the
// whole read-merge-write in updateFilesManifest AND removeOriginalFile, so mutations for
// one owner run one-at-a-time and each sees the previous one's committed manifest.
//
// The fake's manifest `download` SNAPSHOTS the manifest at CALL TIME and resolves after a
// setTimeout(0) tick — this widens the read-modify-write window so the lost update is
// deterministically reproducible. RED-FIRST: without the mutex, two concurrent stores (or
// a store racing a delete) drop an entry → these tests fail.
//
// ZERO Claude/SDK calls. In-memory Storage fake; the module logic runs for real.

const OWNER = "owner-race-1";

type Store = { manifest: string | null; blobs: Map<string, Uint8Array> };
let store: Store;
let supaOn: boolean;

function makeStore(manifest: string | null = null): Store {
  return { manifest, blobs: new Map() };
}

// The client's manifest download captures the value AT CALL TIME then defers a macrotask,
// mimicking a real read that fetched the object before a concurrent writer committed —
// this is what makes the lost-update window observable in-process.
function makeClient(s: Store) {
  const bucketApi = {
    upload: async (path: string, body: Blob) => {
      const bytes = new Uint8Array(await body.arrayBuffer());
      if (path.endsWith("/_files.json")) s.manifest = new TextDecoder().decode(bytes);
      else s.blobs.set(path, bytes);
      return { error: null };
    },
    download: async (path: string) => {
      if (path.endsWith("/_files.json")) {
        const snapshot = s.manifest; // captured NOW, before the concurrent writer commits
        await new Promise((r) => setTimeout(r, 0)); // widen the RMW window
        if (snapshot == null) return { data: null, error: { message: "not found" } };
        return { data: { text: async () => snapshot }, error: null };
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

async function docFiles() {
  return import("@/lib/engine/doc-files.ts");
}
function readManifest(): Array<{ docId: string; displayName: string; session_id: string | null }> {
  return store.manifest ? JSON.parse(store.manifest) : [];
}

// ── 1. Two concurrent uploads for the same owner → BOTH manifest entries survive ──────
test("F5: two concurrent uploads (same owner) both land in the manifest — no lost update", async () => {
  const { storeOriginalFile } = await docFiles();
  const bytesA = new TextEncoder().encode("file A bytes");
  const bytesB = new TextEncoder().encode("file B bytes");

  await Promise.all([
    storeOriginalFile(bytesA, OWNER, "file-a", "a.pdf", "chat-1"),
    storeOriginalFile(bytesB, OWNER, "file-b", "b.pdf", "chat-1"),
  ]);

  const ids = readManifest().map((e) => e.docId).sort();
  assert.deepEqual(
    ids,
    ["file-a", "file-b"],
    `both concurrent uploads must survive; got ${JSON.stringify(ids)}`
  );
});

// ── 2. A delete racing a concurrent upload (same owner) → neither mutation is lost ────
test("F5: a delete racing an upload (same owner) keeps the new file AND drops the deleted one", async () => {
  const { storeOriginalFile, removeOriginalFile } = await docFiles();
  // Seed a manifest that already has the doc we're about to delete.
  store = makeStore(
    JSON.stringify([
      { docId: "existing-x", displayName: "x.pdf", type: "pdf", session_id: "chat-1", space_id: null },
    ])
  );
  const bytesA = new TextEncoder().encode("newly uploaded file A");

  await Promise.all([
    storeOriginalFile(bytesA, OWNER, "file-a", "a.pdf", "chat-1"), // adds file-a
    removeOriginalFile(OWNER, "existing-x"), // removes existing-x
  ]);

  const ids = readManifest().map((e) => e.docId).sort();
  assert.deepEqual(
    ids,
    ["file-a"],
    `the add and the delete must both take effect; got ${JSON.stringify(ids)}`
  );
});

// ── 3. Three concurrent uploads — the chain serializes all of them ────────────────────
test("F5: three concurrent uploads for one owner all persist", async () => {
  const { storeOriginalFile } = await docFiles();
  await Promise.all([
    storeOriginalFile(new Uint8Array([1]), OWNER, "d1", "d1.pdf", "chat-1"),
    storeOriginalFile(new Uint8Array([2]), OWNER, "d2", "d2.pdf", "chat-1"),
    storeOriginalFile(new Uint8Array([3]), OWNER, "d3", "d3.pdf", "chat-1"),
  ]);
  const ids = readManifest().map((e) => e.docId).sort();
  assert.deepEqual(ids, ["d1", "d2", "d3"], `all three must survive; got ${JSON.stringify(ids)}`);
});
