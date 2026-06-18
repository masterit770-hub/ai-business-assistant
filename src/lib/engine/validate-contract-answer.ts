// validateContractAnswer() — the contract-intelligence content-fidelity gate.
// Derived from docs/features/contract-intelligence/03-tests.md Part 3 + Part 4.
//
// Encodes the 02 acceptance bar as a PURE function: passes every golden answer
// (A/B/C) and fails every toy/leaking answer. Run in the contract answer path
// and pinned by a unit test. This is SEPARATE from the generic validateAnswer()
// (citation resolvability) — it enforces "real, honest, no leak" for contracts.
//
// Rules:
//  1. Verifiable count present (no vague quantifier when expiry is discussed).
//  2. Row citations present ([S:contracts#id]).
//  3. Penalty is honestly unavailable — no penalty FIGURE/CLAUSE attributed to a
//     source (covers both generic-prose and fabricated-specific failures).
//  4. No cross-domain content — zero Carter-case tokens.
//  5. Defect honesty — doesn't relabel the role field as a "Contract ID".

export type ContractValidation = { ok: boolean; reasons: string[] };

const VAGUE_QUANTIFIERS = /\b(several|various|some|a number of|many|a few)\b/i;
const CONTRACT_CITE = /\[S:contracts#\d+\]/;
// A verifiable count: a number followed by "contracts", allowing up to a few
// qualifier words in between ("38 vendor contracts", "38 active vendor contracts",
// "650 expiring vendor contracts"). The earlier /\d+\s+contracts?/ required the
// word "contracts" to sit IMMEDIATELY after the number, so a correctly-counted
// answer phrased "38 vendor contracts" was false-rejected as "missing a verifiable
// contract count" (QA #1). Bounded to ≤3 short words so it can't match an unrelated
// number elsewhere in the sentence. Each in-between word is letters only (no digits
// /punctuation), which keeps it from spanning across a "$18,924,883.79 … contracts".
const COUNT_PRESENT = /\b\d{1,4}(?:\s+[A-Za-z]+){0,3}\s+contracts?\b/i;

// Carter case-file tokens — any of these in a contract answer is a cross-domain leak.
const CARTER_TOKENS = [
  /child support/i,
  /\bcustody\b/i,
  /\bjoni\b/i,
  /\bmichel\b/i,
  /final judgment/i,
  /\bdivorce\b/i,
  /home sale within/i,
  /\bcarter\b/i,
];

// A penalty FIGURE or CLAUSE being asserted (vs. the honest "not available").
// Honest statements explicitly negate availability.
const PENALTY_MENTION = /\b(penalt|termination)\b/i;
// The honest "penalty not available" statement: a negation co-occurring with the
// penalty mention in the same sentence (no/not/n't/cannot/won't + penalty +
// unavailable/no-field/no-document/no-source). Matches both orderings:
//   "penalty terms are not available", "no early-termination penalty information available".
const PENALTY_UNAVAILABLE = new RegExp(
  [
    // penalty ... <negation/absence>
    "penalt[^.]*?(not available|no penalty|no (penalty )?(field|data|source|document|information)|not (defined|specified|present|contain)|aren'?t available|cannot|can'?t|won'?t (guess|invent)|no .*documents? (are )?loaded|isn'?t (available|loaded))",
    // <negation/absence> ... penalty/termination ... <unavailable marker>
    "(no|not|does not|do not|doesn'?t|don'?t|cannot|can'?t|won'?t|without)[^.]*?(penalt|termination)[^.]*?(available|loaded|field|data|source|document|information|guess|contain)",
    // does not contain ... penalty
    "(does not|do not|doesn'?t|don'?t|no)[^.]*?(contain|include|have)[^.]*?(penalt|termination)",
    "(no|not|cannot)[^.]*?(early[- ]termination)[^.]*?(available|information)",
  ].join("|"),
  "i"
);
// A concrete penalty figure/percentage/fee that would be fabricated.
const PENALTY_FIGURE = /penalt[^.]*?(\$[\d,]+|\d+\s?%|\d+\s?(days|months)['’ ]?\s?notice|fee of)/i;

export function validateContractAnswer(answer: string): ContractValidation {
  const reasons: string[] = [];
  // Strip markdown emphasis (** __ * _ `) BEFORE structural checks: the LLM bolds
  // figures, so a real answer reads "**38** vendor contracts" — the `**` between the
  // number and "contracts" used to break count-extraction and false-reject a correct
  // answer (QA #1). Stripping markers makes "**38** vendor contracts" → "38 vendor
  // contracts" for the count/expiry/set detection.
  const plain = answer.replace(/[*_`]+/g, "");
  const discussesExpiry = /\bexpir/i.test(plain) || COUNT_PRESENT.test(plain);
  // Prose with citation tokens stripped, so "contracts" inside [S:contracts#id]
  // doesn't trip the plural/set detection.
  const prose = plain.replace(/\[S:[^\]]+\]/g, "").replace(/\[P:[^\]]+\]/g, "");
  // A "set" answer lists/aggregates expiring contracts (plural / a horizon window)
  // and therefore must carry a verifiable count. A single named-contract answer
  // (Example C) discusses expiry but legitimately has no count.
  const isSetAnswer =
    /\bcontracts\b/i.test(prose) || /next\s+\d+\s+days/i.test(prose) || /\bbetween\b[^.]*\band\b/i.test(prose);

  // Rule 1 — verifiable count (only for set answers). Count/vague checks run on the
  // markdown-stripped text so "**38** vendor contracts" counts.
  if (discussesExpiry && isSetAnswer && !COUNT_PRESENT.test(plain)) {
    if (VAGUE_QUANTIFIERS.test(plain)) {
      reasons.push("uses a vague quantifier ('several'/'various') instead of a verifiable contract count");
    } else {
      reasons.push("expiry-set answer is missing a verifiable contract count");
    }
  }

  // Rule 2 — row citations (citation tokens never contain markdown, so test answer)
  if (discussesExpiry && !CONTRACT_CITE.test(answer)) {
    reasons.push("no contract row citation ([S:contracts#id]) present");
  }

  // Rule 3 — penalty honesty (no fabricated figure/clause; mention must be the
  // unavailable statement). Run on `plain` so a bolded "**$5,000**" penalty figure
  // can't slip past the figure check.
  if (PENALTY_FIGURE.test(plain)) {
    reasons.push("contains a fabricated penalty figure/clause (no penalty source exists)");
  } else if (PENALTY_MENTION.test(plain) && !PENALTY_UNAVAILABLE.test(plain)) {
    reasons.push("mentions penalties without the honest 'not available' statement (generic/ungrounded)");
  }

  // Rule 4 — no cross-domain leak
  const leaks = CARTER_TOKENS.filter((re) => re.test(plain));
  if (leaks.length) {
    reasons.push(`cross-domain leak — contains Carter case-file content (${leaks.length} token(s))`);
  }

  // Rule 5 — defect honesty (don't call the role label a Contract ID/number)
  if (/contract (id|number)\s*[:#]/i.test(answer)) {
    reasons.push("relabels the role/job-title field as a 'Contract ID/number'");
  }

  return { ok: reasons.length === 0, reasons };
}
