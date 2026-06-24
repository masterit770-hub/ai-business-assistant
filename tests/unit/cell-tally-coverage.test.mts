import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCellFilterByCountQuestion,
  filterTargetCount,
  entitiesAtCount,
  gridRecurrenceProfile,
  computeExtremeTally,
  accumulateOccurrences,
  type OccMap,
} from "../../src/lib/engine/cell-tally.ts";
import type { TableSchema } from "../../src/lib/engine/sql-guard.ts";
import type { SqlRow } from "../../src/lib/engine/structured-store.ts";

// Deterministic guards for the last three HARD-GATE rows of docs/testing/count-coverage.md:
// DV5 (filter-by-count), EG4 (sparse / no determinable ranking), AD4 (non-existent name → 0).
// These pin the PURE behavior (no LLM/DB) so the engine's count machinery can't silently drift.

// A grid-shaped table (the calendar layout): many sparse TEXT columns.
const grid: TableSchema = {
  table: "שיבוצים_אוגוסט_2024",
  columns: [
    { name: "rowid_anchor", type: "INTEGER" },
    { name: "empty", type: "TEXT" },
    { name: "empty_1", type: "TEXT" },
    { name: "empty_2", type: "TEXT" },
    { name: "empty_3", type: "TEXT" },
    { name: "empty_4", type: "TEXT" },
  ],
};
function rowsOf(table: string, g: Record<string, string>[]): SqlRow[] {
  return g.map((data, i) => ({ table, id: i + 1, data }));
}

// ── DV5: FILTER-BY-COUNT ("who is scheduled EXACTLY N times") ─────────────────────────────────
test("DV5 trigger: isCellFilterByCountQuestion FIRES on an exact-count question over a grid", () => {
  assert.equal(isCellFilterByCountQuestion("מי משובצת בדיוק 5 פעמים באוגוסט?", grid), true);
  assert.equal(isCellFilterByCountQuestion("who is scheduled exactly 3 times?", grid), true);
  assert.equal(isCellFilterByCountQuestion("which people appear exactly 10 times?", grid), true);
});
test("DV5 trigger: does NOT fire without an exact-count cue, without a number, or on a ranking", () => {
  // No "exactly/בדיוק" cue → it's a plain count or lookup, not a filter-by-count.
  assert.equal(isCellFilterByCountQuestion("כמה פעמים רינה משובצת?", grid), false);
  // "exactly" but no integer to filter on.
  assert.equal(isCellFilterByCountQuestion("who is scheduled exactly as often?", grid), false);
  // A superlative ranking → the tally lane owns it, never the filter lane.
  assert.equal(isCellFilterByCountQuestion("who is scheduled the most, exactly?", grid), false);
});
test("DV5 parse: filterTargetCount extracts the target integer, ignoring money/decimals/years", () => {
  assert.equal(filterTargetCount("מי משובצת בדיוק 5 פעמים?"), 5);
  assert.equal(filterTargetCount("exactly 12 times"), 12);
  assert.equal(filterTargetCount("exactly $5.50"), null); // a currency/decimal is not a plain count
  assert.equal(filterTargetCount("scheduled in 2024 exactly"), null); // a 4-digit year is not 1-3 digits
  assert.equal(filterTargetCount("who appears exactly?"), null); // no integer
});

// Two-sheet fixture: Alice 4×, Bob 3×, Dora 3×, Cara 1×; "Gift Room" 4× (an activity, excluded by
// the entity set just like the real classifier excludes it). The PEOPLE entity set is fixed.
const sheetA = rowsOf("sheet_a", [
  { rowid_anchor: "1", d1: "Gift Room", d2: "Alice", d3: "Bob" },
  { rowid_anchor: "2", d1: "Gift Room", d2: "Alice", d3: "Cara" },
  { rowid_anchor: "3", d1: "Gift Room", d2: "Bob", d3: "" },
  { rowid_anchor: "4", d1: "Gift Room", d2: "Alice", d3: "" },
]);
const sheetB = rowsOf("sheet_b", [
  { rowid_anchor: "1", d1: "Dora", d2: "Alice" },
  { rowid_anchor: "2", d1: "Dora", d2: "Bob" },
  { rowid_anchor: "3", d1: "Dora", d2: "" },
]);
const PEOPLE = ["Alice", "Bob", "Cara", "Dora"];
function buildOcc(...sheets: { table: string; rows: SqlRow[] }[]): OccMap {
  const occ: OccMap = new Map();
  for (const s of sheets) accumulateOccurrences(occ, s.table, s.rows);
  return occ;
}

test("DV5 filter: entitiesAtCount returns the EXACT set at N (people only), and excludes the activity", () => {
  const occ = buildOcc({ table: "sheet_a", rows: sheetA }, { table: "sheet_b", rows: sheetB });
  // Counts: Alice 4, Bob 3, Dora 3, Cara 1; Gift Room 4 (NOT in PEOPLE).
  const at3 = entitiesAtCount(occ, PEOPLE, 3).map((t) => t.entity);
  assert.deepEqual(at3, ["Bob", "Dora"]); // both people at exactly 3 — the full set, sorted
  const at4 = entitiesAtCount(occ, PEOPLE, 4).map((t) => t.entity);
  assert.deepEqual(at4, ["Alice"]); // Gift Room is also 4× but is NOT a person → excluded
  const at1 = entitiesAtCount(occ, PEOPLE, 1).map((t) => t.entity);
  assert.deepEqual(at1, ["Cara"]);
});
test("DV5 filter: a count with NO matching entity returns an EMPTY set (honest, never fabricated)", () => {
  const occ = buildOcc({ table: "sheet_a", rows: sheetA }, { table: "sheet_b", rows: sheetB });
  assert.deepEqual(entitiesAtCount(occ, PEOPLE, 99), []); // no one is scheduled 99 times
  assert.deepEqual(entitiesAtCount(occ, PEOPLE, 2), []); // no person is at exactly 2 here
});
test("DV5 filter: the returned anchors are real table-qualified rows (citable)", () => {
  const occ = buildOcc({ table: "sheet_a", rows: sheetA }, { table: "sheet_b", rows: sheetB });
  const alice = entitiesAtCount(occ, PEOPLE, 4)[0];
  assert.equal(alice.entity, "Alice");
  assert.ok(alice.anchors.length > 0);
  assert.ok(alice.anchors.every((a) => a.table === "sheet_a" || a.table === "sheet_b"));
});

// ── EG4: SPARSE / NO DETERMINABLE RANKING ─────────────────────────────────────────────────────
// When NOTHING recurs (every value occurs once — a normalized roster, or a near-empty sheet), there
// is no "most frequent X" to rank. The recurrence profile reports it (maxCount 1, no recurring
// values) so the engine's grid selection drops it / falls to the honest path. The tally over such a
// grid would put EVERY entity tied at 1 — which is NOT a determinable winner. These pin that.
test("EG4: a sparse grid (every value once) has NO recurrence — not a rankable frequency grid", () => {
  const sparse = rowsOf("t", [
    { rowid_anchor: "1", a: "Alice", b: "Bob" },
    { rowid_anchor: "2", a: "Cara", b: "Dora" },
  ]);
  const occ: OccMap = new Map();
  accumulateOccurrences(occ, "t", sparse);
  const { recurringValues, maxCount } = gridRecurrenceProfile(occ);
  assert.equal(maxCount, 1, "nothing recurs in a sparse grid");
  assert.deepEqual(recurringValues, [], "no value recurs → no 'most' to rank");
});
test("EG4: an empty grid has NO recurrence and an empty extreme group (no winner to fabricate)", () => {
  const occ: OccMap = new Map();
  accumulateOccurrences(occ, "t", rowsOf("t", [{ rowid_anchor: "1", a: "", b: "" }]));
  const prof = gridRecurrenceProfile(occ);
  assert.equal(prof.maxCount, 0);
  assert.deepEqual(prof.recurringValues, []);
  assert.deepEqual(computeExtremeTally(occ, [], "most").extremeGroup, []);
});
test("EG4: when all entities tie at 1, the 'extreme group' is EVERYONE — a non-answer the engine must not crown", () => {
  // The deterministic signal the routing uses (maxCount===1 / recurringValues empty) is what tells
  // it 'there is no determinable most' — the tally itself would return all-tied, which is not a winner.
  const occ: OccMap = new Map();
  accumulateOccurrences(occ, "t", rowsOf("t", [{ rowid_anchor: "1", a: "Alice", b: "Bob", c: "Cara" }]));
  const { extremeGroup } = computeExtremeTally(occ, ["Alice", "Bob", "Cara"], "most");
  assert.equal(extremeGroup.length, 3, "all tied at 1");
  assert.ok(extremeGroup.every((e) => e.count === 1));
  // The recurrence profile is the honest signal: nothing recurs → not a rankable grid.
  assert.equal(gridRecurrenceProfile(occ).maxCount, 1);
});

// ── AD4: NON-EXISTENT NAME → HONEST 0 ─────────────────────────────────────────────────────────
// "How many times is <made-up name> scheduled?" — the value is absent from the grid, so its
// occurrence count is 0. The cell-count lane reports an HONEST 0 (never invents a number). These pin
// the pure fact that an absent value has count 0, and that the filter never invents a member.
test("AD4: a value never present in the grid has occurrence count 0 (honest, never invented)", () => {
  const occ = buildOcc({ table: "sheet_a", rows: sheetA }, { table: "sheet_b", rows: sheetB });
  assert.equal(occ.get("Zelda Nonexistent")?.count ?? 0, 0);
  assert.equal(occ.has("Zelda Nonexistent"), false);
});
test("AD4: filtering by a count an absent name could never have yields NO fabricated member", () => {
  const occ = buildOcc({ table: "sheet_a", rows: sheetA }, { table: "sheet_b", rows: sheetB });
  // Even if the (mock) classifier wrongly included a made-up name, entitiesAtCount keys off the REAL
  // occurrence map, so an absent name contributes nothing — it can never be returned as a member.
  const withGhost = entitiesAtCount(occ, [...PEOPLE, "Zelda Nonexistent"], 4).map((t) => t.entity);
  assert.deepEqual(withGhost, ["Alice"]); // the ghost never appears
});
