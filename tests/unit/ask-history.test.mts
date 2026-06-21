import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCitations, shouldLogAsk } from "../../src/lib/engine/ask-history.ts";
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
