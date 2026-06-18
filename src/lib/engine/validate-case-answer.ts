// validateCaseAnswer() — the case-file-qa content-fidelity gate.
// Derived from docs/features/case-file-qa/03-tests.md Part 3.
//
// Pure function: passes the golden answers (A/B/C/D) and fails toys that drop a
// citation, hallucinate a holding, conflate the documents, or silently resolve
// the filing-date conflict. Run in the case answer path.
//
// Rules:
//  1. Page-level citation present — at least one [P:<doc>#<page>] token.
//  2. No [S:...] structured tokens (this is a document-only feature).
//  3. No hallucinated holding from a stop-list of facts NOT in the documents
//     (e.g. spousal/alimony support — the documents award none).
//  4. Conflict integrity — if the answer is about the filing date and mentions
//     BOTH Feb 3 and Feb 10, it must FRAME them as a conflict (not "corroborated").

export type CaseValidation = { ok: boolean; reasons: string[] };

const PAGE_CITE = /\[P:[^\]#]+#\d+\]/;
const STRUCTURED_CITE = /\[S:[^\]]+\]/;

// Facts a confident hallucination would assert that are NOT in either Carter doc.
const HALLUCINATION_STOPLIST = [
  /spousal support/i,
  /\balimony\b/i,
  /sole custody/i, // the judgment is JOINT custody
];

const FEB3 = /(february 3|feb\.? 3|3 february)/i;
const FEB10 = /(february 10|feb\.? 10|10 february)/i;

export function validateCaseAnswer(answer: string): CaseValidation {
  const reasons: string[] = [];
  const notStated = /not stated in the case file|not (in|present in|contained in) the (provided )?documents?|isn'?t in (the|either) (provided )?documents?/i.test(
    answer
  );

  // Rule 1 — a page citation (unless the honest "not stated" answer)
  if (!notStated && !PAGE_CITE.test(answer)) {
    reasons.push("no page-level citation ([P:doc#page]) present");
  }

  // Rule 2 — no structured-table citations in a document-only feature
  if (STRUCTURED_CITE.test(answer)) {
    reasons.push("uses a structured-table citation ([S:...]) in a document-only case answer");
  }

  // Rule 3 — no hallucinated holdings
  for (const re of HALLUCINATION_STOPLIST) {
    if (re.test(answer)) {
      reasons.push(`asserts a holding not in the case documents (${re})`);
    }
  }

  // Rule 4 — conflict integrity: mentioning both filing dates requires framing them
  // as a conflict, never as agreement/corroboration.
  if (FEB3.test(answer) && FEB10.test(answer)) {
    const framesConflict = /conflict|disagree|differ|discrepan|do not (agree|match)|inconsist/i.test(answer);
    if (!framesConflict) {
      reasons.push("two different filing dates present but not surfaced as a conflict (wrongly merged/corroborated)");
    }
  }

  return { ok: reasons.length === 0, reasons };
}
