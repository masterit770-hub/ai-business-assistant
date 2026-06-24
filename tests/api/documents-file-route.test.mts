import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, readJson, mockExports } from "./_harness/harness.mts";

// ── Contract under test: GET/HEAD /api/documents/file ─────────────────────────────
// The "view/download my document" endpoint. The isolation + access wiring is the
// thing under test (a real data-leak surface):
//   • auth gate (401), missing ?doc → 400
//   • a BUNDLED doc streams the committed file with the right content-type/filename
//   • an UPLOADED doc is OWNER-SCOPED: a MEMBER may only fetch their OWN upload's
//     bytes; an ADMIN may fetch anyone's (resolves the owner)
//   • a missing/unstored original → a clean 404 (never a crash)
//   • HEAD mirrors GET's access decision but returns NO body (the rail's probe)
// The doc-files storage layer is stubbed to record the (owner, doc) actually read,
// so the owner-scoping the handler applies is asserted directly.

let current: ReturnType<typeof user> | null = user();
let bundled: { contentType: string; filename: string } | null = null;
// owner -> doc -> stored original
let storage: Record<string, Record<string, { bytes: Uint8Array; contentType: string }>> = {};
let ownerOfUpload: string | null = null;
const fetched: { owner: string; doc: string }[] = [];

before(() => {
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/doc-files", {
    bundledFileFor: (doc: string) => (doc === "family-court" && bundled ? { ...bundled, path: "x" } : null),
    readBundledFile: async () => new Uint8Array([37, 80, 68, 70]), // %PDF
    fetchOriginalFile: async (owner: string, doc: string) => {
      fetched.push({ owner, doc });
      const f = storage[owner]?.[doc];
      return f ? { bytes: f.bytes, contentType: f.contentType } : null;
    },
    // Like the real impl: resolve the actual owner of a stored doc. (A test can pin a
    // specific value via `ownerOfUpload`.) This makes a member-escalation mutation
    // ACTUALLY leak another owner's bytes — so the isolation test can catch it.
    findOwnerOfUpload: async (doc: string) =>
      ownerOfUpload ?? Object.keys(storage).find((owner) => storage[owner]?.[doc]) ?? null,
  });
});

beforeEach(() => {
  current = user({ id: "mem-1", role: "user" });
  bundled = { contentType: "application/pdf", filename: "family-court.pdf" };
  storage = {};
  ownerOfUpload = null;
  fetched.length = 0;
});

async function GET(qs: string) {
  return (await import("@/app/api/documents/file/route.ts")).GET(new Request(`http://x/api/documents/file?${qs}`));
}
async function HEAD(qs: string) {
  return (await import("@/app/api/documents/file/route.ts")).HEAD(new Request(`http://x/api/documents/file?${qs}`));
}

// ── auth + input ──────────────────────────────────────────────────────────────────
test("GET unauthenticated → 401", async () => { current = null; assert.equal((await GET("doc=d1")).status, 401); });
test("GET disabled user → 401", async () => { current = user({ disabled: true }); assert.equal((await GET("doc=d1")).status, 401); });
test("GET without ?doc → 400", async () => { assert.equal((await GET("")).status, 400); });

// ── bundled doc streams with the right headers ─────────────────────────────────────
test("a BUNDLED doc streams the file with its content-type + inline disposition", async () => {
  const res = await GET("doc=family-court");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/pdf/);
  assert.match(res.headers.get("content-disposition") ?? "", /inline/);
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...buf.slice(0, 4)], [37, 80, 68, 70], "the %PDF bytes must stream through");
});

// ── the OWNER-SCOPING isolation contract (a member can't pull another user's bytes) ─
test("a MEMBER downloading their OWN upload gets the bytes, read from THEIR folder", async () => {
  current = user({ id: "mem-7", role: "user" });
  storage = { "mem-7": { up1: { bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" } } };
  const res = await GET("doc=up1");
  assert.equal(res.status, 200);
  assert.equal(fetched[0].owner, "mem-7", "a member must only ever read their own folder");
});
test("a MEMBER requesting a doc that isn't in THEIR folder → 404 (never another user's bytes)", async () => {
  current = user({ id: "mem-7", role: "user" });
  // The doc exists, but under a DIFFERENT owner's folder.
  storage = { "other-user": { up1: { bytes: new Uint8Array([9]), contentType: "application/pdf" } } };
  const { status } = await readJson(await GET("doc=up1"));
  assert.equal(status, 404);
  // the only folder consulted was the member's own
  assert.ok(fetched.every((f) => f.owner === "mem-7"), "a member must never read another owner's folder");
});
test("an ADMIN may download ANY user's upload (resolves the owner)", async () => {
  current = user({ id: "adm", role: "admin" });
  // not in the admin's own folder; owned by someone else.
  ownerOfUpload = "other-user";
  storage = { "other-user": { up1: { bytes: new Uint8Array([5, 6]), contentType: "application/pdf" } } };
  const res = await GET("doc=up1");
  assert.equal(res.status, 200);
  assert.ok(fetched.some((f) => f.owner === "other-user"), "an admin resolves + reads the real owner's folder");
});
test("an uploaded doc with NO stored original → clean 404 (never a crash)", async () => {
  current = user({ id: "mem-7", role: "user" });
  storage = {};
  const { status, body } = await readJson(await GET("doc=ghost"));
  assert.equal(status, 404);
  assert.match(body.error, /not found|no original/i);
});

// ── HEAD mirrors the access decision, no body (the rail's download-button probe) ──
test("HEAD → 200 with no body when the original is retrievable", async () => {
  current = user({ id: "mem-7", role: "user" });
  storage = { "mem-7": { up1: { bytes: new Uint8Array([1]), contentType: "application/pdf" } } };
  const res = await HEAD("doc=up1");
  assert.equal(res.status, 200);
  assert.equal((await res.text()).length, 0, "HEAD must carry no body");
});
test("HEAD → 404 when the original isn't retrievable (so the UI hides the dead button)", async () => {
  current = user({ id: "mem-7", role: "user" });
  storage = {};
  assert.equal((await HEAD("doc=ghost")).status, 404);
});
test("HEAD unauthenticated → 401 with no body", async () => {
  current = null;
  const res = await HEAD("doc=up1");
  assert.equal(res.status, 401);
  assert.equal((await res.text()).length, 0);
});
