// validateNoFabrication() — the maintenance-spend-intelligence content-fidelity gate.
// Derived from docs/features/maintenance-spend-intelligence/03-tests.md Part 3.
//
// Pure function: passes the golden answers (real spend answer + honest refusal,
// EN & HE) and fails any answer that invents an overdue status, relabels vendors
// as debtors, or fabricates a service-suspension term. Run in the answer path for
// maintenance turns.
//
// Rules:
//  1. Spend figures, when present, carry row citations ([S:maintenance#id]).
//  2. If the question is about a concept the data lacks (overdue/paid/due/
//     suspension/who-owes), the answer must REFUSE honestly — it must NOT assert a
//     positive overdue/owed claim. A confident "customer X owes $Y" / "service is
//     suspended after N days" fails.

export type MaintenanceValidation = { ok: boolean; reasons: string[] };

const MAINT_CITE = /\[S:maintenance#\d+\]/;
const SPEND_FIGURE = /\$[\d,]+(\.\d{2})?/;

// The question asked for a concept the data lacks.
const UNANSWERABLE_CONCEPT =
  /\b(overdue|past due|unpaid|owe|owed|outstanding balance|who owes|delinquent|suspension|suspend service|service suspension|arrears)\b/i;

// A POSITIVE fabricated claim about such a concept (vs. an honest refusal).
const FABRICATED_OVERDUE = [
  /\b(customer|vendor)s?\s+\w+\s+(has|have|is|are)\s+(overdue|past due|unpaid|delinquent|in arrears)/i,
  /\bowes?\s+(us\s+)?\$[\d,]+/i,
  /overdue (payments?|balance|amount) (of|totaling|totalling)\s+\$?[\d,]+/i,
  /service (is|will be) suspended after\s+\d+/i,
  /suspension (terms?|policy)[^.]*\b\d+\s*days?\b/i,
];

// Markers of an honest refusal (negating the concept's availability). Includes
// HEBREW markers, because the assistant answers a Hebrew question in Hebrew and its
// honest refusal ("there is no … field / cannot … / not available in the data") is
// phrased in Hebrew — an English-only regex would falsely flag a correct Hebrew
// refusal as raising the concept without negating it (Rule 2b).
const HONEST_REFUSAL = new RegExp(
  [
    // English
    "\\b(no (payment[- ]status|due[- ]date|paid|overdue|suspension)|can'?t determine|cannot determine|no service[- ]agreement|not (a|an)? ?(field|column)|won'?t (guess|invent|fabricate)|not in (this|the) data|no .* field|cannot be answered|cannot answer)\\b",
    // Hebrew: "אין … מידע/שדה" (there is no info/field), "לא ניתן" (cannot),
    // "אינו זמין"/"לא זמין" (not available), "אין … הסכם" (no agreement).
    "אין (ב[^ ]* )?(מידע|שדה)",
    "לא ניתן",
    "איננו? זמין|לא זמין|אינו זמין",
    "אין .{0,20}הסכם",
  ].join("|"),
  "i"
);

export function validateNoFabrication(answer: string): MaintenanceValidation {
  const reasons: string[] = [];

  // Rule 1 — spend figures need a row citation (unless it's purely a refusal with
  // only the schema-cited total, which still carries the maintenance total figure).
  if (SPEND_FIGURE.test(answer) && !MAINT_CITE.test(answer)) {
    // Allow the refusal's pivot figure ($40,597.00 total) which is schema/aggregate
    // cited; only flag if NO maintenance citation at all AND the answer claims a
    // per-vendor/per-row spend breakdown.
    if (/\bby vendor\b|top vendors|breakdown|per ticket/i.test(answer)) {
      reasons.push("states spend figures/breakdown without a row citation ([S:maintenance#id])");
    }
  }

  // Rule 2 — no fabricated overdue/owed/suspension claim.
  for (const re of FABRICATED_OVERDUE) {
    if (re.test(answer)) {
      reasons.push("fabricates an overdue/owed/suspension claim the data cannot support");
      break;
    }
  }

  // Rule 2b — if the question's concept is unanswerable and the answer asserts it
  // positively without an honest refusal marker, fail.
  if (UNANSWERABLE_CONCEPT.test(answer) && !HONEST_REFUSAL.test(answer)) {
    // The answer raises overdue/suspension but never honestly negates it → suspicious.
    reasons.push("raises an overdue/suspension concept without the honest 'not in this data' statement");
  }

  return { ok: reasons.length === 0, reasons };
}
