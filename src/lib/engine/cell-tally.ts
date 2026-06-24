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
  // `rowIds` are LEGACY (single-table) anchors; `anchors` carries the table-qualified
  // anchors so a cross-table tally cites the right table for each occurrence.
  tally: { entity: string; count: number; rowIds: number[]; anchors: { table: string; id: number }[] }[];
  // The table(s) the tally spanned (one for a month-scoped question; many for system-wide).
  table: string | null;
  tables: string[];
  // Which extreme the question asked for: "most" (the default — highest occurrence count) or
  // "least" (lowest). The top group + cited rows are the entities at THAT extreme. The grounded
  // generator + the content-fidelity gate use this so a "who is scheduled the LEAST" question is
  // answered (and checked) against the MINIMUM group, never the maximum.
  direction: "most" | "least";
  ok: boolean;
  note?: string;
  usages: ChatUsage[];
};

// Does the question ask for the LEAST/FEWEST rather than the MOST? EN + HE. Conservative: only
// an explicit fewest/least cue flips direction; the default is "most". Pure + exported for tests.
export function tallyDirection(question: string): "most" | "least" {
  const q = question.normalize("NFC").toLowerCase();
  if (/\b(least|fewest|lowest)\b/.test(q) || /(הכי מעט|הכי פחות|המעט ביותר|הפחות)/.test(question)) {
    return "least";
  }
  return "most";
}

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
  const q = question.normalize("NFC").toLowerCase();
  // A frequency/ranking-by-occurrence intent in EN or HE. We require BOTH a superlative/ranking
  // cue AND an occurrence/appearance/scheduling/activity cue, so a plain "how many rows" doesn't
  // match. The cue lists are broadened to the NATURAL phrasings the client actually types (not
  // just the one eval string): "who is scheduled the MOST", a no-month "מי משובץ הכי הרבה", a
  // system-wide "מי משובץ הכי הרבה במערכת", "who is the MOST ACTIVE / BUSIEST person", "who is
  // scheduled the LEAST". GENERAL — keyed off the question's words + the table SHAPE below.
  const ranks =
    /\b(most|fewest|least|top|highest|lowest|busiest|rank|ranked|first)\b/.test(q) ||
    /(הכי|הרבה ביותר|הכי הרבה|הכי מעט|המשובצת|משובצת הכי|הכי משובץ|הנפוץ|השכיח|התדירות|ביותר)/.test(question);
  const occurs =
    /\b(appear|appears|scheduled|schedule|recur|recurs|frequent|frequency|occurr?ence|times|listed|assigned|active|busy)\b/.test(q) ||
    /(משובץ|משובצת|משובצים|שיבוצ|מופיע|מופיעה|פעמים|הופעות|שובץ|שובצה|תדירות|פעיל|עסוק)/.test(question);
  if (!(ranks && occurs)) return false;
  // GRID SHAPE: many columns, and most are free-text (not numeric) — the layout where a value
  // recurs ACROSS columns. A narrow or mostly-numeric table is a normal SQL aggregate, not this.
  const dataCols = table.columns.filter((c) => !ANCHOR_COLS.has(c.name.toLowerCase()));
  if (dataCols.length < 4) return false;
  const textCols = dataCols.filter((c) => (c.type || "TEXT").toUpperCase() !== "REAL");
  return textCols.length >= Math.max(3, Math.ceil(dataCols.length / 2));
}

/**
 * Decide which grid table(s) a cell-tally question should span, from the relevant tables the
 * planner already chose. The default is "tally EVERY grid table the planner picked and aggregate
 * across them" — so a no-month, system-wide ("across all", "in the system", "overall"), or
 * multi-sheet question reports the TRUE max across her sheets instead of one sheet's local max.
 * If the question NAMES a specific month/sheet keyword that matches some of those tables, we
 * narrow to the matching ones (so "who is scheduled most in August" tallies only August). This
 * is GENERAL: it keys off the question's words vs. the table NAMES, never a specific dataset.
 *
 * Pure + exported so the scoping boundary is unit-tested without an LLM or a DB.
 */
export function tableScopeForTally(question: string, gridTables: string[]): string[] {
  if (gridTables.length <= 1) return gridTables;
  const q = question.normalize("NFC").toLowerCase();
  const segsOf = (t: string) =>
    t.normalize("NFC").toLowerCase().split(/[_\d]+/).filter((s) => s.length >= 2);
  // A segment that appears in EVERY candidate table's name is a COMMON STEM (e.g. "שיבוצים"
  // ("schedules") / "גיליון" ("sheet") shared by all her monthly sheets) — it is NOT a
  // distinguishing month/sheet word, so matching it would select every table and defeat the
  // scoping. We exclude such all-common segments; only a DISTINGUISHING segment (a month name,
  // a sheet number's word) narrows the scope.
  const counts = new Map<string, number>();
  for (const t of gridTables) for (const s of new Set(segsOf(t))) counts.set(s, (counts.get(s) ?? 0) + 1);
  const distinctive = (s: string) => (counts.get(s) ?? 0) < gridTables.length;
  // A table is "named by the question" when one of its DISTINGUISHING segments appears verbatim
  // in the question. This matches a month/sheet word the user typed (in the sheet's own language)
  // against the table's own name — no hardcoded month list.
  const named = gridTables.filter((t) =>
    segsOf(t).some((s) => distinctive(s) && q.includes(s))
  );
  // If the user named one/some specific sheet(s), scope to those; otherwise span them ALL
  // (the system-wide / no-month default — the TRUE cross-sheet max).
  return named.length > 0 ? named : gridTables;
}

/**
 * Run the cell-tally lane over ONE table (compat wrapper). Delegates to the cross-table
 * implementation with a single-table list, so a one-table tally is identical to before.
 */
export async function tallyCellOccurrences(
  question: string,
  table: string,
  catalog: TableSchema[],
  scope?: CatalogScope
): Promise<CellTallyResult> {
  return tallyCellOccurrencesAcross(question, [table], catalog, scope);
}

/**
 * Run the cell-tally lane across ONE OR MORE grid tables and aggregate into a SINGLE coherent
 * ranking. Fetches every row of every table, has the model classify which distinct cell values
 * are the entity being ranked (one call over the UNION of distinct values), tallies them EXACTLY
 * in code SUMMED ACROSS the tables, and returns the FULL top tie group as citable rows whose
 * table-qualified anchors AGREE with the tally. This is the fix for the multi-sheet bug: the old
 * per-table loop overwrote a single `verifiedTally` while accumulating disjoint per-table top
 * groups, so the stated leader/count and the cited rows disagreed (a tie collapsed to one name,
 * a non-max reported as the max). Aggregating once makes the tally and the citations consistent
 * and surfaces the real cross-sheet maximum. Fail-soft: any error → {ok:false}.
 */
export async function tallyCellOccurrencesAcross(
  question: string,
  tables: string[],
  catalog: TableSchema[],
  scope?: CatalogScope
): Promise<CellTallyResult> {
  const usages: ChatUsage[] = [];
  const direction = tallyDirection(question);
  const present = tables.filter((t) => catalog.some((c) => c.table === t));
  if (present.length === 0) {
    return { rows: [], tally: [], table: null, tables: [], direction, ok: false, note: "no table in catalog", usages };
  }

  // 1. Fetch ALL rows of EVERY table (read-only, capped per table). Each occurrence keeps the
  //    table it came from so a cross-sheet tally cites the correct sheet for each anchor.
  const occ = new Map<string, { count: number; anchors: Map<string, { table: string; id: number }> }>();
  let totalRows = 0;
  for (const table of present) {
    let rows: SqlRow[];
    try {
      rows = selectWithIds(`SELECT * FROM "${table}" LIMIT ${HARD_ROW_CAP}`, table, catalog, scope);
    } catch (e) {
      // One unreadable sheet must not sink the whole tally — skip it, keep the others.
      usages.push({ live: false, provider: "—", model: "—" } as ChatUsage);
      void e;
      continue;
    }
    totalRows += rows.length;
    accumulateOccurrences(occ, table, rows);
  }
  if (totalRows === 0) return { rows: [], tally: [], table: present[0], tables: present, direction, ok: false, note: "no rows to tally", usages };
  const distinct = [...occ.keys()];
  if (distinct.length === 0) {
    return { rows: [], tally: [], table: present[0], tables: present, direction, ok: false, note: "all cells empty", usages };
  }

  // 2. MODEL: which distinct values are the entity the question ranks vs noise (day-headers,
  //    dates, activity/event/place labels)? ONE JSON call over the union of distinct values.
  const { entities, usage } = await classifyEntities(question, distinct);
  usages.push(usage);
  if (entities.length === 0) {
    return { rows: [], tally: [], table: present[0], tables: present, direction, ok: false, note: "no entities classified to rank", usages };
  }

  // 3. CODE: tally ONLY the classified entities (exact counts SUMMED across tables) and take the
  //    extreme group. This arithmetic is the pure `computeExtremeTally` (unit-pinned with a fixed
  //    entity set, no LLM/DB), so a deterministic ground-truth tally can't silently drift.
  const { tally: tallied, extremeGroup } = computeExtremeTally(occ, entities, direction);
  if (tallied.length === 0) {
    return { rows: [], tally: [], table: present[0], tables: present, direction, ok: false, note: "no classified entity had a tally", usages };
  }

  // Synthetic citable rows: each extreme entity → a row whose data IS the verified count, anchored
  // to a real table#rowid where that entity appears (so [S:table#rowid] resolves to a row with it).
  const citeRows: SqlRow[] = extremeGroup.map((t) => ({
    table: t.anchors[0].table,
    id: t.anchors[0].id,
    data: { entity: t.entity, occurrences: t.count },
  }));

  return { rows: citeRows, tally: tallied, table: present[0], tables: present, direction, ok: true, usages };
}

// The per-entity occurrence accumulator: distinct cell value → its total count + the
// table-qualified row anchors it occurs in. Exported shape so the pure tally can be tested.
export type OccMap = Map<string, { count: number; anchors: Map<string, { table: string; id: number }> }>;

// Accumulate one table's rows into the cross-table occurrence map. A value seen twice in one row
// counts twice (a real double-booking); the anchor for a (table,row) is recorded once. Pure
// (mutates the passed map) — the counting half of the lane, split out so it is testable.
export function accumulateOccurrences(occ: OccMap, table: string, rows: SqlRow[]): void {
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.data)) {
      if (ANCHOR_COLS.has(k.toLowerCase())) continue;
      const s = String(v ?? "").trim();
      if (!s) continue;
      const e = occ.get(s) ?? { count: 0, anchors: new Map() };
      e.count += 1;
      const key = `${table}#${r.id}`;
      if (!e.anchors.has(key)) e.anchors.set(key, { table, id: r.id });
      occ.set(s, e);
    }
  }
}

export type TallyEntry = { entity: string; count: number; rowIds: number[]; anchors: { table: string; id: number }[] };

/**
 * THE PURE TALLY (no LLM, no DB). Given the accumulated occurrences, the classified entity set,
 * and the direction, produce the full DESCENDING-sorted tally AND the extreme group (the max-count
 * group for "most", the min-count group for "least"). This is the CORRECTNESS core: a fixture grid
 * + a fixed entity set pins exactly which names tie at the extreme and at what count, so the
 * deterministic tally can't silently drift (the verifier's request). Pure + exported.
 */
export function computeExtremeTally(
  occ: OccMap,
  entities: string[],
  direction: "most" | "least"
): { tally: TallyEntry[]; extremeGroup: TallyEntry[] } {
  const entitySet = new Set(entities);
  const tally: TallyEntry[] = [...occ.keys()]
    .filter((v) => entitySet.has(v))
    .map((entity) => {
      const e = occ.get(entity)!;
      const anchors = [...e.anchors.values()].sort((a, b) => a.table.localeCompare(b.table) || a.id - b.id);
      return { entity, count: e.count, rowIds: anchors.map((a) => a.id), anchors };
    })
    .sort((a, b) => b.count - a.count || a.entity.localeCompare(b.entity));
  if (tally.length === 0) return { tally, extremeGroup: [] };
  const extremeCount = direction === "least" ? tally[tally.length - 1].count : tally[0].count;
  const extremeGroup = tally.filter((t) => t.count === extremeCount);
  return { tally, extremeGroup };
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
