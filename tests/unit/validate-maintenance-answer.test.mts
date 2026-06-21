import { test } from "node:test";
import assert from "node:assert/strict";
import { validateNoFabrication } from "../../src/lib/engine/validate-maintenance-answer.ts";
import { buildDatabase } from "../../src/lib/engine/loader.ts";
import { TABLES } from "../../src/lib/engine/schema.ts";
import { join } from "node:path";

// docs/features/maintenance-spend-intelligence/03-tests.md Part 3 + Part 4.

// ── validateNoFabrication: passes goldens, fails fabrications ────────────────

test("golden A: honest refusal of the overdue question (schema-cited, no fabrication)", () => {
  const a = `I can't determine overdue payments from this data — the maintenance table has no payment-status or due-date field; its columns are only Vendor, Invoice, Labor Cost, Parts Cost, Total Cost, Completion Date. The vendors are providers we pay, not customers who owe. What I can tell you: total maintenance spend is $40,597.00 across 750 tickets.`;
  assert.equal(validateNoFabrication(a).ok, true, validateNoFabrication(a).reasons.join("; "));
});

test("golden B: a real spend answer with cited rows", () => {
  const a = `In 2026, maintenance spend was $13,485.66 across 248 tickets. Top vendors by spend: Oyoba $949.94 [S:maintenance#478], Voolith $783.67 [S:maintenance#12]. Total across all tickets: $40,597.00 [S:maintenance#1].`;
  assert.equal(validateNoFabrication(a).ok, true, validateNoFabrication(a).reasons.join("; "));
});

test("golden A-HE: Hebrew honest refusal passes (Hebrew negation markers recognised)", () => {
  // The assistant answers a Hebrew overdue question in Hebrew. Its honest refusal is
  // phrased in Hebrew ("אין … מידע/שדה", "לא ניתן") while the schema columns it names
  // (paid/unpaid, suspension) are English — Rule 2b must NOT fire on this correct
  // refusal. (Regression: an English-only HONEST_REFUSAL regex falsely flagged it.)
  const a = `אין בנתונים מידע על לקוחות המאחרים בתשלומים או על תנאי השעיית שירות. טבלת התחזוקה מכילה עמודות בלבד: Ticket ID, Vendor, Invoice, Labor Cost, Parts Cost, Total Cost, Completion Date. אין בה שדה של סטטוס תשלום (paid/unpaid) או תנאי suspension. לכן לא ניתן לענות על השאלה. סך ההוצאה הכוללת על תחזוקה הוא $40,597.00 על פני 750 כרטיסים [S:maintenance#5].`;
  const r = validateNoFabrication(a);
  assert.equal(r.ok, true, r.reasons.join("; "));
});

test("golden A-variant: 'does not contain any payment-status … fields' phrasing passes (the live-DeepSeek wording)", () => {
  // The EXACT phrasing the cloud model (DeepSeek) produced live for the overdue
  // question. The HONEST_REFUSAL regex previously required the word "no" ADJACENT to
  // the field name ("no payment-status field"), so "does not contain ANY payment-
  // status … fields" slipped through Rule 2b and a correct, honest refusal was wrongly
  // REJECTED — which then flipped the marquee trust-demo answer to a generic general
  // reply, DROPPING the deterministic $40,597.00 figure. The widened marker recognizes
  // the "does not contain / has no / there is no … field" family.
  const a = `The maintenance data does not contain any payment-status, paid/unpaid, due-date, or service-suspension fields. The table only includes columns for Vendor, Invoice, Labor Cost, Parts Cost, Total Cost, and Completion Date. The vendors are providers the school pays, not customers who owe. Total maintenance spend is $40,597.00 across 750 tickets [S:maintenance#5].`;
  const r = validateNoFabrication(a);
  assert.equal(r.ok, true, r.reasons.join("; "));
});

test("golden A-variant: 'there is no due-date field' / 'cannot determine overdue' passes", () => {
  const a = `There is no due-date field in this data, so I cannot determine which accounts are overdue. Total maintenance spend is $40,597.00 across 750 tickets [S:maintenance#5].`;
  const r = validateNoFabrication(a);
  assert.equal(r.ok, true, r.reasons.join("; "));
});

// ── TOYS / fabrications MUST fail ───────────────────────────────────────────

test("toy: fabricated overdue list (the catastrophic failure)", () => {
  const a = `Customers Oyoba and Voolith have overdue payments totaling $1,733.`;
  const r = validateNoFabrication(a);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /fabricates an overdue|owed|suspension/i);
});

test("toy: invented service-suspension clause", () => {
  const a = `The agreement suspends service after 30 days overdue.`;
  const r = validateNoFabrication(a);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /fabricat|suspension/i);
});

test("toy: vendor relabeled as a debtor who owes", () => {
  const a = `Vendor Oyoba owes us $949.94 in overdue maintenance fees.`;
  const r = validateNoFabrication(a);
  assert.equal(r.ok, false);
});

// ── Part 4: schema-absence guard ────────────────────────────────────────────

test("schema-absence: the maintenance table has NO status/paid/due/overdue/balance column", () => {
  const spec = TABLES.find((t) => t.table === "maintenance")!;
  const cols = spec.columns.map((c) => c.col.toLowerCase());
  for (const forbidden of ["status", "paid", "due", "overdue", "balance", "delinquent"]) {
    assert.ok(!cols.includes(forbidden), `maintenance must not have a '${forbidden}' column`);
  }
});

// ── Part 4: aggregation determinism ─────────────────────────────────────────

test("aggregation determinism: $40,597.00 total; 2026 = $13,485.66/248; Oyoba $949.94", () => {
  const { db } = buildDatabase(join(process.cwd(), "data"));
  const total = db.prepare(`SELECT ROUND(SUM(total_cost),2) t, COUNT(*) n FROM maintenance WHERE __malformed=0`).get() as any;
  assert.equal(total.t, 40597);
  assert.equal(total.n, 750);
  const y2026 = db
    .prepare(`SELECT ROUND(SUM(total_cost),2) t, COUNT(*) n FROM maintenance WHERE __malformed=0 AND completion_date_iso LIKE '2026%'`)
    .get() as any;
  assert.equal(y2026.t, 13485.66);
  assert.equal(y2026.n, 248);
  const oyoba = db.prepare(`SELECT ROUND(SUM(total_cost),2) t FROM maintenance WHERE vendor='Oyoba' AND __malformed=0`).get() as any;
  assert.equal(oyoba.t, 949.94);
  db.close();
});
