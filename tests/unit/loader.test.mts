import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildDatabase } from "../../src/lib/engine/loader.ts";
import { toISODate, isMalformedCell } from "../../src/lib/engine/schema.ts";

const DATA = join(process.cwd(), "data");

test("loader ingests all tables and never crashes on malformed rows", () => {
  const { db, report } = buildDatabase(DATA);
  const byTable = Object.fromEntries(report.map((r) => [r.table, r]));
  // Contracts loaded fully.
  assert.equal(byTable.contracts.rows, 1000);
  // Enrollment's term_name column is entirely malformed → quarantined, not crashed.
  assert.ok(byTable.enrollment.malformedCells >= 1000, "enrollment malformed cells quarantined");
  db.close();
});

test("malformed cells become NULL + __malformed flag (graceful, not dropped)", () => {
  const { db } = buildDatabase(DATA);
  const row = db.prepare("SELECT term_name, __malformed FROM enrollment LIMIT 1").get() as any;
  assert.equal(row.term_name, null);
  assert.equal(row.__malformed, 1);
  // The row still exists (not dropped).
  const count = db.prepare("SELECT COUNT(*) c FROM enrollment").get() as any;
  assert.equal(count.c, 1000);
  db.close();
});

test("contracts have queryable ISO end dates (the 90-day golden = 38)", () => {
  const { db } = buildDatabase(DATA);
  const today = "2026-06-09";
  const end = "2026-09-07"; // +90d
  const n = db
    .prepare(
      `SELECT COUNT(*) c FROM contracts
       WHERE __malformed = 0 AND end_date_iso BETWEEN ? AND ?`
    )
    .get(today, end) as any;
  assert.equal(n.c, 38, "38 contracts expire within 90 days of 2026-06-09");
  db.close();
});

test("contracts expiry order is deterministic on the End-Date tie (stable tiebreak)", () => {
  const { db } = buildDatabase(DATA);
  // The 4-way tie on 2026-06-17 must order by vendor ASC so the golden
  // "earliest-expiring" list + screenshot reproduce every run.
  const tie = db
    .prepare(
      `SELECT vendor FROM contracts
       WHERE __malformed = 0 AND end_date_iso = '2026-06-17'
       ORDER BY end_date_iso ASC, vendor ASC, id ASC`
    )
    .all() as { vendor: string }[];
  assert.deepEqual(
    tie.map((r) => r.vendor),
    ["Brainsphere", "Fanoodle", "Feedfish", "Topicware"],
    "the 2026-06-17 tie must be vendor-sorted and stable"
  );
  db.close();
});

test("date + malformed helpers", () => {
  assert.equal(toISODate("5/9/2024"), "2024-05-09");
  assert.equal(toISODate("not a date"), null);
  assert.equal(isMalformedCell("error: undefined method `first' for nil:NilClass"), true);
  assert.equal(isMalformedCell("Sales"), false);
});
