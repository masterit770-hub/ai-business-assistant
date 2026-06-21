import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateGeneratedSql,
  HARD_ROW_CAP,
  DEFAULT_ROW_LIMIT,
  type TableSchema,
} from "../../src/lib/engine/sql-guard.ts";

// The SQL safety validator is the security boundary for the text-to-SQL lane. These
// tests are PURE (no DB, no LLM): they pin that DDL/DML, multi-statement, comment, and
// hallucinated-column queries are rejected, and a valid SELECT against the live schema
// is accepted with an enforced LIMIT. The catalog is the introspected schema — so the
// validator is general, not tied to any dataset.

const catalog: TableSchema[] = [
  {
    table: "contracts",
    columns: [
      { name: "id", type: "INTEGER" },
      { name: "vendor", type: "TEXT" },
      { name: "annual_cost", type: "REAL" },
      { name: "end_date_iso", type: "TEXT" },
    ],
  },
  {
    table: "sales",
    columns: [
      { name: "rowid_anchor", type: "INTEGER" },
      { name: "customer", type: "TEXT" },
      { name: "amount", type: "REAL" },
    ],
  },
];

// ── VALID SELECTs are accepted ─────────────────────────────────────────────────

test("accepts a simple SELECT and enforces a default LIMIT", () => {
  const r = validateGeneratedSql("SELECT vendor, annual_cost FROM contracts", catalog);
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.sql, new RegExp(`LIMIT ${DEFAULT_ROW_LIMIT}$`));
});

test("accepts an aggregate query (COUNT/SUM) — the generalized 'figure' path", () => {
  const r = validateGeneratedSql(
    "SELECT COUNT(*), SUM(annual_cost) FROM contracts WHERE end_date_iso BETWEEN '2026-06-09' AND date('2026-06-09','+90 days')",
    catalog
  );
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});

test("accepts a top-N with ORDER BY and keeps an in-range LIMIT", () => {
  const r = validateGeneratedSql(
    "SELECT customer, SUM(amount) AS total FROM sales GROUP BY customer ORDER BY total DESC LIMIT 3",
    catalog
  );
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.match(r.sql, /LIMIT 3/);
});

test("accepts qualified columns with an alias", () => {
  const r = validateGeneratedSql("SELECT c.vendor FROM contracts c WHERE c.annual_cost > 1000", catalog);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});

test("accepts a fenced query (strips the markdown fence)", () => {
  const r = validateGeneratedSql("```sql\nSELECT vendor FROM contracts\n```", catalog);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});

test("accepts SELECT * and rowid", () => {
  const r = validateGeneratedSql("SELECT * FROM sales", catalog);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});

test("clamps an over-cap LIMIT to the hard cap", () => {
  const r = validateGeneratedSql("SELECT vendor FROM contracts LIMIT 100000", catalog);
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.sql, new RegExp(`LIMIT ${HARD_ROW_CAP}`));
});

// ── DDL / DML are rejected ─────────────────────────────────────────────────────

for (const q of [
  "DROP TABLE contracts",
  "DELETE FROM contracts",
  "UPDATE contracts SET annual_cost = 0",
  "INSERT INTO contracts (vendor) VALUES ('x')",
  "ALTER TABLE contracts ADD COLUMN x TEXT",
  "CREATE TABLE evil (x TEXT)",
  "ATTACH DATABASE 'x.db' AS y",
  "REPLACE INTO contracts VALUES (1)",
]) {
  test(`rejects DDL/DML: ${q.slice(0, 24)}…`, () => {
    const r = validateGeneratedSql(q, catalog);
    assert.equal(r.ok, false);
  });
}

test("rejects a write smuggled after a SELECT (multi-statement)", () => {
  const r = validateGeneratedSql("SELECT vendor FROM contracts; DROP TABLE contracts", catalog);
  assert.equal(r.ok, false);
});

test("rejects two stacked SELECTs (multi-statement)", () => {
  const r = validateGeneratedSql("SELECT 1 FROM contracts; SELECT 2 FROM sales", catalog);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /multiple statements/);
});

test("rejects a PRAGMA (admin escape)", () => {
  const r = validateGeneratedSql("PRAGMA table_info(contracts)", catalog);
  assert.equal(r.ok, false);
});

test("rejects a SQL comment (can hide a keyword)", () => {
  const r = validateGeneratedSql("SELECT vendor FROM contracts -- DROP TABLE contracts", catalog);
  assert.equal(r.ok, false);
});

test("rejects a block comment", () => {
  const r = validateGeneratedSql("SELECT vendor /* sneaky */ FROM contracts", catalog);
  assert.equal(r.ok, false);
});

test("rejects a non-SELECT leading statement", () => {
  const r = validateGeneratedSql("WITH x AS (DELETE FROM contracts) SELECT 1", catalog);
  assert.equal(r.ok, false);
});

// ── Unknown tables / columns are rejected (the schema is the allow-list) ───────

test("rejects an unknown table", () => {
  const r = validateGeneratedSql("SELECT * FROM secrets", catalog);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /unknown table/);
});

test("rejects a hallucinated bare column", () => {
  const r = validateGeneratedSql("SELECT ssn FROM contracts", catalog);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /unknown column/);
});

test("rejects a hallucinated qualified column", () => {
  const r = validateGeneratedSql("SELECT c.is_paid FROM contracts c", catalog);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /unknown column 'is_paid'/);
});

test("rejects a column from the WRONG table on a qualified ref", () => {
  // `amount` exists on sales, not contracts.
  const r = validateGeneratedSql("SELECT c.amount FROM contracts c", catalog);
  assert.equal(r.ok, false);
});

// ── Robustness ────────────────────────────────────────────────────────────────

test("rejects empty / non-string input without throwing", () => {
  assert.equal(validateGeneratedSql("", catalog).ok, false);
  // @ts-expect-error — intentionally passing a non-string to prove it doesn't throw
  assert.equal(validateGeneratedSql(null, catalog).ok, false);
});

test("does not false-reject a string literal that looks like a column", () => {
  const r = validateGeneratedSql("SELECT vendor FROM contracts WHERE vendor = 'overdue'", catalog);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});
