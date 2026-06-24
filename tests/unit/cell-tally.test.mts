import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCellTallyQuestion,
  isCellCountQuestion,
  isGridShaped,
  tallyDirection,
  tableScopeForTally,
  accumulateOccurrences,
  computeExtremeTally,
  gridRecurrenceProfile,
  type OccMap,
} from "../../src/lib/engine/cell-tally.ts";
import type { TableSchema } from "../../src/lib/engine/sql-guard.ts";
import type { SqlRow } from "../../src/lib/engine/structured-store.ts";

// The cell-tally lane answers "which <entity> recurs the MOST" over a WIDE/GRID table that a
// single SELECT can't express (a scheduling grid: a person spread across many day columns).
// isCellTallyQuestion is the PURE trigger (no LLM) — it must fire for an occurrence-ranking
// question on a grid-shaped table, and NOT fire for an ordinary aggregate or a narrow table,
// so normal text-to-SQL keeps owning the cases it handles well. These pin that boundary.

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

// A normal narrow/numeric table — ordinary SQL aggregate territory.
const contracts: TableSchema = {
  table: "contracts",
  columns: [
    { name: "id", type: "INTEGER" },
    { name: "vendor", type: "TEXT" },
    { name: "annual_cost", type: "REAL" },
  ],
};

test("FIRES on a Hebrew 'who is scheduled most' question over a grid table", () => {
  assert.equal(isCellTallyQuestion("מי הכי משובץ באוגוסט?", grid), true);
  assert.equal(isCellTallyQuestion("מי הבת שמשובצת הכי הרבה?", grid), true);
});

test("FIRES on an English 'who appears the most / scheduled most often' over a grid table", () => {
  assert.equal(isCellTallyQuestion("who is scheduled the most this month?", grid), true);
  assert.equal(isCellTallyQuestion("which person appears most frequently?", grid), true);
});

test("does NOT fire on an ordinary aggregate question (total/count) — SQL owns it", () => {
  assert.equal(isCellTallyQuestion("what is the total annual cost?", grid), false);
  assert.equal(isCellTallyQuestion("how many rows are there?", grid), false);
});

test("does NOT fire on a NARROW table even for a 'most' question (not a grid)", () => {
  // "which vendor has the most contracts" is a real GROUP BY — SQL handles it; not a cell grid.
  assert.equal(isCellTallyQuestion("which vendor appears the most?", contracts), false);
});

test("does NOT fire when the ranking cue is absent (a plain lookup over the grid)", () => {
  assert.equal(isCellTallyQuestion("who is scheduled on August 1st?", grid), false);
  assert.equal(isCellTallyQuestion("מתי משובצת אדירה סגל?", grid), false);
});

test("does NOT fire on a mostly-numeric wide table (a real metrics table, not a name grid)", () => {
  const metrics: TableSchema = {
    table: "metrics",
    columns: [
      { name: "rowid_anchor", type: "INTEGER" },
      { name: "jan", type: "REAL" },
      { name: "feb", type: "REAL" },
      { name: "mar", type: "REAL" },
      { name: "apr", type: "REAL" },
      { name: "label", type: "TEXT" },
    ],
  };
  // Only 1 text column among 5 data columns → not a name grid → SQL aggregate territory.
  assert.equal(isCellTallyQuestion("which month appears most?", metrics), false);
});

// ── BROADENED TRIGGER: the NATURAL phrasings the live regression exposed ──────────────────────
// The lane passed the eval's exact "August" string but missed the variations the client actually
// types. These pin that the broadened trigger fires for a NO-MONTH "מי משובץ הכי הרבה", a
// SYSTEM-WIDE "במערכת", an English "most active", and a "LEAST" — all over a grid table.
test("FIRES on the live-regression natural variations over a grid table", () => {
  assert.equal(isCellTallyQuestion("מי משובץ הכי הרבה?", grid), true); // no month — RED #1
  assert.equal(isCellTallyQuestion("מי משובץ הכי הרבה במערכת", grid), true); // system-wide — RED #2
  assert.equal(isCellTallyQuestion("who is the most active person in the schedules?", grid), true);
  // The EXACT bare live-failing phrasing (NO "in the schedules" scheduling-context cue) — the
  // planner punted on this and the lane never fired live; it MUST trigger the tally now.
  assert.equal(isCellTallyQuestion("who is the most active person", grid), true);
  assert.equal(isCellTallyQuestion("מי משובץ הכי מעט בשיבוצים?", grid), true); // least
  assert.equal(isCellTallyQuestion("who is scheduled the least?", grid), true);
});

// ── ATTRIBUTE-SUPERLATIVE EXCLUSION (the AD2 regression) ───────────────────────────────────────
// Broadening the lane to fire even when the planner punts re-exposed a fabrication risk: an
// INTRINSIC-ATTRIBUTE superlative ("who is the OLDEST/youngest/tallest in the schedules?") is a
// ranking by a PROPERTY of the person (age/height), NOT by how often they occur — her grid holds
// no ages, so the tally must NOT fire and crown the most-scheduled person as "the oldest" (the
// recorded AD2 RED). The bare dataset noun "schedules"/"שיבוצים" is a context word, not a
// frequency cue. The lane stays OFF for attribute superlatives so the honest "no age data" path
// answers. GENERAL — a linguistic class of superlative, not a dataset-specific block-list.
test("does NOT fire on an INTRINSIC-ATTRIBUTE superlative (oldest/youngest), HE+EN — AD2 guard", () => {
  assert.equal(isCellTallyQuestion("מי הבת הכי מבוגרת בשיבוצים?", grid), false); // oldest — the live AD2 RED
  assert.equal(isCellTallyQuestion("מי הצעירה ביותר בשיבוצים?", grid), false); // youngest
  assert.equal(isCellTallyQuestion("who is the oldest person in the schedules?", grid), false);
  assert.equal(isCellTallyQuestion("who is the tallest girl scheduled?", grid), false);
  // The cell-COUNT lane must also stay off for an attribute superlative (defense-in-depth).
  assert.equal(isCellCountQuestion("מי הבת הכי מבוגרת בשיבוצים?", grid), false);
});

// ── SPECIFIC-VALUE COUNT (DV4) — "how many times is <X> scheduled" over a grid ──────────────────
// A specific-value occurrence COUNT (not a ranking, not a row count) needs the cell-count lane: a
// single guarded GROUP BY on one column can't count a value across the grid's many columns (the
// live RED: the SQL lane answered "0" for a name that appears 15×). isCellCountQuestion is the pure
// trigger — it must fire for "how many times" / "כמה פעמים", and NOT for a ranking or a row count.
test("isCellCountQuestion FIRES on a specific-value occurrence count over a grid", () => {
  assert.equal(isCellCountQuestion("כמה פעמים רינה אנטוב משובצת?", grid), true);
  assert.equal(isCellCountQuestion("כמה פעמים רינה אנטוב משובצת באוגוסט?", grid), true);
  assert.equal(isCellCountQuestion("how many times is Rina scheduled?", grid), true);
});
test("isCellCountQuestion does NOT fire on a RANKING (that's the tally lane) or a row count", () => {
  // A superlative ranking → the tally lane owns it, not the count lane.
  assert.equal(isCellCountQuestion("מי משובץ הכי הרבה פעמים?", grid), false);
  assert.equal(isCellCountQuestion("who is scheduled the most times?", grid), false);
  // A plain row count is an ordinary SQL aggregate, not a cell occurrence count.
  assert.equal(isCellCountQuestion("how many rows are there?", grid), false);
  // No grid shape → not this lane.
  const narrow: TableSchema = { table: "t", columns: [{ name: "id", type: "INTEGER" }, { name: "name", type: "TEXT" }] };
  assert.equal(isCellCountQuestion("how many times is X listed?", narrow), false);
});

// ── GRID SHAPE predicate (shared by both lanes) ────────────────────────────────────────────────
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
