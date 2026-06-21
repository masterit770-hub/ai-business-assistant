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

// ── SESSION GROUPING ────────────────────────────────────────────────────────────
// A "session" is a conversation thread: the ask_history rows sharing one session_id,
// ordered by created_at. The listing in /api/history collapses rows into one entry
// per session — title = the FIRST turn's question (oldest in the thread), turn_count,
// last_at (the newest turn's time), and (admin only) the owner's email.

// The minimal shape of a persisted ask_history row the grouping reads.
export type AskRow = {
  id: string;
  owner_id: string;
  session_id: string | null;
  question: string;
  created_at: string;
};

// One session entry as returned by GET /api/history.
export type SessionSummary = {
  session_id: string;
  title: string; // the first turn's question
  turn_count: number;
  last_at: string; // ISO time of the most recent turn
  owner_email?: string | null; // admin cross-user view only
};

/**
 * Pick the DISPLAY title for a session: the user's rename OVERRIDE when present and
 * non-blank, else the first turn's question (the default). PURE so the merge rule is
 * unit-tested without a DB.
 *
 * - `firstQuestion` is the immutable first turn's text (the default title).
 * - `override` is the stored session_titles.title for this session, if any.
 *   A null/undefined/blank/whitespace-only override is ignored (falls back to the
 *   question) so an empty rename can never blank out a thread's title.
 */
export function resolveSessionTitle(
  firstQuestion: string,
  override?: string | null
): string {
  return override && override.trim() ? override.trim() : firstQuestion;
}

/**
 * Group ask_history rows into one summary per session, NEWEST session first.
 *
 * Input rows may be in any order. Within a session, the OLDEST row (earliest
 * created_at) supplies the DEFAULT title (the first question the user asked); the
 * NEWEST row supplies last_at. A row whose session_id is null is treated as its OWN
 * singleton session keyed by its row id, so a pre-migration single-shot ask still
 * appears in the list (it just has one turn). `emailOf` (optional) attaches the
 * owner's email for the admin cross-user view. `titleOf` (optional) maps a session_id
 * to a RENAME override — when present and non-blank it replaces the first question as
 * the displayed title (see resolveSessionTitle).
 *
 * PURE (no I/O) so the grouping contract is unit-tested without a DB.
 */
export function groupSessions(
  rows: AskRow[],
  emailOf?: Map<string, string>,
  titleOf?: Map<string, string>
): SessionSummary[] {
  const byKey = new Map<string, AskRow[]>();
  for (const r of rows) {
    // A null session_id → a legacy standalone ask: key it by its own id so it shows as
    // a single-turn session rather than being merged with other null-session rows.
    const key = r.session_id ?? `row:${r.id}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }

  const sessions: SessionSummary[] = [];
  for (const [key, group] of byKey) {
    // Oldest → newest within the thread.
    const ordered = [...group].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const sessionId = first.session_id ?? key;
    sessions.push({
      session_id: sessionId,
      // The user's rename override wins (when present + non-blank); else the first
      // turn's question. A legacy null-session row keyed by `row:<id>` has no override.
      title: resolveSessionTitle(first.question, titleOf?.get(sessionId)),
      turn_count: ordered.length,
      last_at: last.created_at,
      ...(emailOf ? { owner_email: emailOf.get(first.owner_id) ?? null } : {}),
    });
  }

  // Newest session first (by its most recent turn).
  sessions.sort((a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime());
  return sessions;
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
 * (only the question, the answer, the mode, the citation tokens, the route, and the
 * session id that ties this turn to its conversation thread).
 *
 * `sessionId` groups this row with the other turns of the same chat (its conversation).
 * It is optional so any non-chat caller still logs a standalone row (session_id null).
 */
export async function logAsk(
  ownerId: string,
  result: AnswerResult,
  sessionId?: string | null
): Promise<void> {
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
        // Persist the REAL retrieval trace so a resumed/historical turn replays its true
        // inspector (route → retrieval → grounding) instead of a fabricated empty one.
        // The inspector is lightweight (counts + steps); the evidence (rows/chunks) is a
        // few KB and makes the evidence panel + citation count replay faithfully.
        inspector: result.inspector ?? null,
        evidence: result.evidence ?? null,
        // The real grounding verdict, so a resumed turn replays whether it actually
        // passed validateAnswer — never a fabricated green "verified".
        validation: result.validation ?? null,
        session_id: sessionId ?? null,
      });
    if (error) {
      // Non-fatal: the answer already went out. Surface for debugging only.
      console.error("ask-history insert failed:", error.message);
    }
  } catch (e) {
    console.error("ask-history logging error:", e instanceof Error ? e.message : e);
  }
}
