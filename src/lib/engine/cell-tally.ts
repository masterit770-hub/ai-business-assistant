// CELL-TALLY LANE — a GENERAL fallback for "which <entity> appears/recurs the MOST"
// questions over a WIDE / GRID-SHAPED uploaded table that single-SELECT text-to-SQL cannot
// express.
//
// WHY THIS EXISTS (the recorded client miss): a monthly scheduling sheet is a CALENDAR GRID —
// days are columns, and each cell under a day holds a day-header, an activity/event label, OR
// a person's name, all intermixed across ~10 sparse text columns. "Who is scheduled the most?"
// is a frequency-of-occurrence ACROSS columns. A single guarded SELECT can't do it (counting a
// value across N columns needs UNION/subqueries the guard rejects), and a plain GROUP BY on one
// column returns a wrong row. Asking the model to eyeball-count the whole grid is unreliable too
// — it miscounts (a live POC returned 4 where the true max was 5).
//
// THE GENERAL APPROACH (no hardcoded names, no corpus tuning):
//   1. Fetch ALL the table's rows (read-only, capped) — the model never had them before.
//   2. CODE computes the EXACT frequency of every distinct non-empty cell value (deterministic;
//      the model is bad at tallying, code is perfect at it).
//   3. The MODEL classifies the DISTINCT values into "the entity the question ranks" vs noise
//      (day-headers, dates, activity/event/place labels) — the one judgment SQL can't make and
//      the model IS good at. One JSON call, temperature 0.
//   4. CODE intersects: tally only the classified entities, sort, take the top group, and find
//      the real row ids where each top entity occurs so the answer cites [S:table#rowid].
//
// Reliability comes from the split: exact counts are CODE's job, semantic classification is the
// MODEL's job. A live check showed this is consistent run-to-run and matches a hand-computed
// ground truth, while excluding activities/rooms from "people". It generalizes to any wide table
// in any language — it keys off table SHAPE + the question, never a specific dataset.
import { chatWithUsage, type ChatUsage } from "./llm.ts";
import {
  selectWithIds,
  type CatalogScope,
  type SqlRow,
} from "./structured-store.ts";
import type { TableSchema } from "./sql-guard.ts";
import { HARD_ROW_CAP } from "./sql-guard.ts";

export type CellTallyResult = {
  // The aggregate rows to cite: one synthetic row per top entity, carrying its exact count
  // and the table#rowid anchors where it occurs. Empty when the lane couldn't apply.
  rows: SqlRow[];
  // The exact tally the grounded generator can restate (entity → count), top group first.
  tally: { entity: string; count: number; rowIds: number[] }[];
  table: string | null;
  ok: boolean;
  note?: string;
  usages: ChatUsage[];
};

// Columns that are bookkeeping, never tallied.
const ANCHOR_COLS = new Set(["rowid_anchor", "id"]);

/**
 * Decide whether THIS question over THIS table is a cell-tally case: a "which/who recurs the
 * MOST / appears most often / is scheduled most / is the most frequent" ranking-by-occurrence
 * question over a WIDE table whose values are spread across many text columns. Conservative by
 * design — it only fires for an occurrence-frequency question on a genuinely grid-shaped table,
 * so an ordinary aggregate ("total cost", "count of contracts") still goes through SQL. Pure +
 * exported for unit testing (no LLM): keyed off the question's wording + the table's shape.
 */
export function isCellTallyQuestion(question: string, table: TableSchema): boolean {
  const q = question.toLowerCase();
  // A frequency/ranking-by-occurrence intent in EN or HE. We require BOTH a superlative/ranking
  // cue AND an occurrence/appearance/scheduling cue, so a plain "how many rows" doesn't match.
  const ranks =
    /\b(most|fewest|least|top|highest|lowest|rank|ranked)\b/.test(q) ||
    /(הכי|הרבה ביותר|הכי הרבה|המשובצת|משובצת הכי|הכי משובץ|הנפוץ|השכיח|התדירות)/.test(question);
  const occurs =
    /\b(appear|appears|scheduled|recur|recurs|frequent|frequency|occurr?ence|times|listed|assigned)\b/.test(q) ||
    /(משובץ|משובצת|שיבוצ|מופיע|מופיעה|פעמים|הופעות|שובץ|שובצה|תדירות)/.test(question);
  if (!(ranks && occurs)) return false;
  // GRID SHAPE: many columns, and most are free-text (not numeric) — the layout where a value
  // recurs ACROSS columns. A narrow or mostly-numeric table is a normal SQL aggregate, not this.
  const dataCols = table.columns.filter((c) => !ANCHOR_COLS.has(c.name.toLowerCase()));
  if (dataCols.length < 4) return false;
  const textCols = dataCols.filter((c) => (c.type || "TEXT").toUpperCase() !== "REAL");
  return textCols.length >= Math.max(3, Math.ceil(dataCols.length / 2));
}

/**
 * Run the cell-tally lane over one table. Fetches every row, has the model classify which
 * distinct cell values are the entity being ranked, tallies them EXACTLY in code, and returns
 * the top group as citable rows. Fail-soft: any error returns {ok:false} (the caller then
 * falls back to the honest grounded-limit path) — it never throws or fabricates.
 */
export async function tallyCellOccurrences(
  question: string,
  table: string,
  catalog: TableSchema[],
  scope?: CatalogScope
): Promise<CellTallyResult> {
  const usages: ChatUsage[] = [];
  const schema = catalog.find((c) => c.table === table);
  if (!schema) return { rows: [], tally: [], table: null, ok: false, note: "table not in catalog", usages };
  // 1. Fetch ALL rows (read-only, capped). selectWithIds tags each row with its citation id.
  let rows: SqlRow[];
  try {
    rows = selectWithIds(`SELECT * FROM "${table}" LIMIT ${HARD_ROW_CAP}`, table, catalog, scope);
  } catch (e) {
    return { rows: [], tally: [], table, ok: false, note: e instanceof Error ? e.message : String(e), usages };
  }
  if (rows.length === 0) return { rows: [], tally: [], table, ok: false, note: "no rows to tally", usages };

  // 2. CODE: exact frequency of every distinct non-empty cell value, with the row ids it occurs
  //    in (for citation). A value seen twice in one row counts twice (a real double-booking).
  const freq = new Map<string, { count: number; rowIds: Set<number> }>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.data)) {
      if (ANCHOR_COLS.has(k.toLowerCase())) continue;
      const s = String(v ?? "").trim();
      if (!s) continue;
      const e = freq.get(s) ?? { count: 0, rowIds: new Set<number>() };
      e.count += 1;
      e.rowIds.add(r.id);
      freq.set(s, e);
    }
  }
  const distinct = [...freq.keys()];
  if (distinct.length === 0) return { rows: [], tally: [], table, ok: false, note: "all cells empty", usages };

  // 3. MODEL: which distinct values are the entity the question ranks (a person/name/etc.) vs
  //    noise (day-headers, dates, activity/event/place labels)? One JSON call, temperature 0.
  const { entities, usage } = await classifyEntities(question, distinct);
  usages.push(usage);
  if (entities.length === 0) {
    return { rows: [], tally: [], table, ok: false, note: "no entities classified to rank", usages };
  }

  // 4. CODE: tally ONLY the classified entities (exact counts from step 2), sort, take the top
  //    group (all entities tied at the max count). Build a citable synthetic row per top entity.
  const entitySet = new Set(entities);
  const tallied = distinct
    .filter((v) => entitySet.has(v))
    .map((entity) => ({ entity, count: freq.get(entity)!.count, rowIds: [...freq.get(entity)!.rowIds].sort((a, b) => a - b) }))
    .sort((a, b) => b.count - a.count || a.entity.localeCompare(b.entity));
  if (tallied.length === 0) {
    return { rows: [], tally: [], table, ok: false, note: "no classified entity had a tally", usages };
  }
  const maxCount = tallied[0].count;
  const topGroup = tallied.filter((t) => t.count === maxCount);

  // Synthetic citable rows: each top entity → a row whose data IS the verified count, anchored to
  // a real rowid where that entity appears (so [S:table#rowid] resolves to a row that contains it).
  const citeRows: SqlRow[] = topGroup.map((t) => ({
    table,
    id: t.rowIds[0],
    data: { entity: t.entity, occurrences: t.count },
  }));

  return { rows: citeRows, tally: tallied, table, ok: true, usages };
}

/**
 * Classify which of the distinct cell values are the ENTITY the question ranks (e.g. a person's
 * name), excluding day-headers, dates, and activity/event/place labels. Returns the verbatim
 * subset. JSON, temperature 0 — deterministic; copies values exactly so the code tally matches.
 */
async function classifyEntities(
  question: string,
  distinct: string[]
): Promise<{ entities: string[]; usage: ChatUsage }> {
  const system = `You are given the QUESTION a user asked about a spreadsheet, and a list of DISTINCT cell values from that spreadsheet. The question ranks some kind of ENTITY by how often it appears (e.g. which PERSON is scheduled most). Decide which of the listed values ARE that entity (e.g. a person's full name) and which are NOT.

NOT the entity (exclude these): a day-of-week or date header (e.g. a weekday name followed by a date), a month or holiday name, and any activity / event / task / workshop / outing / place / room / location label. These describe WHAT happens or WHERE, not WHO — even though they sit in the same cells. Judge by meaning, in whatever language the values are written.

Return ONLY JSON: {"entities": ["...the values that ARE the entity being ranked..."]}.
- Include a value ONLY if it is the entity the question is about (when in doubt about a plausible person name, include it; when a value is clearly an activity/place/date/header, exclude it).
- COPY each value EXACTLY as written (same characters, same spacing) — do not translate, reformat, or merge.
- Do not invent values that are not in the list.`;
  const user = `QUESTION: ${question}

DISTINCT VALUES:
${distinct.map((v) => `- ${v}`).join("\n")}

Return the JSON now.`;
  const { content, usage } = await chatWithUsage(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { json: true, temperature: 0 }
  );
  let entities: string[] = [];
  try {
    const parsed = JSON.parse(content);
    const valid = new Set(distinct);
    // Keep only values that are REALLY in the distinct set (the model must not invent), exact match.
    entities = Array.isArray(parsed.entities)
      ? parsed.entities.filter((e: unknown): e is string => typeof e === "string" && valid.has(e))
      : [];
  } catch {
    entities = [];
  }
  return { entities, usage };
}
