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
 * Default title for a session that has NO ask_history turn and NO rename override —
 * i.e. a session known only from a docs upload. A neutral, generic label (never a
 * corpus-specific term), shown until the user renames it or asks a first question.
 */
export const UNTITLED_SESSION_TITLE = "Untitled chat";

/**
 * MERGE every source a session can be known from into one listing. The session list
 * must surface a chat for ANY of the owner's sessions that has EITHER an ask_history
 * turn OR a rename (session_titles) row OR docs (doc_chunks / uploaded_rows) tagged
 * with that session_id — not just the ones with ask_history. A restored account whose
 * chats carry only titles + uploaded docs (zero asks) must still see all its chats.
 *
 * Inputs (all already OWNER-SCOPED by the caller — this fn is owner-agnostic and pure):
 *  - `askSessions`   = the sessions already grouped from ask_history rows (their titles,
 *                      turn_count, last_at, ordering all preserved as-is).
 *  - `titledIds`     = session_ids that have a session_titles row (a named chat).
 *  - `docSessionIds` = session_ids that have docs (doc_chunks and/or uploaded_rows).
 *  - `titleOf`       = session_id → rename override (same map used for ask titles).
 *
 * A session present in `askSessions` is NEVER duplicated — its entry wins untouched.
 * A title/doc-only session becomes a zero-turn entry: title = its rename override, else
 * UNTITLED_SESSION_TITLE (a title-only chat always HAS an override; a doc-only chat may
 * not). last_at is epoch-0 for these (no real turn time) so dated chats sort above them
 * while their relative order stays stable. PURE so the merge contract is unit-tested
 * without a DB. NOTE: the caller must exclude the reserved VIRTUAL session UUIDs from
 * `docSessionIds`/`titledIds` so the demo "Sample data"/"Imported" entries aren't doubled.
 */
// De-dup KEY for a session_id. The same logical session is stored in columns of
// DIFFERENT types — ask_history/doc_chunks/uploaded_rows.session_id are UUID, but
// session_titles.session_id is TEXT — so the literal strings CAN differ (case /
// surrounding whitespace) even when they denote the same chat. We compare on a
// normalized key (trimmed + lowercased) so a session that has BOTH a title and docs
// de-dupes to ONE entry, never two. GENERAL: a pure shape normalization, no value/term.
// We still surface the ORIGINAL id string as the entry's session_id (the UI opens the
// chat by it); only the de-dup comparison is normalized.
function sessionKey(id: string): string {
  return id.trim().toLowerCase();
}

export function mergeSessionSources(
  askSessions: SessionSummary[],
  titledIds: Iterable<string>,
  docSessionIds: Iterable<string>,
  titleOf?: Map<string, string>,
  updatedAtOf?: Map<string, string>
): SessionSummary[] {
  const have = new Set(askSessions.map((s) => sessionKey(s.session_id)));
  const merged = [...askSessions];
  // Union of the non-ask sources, de-duplicated by normalized key, insertion-order kept.
  const extraIds = new Map<string, string>(); // normalized key → first original id seen
  for (const id of titledIds) if (id && !extraIds.has(sessionKey(id))) extraIds.set(sessionKey(id), id);
  for (const id of docSessionIds) if (id && !extraIds.has(sessionKey(id))) extraIds.set(sessionKey(id), id);
  for (const id of extraIds.values()) {
    const key = sessionKey(id);
    if (have.has(key)) continue; // already represented by its ask_history entry
    have.add(key);
    // A title-only chat has no ask turn, so it has no real turn time — but it DOES have a
    // rename time (session_titles.updated_at). Use that as last_at so a renamed chat sorts
    // by recency (newest-renamed on top), like a real conversation. A doc-only chat has
    // neither, so it falls back to epoch-0 (sorts below dated/renamed chats, stable order).
    const renamedAt = updatedAtOf?.get(id);
    merged.push({
      session_id: id,
      // A title-only chat resolves to its override; a doc-only chat falls back to the
      // neutral default. resolveSessionTitle ignores a blank/whitespace override.
      title: resolveSessionTitle(UNTITLED_SESSION_TITLE, titleOf?.get(id)),
      turn_count: 0,
      last_at: renamedAt ?? new Date(0).toISOString(),
    });
  }
  // Newest session first by its most recent activity (a real turn, or a rename for a
  // title-only chat); doc-only (epoch-0) chats fall to the bottom in a stable order.
  // Matches groupSessions' ordering exactly.
  merged.sort((a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime());
  return merged;
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
