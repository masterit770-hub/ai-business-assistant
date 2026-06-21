import { test } from "node:test";
import assert from "node:assert/strict";
import { groupSessions, type AskRow } from "../../src/lib/engine/ask-history.ts";

// groupSessions collapses ask_history rows into one summary per conversation, newest
// session first. It backs GET /api/history (the History page lists SESSIONS, not flat
// asks). These PURE tests pin:
//   • rows sharing a session_id become ONE session;
//   • title = the FIRST (oldest) turn's question; turn_count + last_at summarise it;
//   • newest session is listed first (by its most recent turn);
//   • a null session_id row becomes its own single-turn session (legacy asks survive);
//   • the admin owner_email is attached when an emailOf map is supplied.

function row(over: Partial<AskRow>): AskRow {
  return {
    id: "id-" + Math.random().toString(36).slice(2),
    owner_id: "u1",
    session_id: "s1",
    question: "q?",
    created_at: "2026-06-17T10:00:00Z",
    ...over,
  };
}

test("groups rows by session_id; title is the first turn's question", () => {
  const rows: AskRow[] = [
    row({ session_id: "s1", question: "How many contracts expire?", created_at: "2026-06-17T10:00:00Z" }),
    row({ session_id: "s1", question: "What about next quarter?", created_at: "2026-06-17T10:05:00Z" }),
  ];
  const sessions = groupSessions(rows);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session_id, "s1");
  assert.equal(sessions[0].title, "How many contracts expire?");
  assert.equal(sessions[0].turn_count, 2);
  assert.equal(sessions[0].last_at, "2026-06-17T10:05:00Z");
});

test("title uses the OLDEST turn even when rows arrive newest-first", () => {
  // /api/history fetches rows newest-first; grouping must still pick the oldest as title.
  const rows: AskRow[] = [
    row({ session_id: "s1", question: "follow-up", created_at: "2026-06-17T11:00:00Z" }),
    row({ session_id: "s1", question: "the opening question", created_at: "2026-06-17T09:00:00Z" }),
  ];
  const [s] = groupSessions(rows);
  assert.equal(s.title, "the opening question");
  assert.equal(s.last_at, "2026-06-17T11:00:00Z");
});

test("newest session is listed first", () => {
  const rows: AskRow[] = [
    row({ session_id: "older", question: "old", created_at: "2026-06-10T10:00:00Z" }),
    row({ session_id: "newer", question: "new", created_at: "2026-06-17T10:00:00Z" }),
  ];
  const sessions = groupSessions(rows);
  assert.deepEqual(sessions.map((s) => s.session_id), ["newer", "older"]);
});

test("a null session_id row becomes its own single-turn session", () => {
  const rows: AskRow[] = [
    row({ id: "legacy", session_id: null, question: "legacy single-shot ask" }),
  ];
  const sessions = groupSessions(rows);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].turn_count, 1);
  assert.equal(sessions[0].title, "legacy single-shot ask");
  // session_id falls back to a stable per-row key so the UI can still link/resume.
  assert.equal(sessions[0].session_id, "row:legacy");
});

test("two distinct null-session rows do NOT merge into one session", () => {
  const rows: AskRow[] = [
    row({ id: "a", session_id: null, question: "ask one" }),
    row({ id: "b", session_id: null, question: "ask two" }),
  ];
  assert.equal(groupSessions(rows).length, 2);
});

test("admin: owner_email is attached from the emailOf map", () => {
  const rows: AskRow[] = [
    row({ session_id: "s1", owner_id: "u9", question: "q" }),
  ];
  const emailOf = new Map([["u9", "jenny@example.com"]]);
  const [s] = groupSessions(rows, emailOf);
  assert.equal(s.owner_email, "jenny@example.com");
});
