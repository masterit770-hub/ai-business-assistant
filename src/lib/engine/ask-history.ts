// Ask-history logging — persist every successful ask (question + answer + the
// sources/citations used + the routing decision) so a user can review their past
// asks. Each row is owned by the asking user; an admin can later read everyone's.
//
// CONTRACT: logging is BEST-EFFORT and MUST NEVER break /api/ask. `logAsk` swallows
// every error (no DB, transient write failure, Supabase not configured) and simply
// does nothing — the answer the user already received is never affected.
import { admin, supabaseEnabled } from "./supabase.ts";
import { extractCitationTokens } from "./citations.ts";
import type { AnswerResult } from "./answer.ts";

// What we persist alongside the question/answer. Built from the REAL answer result —
// the citation tokens the user actually saw, plus the citable evidence the search
// returned (so "source history" survives even if the model wrote an uncited line).
export type AskHistoryCitations = {
  // Citation tokens that appear in the answer text, e.g. ["[S:contracts#1]", ...].
  tokens: string[];
  // Every distinct retrieved evidence source this turn (rows + chunks), as their
  // citation tokens — the "sources used" view, independent of what the model cited.
  sources: string[];
};

/**
 * Derive the citations/sources payload from an AnswerResult. PURE (no I/O) so the
 * extraction contract is unit-testable without a DB or an LLM.
 *
 * - `tokens`   = the citation tokens present in the answer text the user saw.
 * - `sources`  = the citation token of every retrieved evidence item (structured
 *                rows + document chunks), de-duplicated, order-preserving — this is
 *                the real "source history" even when the answer is uncited/general.
 */
export function deriveCitations(result: AnswerResult): AskHistoryCitations {
  const tokens = extractCitationTokens(result.answer ?? "");
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const r of result.evidence?.rows ?? []) {
    if (r.token && !seen.has(r.token)) {
      seen.add(r.token);
      sources.push(r.token);
    }
  }
  for (const c of result.evidence?.chunks ?? []) {
    if (c.token && !seen.has(c.token)) {
      seen.add(c.token);
      sources.push(c.token);
    }
  }
  return { tokens, sources };
}

/**
 * Should this answer be persisted at all? Skip trivial guidance/error results that
 * carry no real Q&A value: the Local/HIPAA setup-guidance turns (no evidence, no real
 * answer to a question) and any empty answer. A normal grounded OR general answer IS
 * persisted — the user asked a real question and got a real reply. PURE + exported so
 * the skip rule is unit-tested deterministically.
 */
export function shouldLogAsk(result: AnswerResult): boolean {
  if (!result || !result.question?.trim() || !result.answer?.trim()) return false;
  // localGuidance is set ONLY on the "Local/HIPAA isn't set up" setup-guidance turns —
  // those are plumbing notes, not a question the user wants in their history.
  if (result.localGuidance) return false;
  return true;
}

/**
 * Persist one ask. BEST-EFFORT: any failure is caught and logged to the server
 * console only — it NEVER throws, NEVER changes the response. No secrets are written
 * (only the question, the answer, the mode, the citation tokens, and the route).
 */
export async function logAsk(ownerId: string, result: AnswerResult): Promise<void> {
  try {
    if (!ownerId) return;
    if (!shouldLogAsk(result)) return;
    if (!supabaseEnabled()) return; // no persistent store configured → nothing to do.

    const citations = deriveCitations(result);
    const { error } = await admin()
      .from("ask_history")
      .insert({
        owner_id: ownerId,
        question: result.question,
        answer: result.answer,
        mode: result.mode ?? null,
        citations,
        route: result.route ?? null,
      });
    if (error) {
      // Non-fatal: the answer already went out. Surface for debugging only.
      console.error("ask-history insert failed:", error.message);
    }
  } catch (e) {
    console.error("ask-history logging error:", e instanceof Error ? e.message : e);
  }
}
