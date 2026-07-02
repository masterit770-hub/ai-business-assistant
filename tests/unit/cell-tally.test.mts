import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isGridShaped,
  tallyDirection,
  tableScopeForTally,
  filterTargetCount,
  entitiesAtCount,
  accumulateOccurrences,
  computeExtremeTally,
  gridRecurrenceProfile,
  type OccMap,
} from "../../src/lib/engine/cell-tally.ts";
import type { TableSchema } from "../../src/lib/engine/sql-guard.ts";
import type { SqlRow } from "../../src/lib/engine/structured-store.ts";

// The cell-tally lane answers occurrence questions ("which <entity> recurs the MOST", "how many
// times is X scheduled", "who is scheduled exactly N times") over a WIDE/GRID table that a single
// SELECT can't express (a scheduling grid: a person spread across many day columns).
//
// PHRASING-INDEPENDENT TRIGGER: the lane no longer fires off a hand-maintained cue regex (the
// rejected band-aid — "who participates the most" / "who is more active" / "מי הכי פעילה" broke it).
// An LLM intent classifier (classifyOccurrenceIntent) reads the question + the grid schemas and emits
// {ranking | specific-count | filter | none}; CODE then runs the matching pure lane. The INTENT step
// is an LLM call, proven by the LIVE evals (participation-count-her-data.mjs, RED-first + serial), NOT
// unit-tested here. These unit tests pin the DETERMINISTIC pieces that survive: the grid-shape
// discriminator, the direction parse, the table scoping, the integer parse, and the pure tally/filter
// arithmetic (the correctness core that must never silently drift).

// A grid-shaped table: many sparse TEXT columns (the calendar layout).
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

// ── FILTER-TARGET integer parse (the deterministic half of the DV5 filter lane) ────────────────
test("filterTargetCount: extracts the first plain integer, ignores money/decimal/year", () => {
  assert.equal(filterTargetCount("who is scheduled exactly 5 times?"), 5);
  assert.equal(filterTargetCount("מי משובצת בדיוק 3 פעמים?"), 3);
  assert.equal(filterTargetCount("who participates the most?"), null); // no integer
  assert.equal(filterTargetCount("which sessions cost $1,200?"), null); // currency, not a count
  assert.equal(filterTargetCount("who is scheduled in 2024?"), null); // a 4-digit year, not 1–3 digit count
});

// ── GRID SHAPE predicate (shared by all lanes) ────────────────────────────────────────────────
test("isGridShaped: a wide free-text table is a grid; a narrow/numeric one is not", () => {
  assert.equal(isGridShaped(grid), true);
  assert.equal(isGridShaped({ table: "c", columns: [{ name: "id", type: "INTEGER" }, { name: "vendor", type: "TEXT" }, { name: "cost", type: "REAL" }] }), false);
});

// THE CLEAN-TABLE DISCRIMINATOR (the over-count fix): a header-LESS calendar grid (placeholder
// columns) IS a grid and falls to the occurrence-tally fallback; a CLEAN tabular sheet with distinct
// named columns is NOT a grid — it must route to text-to-SQL (GROUP BY the real column) so a name
// that also appears in another column is not over-counted. Keyed only off column NAMES, no dataset.
test("isGridShaped: a CLEAN named-column table is NOT a grid (routes to text-to-SQL, not the tally)", () => {
  // A simple participation log: 4 distinct, meaningful headers, all text. Old logic wrongly called
  // this a grid (wide + text-heavy); now it is NOT — text-to-SQL handles it exactly.
  const cleanTable = {
    table: "participation_log",
    columns: [
      { name: "rowid_anchor", type: "INTEGER" },
      { name: "participant", type: "TEXT" },
      { name: "coach", type: "TEXT" },
      { name: "session", type: "TEXT" },
      { name: "date", type: "TEXT" },
    ],
  };
  assert.equal(isGridShaped(cleanTable), false);
});
test("isGridShaped: a HEADER-LESS grid (placeholder columns) IS still a grid (her scheduling sheets)", () => {
  // The auto-named, header-less calendar layout — the only case the occurrence-tally should own.
  const headerlessGrid = {
    table: "schedule",
    columns: [
      { name: "rowid_anchor", type: "INTEGER" },
      { name: "__EMPTY", type: "TEXT" },
      { name: "__EMPTY_1", type: "TEXT" },
      { name: "__EMPTY_2", type: "TEXT" },
      { name: "__EMPTY_3", type: "TEXT" },
      { name: "1", type: "TEXT" },
    ],
  };
  assert.equal(isGridShaped(headerlessGrid), true);
});
test("isGridShaped: a MOSTLY-named table with one stray placeholder is NOT a grid (majority rule)", () => {
  // 4 named columns + 1 placeholder → still a clean table; the model/SQL reads it.
  const mostlyNamed = {
    table: "log",
    columns: [
      { name: "rowid_anchor", type: "INTEGER" },
      { name: "participant", type: "TEXT" },
      { name: "role", type: "TEXT" },
      { name: "team", type: "TEXT" },
      { name: "notes", type: "TEXT" },
      { name: "__EMPTY", type: "TEXT" },
    ],
  };
  assert.equal(isGridShaped(mostlyNamed), false);
});

// ── DIRECTION: most vs least ──────────────────────────────────────────────────────────────────
test("tallyDirection detects LEAST/FEWEST (EN+HE), defaults to MOST", () => {
  assert.equal(tallyDirection("who is scheduled the most?"), "most");
  assert.equal(tallyDirection("מי משובץ הכי הרבה?"), "most");
  assert.equal(tallyDirection("who is scheduled the least?"), "least");
  assert.equal(tallyDirection("who appears the fewest times?"), "least");
  assert.equal(tallyDirection("מי משובץ הכי מעט?"), "least");
});

// ── SCOPE: a month-named question narrows; a bare/system-wide one spans ALL sheets ────────────
test("tableScopeForTally narrows to a named sheet, else spans all (system-wide default)", () => {
  // Her REAL table set: every sheet shares the common stems "שיבוצים" (schedules) + "גיליון"
  // (sheet); only the MONTH distinguishes them. The common stems must NOT cause a month query to
  // select every sheet (the bug that made "system-wide" and "August" both fan out to all sheets).
  const tables = [
    "שיבוצים_אוגוסט_2024_גיליון1",
    "שיבוצים_דצמבר_2024_גיליון1",
    "שיבוצים_דצמבר_2024_גיליון2",
    "שיבוצים_יולי_2024_גיליון1",
    "שיבוצים_יוני_2024_גיליון1",
  ];
  // Hebrew month named → narrows to ONLY the august sheet (the common "שיבוצים" stem does NOT
  // drag in the other months).
  assert.deepEqual(
    tableScopeForTally("בשיבוצי אוגוסט מי משובץ הכי הרבה?", tables),
    ["שיבוצים_אוגוסט_2024_גיליון1"]
  );
  // Hebrew month named → narrows to BOTH december sheets (the named month spans its two sheets).
  assert.deepEqual(
    tableScopeForTally("בשיבוצים של דצמבר מי משובץ הכי הרבה?", tables),
    ["שיבוצים_דצמבר_2024_גיליון1", "שיבוצים_דצמבר_2024_גיליון2"]
  );
  // No month / system-wide → spans them ALL (the cross-sheet true max). The common stem
  // "שיבוצים" in "במערכת"/bare phrasings must NOT be treated as a month selector.
  assert.deepEqual(tableScopeForTally("מי משובץ הכי הרבה במערכת", tables), tables);
  assert.deepEqual(tableScopeForTally("מי משובץ הכי הרבה?", tables), tables);
  // An English-named sheet set: the English month word narrows to it.
  const enTables = ["schedule_august_2024", "schedule_july_2024", "schedule_june_2024"];
  assert.deepEqual(tableScopeForTally("who is scheduled most in august?", enTables), ["schedule_august_2024"]);
  // A single grid table → trivially itself.
  assert.deepEqual(tableScopeForTally("who is scheduled most?", ["only_sheet"]), ["only_sheet"]);
});

// ── FIXTURE-GRID TALLY CORRECTNESS (the verifier's ask: pin the deterministic tally, not just the
// trigger boundary). A mock-classifier fixture grid + a FIXED entity set drive the pure tally so
// ground-truth can't silently drift. Two sheets; a person appears ACROSS them, and an activity/
// place label out-frequencies the people in a naive count but is EXCLUDED by the entity set.
function rowsOf(table: string, grid: Record<string, string>[]): SqlRow[] {
  return grid.map((data, i) => ({ table, id: i + 1, data }));
}

// SHEET A (5 rows). Raw cell frequencies: "Gift Room" appears 4× (an ACTIVITY/PLACE — must be
// excluded from the people ranking), "Alice" 2×, "Bob" 2×, "Cara" 1×.
const sheetA = rowsOf("sheet_a", [
  { rowid_anchor: "1", d1: "Gift Room", d2: "Alice", d3: "Bob" },
  { rowid_anchor: "2", d1: "Gift Room", d2: "Alice", d3: "Cara" },
  { rowid_anchor: "3", d1: "Gift Room", d2: "Bob", d3: "" },
  { rowid_anchor: "4", d1: "Gift Room", d2: "", d3: "" },
  { rowid_anchor: "5", d1: "", d2: "", d3: "" },
]);
// SHEET B (3 rows). "Alice" 2×, "Bob" 1×, "Dora" 3×. Summed across A+B: Dora=3, Alice=4, Bob=3,
// Cara=1. So the people MAX (=4) is Alice (unique); the people MIN (=1) is Cara (unique).
const sheetB = rowsOf("sheet_b", [
  { rowid_anchor: "1", d1: "Dora", d2: "Alice" },
  { rowid_anchor: "2", d1: "Dora", d2: "Alice" },
  { rowid_anchor: "3", d1: "Dora", d2: "Bob" },
]);
// The entity set the (mocked) classifier returns — PEOPLE only, excluding the "Gift Room" place.
const PEOPLE = ["Alice", "Bob", "Cara", "Dora"];

function buildOcc(...sheets: SqlRow[][]): OccMap {
  const occ: OccMap = new Map();
  for (const [i, rows] of sheets.entries()) accumulateOccurrences(occ, `sheet_${"ab"[i]}`, rows);
  return occ;
}

test("fixture tally: cross-sheet sum is EXACT and excludes the activity label", () => {
  const occ = buildOcc(sheetA, sheetB);
  // The activity "Gift Room" is counted in the raw occurrences (4×)…
  assert.equal(occ.get("Gift Room")!.count, 4);
  // …but it is NOT in the people entity set, so the tally must drop it.
  const { tally } = computeExtremeTally(occ, PEOPLE, "most");
  assert.ok(!tally.some((t) => t.entity === "Gift Room"), "activity leaked into the people tally");
  const counts = Object.fromEntries(tally.map((t) => [t.entity, t.count]));
  assert.deepEqual(counts, { Alice: 4, Bob: 3, Dora: 3, Cara: 1 }); // exact cross-sheet sums
});

test("fixture tally: MOST picks the true max group (no collapse, no activity, no non-max)", () => {
  const occ = buildOcc(sheetA, sheetB);
  const { extremeGroup } = computeExtremeTally(occ, PEOPLE, "most");
  assert.deepEqual(extremeGroup.map((t) => t.entity), ["Alice"]); // unique max @4
  assert.equal(extremeGroup[0].count, 4);
  // Its anchors span the sheets she actually appears in (cross-table citation correctness).
  assert.ok(extremeGroup[0].anchors.some((a) => a.table === "sheet_a"));
  assert.ok(extremeGroup[0].anchors.some((a) => a.table === "sheet_b"));
});

test("fixture tally: a genuine TIE at the max is returned IN FULL (never collapsed)", () => {
  // Make Bob tie Alice at the top: add one more Bob occurrence on a 3rd sheet.
  const occ = buildOcc(sheetA, sheetB);
  accumulateOccurrences(occ, "sheet_c", rowsOf("sheet_c", [{ rowid_anchor: "1", d1: "Bob" }]));
  // Now Alice=4, Bob=4 → a 2-way tie at the max. The extreme group must contain BOTH.
  const { extremeGroup } = computeExtremeTally(occ, PEOPLE, "most");
  assert.equal(extremeGroup[0].count, 4);
  assert.deepEqual(extremeGroup.map((t) => t.entity).sort(), ["Alice", "Bob"]);
});

test("fixture tally: LEAST picks the MIN group, not the max (direction is honored)", () => {
  const occ = buildOcc(sheetA, sheetB);
  const { extremeGroup } = computeExtremeTally(occ, PEOPLE, "least");
  assert.deepEqual(extremeGroup.map((t) => t.entity), ["Cara"]); // unique min @1
  assert.equal(extremeGroup[0].count, 1);
});

// ── GRID RECURRENCE PROFILE — the CODE half of the cross-corpus grid SELECTION fix (the EN
// "most active person" mis-routed to the bundled `contracts` grid). selectTallyGridsByKind is
// LLM-driven (the entity-kind classifier), but its grid-qualification rests on this PURE profile:
// a grid only ranks "most X" if some value RECURS (count > 1). A normalized relational roster
// (every person listed once) has NO recurrence — so it can never be picked as a "most active"
// frequency grid, no matter that its values ARE person-names. The scheduling grid (a person
// spread across many day cells) DOES recur. This pins that separation deterministically.
test("gridRecurrenceProfile: a recurring scheduling grid surfaces recurring values + the max", () => {
  // Two people recur across cells (the calendar layout): Alice 4×, Bob 3×, Cara 1× (summed A+B).
  const occ = buildOcc(sheetA, sheetB);
  const { recurringValues, maxCount } = gridRecurrenceProfile(occ);
  assert.equal(maxCount, 4); // Alice's cross-sheet max (Gift Room also 4, but it still recurs)
  // Alice/Bob/Dora/Gift Room recur (>1); Cara (1×) does NOT.
  assert.ok(recurringValues.includes("Alice"));
  assert.ok(recurringValues.includes("Bob"));
  assert.ok(!recurringValues.includes("Cara"), "a once-only value must not count as recurring");
});

test("gridRecurrenceProfile: a normalized roster (every value once) has NO recurrence — not a frequency grid", () => {
  // A `people`/`payroll`-style roster: each name appears exactly once. There is no "most" to rank,
  // so the profile reports no recurring values and a max of 1 → selectTallyGridsByKind drops it.
  const roster = rowsOf("people", [
    { rowid_anchor: "1", first_name: "Ann", last_name: "Lee" },
    { rowid_anchor: "2", first_name: "Ben", last_name: "Roy" },
    { rowid_anchor: "3", first_name: "Cyd", last_name: "Fox" },
  ]);
  const occ: OccMap = new Map();
  accumulateOccurrences(occ, "people", roster);
  const { recurringValues, maxCount } = gridRecurrenceProfile(occ);
  assert.equal(maxCount, 1);
  assert.deepEqual(recurringValues, []);
});
