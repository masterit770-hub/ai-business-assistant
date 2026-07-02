import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSessionTitle,
  groupSessions,
  type AskRow,
} from "../../src/lib/engine/ask-history.ts";

// A conversation can be RENAMED without rewriting its immutable first question: the
// rename is stored as a session_titles OVERRIDE, and the history listing PREFERS it.
// resolveSessionTitle is the PURE merge rule behind that, and groupSessions now takes
// an optional title-override map. These pin:
//   • an override (when present + non-blank) replaces the first question;
//   • a missing / null / blank / whitespace-only override falls back to the question
//     (an empty rename can never blank out a thread's title);
//   • the override is trimmed;
//   • groupSessions applies the override only to the matching session_id, and a
//     session with no override keeps its first-question title.

// ── resolveSessionTitle (the pure merge) ─────────────────────────────────────────

test("resolveSessionTitle: a non-blank override replaces the first question", () => {
  assert.equal(resolveSessionTitle("How many contracts expire?", "Q3 renewals"), "Q3 renewals");
});

test("resolveSessionTitle: a trimmed override is used", () => {
  assert.equal(resolveSessionTitle("orig", "  Renamed  "), "Renamed");
});

test("resolveSessionTitle: no override falls back to the first question", () => {
  assert.equal(resolveSessionTitle("orig question"), "orig question");
  assert.equal(resolveSessionTitle("orig question", null), "orig question");
  assert.equal(resolveSessionTitle("orig question", undefined), "orig question");
});

test("resolveSessionTitle: a blank/whitespace override never blanks the title", () => {
  assert.equal(resolveSessionTitle("orig question", ""), "orig question");
  assert.equal(resolveSessionTitle("orig question", "   "), "orig question");
});

// ── groupSessions with the title-override map ────────────────────────────────────

function row(over: Partial<AskRow>): AskRow {
  return {
    id: "r1",
    owner_id: "u1",
    session_id: "s1",
    question: "first question",
    created_at: "2026-06-17T10:00:00.000Z",
    ...over,
  };
}

test("groupSessions: the override title wins for the matching session, default for others", () => {
  const rows: AskRow[] = [
    row({ id: "a", session_id: "s1", question: "first of s1", created_at: "2026-06-17T10:00:00.000Z" }),
    row({ id: "b", session_id: "s1", question: "second of s1", created_at: "2026-06-17T10:05:00.000Z" }),
    row({ id: "c", session_id: "s2", question: "first of s2", created_at: "2026-06-17T11:00:00.000Z" }),
  ];
  const titleOf = new Map([["s1", "Renamed S1"]]);
  const sessions = groupSessions(rows, undefined, titleOf);

  const s1 = sessions.find((s) => s.session_id === "s1")!;
  const s2 = sessions.find((s) => s.session_id === "s2")!;
  assert.equal(s1.title, "Renamed S1", "s1 uses the override");
  assert.equal(s1.turn_count, 2, "override does not change the turn count");
  assert.equal(s2.title, "first of s2", "s2 has no override → keeps its first question");
});

test("groupSessions: a blank override is ignored (keeps the first question)", () => {
  const rows: AskRow[] = [row({ id: "a", session_id: "s1", question: "the real first question" })];
  const sessions = groupSessions(rows, undefined, new Map([["s1", "   "]]));
  assert.equal(sessions[0].title, "the real first question");
});

test("groupSessions: with no override map at all, behaves exactly as before", () => {
  const rows: AskRow[] = [row({ id: "a", session_id: "s1", question: "untouched title" })];
  const sessions = groupSessions(rows);
  assert.equal(sessions[0].title, "untouched title");
});
