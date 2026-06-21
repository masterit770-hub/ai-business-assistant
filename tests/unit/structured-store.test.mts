import { test } from "node:test";
import assert from "node:assert/strict";
import {
  introspectSchema,
  runGeneratedSelect,
  idColumnFor,
  resetStore,
} from "../../src/lib/engine/structured-store.ts";
import { addRuntimeRows, clearRuntimeRows } from "../../src/lib/engine/runtime-store.ts";

// Schema introspection + the queryable structured store. No LLM: these drive the REAL
// PRAGMA-based introspection over the bundled SQLite AND a materialized uploaded table,
// proving the text-to-SQL lane's catalog is general (works for any ingested table) and
// that a guarded SELECT executes and cites real rows.

function reset() {
  clearRuntimeRows();
  resetStore();
}

test("introspects the bundled tables with real columns (PRAGMA-derived)", () => {
  reset();
  const { catalog } = introspectSchema();
  const contracts = catalog.find((t) => t.table === "contracts");
  assert.ok(contracts, "contracts table is in the introspected catalog");
  const cols = contracts!.columns.map((c) => c.name);
  // Real columns the loader created; the internal __malformed flag is hidden.
  assert.ok(cols.includes("vendor"));
  assert.ok(cols.includes("annual_cost"));
  assert.ok(cols.includes("end_date_iso"));
  assert.ok(!cols.includes("__malformed"), "internal __malformed column is hidden from the catalog");
});

test("the bundled load report meta table is NOT advertised as a queryable table", () => {
  reset();
  const { catalog } = introspectSchema();
  assert.ok(!catalog.some((t) => t.table === "_load_report"));
});

test("a generated COUNT/SUM runs and returns the figure as a real row (the generalized figure path)", () => {
  reset();
  const { catalog } = introspectSchema();
  const r = runGeneratedSelect(
    "SELECT COUNT(*) AS n, ROUND(SUM(annual_cost), 2) AS total FROM contracts WHERE end_date_iso BETWEEN '2026-06-09' AND date('2026-06-09', '+90 days')",
    "contracts",
    catalog
  );
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) {
    assert.equal(r.rows.length, 1);
    // The aggregate row IS the figure — no hardcode, the query produced it.
    assert.equal(r.rows[0].data.n, 38);
    assert.equal(r.rows[0].data.total, 18924883.79);
  }
});

test("a guard violation is reported, not thrown (DDL rejected)", () => {
  reset();
  const { catalog } = introspectSchema();
  const r = runGeneratedSelect("DROP TABLE contracts", "contracts", catalog);
  assert.equal(r.ok, false);
});

test("an UPLOADED table with messy headers becomes introspectable + queryable + citable", () => {
  reset();
  // Simulate the ingest path: messy headers (mixed case, spaces), a junk/null row.
  addRuntimeRows([
    { table: "orders_upload", id: 1, data: { id: 1, "Customer Name": "Acme", "Order Amount": "100.50" } },
    { table: "orders_upload", id: 2, data: { id: 2, "Customer Name": "Globex", "Order Amount": "250" } },
    { table: "orders_upload", id: 3, data: { id: 3, "Customer Name": "", "Order Amount": "" } }, // junk/null row
  ]);

  const { catalog } = introspectSchema();
  const t = catalog.find((c) => c.table === "orders_upload");
  assert.ok(t, "uploaded table is introspected");
  const cols = t!.columns.map((c) => c.name);
  // Headers sanitized to safe identifiers; the citation anchor column is present.
  assert.ok(cols.includes("rowid_anchor"));
  assert.ok(cols.includes("customer_name"));
  assert.ok(cols.includes("order_amount"));

  // The id column the citation uses for an uploaded table is rowid_anchor.
  assert.equal(idColumnFor("orders_upload", catalog), "rowid_anchor");

  // An aggregate over the uploaded numeric column runs (proving type inference made it
  // REAL despite arriving as strings).
  const sum = runGeneratedSelect(
    "SELECT SUM(order_amount) AS total, COUNT(*) AS n FROM orders_upload",
    "orders_upload",
    catalog
  );
  assert.equal(sum.ok, true, sum.ok ? "" : sum.reason);
  if (sum.ok) assert.equal(sum.rows[0].data.total, 350.5);

  // A row-level SELECT cites real uploaded rows via rowid_anchor.
  const rows = runGeneratedSelect(
    "SELECT rowid_anchor, customer_name, order_amount FROM orders_upload WHERE order_amount IS NOT NULL ORDER BY order_amount DESC",
    "orders_upload",
    catalog
  );
  assert.equal(rows.ok, true, rows.ok ? "" : rows.reason);
  if (rows.ok) {
    assert.equal(rows.rows.length, 2, "the null/junk row is excluded by the query, not crashed on");
    assert.equal(rows.rows[0].id, 2, "row id (rowid_anchor) anchors the citation");
    assert.equal(rows.rows[0].data.customer_name, "Globex");
  }
  reset();
});

test("counting null/blank cells in an uploaded column works (a real analytical question)", () => {
  reset();
  addRuntimeRows([
    { table: "orders2", id: 1, data: { id: 1, amount: "100" } },
    { table: "orders2", id: 2, data: { id: 2, amount: "" } },
    { table: "orders2", id: 3, data: { id: 3, amount: "" } },
  ]);
  const { catalog } = introspectSchema();
  const r = runGeneratedSelect(
    "SELECT COUNT(*) AS missing FROM orders2 WHERE amount IS NULL",
    "orders2",
    catalog
  );
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.equal(r.rows[0].data.missing, 2);
  reset();
});
