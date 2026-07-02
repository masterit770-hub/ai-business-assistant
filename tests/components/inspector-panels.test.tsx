// StatusTiles — the inspector's six-tile summary row
// (src/components/assistant/inspector-panels.tsx). This pins the ANSWER tile's state
// machine, which the user reads as the headline verdict on a turn.
//
// THE BAR: the ANSWER tile must reflect whether the answer is actually GROUNDED in the
// user's evidence — derived from citations + validation, NOT solely the raw evidence
// COUNTER. The bug this guards: a cell-tally count answer (e.g. "who is scheduled the
// most") has an internal evidenceCount of 0 — the tally is computed by code over the
// grid, so no per-row evidence is attached — yet it IS grounded: it carries [S:…]/[P:…]
// citation tokens and validateAnswer passed. The old code read `isGeneral && evidence===0`
// as "insufficient", mislabeling a real grounded answer as having no evidence.
//
// The cases pin both directions so the fix can't over-correct:
//   • cited (tokens present) + validation.ok + evidenceCount 0 → "grounded" (the bug)
//   • a genuinely general answer (NO citation tokens, evidenceCount 0) → "insufficient"
//   • a normal grounded answer with real rows → still "grounded" (no regression)
//   • a rejected (validation failed) grounded answer → still "rejected"

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { StatusTiles, MetricsPanels } from "@/components/assistant/inspector-panels";
import type { EngineResult } from "@/components/assistant/types";

// A minimal valid EngineResult; override the slice each case needs. We build the
// inspector explicitly so evidenceCount is controllable independently of rows/chunks —
// the whole point of the cell-tally case (count computed by code, no per-row evidence).
function result(over: Partial<EngineResult> = {}): EngineResult {
  const base: EngineResult = {
    question: "q?",
    route: { sources: ["structured"], docFilter: null, rationale: "" },
    answer: "a",
    mode: "grounded",
    grounded: true,
    evidence: { rows: [], chunks: [] },
    validation: { ok: true, reasons: [] },
    inspector: {
      retrievalMethod: "text-to-SQL",
      passages: 0,
      evidenceCount: 0,
      confidence: { value: 0.9, basis: "" },
      steps: [],
      timings: { routingMs: 1, retrievalMs: 1, generationMs: 1, totalMs: 3 },
      cost: { liveCalls: 1, usd: null, pricingNote: "", provider: "p", model: "m" },
    },
  };
  return { ...base, ...over } as EngineResult;
}

// Read the ANSWER tile's value (the word under the "Answer" label). The tile lays out
// label-then-value, so we find the "Answer" label and read its sibling value text.
function answerTileValue(): string {
  const tiles = screen.getByTestId("status-tiles");
  // Each tile column contains the label "Answer" and, after it, the state value.
  const labels = within(tiles).getAllByText(/^Answer$/i);
  const labelEl = labels[0];
  // The value span is the next element sibling within the same tile column.
  const valueEl = labelEl.nextElementSibling as HTMLElement | null;
  return (valueEl?.textContent ?? "").trim().toLowerCase();
}

describe("StatusTiles — ANSWER tile state", () => {
  it("a CITED, VALIDATED cell-tally answer with evidenceCount 0 reads 'grounded', never 'insufficient'", () => {
    // The real cell-tally shape: the count is code-computed over the grid, so the engine
    // attaches no per-row evidence (evidenceCount 0) and the lane is flagged general — but
    // the answer cites the structured rows and passed validateAnswer. It IS grounded.
    render(
      <StatusTiles
        result={result({
          mode: "general",
          grounded: false,
          answer: "רינה אנטוב is scheduled the most — 10 times [S:schedule#4].",
          evidence: { rows: [], chunks: [] },
          validation: { ok: true, reasons: [] },
          inspector: {
            retrievalMethod: "cell-tally over the grid",
            passages: 0,
            evidenceCount: 0,
            confidence: { value: 0.9, basis: "" },
            steps: [],
            timings: { routingMs: 1, retrievalMs: 1, generationMs: 1, totalMs: 3 },
            cost: { liveCalls: 1, usd: null, pricingNote: "", provider: "p", model: "m" },
          },
        })}
      />,
    );
    const state = answerTileValue();
    expect(state, "a cited grounded answer must NOT read insufficient").not.toBe("insufficient");
    expect(state).toBe("grounded");
    // The rest of the tile row must agree — an ANSWER tile that says "grounded" while the
    // CITATIONS tile reads 0/skipped would be a self-contradicting verdict. The honest
    // citation count is the distinct tokens the user saw (1 here), and the badge is the check.
    const tiles = screen.getByTestId("status-tiles");
    const citLabel = within(tiles).getAllByText(/^Citations$/i)[0];
    const citValue = (citLabel.nextElementSibling?.textContent ?? "").trim();
    expect(citValue).toBe("1");
  });

  it("a GENUINELY general answer (no citation tokens, 0 evidence) still reads 'insufficient'", () => {
    // The alimony-style general fallback: no source matched, the answer carries NO
    // [S:…]/[P:…] tokens. This must NOT be promoted to grounded by the fix.
    render(
      <StatusTiles
        result={result({
          mode: "general",
          grounded: false,
          answer:
            "In general, spousal maintenance is discretionary — confirm specifics with a qualified attorney.",
          evidence: { rows: [], chunks: [] },
          validation: { ok: true, reasons: [] },
          inspector: {
            retrievalMethod: "no source matched — general knowledge",
            passages: 0,
            evidenceCount: 0,
            confidence: { value: 0.4, basis: "" },
            steps: [],
            timings: { routingMs: 1, retrievalMs: 1, generationMs: 1, totalMs: 3 },
            cost: { liveCalls: 1, usd: null, pricingNote: "", provider: "p", model: "m" },
          },
        })}
      />,
    );
    expect(answerTileValue()).toBe("insufficient");
  });

  it("a normal grounded answer with real evidence still reads 'grounded' (no regression)", () => {
    render(
      <StatusTiles
        result={result({
          mode: "grounded",
          grounded: true,
          answer: "The total maintenance spend is $42,000 [S:maintenance#3].",
          evidence: {
            rows: [{ table: "maintenance", id: 3, token: "[S:maintenance#3]", data: {} }],
            chunks: [],
          },
          validation: { ok: true, reasons: [] },
          inspector: {
            retrievalMethod: "text-to-SQL",
            passages: 0,
            evidenceCount: 1,
            confidence: { value: 0.9, basis: "" },
            steps: [],
            timings: { routingMs: 1, retrievalMs: 1, generationMs: 1, totalMs: 3 },
            cost: { liveCalls: 1, usd: null, pricingNote: "", provider: "p", model: "m" },
          },
        })}
      />,
    );
    expect(answerTileValue()).toBe("grounded");
  });

  it("a grounded answer that FAILED validation still reads 'rejected' (not promoted)", () => {
    render(
      <StatusTiles
        result={result({
          mode: "grounded",
          grounded: true,
          answer: "Total is $99,999 [S:maintenance#3].",
          evidence: {
            rows: [{ table: "maintenance", id: 3, token: "[S:maintenance#3]", data: {} }],
            chunks: [],
          },
          validation: { ok: false, reasons: ["cited figure not found in evidence"] },
          inspector: {
            retrievalMethod: "text-to-SQL",
            passages: 0,
            evidenceCount: 1,
            confidence: { value: 0.9, basis: "" },
            steps: [],
            timings: { routingMs: 1, retrievalMs: 1, generationMs: 1, totalMs: 3 },
            cost: { liveCalls: 1, usd: null, pricingNote: "", provider: "p", model: "m" },
          },
        })}
      />,
    );
    expect(answerTileValue()).toBe("rejected");
  });

  it("a general answer WITH evidence (isGeneral, evidence > 0, no citations) reads 'general' (no regression)", () => {
    // T5: an uncited general answer that DID retrieve evidence is "general", not promoted to
    // grounded (no citation tokens) and not "insufficient" (evidence > 0).
    render(
      <StatusTiles
        result={result({
          mode: "general",
          grounded: false,
          answer: "Here is a general explanation with no citation tokens.",
          evidence: {
            rows: [{ table: "maintenance", id: 3, token: "[S:maintenance#3]", data: {} }],
            chunks: [],
          },
          validation: { ok: true, reasons: [] },
          inspector: {
            retrievalMethod: "hybrid",
            passages: 0,
            evidenceCount: 2,
            confidence: { value: 0.5, basis: "" },
            steps: [],
            timings: { routingMs: 1, retrievalMs: 1, generationMs: 1, totalMs: 3 },
            cost: { liveCalls: 1, usd: null, pricingNote: "", provider: "p", model: "m" },
          },
        })}
      />,
    );
    expect(answerTileValue()).toBe("general");
  });
});

describe("MetricsPanels — citation check stays consistent with the verdict", () => {
  it("a cited, validated cell-tally answer reads 'verified', not 'skipped'", () => {
    render(
      <MetricsPanels
        result={result({
          mode: "general",
          grounded: false,
          answer: "רינה אנטוב is scheduled the most — 10 times [S:schedule#4].",
          evidence: { rows: [], chunks: [] },
          validation: { ok: true, reasons: [] },
          inspector: {
            retrievalMethod: "cell-tally over the grid",
            passages: 0,
            evidenceCount: 0,
            confidence: { value: 0.9, basis: "" },
            steps: [],
            timings: { routingMs: 1, retrievalMs: 1, generationMs: 1, totalMs: 3 },
            cost: { liveCalls: 1, usd: null, pricingNote: "", provider: "p", model: "m" },
          },
        })}
      />,
    );
    const check = screen.getByTestId("citation-check");
    expect(check.textContent?.toLowerCase()).toContain("verified");
    expect(check.textContent?.toLowerCase()).not.toContain("skipped");
  });

  it("a genuine general answer (no citation tokens) still reads 'skipped'", () => {
    render(
      <MetricsPanels
        result={result({
          mode: "general",
          grounded: false,
          answer: "In general, alimony is discretionary — confirm with a qualified attorney.",
          evidence: { rows: [], chunks: [] },
          validation: { ok: true, reasons: [] },
          inspector: {
            retrievalMethod: "no source matched — general knowledge",
            passages: 0,
            evidenceCount: 0,
            confidence: { value: 0.4, basis: "" },
            steps: [],
            timings: { routingMs: 1, retrievalMs: 1, generationMs: 1, totalMs: 3 },
            cost: { liveCalls: 1, usd: null, pricingNote: "", provider: "p", model: "m" },
          },
        })}
      />,
    );
    expect(screen.getByTestId("citation-check").textContent?.toLowerCase()).toContain("skipped");
  });
});
