import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConversationContext,
  recentTurns,
  MAX_HISTORY_TURNS,
  type Turn,
} from "../../src/lib/engine/conversation.ts";

// The multi-turn helpers build the "prior conversation" block that is threaded BEFORE
// the current question into the router + generation prompts, so a follow-up resolves
// references against the chat. These PURE helpers pin:
//   • NO history → "" (the backward-compatibility guarantee: single-shot unchanged);
//   • the block is labelled, ordered oldest→newest, with both turns;
//   • only the last MAX_HISTORY_TURNS turns are carried (a long chat stays bounded);
//   • malformed/blank turns are dropped.

test("buildConversationContext: no history yields an empty block (single-shot unchanged)", () => {
  assert.equal(buildConversationContext(undefined), "");
  assert.equal(buildConversationContext([]), "");
});

test("buildConversationContext: includes each turn's question AND answer, labelled", () => {
  const history: Turn[] = [
    { question: "How many contracts expire in Q1?", answer: "12 contracts [S:contracts#3]." },
    { question: "What about Q2?", answer: "8 contracts [S:contracts#9]." },
  ];
  const block = buildConversationContext(history);
  assert.match(block, /PRIOR CONVERSATION/);
  assert.match(block, /User: How many contracts expire in Q1\?/);
  assert.match(block, /Assistant: 12 contracts \[S:contracts#3\]\./);
  assert.match(block, /User: What about Q2\?/);
  assert.match(block, /Assistant: 8 contracts \[S:contracts#9\]\./);
});

test("buildConversationContext: orders turns oldest → newest (Q1 before Q2)", () => {
  const block = buildConversationContext([
    { question: "first", answer: "a1" },
    { question: "second", answer: "a2" },
  ]);
  assert.ok(block.indexOf("first") < block.indexOf("second"));
});

test("recentTurns: keeps only the last MAX_HISTORY_TURNS turns, newest-last", () => {
  const many: Turn[] = Array.from({ length: 10 }, (_, i) => ({
    question: `q${i}`,
    answer: `a${i}`,
  }));
  const kept = recentTurns(many);
  assert.equal(kept.length, MAX_HISTORY_TURNS);
  assert.equal(kept[0].question, "q4"); // q0..q3 dropped
  assert.equal(kept[kept.length - 1].question, "q9");
});

test("recentTurns: drops empty / malformed turns", () => {
  // A malformed client payload (wrong types, blanks) must be tolerated, not crash.
  const dirty = [
    { question: "  ", answer: "x" },
    { question: "real", answer: "answer" },
    { question: "y", answer: "   " },
    { question: 5, answer: "z" },
  ] as unknown as Turn[];
  const kept = recentTurns(dirty);
  assert.deepEqual(kept, [{ question: "real", answer: "answer" }]);
});
