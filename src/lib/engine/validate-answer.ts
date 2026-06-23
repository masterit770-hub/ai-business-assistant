// validateAnswer() — the pure content-fidelity gate.
//
// This is the gate that turns "fluent but ungrounded" into a RED result instead
// of a shipped lie. It runs in the answer path AND is pinned by a unit test that
// must pass every golden answer and fail every toy (a fluent-but-uncited answer,
// or a citation that resolves to no retrieved evidence).
//
// ── INTENTIONALLY RELAXED (the reliability fix) ─────────────────────────────────
// The previous gate was TOO STRICT: it hard-failed (and forced flaky retries) over a
// citation's PLACEMENT or DERIVATION — a right value pinned to a slightly-off page, or
// a number the model computed (a sum, an income gap, a percentage) sitting beside a
// token. That over-strictness — NOT the model — was the bug: a single misplaced/derived
// citation rejected the WHOLE grounded answer and the pipeline punted to generic
// boilerplate (the bluefalcon 6/10, overdue-payments 2/10 intermittency). So the gate
// now HARD-FAILS ONLY genuine FABRICATION and is otherwise placement-agnostic.
//
// Rules (all structural — no LLM):
//  1. Every citation token in the answer must RESOLVE to evidence retrieved this
//     turn (no fabricated row ids / page numbers).
//  2. An answer that makes factual claims must carry at least one citation — a
//     fluent paragraph with zero citations is rejected (the toy failure).
//  3. Multi-source citations stay separate: a [S:...] and a [P:...] are each
//     checked against their own evidence namespace; we never accept one for the
//     other.
//  4. CLAIM-SUPPORT cross-check — PLACEMENT-AGNOSTIC, fabrication-only. A cited
//     factual number is SUPPORTED when that exact value appears ANYWHERE in the
//     retrieved evidence this turn — any chunk's text or any row of the cited kind —
//     NOT necessarily on the exact cited page/row. We DO NOT fail on placement (a
//     right value cited to a sibling page/doc) or on DERIVATION (a number the model
//     computed that is in no evidence chunk — that is reasoning, written beside a real
//     citation; it is not a claimed document fact and is left alone).
//     The answer fails the cross-check ONLY when it is genuinely UNGROUNDED: it makes
//     document-fact claims (states figures beside citations) yet NOT ONE of those cited
//     figures appears anywhere in the retrieved evidence. "$999,999.00 [S:contracts#269]"
//     as the sole figure — present in no retrieved row — is fabrication and fails;
//     "$1,285 [P:carter-story#7]" when $1,285 IS in the retrieved family-court page (just
//     cited to the wrong page) is a placement slip and PASSES.
//
// An honest "this is not in the available sources" answer is ALLOWED (it makes no
// uncited factual claim) — that's the grounding discipline, not a failure.

import { extractCitationTokens, resolvableTokenSet } from "./citations.ts";

// Matches a citation token anywhere inside a string (e.g. inside a validation
// reason message, which names the offending token verbatim). Same shape as the
// citations module's token, used here to recover the bad tokens a reason names.
const ANY_TOKEN_RE = /\[(?:S|P):[^\]#]+#\d+\]/g;

// Evidence carries the citation anchors AND (when available) the underlying values
// so the claim-support cross-check can run. `data`/`text` are optional: when a
// caller passes only anchors (e.g. a resolvability-only unit fixture) the
// cross-check is skipped and rules 1–3 still apply. `aggregates` are verified
// server-computed figures (counts, totals) that a row-cited summary line may state
// even though no single row holds that value.
export type Evidence = {
  rows: { table: string; id: number; data?: Record<string, unknown> }[];
  chunks: { doc: string; page: number; text?: string }[];
  aggregates?: number[];
};

export type ValidationResult = {
  ok: boolean;
  reasons: string[];
  unresolved: string[]; // citation tokens with no backing evidence
};

// A claim is a sentence asserting a fact. We approximate "makes a factual claim"
// as: contains a digit, a currency amount, or a quantified/asserting keyword —
// while excluding explicit not-found / schema-absence disclaimers.
//
// A SCHEMA-ABSENCE disclaimer ("the data does not include/contain/have any column /
// field for X", "none of which indicate …", "is not available in the evidence") is an
// honest non-answer, NOT an uncited factual claim — it must not be forced to carry a
// citation just because it names a column keyword (invoice/total/overdue/…). This is
// general (it polices ANY honest refusal), not tied to a dataset.
const NOT_FOUND_RE = new RegExp(
  [
    "\\b(not (present|available|found|in the (available )?sources?))",
    "no (matching|relevant) (data|records?|sources?)",
    "the (available )?sources? do(es)? not",
    "cannot find|could not find",
    // "does not / do not / doesn't / don't / has no / there is no … (include|contain|
    //  have|indicate|show) … (field|column|information|status|data)"
    "(does not|do not|doesn'?t|don'?t|did not|didn'?t|has no|have no|there (is|are) no|lacks?|without)[^.]*?(include|contain|have|indicate|show|provide|field|column|information|status)",
    // "none of (these|which|the) … (indicate|show|contain|include|field)"
    "none of (these|which|the|them)[^.]*?(indicate|show|contain|include|provide|field|column|payment|status)",
    // "is/are not available in the (evidence|data|documents|records)"
    "(is|are) not available in (the )?(evidence|data|documents?|records?)",
  ].join("|"),
  "i"
);

const FACTUAL_SIGNAL_RE =
  /(\$[\d,]+|\b\d+\b|\bexpire|\boverdue|\bcustody|\bsalary|\bcontract|\binvoice|\bpenalt|\bjudg|\bawarded|\btotal\b)/i;

export function validateAnswer(answer: string, evidence: Evidence): ValidationResult {
  const reasons: string[] = [];
  const resolvable = resolvableTokenSet(evidence);
  const tokens = extractCitationTokens(answer);
  const unresolved = tokens.filter((t) => !resolvable.has(t));

  // Rule 1 — every citation resolves
  if (unresolved.length > 0) {
    reasons.push(
      `answer cites evidence that was not retrieved this turn: ${unresolved.join(", ")}`
    );
  }

  // Strip not-found / schema-absence disclaimer sentences before deciding "makes a
  // factual claim". A disclaimer is exempt ONLY when it carries NO concrete figure (a
  // `$` amount or a 2+ digit number) — a sentence stating a real figure is always a
  // factual claim that must be cited, even if it also hedges. This keeps the broadened
  // disclaimer recognizer from letting a fabricated "owes $5,000" sentence through.
  const FIGURE_RE = /\$[\d,]+|\b\d{2,}\b/;
  const sentences = answer.split(/(?<=[.!?])\s+/);
  const factualSentences = sentences.filter((s) => {
    if (!FACTUAL_SIGNAL_RE.test(s)) return false;
    const isDisclaimer = NOT_FOUND_RE.test(s) && !FIGURE_RE.test(s);
    return !isDisclaimer;
  });

  // Rule 2 — a factual answer must carry at least one citation
  if (factualSentences.length > 0 && tokens.length === 0) {
    reasons.push(
      "answer makes factual claims but carries no citations (ungrounded — the toy failure)"
    );
  }

  // Rule 4 — claim-support cross-check (only runs when evidence carries values).
  reasons.push(...crossCheckClaims(answer, evidence));

  return { ok: reasons.length === 0, reasons, unresolved };
}

// ── SALVAGE: strip ONLY the flagged-bad citation tokens ──────────────────────────
// Now that the claim-support cross-check is relaxed to fail ONLY genuine fabrication
// (placement/derivation no longer reject an answer), the salvage's job is much smaller:
// it strips a genuinely-UNRESOLVABLE citation token (rule 1 — a token pointing at evidence
// that was not retrieved this turn) so the figure beside it becomes uncited prose, rather
// than discarding a real grounded answer over one bad token. (It also picks up any token a
// reason names verbatim, but the relaxed cross-check no longer names tokens, so in practice
// this is the rule-1 unresolved set.) GENERAL — keyed ONLY off validation state (the
// `unresolved` set + any token a reason names), never the question/domain/any fact. The
// caller adopts the cleaned text ONLY IF it is then fully clean AND still cites ≥1 real
// evidence token, so a salvaged answer is still genuinely grounded.
//
// Returns the cleaned answer text and the exact set of tokens removed (for telemetry/tests).
// Pure + exported so the strip contract is unit-tested without an LLM.
export function flaggedBadTokens(validation: ValidationResult): Set<string> {
  const bad = new Set<string>(validation.unresolved);
  // Each claim-support reason embeds the offending token verbatim
  // ("claim \"$X\" cited to [P:doc#page] does not appear …" / "… is not supported …").
  for (const reason of validation.reasons) {
    for (const m of reason.matchAll(ANY_TOKEN_RE)) bad.add(m[0]);
  }
  return bad;
}

export function stripFlaggedCitations(
  answer: string,
  validation: ValidationResult
): { text: string; removed: string[] } {
  const bad = flaggedBadTokens(validation);
  if (bad.size === 0) return { text: answer, removed: [] };
  const removed: string[] = [];
  // Remove each flagged token (and a single adjacent space/leading space it leaves)
  // so the figure beside it becomes clean uncited prose, never a dangling "  ." gap.
  let text = answer;
  for (const token of bad) {
    // Escape the token for use in a regex (the brackets/# are regex-meaningful).
    const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Eat an optional single space immediately before the token so "$X [P:..]" → "$X".
    const re = new RegExp(`\\s?${esc}`, "g");
    if (re.test(text)) {
      removed.push(token);
      text = text.replace(re, "");
    }
  }
  // Collapse any double spaces the removal introduced (cosmetic; keeps prose clean).
  text = text.replace(/[ \t]{2,}/g, " ").replace(/ +([.,;:])/g, "$1");
  return { text, removed };
}

// The full salvage decision, run by the rescue loops. Given a forced grounded answer
// and the evidence, attempt to rescue it by stripping ONLY the flagged-bad citations.
// Returns the cleaned answer iff it is then fidelity-clean AND still cites ≥1 real
// evidence token; otherwise null (the answer genuinely can't be salvaged → the caller
// falls through to its honest path). GENERAL — keyed only off validation state.
//
// Pure + exported so the adopt/reject decision is unit-tested deterministically.
export function salvageGroundedAnswer(
  answer: string,
  evidence: Evidence
): { text: string; removed: string[] } | null {
  const first = validateAnswer(answer, evidence);
  if (first.ok) {
    // Already clean — nothing to salvage; let the caller's own clean-check adopt it.
    return extractCitationTokens(answer).length > 0 ? { text: answer, removed: [] } : null;
  }
  const { text: cleaned, removed } = stripFlaggedCitations(answer, first);
  if (removed.length === 0) return null; // no flagged tokens to strip → not salvageable here
  const second = validateAnswer(cleaned, evidence);
  // Adopt ONLY if the cleaned answer is now fully clean AND still carries ≥1 real
  // (resolvable) citation — i.e. it is still a genuinely grounded answer, not stripped
  // bare. extractCitationTokens on the cleaned text are all valid because validateAnswer
  // just passed (every remaining token resolves and is supported).
  if (second.ok && extractCitationTokens(cleaned).length > 0) {
    return { text: cleaned, removed };
  }
  return null;
}

// ── Claim-support cross-check — PLACEMENT-AGNOSTIC, fabrication-only ─────────────
// For every number/$ amount stated immediately BEFORE a citation token, decide whether
// that figure is BACKED BY THE EVIDENCE AT ALL (anywhere this turn) — not whether it
// sits on the exact cited page/row. Skipped silently when the evidence carries no
// values (data/text absent) so resolvability-only callers are unaffected.
//
// THE RELAXED CONTRACT (the reliability fix):
//   • PLACEMENT-AGNOSTIC: a cited factual figure is supported if it appears ANYWHERE in
//     the retrieved evidence — any chunk's text, any row of the cited kind. A right value
//     pinned to a slightly-off page/doc (placement) is NOT a fabrication and does not fail.
//   • DERIVATION-TOLERANT: a number that appears in NO evidence chunk/row is treated as
//     REASONING the model wrote beside a citation (a sum, a gap, a percentage) — it is not
//     a claimed document FACT, so it does NOT fail the answer on its own.
//   • FABRICATION-ONLY FAILURE: the cross-check fails the answer ONLY when it is genuinely
//     UNGROUNDED — it states figures beside citations yet NOT ONE of those cited figures is
//     found anywhere in the evidence. (A purely-derived answer that also restates ≥1 real
//     evidence figure is grounded; one that restates a real figure on the WRONG page is
//     grounded.) The one remaining RED is "every cited figure is absent from all evidence"
//     — the $999,999 / $5,000-fabrication case.

const TOKEN_WITH_CONTEXT_RE = /\[(S|P):([^\]#]+)#(\d+)\]/g;
// A stated number/currency amount. Capturing the raw text lets us match it against
// page text verbatim AND parse it for numeric row comparison.
const NUMBER_RE = /\$?\d[\d,]*(?:\.\d+)?%?/g;

function crossCheckClaims(answer: string, evidence: Evidence): string[] {
  const haveRowData = evidence.rows.some((r) => r.data);
  const haveChunkText = evidence.chunks.some((c) => c.text);
  if (!haveRowData && !haveChunkText) return []; // anchors only — nothing to cross-check

  // PLACEMENT-AGNOSTIC support sets, built ONCE from ALL retrieved evidence this turn:
  //   • numericValues  — every numeric value present across every row AND every chunk's
  //     text (component-split so a year inside a date counts), plus verified aggregates.
  //   • pageTextBlob   — all chunk text concatenated + normalized, so a verbatim figure
  //     ("$494,513,028.33", "52,800") is found regardless of which page it was cited to.
  // A cited figure is "in the evidence" if it matches either set. Placement no longer
  // matters; only presence-anywhere does.
  const numericValues = collectAllNumericValues(evidence);
  const aggregates = new Set((evidence.aggregates ?? []).map((n) => round2(n)));
  const pageTextBlob = evidence.chunks
    .map((c) => c.text ?? "")
    .join(" ")
    .replace(/[$,\s]/g, "");
  const rowTextBlob = evidence.rows
    .map((r) => (r.data ? Object.values(r.data).map((v) => String(v)).join(" ") : ""))
    .join(" ")
    .replace(/[$,\s]/g, "");

  // A cited figure is supported (present anywhere in evidence) — placement-agnostic.
  const figureInEvidence = (claimText: string): boolean => {
    const claim = parseNumber(claimText);
    if (claim != null) {
      if (aggregates.has(round2(claim))) return true;
      if (numericValues.has(round2(claim))) return true;
    }
    // Verbatim substring match against the normalized chunk/row text (catches exact
    // figures the numeric parse might miss, and component matches like a year in a date).
    const norm = claimText.replace(/[$,\s]/g, "");
    if (norm.length >= 2 && (pageTextBlob.includes(norm) || rowTextBlob.includes(norm))) return true;
    return false;
  };

  // We collect EVERY figure stated beside a citation token across the WHOLE answer and ask
  // a single, answer-level question: did ANY of them resolve to a real evidence value? An
  // answer is grounded if at least one cited figure is real — so a DERIVED number (a sum,
  // a per-year extrapolation) sitting beside the same citation as a real figure never sinks
  // the answer, and a real figure on the WRONG page is still real. Only an answer whose
  // EVERY cited figure is absent from all evidence is fabrication. (We grade per-figure
  // across the answer, not per-token-nearest, precisely so a derived figure adjacent to a
  // token doesn't independently fail an otherwise-grounded answer.)
  const WINDOW_AFTER_RE = /^\s*(days?|weeks?|months?|years?|quarters?|hours?|minutes?)\b/i;
  let citedFactualFigures = 0; // cited figures the answer presents as facts
  let supportedFigures = 0; // those that resolve to a real evidence value (anywhere)

  for (const m of answer.matchAll(TOKEN_WITH_CONTEXT_RE)) {
    // The ~60 chars immediately before this token are the claim(s) it backs.
    const start = Math.max(0, m.index! - 60);
    const context = answer.slice(start, m.index!);
    const numbers = context.match(NUMBER_RE);
    if (!numbers || numbers.length === 0) continue; // a non-numeric claim — nothing to check
    for (const n of numbers) {
      // INCIDENTAL QUERY-PARAMETER GUARD (general, no figure/table named): a bare integer
      // immediately followed by a time-unit/window word ("next 90 DAYS", "3 MONTHS") is the
      // QUERY WINDOW, not a cited data figure — skip it. (A $ amount is never followed by
      // such a word, so a fabricated dollar amount is unaffected.)
      const after = context.slice(context.indexOf(n) + n.length);
      if (/^\d{1,4}$/.test(n.trim()) && WINDOW_AFTER_RE.test(after)) continue;
      // A bare calendar year is real document evidence wherever it appears — never a
      // fabrication candidate; don't count it as a factual figure to support.
      if (isBareYear(n)) continue;
      citedFactualFigures++;
      if (figureInEvidence(n)) supportedFigures++;
    }
  }

  // FABRICATION-ONLY FAILURE: the answer states cited figures yet NOT ONE of them appears
  // anywhere in the retrieved evidence → genuinely ungrounded/fabricated. A single real
  // figure (even one cited to the wrong page, or sitting beside a derived number) makes it
  // grounded — placement & derivation never fail it.
  if (citedFactualFigures > 0 && supportedFigures === 0) {
    return [
      `answer states cited figure(s) that appear nowhere in the retrieved evidence — ungrounded/fabricated`,
    ];
  }
  return [];
}

// Every numeric value present across ALL retrieved evidence this turn — every row's
// values AND every chunk's text (component-split, so a year inside a date or a figure
// embedded in prose counts). Placement-agnostic by construction. Used to accept a cited
// figure that appears ANYWHERE in the evidence regardless of the exact page/row cited.
function collectAllNumericValues(evidence: Evidence): Set<number> {
  const set = new Set<number>();
  const addFromString = (s: string) => {
    for (const m of s.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
      const n = parseNumber(m[0]);
      if (n != null) set.add(round2(n));
    }
  };
  for (const r of evidence.rows) {
    if (!r.data) continue;
    for (const v of Object.values(r.data)) {
      const n = typeof v === "number" ? v : parseNumber(String(v));
      if (n != null) set.add(round2(n));
      if (typeof v === "string") addFromString(v);
    }
  }
  for (const c of evidence.chunks) if (c.text) addFromString(c.text);
  return set;
}

// A bare 4-digit calendar year (no currency/decimal), e.g. "2024".
function isBareYear(claimText: string): boolean {
  return /^\d{4}$/.test(claimText.trim()) && /^(19|20)\d\d$/.test(claimText.trim());
}

function parseNumber(s: string): number | null {
  const cleaned = s.replace(/[$,%\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
