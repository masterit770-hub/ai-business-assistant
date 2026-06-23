import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampPaging,
  rowsToCsv,
  decideAccess,
  csvFilename,
  MAX_PAGE,
  DEFAULT_PAGE,
} from "../../src/lib/engine/table-view.ts";

// The load-bearing pure helpers behind GET /api/table — the row→CSV serializer, the
// paging clamp, and the per-user isolation policy. No DB / no request: these prove the
// bits that, if wrong, leak data (isolation), corrupt a download (CSV escaping), or
// allow an unbounded dump (paging cap).

// ── rowsToCsv ────────────────────────────────────────────────────────────────────
test("rowsToCsv writes a header row then one line per row, in COLUMN order", () => {
  const csv = rowsToCsv(
    ["vendor", "annual_cost"],
    [
      { vendor: "Acme", annual_cost: 5000 },
      { vendor: "Globex", annual_cost: 250 },
    ]
  );
  assert.equal(csv, "vendor,annual_cost\r\nAcme,5000\r\nGlobex,250");
});

test("rowsToCsv follows the column order, not the row object's key order", () => {
  // The row's keys are in a different order than `columns` — CSV must match `columns`.
  const csv = rowsToCsv(["a", "b"], [{ b: 2, a: 1 }]);
  assert.equal(csv, "a,b\r\n1,2");
});

test("rowsToCsv escapes commas, quotes, and newlines (RFC-4180)", () => {
  const csv = rowsToCsv(
    ["note"],
    [
      { note: "hello, world" }, // comma → quoted
      { note: 'she said "hi"' }, // quote → doubled + quoted
      { note: "line1\nline2" }, // newline → quoted
    ]
  );
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "note");
  assert.equal(lines[1], '"hello, world"');
  assert.equal(lines[2], '"she said ""hi"""');
  assert.equal(lines[3], '"line1\nline2"');
});

test("rowsToCsv renders null/undefined/missing cells as empty fields", () => {
  const csv = rowsToCsv(["a", "b", "c"], [{ a: "x", b: null /* c missing */ }]);
  assert.equal(csv, "a,b,c\r\nx,,");
});

test("rowsToCsv with no rows still emits the header", () => {
  assert.equal(rowsToCsv(["a", "b"], []), "a,b");
});

// ── clampPaging ────────────────────────────────────────────────────────────────────
test("clampPaging defaults a missing limit/offset", () => {
  const p = clampPaging(null, null);
  assert.equal(p.limit, DEFAULT_PAGE);
  assert.equal(p.offset, 0);
});

test("clampPaging caps the limit at MAX_PAGE (no unbounded dump)", () => {
  assert.equal(clampPaging("100000", "0").limit, MAX_PAGE);
  assert.equal(clampPaging("250", "0").limit, MAX_PAGE);
});

test("clampPaging honors a valid in-range limit + offset", () => {
  const p = clampPaging("25", "75");
  assert.equal(p.limit, 25);
  assert.equal(p.offset, 75);
});

test("clampPaging rejects negative / non-numeric values", () => {
  assert.equal(clampPaging("-5", "-10").limit, DEFAULT_PAGE);
  assert.equal(clampPaging("-5", "-10").offset, 0);
  assert.equal(clampPaging("abc", "xyz").limit, DEFAULT_PAGE);
  assert.equal(clampPaging("abc", "xyz").offset, 0);
});

test("clampPaging floors fractional values", () => {
  const p = clampPaging("10.9", "5.7");
  assert.equal(p.limit, 10);
  assert.equal(p.offset, 5);
});

// ── decideAccess (the per-user ISOLATION policy) ────────────────────────────────────
test("a HIDDEN table is 404 for everyone (excluded everywhere)", () => {
  assert.deepEqual(decideAccess({ table: "t", isHidden: true, kind: "bundled", role: "admin" }), {
    ok: false,
    status: 404,
    error: "table not found",
  });
});

test("a BUNDLED non-hidden table is readable by any authed user", () => {
  assert.equal(decideAccess({ table: "contracts", isHidden: false, kind: "bundled", role: "user" }).ok, true);
  assert.equal(decideAccess({ table: "contracts", isHidden: false, kind: "bundled", role: "admin" }).ok, true);
});

test("an UPLOADED table PRESENT in the caller's scoped catalog is readable (presence encodes ownership)", () => {
  // The route now introspects the catalog OWNER-SCOPED, so a member's catalog contains
  // ONLY their own uploaded tables. An uploaded `kind` reaching decideAccess therefore
  // belongs to the caller (member) or is any owner's (admin) → readable. Isolation is
  // enforced upstream: another member's table resolves to kind=null → 404 (below).
  assert.equal(decideAccess({ table: "u", isHidden: false, kind: "uploaded", role: "user" }).ok, true);
  assert.equal(decideAccess({ table: "u", isHidden: false, kind: "uploaded", role: "admin" }).ok, true);
});

test("an uploaded table NOT in the caller's scoped catalog is 404 (a member can't read another member's upload)", () => {
  // The owner-scoping happens in the route (introspectSchema(scope)); a table not in the
  // caller's scope arrives here as kind=null → 404. This is the isolation gate.
  const d = decideAccess({ table: "someone-elses", isHidden: false, kind: null, role: "user" });
  assert.deepEqual(d, { ok: false, status: 404, error: "table not found" });
});

test("a table not in the catalog is 404", () => {
  const d = decideAccess({ table: "nope", isHidden: false, kind: null, role: "admin" });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.status, 404);
});

// ── csvFilename ────────────────────────────────────────────────────────────────────
test("csvFilename produces a safe .csv name", () => {
  assert.equal(csvFilename("contracts"), "contracts.csv");
  assert.equal(csvFilename("My Table 2024!"), "My_Table_2024.csv");
  assert.equal(csvFilename("***"), "table.csv");
});
