import { test } from "node:test";
import assert from "node:assert/strict";
import { isCellTallyQuestion } from "../../src/lib/engine/cell-tally.ts";
import type { TableSchema } from "../../src/lib/engine/sql-guard.ts";

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
