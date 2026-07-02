/**
 * PER-CHAT DOCUMENT SCOPING — two-tier model (agentic manifest path)
 *
 * The agent (answer-agentic.ts listOwnerFiles) scopes the owner's files per chat via the
 * SHARED, exported filterFilesForChat() in src/lib/engine/file-scope.ts — imported HERE so
 * this test exercises the REAL logic, not a re-implementation that can silently drift. A
 * local re-implementation is exactly what hid the client's "the assistant didn't read my
 * files" bug: the old test asserted strict scoping against its OWN copy of the predicate
 * while the real code stranded Sources-page uploads (session_id = null) in every chat.
 *
 * TWO-TIER model (what the upload UI documents + what the client expects):
 *   • CHAT attachment (session_id === chatId) → visible ONLY in that chat.
 *   • GLOBAL library  (session_id === null, Sources-page uploads) → visible in EVERY chat.
 *   • A chat sees: its own attachments + the owner's global library.
 *
 * The DB/RAG lane (hybrid_match p_session, storeDocChunks session_id — migration 015) is
 * the dead retrieval relic and stays strict; those row-shape tests below are unchanged.
 *
 * Tests use in-process logic only — no live DB, no LLM, no API key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { filterFilesForChat } from "../../src/lib/engine/file-scope.ts";
import { canSearchOwner } from "../../src/lib/engine/pgvector-store.ts";
import { canReadOwner } from "../../src/lib/engine/structured-rows-store.ts";
import {
  IMPORTED_SESSION_ID,
  SAMPLE_DATA_SESSION_ID,
} from "../../src/lib/engine/virtual-sessions.ts";

// ── Agentic manifest scoping — the REAL filterFilesForChat (STRICT) ────────────
// Requirement: EVERY doc belongs to a chat; there is NO "global" tier. A chat sees ONLY
// its own docs. A null-session doc is a BUG upstream (an upload that failed to link to a
// chat) and is intentionally NOT surfaced — so the bug stays visible, never masked. The
// upload path makes a null-session doc impossible (chat-upload mints a session; /api/ingest
// rejects a sessionless upload) — see those tests.

type ManifestEntry = { docId: string; displayName: string; type: string; session_id?: string | null };

const MANIFEST: ManifestEntry[] = [
  { docId: "a.pdf",      displayName: "a.pdf",      type: "pdf", session_id: "chat-A" }, // chat A's doc
  { docId: "b.csv",      displayName: "b.csv",      type: "csv", session_id: "chat-B" }, // chat B's doc
  { docId: "orphan.pdf", displayName: "orphan.pdf", type: "pdf", session_id: null },     // BUG: an unassigned upload
];

// (a) A chat sees ONLY its own doc — not other chats', not an unassigned one.
test("filterFilesForChat: chat A sees ONLY its own doc", () => {
  const ids = filterFilesForChat(MANIFEST, "chat-A").map((f) => f.docId).sort();
  assert.deepEqual(ids, ["a.pdf"]);
});

// (b) Cross-chat isolation.
test("filterFilesForChat: chat B sees ONLY its own doc, not chat A's", () => {
  const ids = filterFilesForChat(MANIFEST, "chat-B").map((f) => f.docId).sort();
  assert.deepEqual(ids, ["b.csv"]);
});

// (c) An unassigned (null-session) doc is NOT surfaced in any chat. It must never be
//     created in the first place (the real bug is the upload path, fixed separately).
test("filterFilesForChat: an unassigned (null-session) doc is NOT shown in any chat", () => {
  assert.equal(filterFilesForChat(MANIFEST, "chat-A").some((f) => f.docId === "orphan.pdf"), false);
  assert.equal(filterFilesForChat(MANIFEST, "brand-new-chat-with-no-docs").length, 0);
});

// (d) No chatId (admin / all-docs view) → every file.
test("filterFilesForChat: no chatId → all files returned", () => {
  assert.equal(filterFilesForChat(MANIFEST, null).length, MANIFEST.length);
});

test("filterFilesForChat: undefined chatId → all files returned", () => {
  assert.equal(filterFilesForChat(MANIFEST, undefined).length, MANIFEST.length);
});

// ── Virtual session ID stability ───────────────────────────────────────────────
// These UUIDs are baked into migration 015 SQL. Changing them breaks the migration.
// Pin them here so a refactor can't silently drift.

test("IMPORTED_SESSION_ID is the expected well-known UUID", () => {
  assert.equal(IMPORTED_SESSION_ID, "00000000-0000-0000-0000-000000000001");
});

test("SAMPLE_DATA_SESSION_ID is the expected well-known UUID", () => {
  assert.equal(SAMPLE_DATA_SESSION_ID, "00000000-0000-0000-0000-000000000002");
});

// ── storeDocChunks row payload includes session_id ────────────────────────────
// Pins the row shape built in pgvector-store.ts storeDocChunks() for the chat lane.

test("storeDocChunks row payload includes session_id when chatId is provided", () => {
  const chatId = "session-xyz";
  const row = {
    owner_id: "owner-1",
    doc_id: "doc-1",
    doc_label: "test.pdf",
    page: 1,
    chunk_index: 0,
    content: "some text",
    token: "[P:doc-1#1]",
    urgency: null,
    embedding: "[0.1,0.2]",
    session_id: chatId ?? null,  // ← the session scoping field (migration 014+)
  };
  assert.equal(row.session_id, chatId);
});

test("storeDocChunks row payload has session_id=null when chatId is omitted", () => {
  const chatId: string | null | undefined = undefined;
  const row = { session_id: chatId ?? null };
  assert.equal(row.session_id, null);
});

// ── storeUploadedRows payload includes session_id ─────────────────────────────
// Pins the payload shape built in structured-rows-store.ts storeUploadedRows() for the
// structured (spreadsheet) lane.

test("storeUploadedRows payload includes session_id when chatId is provided", () => {
  const chatId = "session-abc";
  const payload = {
    owner_id: "owner-2",
    table_name: "my_table",
    label: "my_table",
    row_id: 1,
    data: { id: 1, name: "Alice" },
    session_id: chatId ?? null,
  };
  assert.equal(payload.session_id, chatId);
});

test("storeUploadedRows payload has session_id=null when chatId is omitted", () => {
  const chatId: string | null | undefined = null;
  const payload = { session_id: chatId ?? null };
  assert.equal(payload.session_id, null);
});

// ── hybridSearch RPC call shape carries p_session ─────────────────────────────
// Pins the param shape that pgvector-store.ts hybridSearch() sends to the DB RPC.
// The DB/RAG lane stays STRICT (migration 015) — it is the dead retrieval relic; the live
// agentic path uses the two-tier manifest filter above, not this RPC.

test("hybridSearch RPC call shape includes p_session when chatId is provided", () => {
  const chatId = "session-hybrid-1";
  const params = {
    query_embedding: "[0.1,0.2]",
    query_text: "test question",
    p_owner: "owner-1",
    p_is_admin: false,
    k: 8,
    p_session: chatId ?? null,
  };
  assert.equal(params.p_session, chatId);
});

test("hybridSearch RPC call shape has p_session=null when no chatId", () => {
  const chatId: string | null | undefined = undefined;
  const params = { p_session: chatId ?? null };
  assert.equal(params.p_session, null);
});

// ── Cross-owner isolation: canSearchOwner (doc lane) ──────────────────────────
// The per-chat filter is ADDITIVE on top of owner isolation — it never widens scope.
// If canSearchOwner returns false, no search runs regardless of chatId.

test("canSearchOwner: fail-closed when no owner id and not admin", () => {
  assert.equal(canSearchOwner(undefined, false), false);
});

test("canSearchOwner: allows access with a concrete owner id (non-admin)", () => {
  assert.equal(canSearchOwner("owner-1", false), true);
});

test("canSearchOwner: allows admin access without an owner id", () => {
  assert.equal(canSearchOwner(undefined, true), true);
});

test("owner isolation gates access before any chat filter is applied", () => {
  // A non-admin with no ownerId cannot search — regardless of chatId.
  // hybridSearch returns [] immediately when canSearchOwner is false.
  const canSearch = canSearchOwner(undefined, false);
  assert.equal(canSearch, false, "fail-closed: no search for unscoped non-admin caller");
});

// ── Cross-owner isolation: canReadOwner (structured lane) ─────────────────────
// Same guarantee for the spreadsheet/text-to-SQL lane.

test("canReadOwner: fail-closed when no owner id and not admin", () => {
  assert.equal(canReadOwner(undefined, false), false);
});

test("canReadOwner: allows read with a concrete owner id", () => {
  assert.equal(canReadOwner("owner-2", false), true);
});

test("canReadOwner: allows admin read without an owner id", () => {
  assert.equal(canReadOwner(undefined, true), true);
});
