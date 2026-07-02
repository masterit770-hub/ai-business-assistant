import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveCitations,
  shouldLogAsk,
  mergeSessionSources,
  groupSessions,
  UNTITLED_SESSION_TITLE,
  type AskRow,
} from "../../src/lib/engine/ask-history.ts";
import type { AnswerResult } from "../../src/lib/engine/answer.ts";

// The ask-history logger persists every successful ask so a user can review their
// past questions (session/query/SOURCE history). deriveCitations + shouldLogAsk are
// the PURE helpers behind that — testable without a DB or an LLM. These pin:
//   • the citation TOKENS shown in the answer are extracted verbatim;
//   • the retrieved SOURCES (rows + chunks) are captured even when the answer is
//     uncited/general — so "source history" survives an uncited turn;
//   • duplicate tokens collapse; order is preserved;
//   • trivial guidance/empty turns are NOT logged, real Q&A turns ARE.

// A minimal AnswerResult factory — only the fields the helpers read.
function result(over: Partial<AnswerResult>): AnswerResult {
  return {
    question: "q?",
    answer: "a",
    mode: "grounded",
    grounded: true,
    route: { sources: [], docFilter: null, rationale: "" },
    evidence: { rows: [], chunks: [] },
    validation: { ok: true, reasons: [] },
    ...over,
  } as AnswerResult;
}

test("deriveCitations: extracts the citation tokens present in the answer text", () => {
  const r = result({
    answer:
      "38 contracts expire soon, totaling $18.9M [S:contracts#269]. See also [P:family-court#24].",
    evidence: { rows: [], chunks: [] },
  });
  const { tokens } = deriveCitations(r);
  assert.deepEqual(tokens, ["[S:contracts#269]", "[P:family-court#24]"]);
});

test("deriveCitations: captures retrieved SOURCES even when the answer is uncited", () => {
  // A general/uncited answer still has retrieved evidence — source history must keep it.
  const r = result({
    mode: "general",
    grounded: false,
    answer: "Here is a general explanation with no citation tokens.",
    evidence: {
      rows: [{ table: "contracts", id: 1, token: "[S:contracts#1]", data: {} }],
      chunks: [
        { doc: "family-court", page: 24, token: "[P:family-court#24]", text: "…", score: 0.9 },
      ],
    },
  });
  const { tokens, sources } = deriveCitations(r);
  assert.deepEqual(tokens, [], "no tokens in an uncited answer");
  assert.deepEqual(sources, ["[S:contracts#1]", "[P:family-court#24]"]);
});

test("deriveCitations: de-duplicates source tokens, preserving first-seen order", () => {
  const r = result({
    answer: "x",
    evidence: {
      rows: [
        { table: "c", id: 2, token: "[S:c#2]", data: {} },
        { table: "c", id: 2, token: "[S:c#2]", data: {} },
      ],
      chunks: [{ doc: "d", page: 5, token: "[P:d#5]", text: "…", score: 0.5 }],
    },
  });
  assert.deepEqual(deriveCitations(r).sources, ["[S:c#2]", "[P:d#5]"]);
});

test("shouldLogAsk: a real grounded answer IS logged", () => {
  assert.equal(shouldLogAsk(result({ question: "How many contracts?", answer: "38." })), true);
});

test("shouldLogAsk: a real general answer IS logged", () => {
  assert.equal(
    shouldLogAsk(result({ mode: "general", grounded: false, question: "What is X?", answer: "X is…" })),
    true
  );
});

test("shouldLogAsk: Local/HIPAA setup-guidance turns are NOT logged", () => {
  assert.equal(
    shouldLogAsk(
      result({ mode: "general", grounded: false, answer: "Local mode is on…", localGuidance: "not-configured" })
    ),
    false
  );
});

test("shouldLogAsk: an empty question or answer is NOT logged", () => {
  assert.equal(shouldLogAsk(result({ question: "   ", answer: "a" })), false);
  assert.equal(shouldLogAsk(result({ question: "q", answer: "" })), false);
});

// ── mergeSessionSources — the FIX-1 merge contract ───────────────────────────────
// A chat must be surfaced for ANY session the owner has known from ask_history OR a
// rename (session_titles) row OR docs (doc_chunks/uploaded_rows) — not just the ones
// with ask_history. This is the bug that made a RESTORED account (titles + docs, zero
// asks) show "No conversations yet". These pin the pure merge; the HTTP wiring +
// owner-scoping is pinned in tests/api/history-route.test.mts.

test("mergeSessionSources: a TITLE-ONLY session (no ask, no docs) appears, titled by its override", () => {
  // The exact restored-client shape: a named chat with zero ask_history rows.
  const merged = mergeSessionSources(
    [], // no ask sessions
    ["s-title"], // has a session_titles row
    [], // no docs
    new Map([["s-title", "Family Court — Carter Case"]])
  );
  const ids = merged.map((s) => s.session_id);
  assert.ok(ids.includes("s-title"), "a title-only session must surface a chat");
  const entry = merged.find((s) => s.session_id === "s-title")!;
  assert.equal(entry.title, "Family Court — Carter Case", "titled by its session_titles override");
  assert.equal(entry.turn_count, 0, "a chat with no ask is a zero-turn entry");
});

test("mergeSessionSources: a DOCS-ONLY session (no ask, no title) appears with the neutral default title", () => {
  const merged = mergeSessionSources([], [], ["s-docs"], undefined);
  const entry = merged.find((s) => s.session_id === "s-docs");
  assert.ok(entry, "a docs-only session must surface a chat");
  assert.equal(entry!.title, UNTITLED_SESSION_TITLE, "no title/ask → the neutral default (general, not corpus-specific)");
  assert.equal(entry!.turn_count, 0);
});

test("mergeSessionSources: a session present in ask_history is NOT duplicated by a title/doc source", () => {
  const askRows: AskRow[] = [
    { id: "1", owner_id: "o", session_id: "s-ask", question: "How many contracts?", created_at: "2026-01-01T00:00:00Z" },
  ];
  // Mirror the real route: the override is applied at grouping time (groupSessions gets
  // the title map), then the same session also appears in the title + doc sources.
  const titleOf = new Map([["s-ask", "Renamed"]]);
  const askSessions = groupSessions(askRows, undefined, titleOf);
  const merged = mergeSessionSources(askSessions, ["s-ask"], ["s-ask"], titleOf);
  const occurrences = merged.filter((s) => s.session_id === "s-ask").length;
  assert.equal(occurrences, 1, "a session with both ask + title/docs must not be doubled");
  // Its ask-derived entry (turn_count + title resolution) wins untouched.
  const entry = merged.find((s) => s.session_id === "s-ask")!;
  assert.equal(entry.turn_count, 1, "the ask entry's turn_count is preserved");
  assert.equal(entry.title, "Renamed", "the ask entry's title (override) is preserved");
});

test("mergeSessionSources: dated ask sessions sort ABOVE zero-turn title/doc-only chats", () => {
  const askRows: AskRow[] = [
    { id: "1", owner_id: "o", session_id: "s-ask", question: "q", created_at: "2026-06-01T00:00:00Z" },
  ];
  const merged = mergeSessionSources(groupSessions(askRows), ["s-title"], ["s-docs"], undefined);
  assert.equal(merged[0].session_id, "s-ask", "a real dated chat is newest-first, above the zero-turn ones");
  assert.equal(merged.length, 3, "all three sources are represented exactly once");
});

test("mergeSessionSources: the union of title + doc sources de-duplicates a shared id", () => {
  const merged = mergeSessionSources([], ["s-both"], ["s-both"], new Map([["s-both", "Scheduling"]]));
  assert.equal(merged.filter((s) => s.session_id === "s-both").length, 1, "title+docs on one id → one entry");
  assert.equal(merged[0].title, "Scheduling");
});

test("mergeSessionSources: the restored-client shape — 6 title-only sessions all appear", () => {
  // Mirrors owner b01c311e: 6 session_titles, docs on a subset, ZERO ask_history.
  const titles = new Map([
    ["c1", "Scheduling (June & August 2024)"],
    ["c2", "Family Court — Carter Case"],
    ["c3", "Contracts (School Data 1)"],
    ["c4", "Course Enrollment (School Data 4 & 6)"],
    ["c5", "Payroll (School Data 2)"],
    ["c6", "Maintenance (School Data 3)"],
  ]);
  const merged = mergeSessionSources([], [...titles.keys()], ["c1", "c3", "c4"], titles);
  assert.equal(merged.length, 6, "all 6 of her chats must appear with zero asks");
  for (const [id, title] of titles) {
    const e = merged.find((s) => s.session_id === id);
    assert.ok(e, `chat ${id} must appear`);
    assert.equal(e!.title, title, `chat ${id} keeps its title`);
  }
});

// The verifier's real catch: session_titles.session_id is TEXT while doc_chunks/
// uploaded_rows.session_id are UUID, so the SAME logical session can arrive as strings
// that differ in case/whitespace. The de-dup must normalize the key so a session with
// BOTH a title and docs (the Carter case) collapses to ONE entry, not two.
test("mergeSessionSources: a title (TEXT) + docs (UUID) for the SAME session, case-mismatched, de-dupe to ONE", () => {
  const upper = "C0C311E2-0002-4000-8000-000000000002"; // as a TEXT title row might store it
  const lower = "c0c311e2-0002-4000-8000-000000000002"; // as the UUID doc column returns it
  const merged = mergeSessionSources(
    [],
    [upper], // titledIds (TEXT, upper)
    [lower], // docSessionIds (UUID, lower)
    new Map([[upper, "Family Court — Carter Case"]])
  );
  assert.equal(merged.length, 1, "a title+docs session that differs only by case must be ONE chat, not two");
  assert.equal(merged[0].title, "Family Court — Carter Case", "the titled entry's title wins");
});

test("mergeSessionSources: surrounding whitespace in a TEXT session_id still de-dupes against the UUID", () => {
  const padded = "  c0c311e1-0001-4000-8000-000000000001  ";
  const clean = "c0c311e1-0001-4000-8000-000000000001";
  const merged = mergeSessionSources([], [padded], [clean], new Map([[padded, "Scheduling"]]));
  assert.equal(merged.length, 1, "a whitespace-padded title id must de-dupe against the clean UUID");
});

// Finding 2 (verifier): zero-turn title-only chats must have a DETERMINISTIC order —
// newest-renamed first — not all-epoch-0 (whatever the DB returns). The rename time
// (session_titles.updated_at) is threaded in as last_at so a renamed chat sorts by recency.
test("mergeSessionSources: title-only chats sort NEWEST-RENAMED first (deterministic, not epoch-0)", () => {
  const titleOf = new Map([
    ["c-old", "Renamed long ago"],
    ["c-new", "Renamed just now"],
    ["c-mid", "Renamed yesterday"],
  ]);
  const updatedAtOf = new Map([
    ["c-old", "2026-01-01T00:00:00Z"],
    ["c-new", "2026-06-26T00:00:00Z"],
    ["c-mid", "2026-06-25T00:00:00Z"],
  ]);
  const merged = mergeSessionSources([], [...titleOf.keys()], [], titleOf, updatedAtOf);
  assert.deepEqual(
    merged.map((s) => s.session_id),
    ["c-new", "c-mid", "c-old"],
    "title-only chats must be ordered by rename recency, newest first"
  );
});

test("mergeSessionSources: a renamed title-only chat sorts ABOVE a doc-only chat (which has no time)", () => {
  // A doc-only chat has no rename time → epoch-0 → below any renamed chat.
  const merged = mergeSessionSources(
    [],
    ["c-titled"],
    ["c-docs"],
    new Map([["c-titled", "Named recently"]]),
    new Map([["c-titled", "2026-06-20T00:00:00Z"]])
  );
  assert.equal(merged[0].session_id, "c-titled", "a renamed chat sorts above a timeless doc-only chat");
  assert.equal(merged[1].session_id, "c-docs");
});
