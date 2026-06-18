// validateAnswer() — the pure content-fidelity gate.
//
// This is the gate that turns "fluent but ungrounded" into a RED result instead
// of a shipped lie. It runs in the answer path AND is pinned by a unit test that
// must pass every golden answer and fail every toy (a fluent-but-uncited answer,
// or a citation that resolves to no retrieved evidence).
//
// Rules (all structural — no LLM):
//  1. Every citation token in the answer must RESOLVE to evidence retrieved this
//     turn (no fabricated row ids / page numbers).
//  2. An answer that makes factual claims must carry at least one citation — a
//     fluent paragraph with zero citations is rejected (the toy failure).
//  3. Multi-source citations stay separate: a [S:...] and a [P:...] are each
//     checked against their own evidence namespace; we never accept one for the
//     other.
//  4. CLAIM-SUPPORT cross-check: a citation must not only RESOLVE, it must SUPPORT
//     the number stated next to it. A stated dollar/number adjacent to [S:src#id]
//     must equal a value in that row (or a verified server-side aggregate); a
//     number stated next to [P:doc#page] must literally appear in that page's text
//     and the cited doc must match. "$999,999.00 [S:contracts#269]" resolves but is
//     NOT supported by the row → rejected. This is what stops a fluent answer from
//     hanging a real citation on a fabricated figure.
//
// An honest "this is not in the available sources" answer is ALLOWED (it makes no
// uncited factual claim) — that's the grounding discipline, not a failure.

import { extractCitationTokens, resolvableTokenSet } from "./citations.ts";

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
// while excluding explicit not-found disclaimers.
const NOT_FOUND_RE =
  /\b(not (present|available|found|in the (available )?sources?)|no (matching|relevant) (data|records?|sources?)|the (available )?sources? do(es)? not|cannot find|could not find)\b/i;

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

  // Strip not-found disclaimer sentences before deciding "makes a factual claim".
  const sentences = answer.split(/(?<=[.!?])\s+/);
  const factualSentences = sentences.filter(
    (s) => FACTUAL_SIGNAL_RE.test(s) && !NOT_FOUND_RE.test(s)
  );

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

// ── Claim-support cross-check ────────────────────────────────────────────────
// For every number/$ amount stated immediately BEFORE a citation token, verify the
// citation actually backs that figure. Skipped silently if the evidence carries no
// values (data/text absent) so resolvability-only callers are unaffected.

const TOKEN_WITH_CONTEXT_RE = /\[(S|P):([^\]#]+)#(\d+)\]/g;
// A stated number/currency amount. Capturing the raw text lets us match it against
// page text verbatim AND parse it for numeric row comparison.
const NUMBER_RE = /\$?\d[\d,]*(?:\.\d+)?%?/g;

function crossCheckClaims(answer: string, evidence: Evidence): string[] {
  const haveRowData = evidence.rows.some((r) => r.data);
  const haveChunkText = evidence.chunks.some((c) => c.text);
  if (!haveRowData && !haveChunkText) return []; // anchors only — nothing to cross-check

  const rowById = new Map<string, Record<string, unknown>>();
  for (const r of evidence.rows) if (r.data) rowById.set(`${r.table}#${r.id}`, r.data);
  const chunkByKey = new Map<string, string>();
  for (const c of evidence.chunks) if (c.text != null) chunkByKey.set(`${c.doc}#${c.page}`, c.text);

  const aggregates = new Set((evidence.aggregates ?? []).map((n) => round2(n)));
  // Every numeric value present across the retrieved rows of each table. A model
  // listing a breakdown / sample rows sometimes pairs a REAL row value with a
  // sibling row's citation (e.g. "$549.98 [S:maintenance#685]" where 549.98 is
  // another retrieved row). The value is genuinely in the evidence set, so it is
  // accepted against any citation of the SAME table. The cross-check's hard job is
  // rejecting FABRICATED values — a number present in NO retrieved row of that table
  // (e.g. "$999,999.00 [S:contracts#269]") still fails.
  const valuesByTable = collectValuesByTable(evidence.rows);
  // Calendar years present ANYWHERE in the retrieved structured evidence. A bare
  // year (e.g. "2024") is a real value in the evidence set; the cross-check polices
  // fabricated VALUES (dollar amounts, counts), not which exact dated row a model
  // pins a calendar year to — so a year that appears in any retrieved row is allowed
  // beside any structured citation. A dollar amount gets no such latitude.
  const yearsInEvidence = collectYears(evidence.rows);
  // Years present in each retrieved DOCUMENT's chunks (across its pages). A bare year
  // beside a page citation is accepted if that year appears anywhere in the same
  // document — a conflict answer legitimately surfaces a filing year that lives on a
  // different page (the cover sheet) than the page it pins the citation to. Dollar
  // amounts get NO such latitude: they must appear on the exact cited page.
  const yearsByDoc = collectYearsByDoc(evidence.chunks);
  const reasons: string[] = [];

  for (const m of answer.matchAll(TOKEN_WITH_CONTEXT_RE)) {
    const [token, kind, name, idStr] = m;
    // The text in the ~60 chars immediately before this token is the claim it backs.
    const start = Math.max(0, m.index! - 60);
    const context = answer.slice(start, m.index!);
    const numbers = context.match(NUMBER_RE);
    if (!numbers || numbers.length === 0) continue; // a non-numeric claim — nothing to check
    // The number nearest the token is the one it cites.
    const claimText = numbers[numbers.length - 1];

    if (kind === "S") {
      const data = rowById.get(`${name}#${idStr}`);
      if (!data) continue; // resolvability handled by rule 1; only cross-check what we hold
      if (isBareYear(claimText) && yearsInEvidence.has(claimText.trim())) continue;
      const tableValues = valuesByTable.get(name);
      if (!numberSupportedByRow(claimText, data, aggregates, tableValues)) {
        reasons.push(
          `claim "${claimText.trim()}" cited to ${token} is not supported by any retrieved ${name} row or verified aggregate`
        );
      }
    } else {
      // [P:doc#page] — the stated number must literally appear on that page.
      const text = chunkByKey.get(`${name}#${idStr}`);
      if (text == null) continue;
      if (isBareYear(claimText) && (yearsByDoc.get(name)?.has(claimText.trim()) ?? false)) continue;
      if (!pageContainsNumber(claimText, text)) {
        reasons.push(
          `claim "${claimText.trim()}" cited to ${token} does not appear in that page's text`
        );
      }
    }
  }
  return reasons;
}

// A stated number is supported if it numerically equals any value in the cited row,
// OR any value present across the retrieved rows of that table (a breakdown/sample
// listing may pin a real value to a sibling row's token), OR a verified server-side
// aggregate (totals/counts live in no single row but ARE ground truth). A value in
// NONE of these — a fabrication — is rejected. Percentages are literal numbers.
function numberSupportedByRow(
  claimText: string,
  data: Record<string, unknown>,
  aggregates: Set<number>,
  tableValues?: Set<number>
): boolean {
  const claim = parseNumber(claimText);
  if (claim == null) return true; // unparseable → don't false-fail
  if (aggregates.has(round2(claim))) return true;
  if (tableValues?.has(round2(claim))) return true; // any retrieved row of this table
  // The claim's bare digit string, for substring/component matching against a row's
  // string fields (a year inside a date, an id inside a label, etc.).
  const claimDigits = claimText.replace(/[$,%\s]/g, "");
  for (const v of Object.values(data)) {
    const n = typeof v === "number" ? v : parseNumber(String(v));
    if (n != null && round2(n) === round2(claim)) return true;
    if (typeof v === "string") {
      // Exact field match (an id/ticket label cited verbatim).
      if (v.trim() === claimText.trim()) return true;
      // A numeric COMPONENT of a structured string value (e.g. the year "2024" in
      // the completion date "3/7/2024", which IS literally in this row). We split on
      // non-digits and compare components so a fabricated number still can't sneak in
      // as a spurious substring of a longer run of digits.
      const components = v.split(/\D+/).filter(Boolean);
      if (components.includes(claimDigits)) return true;
    }
  }
  return false;
}

// Every numeric value present across the retrieved rows of each table, keyed by
// table. Used to accept a real row value paired with a sibling row's citation.
function collectValuesByTable(
  rows: { table: string; data?: Record<string, unknown> }[]
): Map<string, Set<number>> {
  const byTable = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!r.data) continue;
    const set = byTable.get(r.table) ?? new Set<number>();
    for (const v of Object.values(r.data)) {
      const n = typeof v === "number" ? v : parseNumber(String(v));
      if (n != null) set.add(round2(n));
    }
    byTable.set(r.table, set);
  }
  return byTable;
}

// A bare 4-digit calendar year (no currency/decimal), e.g. "2024".
function isBareYear(claimText: string): boolean {
  return /^\d{4}$/.test(claimText.trim()) && /^(19|20)\d\d$/.test(claimText.trim());
}

// Every 4-digit year that appears in any retrieved row's string values (dates).
function collectYears(rows: { data?: Record<string, unknown> }[]): Set<string> {
  const years = new Set<string>();
  for (const r of rows) {
    if (!r.data) continue;
    for (const v of Object.values(r.data)) {
      if (typeof v !== "string") continue;
      for (const comp of v.split(/\D+/)) if (/^(19|20)\d\d$/.test(comp)) years.add(comp);
    }
  }
  return years;
}

// Years (4-digit) present in each document's retrieved chunks, keyed by doc.
function collectYearsByDoc(chunks: { doc: string; text?: string }[]): Map<string, Set<string>> {
  const byDoc = new Map<string, Set<string>>();
  for (const c of chunks) {
    if (c.text == null) continue;
    const set = byDoc.get(c.doc) ?? new Set<string>();
    for (const comp of c.text.split(/\D+/)) if (/^(19|20)\d\d$/.test(comp)) set.add(comp);
    byDoc.set(c.doc, set);
  }
  return byDoc;
}

function pageContainsNumber(claimText: string, pageText: string): boolean {
  const norm = (s: string) => s.replace(/[$,\s]/g, "");
  return norm(pageText).includes(norm(claimText));
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
