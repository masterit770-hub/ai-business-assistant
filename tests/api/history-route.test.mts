import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, NextResponseShim, readJson, makeFakeAdmin, mockExports } from "./_harness/harness.mts";

// ── Contract under test: GET /api/history + the [session_id] turns/rename/delete ──
// THE per-user-isolation contract at the HTTP boundary: a MEMBER's reads/writes must
// be scoped to .eq("owner_id", <self>); an ADMIN's must NOT be (sees everyone's). A
// member who guesses another user's session_id must get an empty/404 result, never
// another user's turns. We stub the Supabase client with a recording fake builder so
// the EXACT owner-scoping the handler applies is asserted; groupSessions is the real
// pure function. supabaseEnabled is toggled to exercise the honest-empty branches.

let current: ReturnType<typeof user> | null = user();
let supaOn = true;
let fake = makeFakeAdmin();
// The caller's _files.json manifest, as the routes read it via listManifestEntries():
// doc-known session discovery, the Imported virtual session, and the turns exists-check
// ALL come from here since the RAG excision (doc_chunks/uploaded_rows reads removed).
let manifestEntries: { docId: string; displayName: string; type: string; session_id: string | null }[] = [];
const manifestCalls: { ownerId: string; chatId?: string | null }[] = [];

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/supabase", { supabaseEnabled: () => supaOn, admin: () => fake.client });
  // doc-files — mocked with the REAL read contract: chatId given → strict session_id
  // filter (mirrors filterFilesForChat), no chatId → every entry. Both routes' imports
  // (listManifestEntries + removeOriginalFile) must exist or the import itself throws.
  mockExports("@/lib/engine/doc-files", {
    listManifestEntries: async (ownerId: string, chatId?: string | null) => {
      manifestCalls.push({ ownerId, chatId });
      return chatId == null ? manifestEntries : manifestEntries.filter((e) => e.session_id === chatId);
    },
    removeOriginalFile: async () => {},
  });
});

beforeEach(() => { current = user(); supaOn = true; manifestEntries = []; manifestCalls.length = 0; });

function withRows(rows: any[]) {
  return makeFakeAdmin({
    on: {
      "ask_history:select": () => ({ data: rows }),
      "profiles:select": () => ({ data: [] }),
      "session_titles:select": () => ({ data: [] }),
    },
  });
}

async function GETlist() { return (await import("@/app/api/history/route.ts")).GET(); }

// ── /api/history list ──────────────────────────────────────────────────────────────
test("list unauthenticated → 401", async () => { current = null; assert.equal((await GETlist()).status, 401); });

test("Supabase OFF → honest empty history (never a 500)", async () => {
  supaOn = false;
  const { status, body } = await readJson(await GETlist());
  assert.equal(status, 200);
  assert.deepEqual(body.sessions, []);
});

test("a MEMBER's listing is scoped to .eq('owner_id', self)", async () => {
  current = user({ id: "mem-1", role: "user" });
  fake = withRows([{ id: "1", owner_id: "mem-1", session_id: "s1", question: "q", created_at: "2026-01-01" }]);
  await GETlist();
  const askRead = fake.calls.find((c) => c.table === "ask_history" && c.op === "select")!;
  assert.equal(askRead.eq["owner_id"], "mem-1", "a member must be owner-scoped");
});

test("an ADMIN's listing is NOT owner-scoped (sees everyone)", async () => {
  current = user({ id: "adm", role: "admin" });
  fake = withRows([{ id: "1", owner_id: "someone-else", session_id: "s1", question: "q", created_at: "2026-01-01" }]);
  await GETlist();
  const askRead = fake.calls.find((c) => c.table === "ask_history" && c.op === "select")!;
  assert.equal(askRead.eq["owner_id"], undefined, "an admin must NOT be owner-scoped");
});

// ── FIX 1: a chat appears for a session known ONLY from session_titles or docs ────
// The blocker: a session with a session_titles row OR docs (doc_chunks/uploaded_rows)
// but ZERO ask_history was invisible — /api/history listed only from ask_history. The
// restored client (owner b01c311e) has 6 session_titles + docs + 0 asks → "No
// conversations yet". The listing must MERGE all three owner-scoped sources.
//
// Builder: ask_history empty; session_titles + the doc tables seeded per test. The doc
// tables are read TWICE by the handler (distinct-session-ids select → uses .data; the
// Imported head-count → uses .count); one responder returning both serves both reads.
function withMergeSources(opts: {
  titles?: { session_id: string; owner_id: string; title: string }[];
  chunkSessions?: { session_id: string }[];
  rowSessions?: { session_id: string }[];
}) {
  // Doc-known sessions come from the MANIFEST now (the doc_chunks/uploaded_rows
  // distinct-session reads were removed with the RAG excision). chunkSessions model
  // pdf docs, rowSessions model spreadsheets — same shapes the ingest path writes.
  manifestEntries = [
    ...(opts.chunkSessions ?? []).map((s, i) => ({
      docId: `pdf-${i}`, displayName: `pdf-${i}.pdf`, type: "pdf", session_id: s.session_id })),
    ...(opts.rowSessions ?? []).map((s, i) => ({
      docId: `tbl-${i}`, displayName: `tbl-${i}.xlsx`, type: "spreadsheet", session_id: s.session_id })),
  ];
  return makeFakeAdmin({
    on: {
      "ask_history:select": () => ({ data: [] }),
      "profiles:select": () => ({ data: [] }),
      "session_titles:select": () => ({ data: opts.titles ?? [] }),
    },
  });
}

test("FIX 1: a TITLE-ONLY session (session_titles, no ask_history) surfaces a named chat", async () => {
  current = user({ id: "mem-restored", role: "user" });
  fake = withMergeSources({
    titles: [{ session_id: "c2", owner_id: "mem-restored", title: "Family Court — Carter Case" }],
  });
  const { body } = await readJson(await GETlist());
  const entry = body.sessions.find((s: any) => s.session_id === "c2");
  assert.ok(entry, "a session known only from session_titles must appear as a chat");
  assert.equal(entry.title, "Family Court — Carter Case", "titled by its session_titles override");
});

test("FIX 1 (H2): a DOCS-ONLY session (no ask, no title) surfaces a chat with a DETERMINISTIC non-blank default title", async () => {
  current = user({ id: "mem-docs", role: "user" });
  fake = withMergeSources({ rowSessions: [{ session_id: "c-docs" }] });
  const { body } = await readJson(await GETlist());
  const entry = body.sessions.find((s: any) => s.session_id === "c-docs");
  assert.ok(entry, "a session known only from uploaded_rows must appear as a chat");
  // The default title must be human + deterministic — never blank, the raw uuid, or "undefined".
  assert.equal(entry.title, "Untitled chat", "docs-only default title is the deterministic neutral label");
  assert.notEqual(entry.title.trim(), "", "default title must not be blank");
  assert.notEqual(entry.title, "c-docs", "default title must not be the raw session id");
});

test("FIX 1: a DOCS-ONLY session from doc_chunks (PDF) also surfaces a chat", async () => {
  current = user({ id: "mem-pdf", role: "user" });
  fake = withMergeSources({ chunkSessions: [{ session_id: "c-pdf" }] });
  const { body } = await readJson(await GETlist());
  assert.ok(body.sessions.map((s: any) => s.session_id).includes("c-pdf"),
    "a session known only from doc_chunks must appear as a chat");
});

test("FIX 1: the restored client's shape — 6 title-only sessions all appear, named, with zero asks", async () => {
  current = user({ id: "b01c311e", role: "user" });
  const titles = [
    { session_id: "c1", owner_id: "b01c311e", title: "Scheduling (June & August 2024)" },
    { session_id: "c2", owner_id: "b01c311e", title: "Family Court — Carter Case" },
    { session_id: "c3", owner_id: "b01c311e", title: "Contracts (School Data 1)" },
    { session_id: "c4", owner_id: "b01c311e", title: "Course Enrollment (School Data 4 & 6)" },
    { session_id: "c5", owner_id: "b01c311e", title: "Payroll (School Data 2)" },
    { session_id: "c6", owner_id: "b01c311e", title: "Maintenance (School Data 3)" },
  ];
  fake = withMergeSources({
    titles,
    rowSessions: [{ session_id: "c1" }, { session_id: "c3" }, { session_id: "c4" }],
  });
  const { body } = await readJson(await GETlist());
  for (const t of titles) {
    const entry = body.sessions.find((s: any) => s.session_id === t.session_id);
    assert.ok(entry, `her chat ${t.session_id} must appear`);
    assert.equal(entry.title, t.title, `chat ${t.session_id} keeps its title`);
  }
  assert.equal(body.sessions.length, 6, "exactly her 6 chats (no duplicates, no virtual entries for a non-demo user)");
});

test("FIX 1: the title-only/docs merge stays OWNER-SCOPED (a member reads only their own sources)", async () => {
  current = user({ id: "mem-scope", role: "user" });
  fake = withMergeSources({ titles: [{ session_id: "c1", owner_id: "mem-scope", title: "Mine" }] });
  await GETlist();
  // session_titles (now fetched for ALL the owner's titles), doc_chunks + uploaded_rows
  // distinct reads must each carry the owner filter for a member.
  const titleRead = fake.calls.find((c) => c.table === "session_titles" && c.op === "select")!;
  assert.equal(titleRead.eq["owner_id"], "mem-scope", "the title source must be owner-scoped for a member");
  // 🔒 TENANT-ISOLATION GATE — the doc-session source is the CALLER's manifest now
  // (listManifestEntries replaced the doc_chunks/uploaded_rows distinct-session reads).
  // The manifest is owner-keyed by its path, so the isolation property to pin is:
  // every manifest read this listing makes is for the CALLER's id — never another
  // owner's. Drop the owner argument (or pass a different owner) and THIS goes RED.
  assert.ok(manifestCalls.length > 0, "the listing must read the manifest for doc-known sessions");
  for (const mc of manifestCalls) {
    assert.equal(mc.ownerId, "mem-scope", "every manifest read must be scoped to the CALLER");
  }
});

test("FIX 1 (Finding 2): title-only chats come back NEWEST-RENAMED first, deterministically", async () => {
  current = user({ id: "mem-order", role: "user" });
  // Seed the rows in a NON-recency order (mid, old, new) on purpose: the listing must be
  // re-sorted by updated_at in the merge, so this only passes if the rename time is really
  // carried into last_at. If it weren't (epoch-0 collapse), the stable sort would preserve
  // THIS insertion order (mid, old, new) — which is NOT the expected recency order → RED.
  fake = withMergeSources({
    titles: [
      { session_id: "c-mid", owner_id: "mem-order", title: "Renamed yesterday", updated_at: "2026-06-25T00:00:00Z" },
      { session_id: "c-old", owner_id: "mem-order", title: "Renamed long ago", updated_at: "2026-01-01T00:00:00Z" },
      { session_id: "c-new", owner_id: "mem-order", title: "Renamed just now", updated_at: "2026-06-26T00:00:00Z" },
    ] as any,
  });
  const { body } = await readJson(await GETlist());
  assert.deepEqual(
    body.sessions.map((s: any) => s.session_id),
    ["c-new", "c-mid", "c-old"],
    "title-only chats must be newest-renamed first (not arbitrary DB order)"
  );
  // The route must ASK the DB for that order (so the bound is right even past the row limit).
  const titleRead = fake.calls.find((c) => c.table === "session_titles" && c.op === "select")!;
  const orderedByUpdatedAt = titleRead.args.some(
    (a) => Array.isArray(a) && a[0] === "order" && a[1] === "updated_at"
  );
  assert.ok(orderedByUpdatedAt, "the session_titles read must order by updated_at");
});

test("FIX 1 (H5): a title (TEXT) + docs (UUID) for the SAME session, case-mismatched, appears ONCE at the HTTP boundary", async () => {
  // The schema gotcha: session_titles.session_id is TEXT, doc_chunks.session_id is UUID.
  // The same logical session can arrive as case-differing strings; the merge must de-dupe
  // on a normalized key so it shows ONE chat, not two. Drop the normalization → 2 → RED.
  current = user({ id: "mem-carter", role: "user" });
  fake = withMergeSources({
    titles: [{ session_id: "C0C311E2-0002-4000-8000-000000000002", owner_id: "mem-carter", title: "Family Court — Carter Case" }] as any,
    chunkSessions: [{ session_id: "c0c311e2-0002-4000-8000-000000000002" }],
  });
  const { body } = await readJson(await GETlist());
  const carter = body.sessions.filter(
    (s: any) => s.session_id.toLowerCase() === "c0c311e2-0002-4000-8000-000000000002"
  );
  assert.equal(carter.length, 1, "title(TEXT)+docs(UUID) for one session must be ONE chat, not two");
  assert.equal(carter[0].title, "Family Court — Carter Case", "the titled entry wins");
});

test("FIX 1 (H8): a clean non-demo account with NO ask_history, NO titles, NO docs → honest empty []", async () => {
  current = user({ id: "mem-clean", role: "user", isDemo: false });
  fake = withMergeSources({}); // everything empty
  const { body } = await readJson(await GETlist());
  assert.deepEqual(body.sessions, [], "no sources → no phantom entry from the default-title logic");
});

test("FIX 1: a merged session is NOT duplicated when it ALSO has ask_history", async () => {
  current = user({ id: "mem-dup", role: "user" });
  fake = makeFakeAdmin({
    on: {
      "ask_history:select": () => ({ data: [{ id: "1", owner_id: "mem-dup", session_id: "s-dup", question: "q", created_at: "2026-01-01" }] }),
      "profiles:select": () => ({ data: [] }),
      "session_titles:select": () => ({ data: [{ session_id: "s-dup", owner_id: "mem-dup", title: "Renamed" }] }),
      "doc_chunks:select": () => ({ data: [{ session_id: "s-dup" }], count: 0 }),
      "uploaded_rows:select": () => ({ data: [], count: 0 }),
    },
  });
  const { body } = await readJson(await GETlist());
  const occ = body.sessions.filter((s: any) => s.session_id === "s-dup").length;
  assert.equal(occ, 1, "ask + title + docs on one session must yield a single chat");
});

// ── Imported virtual session — only appears when the owner has docs ───────────────
function withImportedDocs(docCount: number, rowCount: number) {
  // Imported docs live in the manifest under the reserved IMPORTED session id now.
  const IMPORTED = "00000000-0000-0000-0000-000000000001";
  manifestEntries = [
    ...Array.from({ length: docCount }, (_, i) => ({
      docId: `imp-pdf-${i}`, displayName: `imp-${i}.pdf`, type: "pdf", session_id: IMPORTED })),
    ...Array.from({ length: rowCount }, (_, i) => ({
      docId: `imp-tbl-${i}`, displayName: `imp-${i}.xlsx`, type: "spreadsheet", session_id: IMPORTED })),
  ];
  return makeFakeAdmin({
    on: {
      "ask_history:select": () => ({ data: [] }),
      "profiles:select": () => ({ data: [] }),
      "session_titles:select": () => ({ data: [] }),
    },
  });
}

test("demo account with NO imported docs → Imported virtual session NOT appended", async () => {
  current = user({ isDemo: true });
  fake = withImportedDocs(0, 0);
  const { body } = await readJson(await GETlist());
  const sessionIds = body.sessions.map((s: any) => s.session_id);
  assert.ok(!sessionIds.includes("00000000-0000-0000-0000-000000000001"),
    "Imported must NOT appear when owner has no imported docs");
  // Sample data always appears for demo accounts
  assert.ok(sessionIds.includes("00000000-0000-0000-0000-000000000002"),
    "Sample data must still appear for demo accounts");
});

test("demo account WITH doc_chunks for IMPORTED_SESSION_ID → Imported virtual session appended", async () => {
  current = user({ isDemo: true });
  fake = withImportedDocs(3, 0);
  const { body } = await readJson(await GETlist());
  const sessionIds = body.sessions.map((s: any) => s.session_id);
  assert.ok(sessionIds.includes("00000000-0000-0000-0000-000000000001"),
    "Imported must appear when owner has doc_chunks for IMPORTED_SESSION_ID");
});

test("non-demo account WITH uploaded_rows for IMPORTED_SESSION_ID → Imported virtual session appended", async () => {
  current = user({ isDemo: false });
  fake = withImportedDocs(0, 5);
  const { body } = await readJson(await GETlist());
  const sessionIds = body.sessions.map((s: any) => s.session_id);
  assert.ok(sessionIds.includes("00000000-0000-0000-0000-000000000001"),
    "Imported must appear for any account (not just demo) that has uploaded_rows for IMPORTED_SESSION_ID");
});

// ── /api/history/[session_id] — turns / rename / delete ───────────────────────────
async function GETturns(sessionId: string) {
  const mod = await import("@/app/api/history/[session_id]/route.ts");
  return mod.GET(new Request("http://x"), { params: Promise.resolve({ session_id: sessionId }) });
}
async function PATCH(sessionId: string, body: unknown) {
  const mod = await import("@/app/api/history/[session_id]/route.ts");
  return mod.PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ session_id: sessionId }) });
}
async function DEL(sessionId: string) {
  const mod = await import("@/app/api/history/[session_id]/route.ts");
  return mod.DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ session_id: sessionId }) });
}

test("turns: a MEMBER loading a session they DON'T own → empty turns (never another user's thread)", async () => {
  current = user({ id: "mem-2", role: "user" });
  // The owner-scoped query returns no rows for a session that isn't theirs.
  fake = makeFakeAdmin({ on: { "ask_history:select": () => ({ data: [] }) } });
  const { status, body } = await readJson(await GETturns("not-mine"));
  assert.equal(status, 200);
  assert.deepEqual(body.turns, []);
  const read = fake.calls.find((c) => c.table === "ask_history")!;
  assert.equal(read.eq["owner_id"], "mem-2", "the member's turns read must be owner-scoped");
  assert.equal(read.eq["session_id"], "not-mine");
});

test("turns: a member's OWN docs/title-only session (no ask_history) → empty turns but exists:true (openable, not 'not found')", async () => {
  // The restored-client case at the turns endpoint: zero ask_history rows, but the
  // session has a session_titles row and uploaded docs. It must report exists:true so
  // the client opens it (scoped to its docs) instead of "couldn't be found".
  current = user({ id: "mem-restored", role: "user" });
  fake = makeFakeAdmin({
    on: {
      "ask_history:select": () => ({ data: [] }),
      "session_titles:select": () => ({ count: 1 }),
      "doc_chunks:select": () => ({ count: 0 }),
      "uploaded_rows:select": () => ({ count: 12 }),
    },
  });
  const { status, body } = await readJson(await GETturns("c2"));
  assert.equal(status, 200);
  assert.deepEqual(body.turns, []);
  assert.equal(body.exists, true, "a real chat known from title/docs must report exists:true");
});

test("turns: a genuinely unknown/foreign session (no turns, no title, no docs) → exists:false (honest not-found)", async () => {
  current = user({ id: "mem-x", role: "user" });
  fake = makeFakeAdmin({
    on: {
      "ask_history:select": () => ({ data: [] }),
      "session_titles:select": () => ({ count: 0 }),
      "doc_chunks:select": () => ({ count: 0 }),
      "uploaded_rows:select": () => ({ count: 0 }),
    },
  });
  const { body } = await readJson(await GETturns("ghost"));
  assert.deepEqual(body.turns, []);
  assert.equal(body.exists, false, "an id with no turns/title/docs must report exists:false");
});

test("turns: the exists-check for a member is OWNER-SCOPED on both sources (titles + manifest)", async () => {
  current = user({ id: "mem-scope2", role: "user" });
  // No title row → the route must fall through to the SECOND source (the manifest),
  // so BOTH exists-check reads are exercised and both scopings asserted.
  fake = makeFakeAdmin({
    on: {
      "ask_history:select": () => ({ data: [] }),
      "session_titles:select": () => ({ count: 0 }),
    },
  });
  manifestEntries = [{ docId: "d1", displayName: "d1.pdf", type: "pdf", session_id: "c2" }];
  await GETturns("c2");
  const titleRead = fake.calls.find((c) => c.table === "session_titles" && c.op === "select");
  assert.ok(titleRead, "session_titles must be queried for the exists check");
  assert.equal(titleRead!.eq["owner_id"], "mem-scope2", "session_titles exists-check must be owner-scoped");
  assert.equal(titleRead!.eq["session_id"], "c2", "session_titles exists-check must be session-scoped");
  const mc = manifestCalls.find((c) => c.chatId === "c2");
  assert.ok(mc, "the manifest must be consulted (session-scoped) when no title exists");
  assert.equal(mc!.ownerId, "mem-scope2", "the manifest exists-check must be scoped to the CALLER");
});

test("rename: blank title → 400", async () => {
  const { status } = await readJson(await PATCH("s1", { title: "   " }));
  assert.equal(status, 400);
});
test("rename: an over-long title → 400", async () => {
  const { status } = await readJson(await PATCH("s1", { title: "x".repeat(201) }));
  assert.equal(status, 400);
});
test("rename: a session not owned by the member → 404 (resolves to no owner)", async () => {
  current = user({ id: "mem-3", role: "user" });
  fake = makeFakeAdmin({ on: { "ask_history:select": () => ({ data: [] }) } });
  const { status } = await readJson(await PATCH("not-mine", { title: "New name" }));
  assert.equal(status, 404);
});
test("rename: a member's OWN session upserts the title under the resolved owner", async () => {
  current = user({ id: "mem-4", role: "user" });
  fake = makeFakeAdmin({
    on: {
      "ask_history:select": () => ({ data: [{ owner_id: "mem-4" }] }),
      "session_titles:upsert": () => ({ data: null }),
    },
  });
  const { status, body } = await readJson(await PATCH("s1", { title: "My Title" }));
  assert.equal(status, 200);
  assert.equal(body.title, "My Title");
  const up = fake.calls.find((c) => c.table === "session_titles" && c.op === "upsert");
  assert.ok(up, "the rename must upsert a session_titles override");
});

test("delete: a MEMBER's delete is owner-scoped (can't delete another user's thread)", async () => {
  current = user({ id: "mem-5", role: "user" });
  fake = makeFakeAdmin({ on: { "ask_history:delete": () => ({ data: [{ id: "1" }] }) } });
  const { status, body } = await readJson(await DEL("s9"));
  assert.equal(status, 200);
  assert.equal(body.deleted, 1);
  const del = fake.calls.find((c) => c.table === "ask_history" && c.op === "delete")!;
  assert.equal(del.eq["owner_id"], "mem-5", "a member's delete must be owner-scoped");
});
test("delete: an ADMIN's delete is NOT owner-scoped (may delete any)", async () => {
  current = user({ id: "adm", role: "admin" });
  fake = makeFakeAdmin({ on: { "ask_history:delete": () => ({ data: [{ id: "1" }] }) } });
  await DEL("s9");
  const del = fake.calls.find((c) => c.table === "ask_history" && c.op === "delete")!;
  assert.equal(del.eq["owner_id"], undefined, "an admin's delete must NOT be owner-scoped");
});
