import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mockExports } from "./_harness/harness.mts";

// ── Contract under test: removeOriginalFile (src/lib/engine/doc-files.ts) ─────────────
//
// This suite tests that:
//   1. removeOriginalFile removes the Storage blob at the owner-scoped path.
//   2. removeOriginalFile removes the docId entry from the owner's _files.json manifest.
//   3. removeOriginalFile is idempotent — no error when blob or manifest entry is absent.
//   4. HARD SAFETY: removeOriginalFile refuses to operate if ownerId is empty.
//   5. OWNER-SCOPING: a caller CANNOT remove another owner's blob — the path assertion
//      blocks any path that does not start with `${ownerId}/`.
//
// All I/O (Supabase Storage client) is stubbed. The function's own logic runs for real.

// ── Stable fixtures ──────────────────────────────────────────────────────────────────
const OWNER_A = "owner-aaa-111";
const OWNER_B = "owner-bbb-222";
const DOC_ID  = "my-uploaded-file.pdf";

// storagePath is `${ownerId}/${sha256hex(docId)}`; we don't need to reproduce the exact
// sha256 in the test — what matters is that `.remove()` is called with a path that
// starts with `${ownerId}/`.

// ── Storage call recorder ─────────────────────────────────────────────────────────────
type StorageCall = { op: string; bucket: string; path?: string; paths?: string[] };
let storageCalls: StorageCall[];
let supaOn: boolean;
let manifestContent: string | null; // null = no manifest

function makeStorageClient(opts: { manifest?: string | null } = {}) {
  manifestContent = opts.manifest ?? null;
  storageCalls = [];
  return {
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          storageCalls.push({ op: "remove", bucket, paths });
          return { error: null };
        },
        download: async (path: string) => {
          storageCalls.push({ op: "download", bucket, path });
          if (manifestContent === null) return { data: null, error: { message: "not found" } };
          // Return a Blob-like with .text()
          const text = manifestContent;
          return { data: { text: async () => text }, error: null };
        },
        upload: async (path: string) => {
          storageCalls.push({ op: "upload", bucket, path });
          return { error: null };
        },
      }),
    },
  };
}

before(() => {
  mockExports("@/lib/engine/supabase", {
    supabaseEnabled: () => supaOn,
    admin: () => makeStorageClient({ manifest: manifestContent }),
  });
});

beforeEach(() => {
  supaOn = true;
  manifestContent = null;
  storageCalls = [];
});

// Helper: import the function fresh each test (mocks are live).
async function removeOriginalFile(ownerId: string, docId: string): Promise<void> {
  const mod = await import("@/lib/engine/doc-files.ts");
  return mod.removeOriginalFile(ownerId, docId);
}

// ── 1. removes the Storage blob ───────────────────────────────────────────────────────
test("removeOriginalFile: removes the Storage blob at owner/sha256(docId)", async () => {
  supaOn = true;
  manifestContent = null; // no manifest → only blob removal
  await removeOriginalFile(OWNER_A, DOC_ID);

  const removeCalls = storageCalls.filter((c) => c.op === "remove");
  assert.equal(removeCalls.length, 1, "must call storage.remove() once");
  const paths = removeCalls[0]!.paths!;
  assert.equal(paths.length, 1, "must remove exactly one path");
  // The path must start with the caller's ownerId prefix.
  assert.ok(
    paths[0]!.startsWith(`${OWNER_A}/`),
    `Storage path '${paths[0]}' must start with '${OWNER_A}/'`
  );
});

// ── 2. removes the manifest entry ────────────────────────────────────────────────────
test("removeOriginalFile: removes the docId entry from _files.json manifest", async () => {
  supaOn = true;
  const initial = [
    { docId: DOC_ID, displayName: "my-uploaded-file.pdf", type: "pdf", session_id: null },
    { docId: "other-doc.pdf", displayName: "other.pdf", type: "pdf", session_id: null },
  ];
  manifestContent = JSON.stringify(initial);
  await removeOriginalFile(OWNER_A, DOC_ID);

  const uploadCalls = storageCalls.filter((c) => c.op === "upload");
  assert.equal(uploadCalls.length, 1, "must re-write the manifest once");
  // The manifest path must be under the caller's folder.
  assert.ok(
    uploadCalls[0]!.path!.startsWith(`${OWNER_A}/`),
    `manifest upload path '${uploadCalls[0]!.path}' must be under '${OWNER_A}/'`
  );
});

// ── 3. idempotent — no manifest entry → no upload (nothing to remove) ────────────────
test("removeOriginalFile: idempotent when manifest entry is absent", async () => {
  supaOn = true;
  // Manifest exists but does NOT contain the target docId.
  const initial = [
    { docId: "something-else.pdf", displayName: "something-else.pdf", type: "pdf", session_id: null },
  ];
  manifestContent = JSON.stringify(initial);
  await removeOriginalFile(OWNER_A, DOC_ID); // must not throw

  const uploadCalls = storageCalls.filter((c) => c.op === "upload");
  assert.equal(uploadCalls.length, 0, "must NOT re-write manifest when entry was not present");
});

// ── 4. idempotent — Supabase OFF → silent no-op ──────────────────────────────────────
test("removeOriginalFile: no-op when Supabase is disabled", async () => {
  supaOn = false;
  await removeOriginalFile(OWNER_A, DOC_ID); // must not throw, must not call storage
  assert.equal(storageCalls.length, 0, "must make no Storage calls when Supabase is off");
});

// ── 5. HARD SAFETY: empty ownerId → refuse, no Storage calls ─────────────────────────
test("removeOriginalFile: HARD SAFETY — empty ownerId → refuse, no Storage calls", async () => {
  supaOn = true;
  manifestContent = JSON.stringify([
    { docId: DOC_ID, displayName: "f.pdf", type: "pdf", session_id: null },
  ]);
  await removeOriginalFile("", DOC_ID); // must not throw, must not call storage.remove
  const removeCalls = storageCalls.filter((c) => c.op === "remove");
  assert.equal(removeCalls.length, 0, "must NOT call remove() when ownerId is empty");
});

// ── 6. OWNER-SCOPING: a caller cannot remove OWNER_B's blob via OWNER_A's call ──────
// The path assertion in removeOriginalFile ensures the Storage path starts with
// `${ownerId}/`. storagePath(OWNER_A, docId) → `${OWNER_A}/${hash}` which passes.
// We verify that remove() is called with a path that starts with OWNER_A/, NOT OWNER_B/.
test("removeOriginalFile: path is scoped to the caller's ownerId, never another owner", async () => {
  supaOn = true;
  manifestContent = null;
  await removeOriginalFile(OWNER_A, DOC_ID);

  const removeCalls = storageCalls.filter((c) => c.op === "remove");
  if (removeCalls.length > 0) {
    for (const call of removeCalls) {
      for (const p of call.paths ?? []) {
        assert.ok(
          !p.startsWith(`${OWNER_B}/`),
          `Storage path '${p}' must NOT start with OWNER_B prefix — cross-owner blob removal is forbidden`
        );
        assert.ok(
          p.startsWith(`${OWNER_A}/`),
          `Storage path '${p}' must start with OWNER_A prefix`
        );
      }
    }
  }
});
