// Pure helpers for the answer-rendering + chat-console UI. Kept side-effect-free and
// dependency-free so they can be unit-tested directly (node --test) without React or
// the DOM. Two concerns live here:
//   1. resolveCitation() — map a citation chip's text ([P:doc#page] / [S:table#id]) to
//      the matching retrieved evidence item, so the chip can REVEAL its source.
//   2. classifyAskError() — turn a raw provider/gateway failure string into a friendly,
//      actionable line for the chat thread. Mirrors the server-side mapping so the
//      client shows something calm even when it only has a bare message.

import type { EngineResult } from "./types";

type Chunk = EngineResult["evidence"]["chunks"][number];
type Row = EngineResult["evidence"]["rows"][number];

// What a resolved citation chip carries to the UI. `kind` picks the renderer:
//   - "passage" → show the chunk text + doc/page
//   - "row"     → show the row's field/value pairs
//   - null      → no matching evidence; the chip stays plain (no popover, no crash)
export type ResolvedCitation =
  | { kind: "passage"; token: string; doc: string; page: number; text: string }
  | { kind: "row"; token: string; table: string; id: number; data: Record<string, unknown> }
  | null;

// Resolve ONE chip token against the turn's evidence. The chip text is the SAME token
// string the engine stamped onto each evidence item (sqlToken/pdfToken), so this is an
// exact-token lookup — no parsing of doc names that may contain '#'/':'. A token with no
// matching item returns null (the chip renders inert).
export function resolveCitation(
  token: string,
  evidence: { rows: Row[]; chunks: Chunk[] }
): ResolvedCitation {
  const t = token.trim();
  if (t.startsWith("[P:")) {
    const c = evidence.chunks.find((x) => x.token === t);
    if (!c) return null;
    return { kind: "passage", token: t, doc: c.doc, page: c.page, text: c.text ?? "" };
  }
  if (t.startsWith("[S:")) {
    const r = evidence.rows.find((x) => x.token === t);
    if (!r) return null;
    return { kind: "row", token: t, table: r.table, id: r.id, data: r.data ?? {} };
  }
  return null;
}

// Build a plain-text source list for the Copy action — one line per retrieved evidence
// item, mirroring the eN numbering the Sources block shows on screen. Empty when there
// is no evidence (a general answer), so Copy just yields the answer text.
export function sourceLines(evidence: { rows: Row[]; chunks: Chunk[] }): string[] {
  const lines: string[] = [];
  evidence.rows.forEach((r, i) => {
    lines.push(`e${i + 1}  ${r.token}  ${r.table}#${r.id}`);
  });
  evidence.chunks.forEach((c, i) => {
    lines.push(`e${evidence.rows.length + i + 1}  ${c.token}  ${c.doc} p.${c.page}`);
  });
  return lines;
}

// Assemble the full clipboard payload for an answer: the answer text, then (when there
// is retrieved evidence) a "Sources" block. Used by the Copy button.
export function buildCopyText(result: EngineResult): string {
  const parts = [result.answer.trim()];
  const lines = sourceLines(result.evidence);
  if (lines.length > 0) {
    parts.push("", "Sources:", ...lines);
  }
  return parts.join("\n");
}

// Format the per-answer cost line shown under each answer (#6). Plain, compact, honest:
// real token count + USD when the engine priced it, "cost n/a" when it couldn't (no live
// call, or a provider that didn't report usage / isn't priced). Never fabricates a number.
export function formatCostLine(result: EngineResult): string {
  const cost = result.inspector?.cost;
  if (!cost) return "· cost n/a";
  const total =
    (cost.promptTokens ?? 0) + (cost.completionTokens ?? 0);
  const haveTokens = cost.promptTokens !== undefined;
  const tokenPart = haveTokens ? `${total.toLocaleString("en-US")} tokens` : "tokens n/a";
  const usdPart = cost.usd !== null ? `$${cost.usd.toFixed(3)}` : null;
  if (!haveTokens && usdPart === null) return "· cost n/a";
  return usdPart ? `· ${tokenPart} · ${usdPart}` : `· ${tokenPart}`;
}

// ── Friendly error classification (client mirror of the route's mapping) ────────────
// The chat console catches a thrown message and shows it as a calm error card. When the
// server already mapped the failure (route.ts below), the message is friendly and passes
// through. As a defence-in-depth, we ALSO classify here so a raw blob that slips through
// (e.g. an upstream gateway HTML page reduced to a status line) still reads cleanly.

const RATE_LIMIT_RE = /\b(429|rate.?limit|exhausted|quota|resource[_ ]?exhausted|too many requests|overloaded|credit balance|usage limit|monthly|billing)/i;
const AUTH_RE = /\b(401|403|invalid.?api.?key|invalid key|unauthorized|permission denied|api key not valid)\b/i;
const TIMEOUT_RE = /\b(timed? ?out|timeout|etimedout|deadline)\b/i;

export function classifyAskError(raw: unknown): string {
  const msg = (raw instanceof Error ? raw.message : String(raw ?? "")).trim();
  if (!msg) return "Something went wrong generating the answer — try again.";
  // An already-friendly, full-sentence message from the server passes through unchanged
  // (it has no status code / provider blob markers). We only re-map raw-looking blobs.
  if (RATE_LIMIT_RE.test(msg)) {
    return "The Claude API key has reached its usage limit — please try again later.";
  }
  if (AUTH_RE.test(msg)) {
    return "The cloud model key looks invalid — check it in Settings → Model.";
  }
  if (TIMEOUT_RE.test(msg)) {
    return "That took too long — try again.";
  }
  // The specific JSON-parse symptom of the res.json()-before-res.ok bug.
  if (/unexpected token|not valid json|json\.parse|<!doctype|<html/i.test(msg)) {
    return "Something went wrong generating the answer — try again.";
  }
  // A clean, human sentence (server already mapped it) — keep it.
  if (/[a-z].*[.!?]\s*$/i.test(msg) && msg.length < 200 && !/\d{3}:/.test(msg)) {
    return msg;
  }
  return "Something went wrong generating the answer — try again.";
}
