// Multi-turn conversation context — the pure helpers that let a follow-up question
// ("what about Q2?", "and the next quarter?", "summarize that") be understood in the
// light of the turns that came before it.
//
// These are PURE (no I/O, no LLM) so the exact wording fed to the router + the
// generator is unit-tested deterministically. The engine threads the most recent
// turns BEFORE the current question, clearly labelled as prior conversation, into
// both the routing prompt (so it routes a follow-up correctly) and the generation
// prompt (so the answerer resolves "it/that/the next quarter" against the thread).

// One prior turn = a question the user asked and the answer they got.
export type Turn = { question: string; answer: string };

// How many recent turns to carry. Keeps the prompt bounded (a long chat doesn't
// blow up the context) while giving the model enough to resolve references — the
// last ~6 turns is plenty for "it/that/the next quarter" style follow-ups.
export const MAX_HISTORY_TURNS = 6;

// Trim an answer carried into the prompt so a very long prior answer doesn't dominate
// the context window. The recent answer's gist is what disambiguates a follow-up; the
// full text is still on screen for the user.
const MAX_ANSWER_CHARS = 1200;

/**
 * Take the last `MAX_HISTORY_TURNS` valid turns, newest-last (chronological order).
 * Drops empty/whitespace-only turns so a malformed client payload can't inject blanks.
 * PURE.
 */
export function recentTurns(history: Turn[] | undefined, max = MAX_HISTORY_TURNS): Turn[] {
  if (!Array.isArray(history) || history.length === 0) return [];
  const clean = history.filter(
    (t) => t && typeof t.question === "string" && typeof t.answer === "string" && t.question.trim() && t.answer.trim()
  );
  return clean.slice(-max);
}

/**
 * Build the human-readable "prior conversation" block that is injected BEFORE the
 * current question. Returns "" when there is no usable history, so the prompts are
 * byte-for-byte identical to today's single-shot behavior when no history is passed
 * (the backward-compatibility guarantee). Each turn is labelled "User:" / "Assistant:"
 * and ordered oldest→newest, with the current question handled separately by the caller.
 *
 * PURE — unit-tested without an LLM.
 */
export function buildConversationContext(history: Turn[] | undefined, max = MAX_HISTORY_TURNS): string {
  const turns = recentTurns(history, max);
  if (turns.length === 0) return "";
  const lines = turns
    .map((t) => {
      const q = t.question.trim();
      const a = t.answer.trim();
      const aClipped = a.length > MAX_ANSWER_CHARS ? a.slice(0, MAX_ANSWER_CHARS) + " …" : a;
      return `User: ${q}\nAssistant: ${aClipped}`;
    })
    .join("\n\n");
  return `PRIOR CONVERSATION (most recent last) — the user's new question may refer back to this (e.g. "it", "that", "the next quarter"). Use it ONLY to resolve what the new question means; always answer the NEW question:\n\n${lines}`;
}
