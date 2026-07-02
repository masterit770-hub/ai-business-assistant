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

// ── OCCURRENCE-INTENT CLASSIFIER (the phrasing-independent trigger) ───────────────────────────────
// WHY THIS REPLACED THE REGEX CUE-GATE (the recorded miss): the cell lanes used to fire only when a
// hand-maintained cue regex (OCCURS_RE/OCCURS_HE: "scheduled|appears|times|…") matched the question.
// That is a treadmill — the client asked "who participates the most" and "who is more active" and
// "מי הכי פעילה" in words the list didn't have, so the lane never fired and the answer fell to a
// general "I can't find participation counts" (the live RED). Maintaining a synonym list is endless.
//
// THE FIX (per CLAUDE.md "let the model decide via an explicit flag"): a SINGLE LLM intent call reads
// the QUESTION + the grid table SCHEMAS and emits a structured flag — is this an occurrence-frequency
// RANKING ("who recurs most/least"), a SPECIFIC-VALUE count ("how many times is X scheduled"), a
// FILTER-by-count ("who is scheduled exactly N times"), or NONE — then CODE executes deterministically
// (the existing pure tally/count/filter lanes). The model decides INTENT (phrasing-independent); CODE
// does the COUNTING (deterministic). No maintained phrase list, in any language.
//
// The two guards that MUST survive are expressed as explicit prompt rules AND a code post-check:
//   • ATTRIBUTE superlatives (oldest/tallest/most-senior — a property of the person, not how often
//     they occur) are NOT occurrence rankings → kind:"none" (the AD2 fabrication guard). A code
//     post-check forces "none" if the deterministic isAttributeSuperlative still fires, so a model
//     slip can't reopen AD2.
//   • A PLAIN LOOKUP ("who is scheduled on Aug 1", "when is X scheduled") is NOT a ranking/count → none.
export type OccurrenceKind = "ranking" | "specific-count" | "filter" | "none";
// `errored` is TRUE only when the classifier LLM call itself failed (network/timeout/provider error),
// distinct from the model deliberately judging "none". The router guard uses it to FAIL-SAFE: on an
// error over the caller's OWN grid it still routes structured (engage their data) rather than punt.
export type OccurrenceIntent = { kind: OccurrenceKind; direction: "most" | "least"; errored: boolean; usage?: ChatUsage };

// A compact, language-neutral schema description for the intent prompt: each grid table + its columns.
function describeGridCatalog(tables: TableSchema[]): string {
  return tables
    .map((t) => `- ${t.table} (columns: ${t.columns.map((c) => c.name).join(", ")})`)
    .join("\n");
}

/**
 * Classify the question's OCCURRENCE intent over the caller's GRID tables. ONE LLM call (temp 0,
 * JSON). Returns {kind, direction}. Fail-OPEN to "none" on any parse/empty error (the lane simply
 * doesn't fire — text-to-SQL still runs — so a classifier hiccup never fabricates). The caller only
 * invokes this when ≥1 grid-shaped table exists, so it never runs for a pure non-grid catalog.
 * Pure-ish (the only effect is the LLM call). Exported for the live evals; the kind→lane wiring is
 * in text-to-sql. The deterministic attribute-superlative guard is applied AFTER the model here.
 */
export async function classifyOccurrenceIntent(
  question: string,
  gridTables: TableSchema[]
): Promise<OccurrenceIntent> {
  const direction = tallyDirection(question);
  // Deterministic AD2 backstop: an intrinsic-attribute superlative is NEVER an occurrence ranking —
  // short-circuit BEFORE the model so a model slip can't crown the most-scheduled person as "oldest".
  if (isAttributeSuperlative(question)) return { kind: "none", direction, errored: false };
  // Run the classifier; RETRY ONCE on "none". A "none" can mean a genuine non-occurrence question OR a
  // degraded/garbled completion from a momentarily-overloaded provider (a 429-retried-but-truncated
  // response that parsed to {} → "none"). A genuine "none" is STABLE — a plain lookup / attribute
  // superlative says "none" both times — so the retry only recovers a flaky false-none, it never
  // flips a true none into a lane. (Mirrors the classifyEntities retry-once-on-empty already used by
  // the tally.) The AD2 short-circuit above already removed the one false-positive risk.
  const system = `You classify a USER QUESTION about one or more SPREADSHEET tables. The tables are messy calendar/scheduling GRIDS: a value (a person's name, an activity, a day header) recurs across many cells. Your ONE job: decide whether the question is asking about HOW OFTEN a value OCCURS across the grid — something a plain SQL GROUP BY on one column cannot answer because the value is spread across many columns.

THINK in two steps, then output JSON {"reasoning": "<your 1-2 step reasoning>", "kind": "<one value>"}:
STEP 1 — Is the question comparing/ranking PEOPLE (or activities) by how MUCH / how OFTEN they appear, participate, are scheduled, are active, are busy, show up? A scheduling grid lists people across days; "who is busiest / most active / participates most / is scheduled most / shows up most / appears most" ALL mean the SAME thing: whose name RECURS most across the grid cells. This is the core concept — match it by MEANING, in ANY language, not by specific words ("active", "פעילה", "busy", "involved", "comes most" all qualify).
STEP 2 — pick the kind:
- "ranking": ranks entities by how often they occur (most OR least / busiest / most active / participates most / scheduled most / fewest). Examples: "who participates the most", "who is more active", "who is busiest", "who shows up most", "מי משתתפת הכי הרבה", "מי הכי פעילה", "מי הכי עסוקה", "who is scheduled the most across the schedules", "who appears the fewest times".
- "specific-count": HOW MANY TIMES one NAMED value occurs — "how many times is Rina scheduled", "כמה פעמים X משובצת".
- "filter": WHICH entities occur EXACTLY N times — "who is scheduled exactly 5 times".
- "none": NOT about frequency-of-occurrence. Use "none" ONLY for:
   • an INTRINSIC-ATTRIBUTE superlative — ranking by a PROPERTY of the person (oldest, youngest, tallest, most senior, highest paid). The grid has no ages/heights. → "none".
   • a PLAIN LOOKUP of one slot — "who is scheduled on August 1st", "when is X scheduled", "is X free Tuesday". → "none".
   • an ordinary total/sum/average over a numeric column, a greeting, or a pure general-knowledge question. → "none".

IMPORTANT: when in doubt between "ranking" and "none" for a who-is-most/who-is-more question about PEOPLE over a scheduling grid, choose "ranking" — a comparative/superlative about people on a schedule is almost always an occurrence ranking. Do NOT answer "none" just because the wording is casual ("who is more active" IS a ranking).`;
  const user = `GRID TABLES:
${describeGridCatalog(gridTables)}

QUESTION: ${question}

Return the JSON now.`;
  const callOnce = async (): Promise<{ kind: OccurrenceKind; usage: ChatUsage; errored: boolean }> => {
    let content: string;
    let usage: ChatUsage;
    try {
      // TEST-ONLY: simulate a classifier LLM outage so a test can prove the fail-safe (route
      // structured, never punt) without a real provider failure. Never set in production.
      if (process.env.__INTENT_FORCE_ERROR === "1") throw new Error("forced intent-classifier error (test)");
      ({ content, usage } = await chatWithUsage(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        { json: true, temperature: 0 }
      ));
    } catch (e) {
      // FAIL-SAFE: the classifier is an LLM call — on a network/timeout/provider error it must NOT
      // crash the answer pipeline. Return errored:true so the CALLER can degrade toward ENGAGING the
      // caller's own structured data (never punt to a general "can't find" over her own grid). The
      // `kind` here is "none" (no specific lane), but `errored` distinguishes "the model judged none"
      // from "we couldn't ask" — the router guard uses that to still route structured on error.
      void e;
      return { kind: "none", usage: { live: false, provider: "—", model: "—" } as ChatUsage, errored: true };
    }
    let kind: OccurrenceKind = "none";
    try {
      const parsed = JSON.parse(content);
      if (parsed.kind === "ranking" || parsed.kind === "specific-count" || parsed.kind === "filter") {
        kind = parsed.kind;
      }
    } catch {
      kind = "none"; // unparseable JSON → no cell lane, text-to-SQL still runs (not an error)
    }
    return { kind, usage, errored: false };
  };
  let { kind, usage, errored } = await callOnce();
  if (kind === "none") {
    // Retry once — a flaky false-none (degraded/truncated provider response) OR a transient error
    // recovers; a real none (lookup / attribute superlative) stays none. We keep the first usage.
    const retry = await callOnce();
    if (retry.kind !== "none") kind = retry.kind;
    // Stay errored ONLY if BOTH calls errored (a persistent provider outage), so the guard fail-safes.
    errored = errored && retry.errored;
  }
  // Post-check (defense in depth): a "filter" must actually name a target integer; if it doesn't,
  // treat it as a ranking ("who is scheduled the most/least") rather than a broken filter.
  if (kind === "filter" && filterTargetCount(question) == null) kind = "ranking";
  return { kind, direction, errored, usage };
}

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


// An INTRINSIC-ATTRIBUTE superlative (oldest/youngest/tallest/shortest/biggest…/most senior) —
// a ranking by a property of the PERSON (age, height, seniority), NOT by how often they occur in
// the grid. The cell-tally lane answers ONLY frequency-of-occurrence ("appears/scheduled the
// most"); an attribute ranking it cannot answer (her grid holds no ages/heights), so the engine
// must fall through to the honest "there is no age data to rank by" — NOT crown the most-scheduled
// person as "the oldest" (the recorded AD2 RED). This fires even though the dataset is NAMED
// "schedules" (the bare noun שיבוצים/"schedules" is a dataset/context word, not a frequency cue),
// so an attribute superlative over the scheduling grid is correctly excluded. GENERAL — a
// linguistic class of superlative the occurrence tally never answers, not a dataset-specific list.
const ATTRIBUTE_SUPERLATIVE_RE =
  /\b(oldest|youngest|tallest|shortest|biggest|smallest|largest|eldest|most senior|most experienced|highest paid|best paid)\b/;
const ATTRIBUTE_SUPERLATIVE_HE =
  /(הכי מבוגר|המבוגר|הכי צעיר|הצעיר|הכי גבוה|הגבוה|הכי נמוך|הנמוך|הכי ותיק|הוותיק|הכי מנוסה|הכי גדול|הכי קטן)/;
function isAttributeSuperlative(question: string): boolean {
  return (
    ATTRIBUTE_SUPERLATIVE_RE.test(question.normalize("NFC").toLowerCase()) ||
    ATTRIBUTE_SUPERLATIVE_HE.test(question)
  );
}

// A PLACEHOLDER / positional column name — the fingerprint of a sheet that had NO real header row,
// so ingestion auto-named its columns. A calendar/scheduling GRID (day-columns with no headers) ends
// up like this: `__EMPTY`, `__EMPTY_3`, `empty`, `empty_2`, `col5`, `column_7`, `unnamed: 4`, a bare
// number, or `1`/`2`. A CLEAN tabular sheet instead has DISTINCT, meaningful headers (participant,
// coach, session, date). This is the structural signal that separates "text-to-SQL can't parse this
// (no columns to GROUP BY)" from "this is an ordinary table the model should read/query directly".
// Pure; keyed only off the column NAME, no dataset/value hardcoding.
function isPlaceholderColumnName(name: string): boolean {
  const n = name.normalize("NFC").trim().toLowerCase();
  if (!n) return true;
  return (
    /^_*empty(_\d+)?$/.test(n) ||           // __EMPTY, __EMPTY_3, empty, empty_2
    /^unnamed(:?\s*\d+)?$/.test(n) ||        // "unnamed", "unnamed: 4"
    /^(col|column|field|c|f|var)_?\d+$/.test(n) || // col5, column_7, field3, c1
    /^\d+$/.test(n)                          // a bare numeric header (1, 2, 3 …)
  );
}

/**
 * GRID SHAPE: a calendar/scheduling GRID that single-SELECT text-to-SQL CANNOT parse — many columns,
 * mostly free-text, AND dominated by PLACEHOLDER/positional column names (the sheet had no header row,
 * so a value recurs ACROSS unnamed day-columns). The placeholder-name requirement is what stops the
 * occurrence-tally from HIJACKING a CLEAN tabular sheet (e.g. participant/coach/session/date): a clean
 * table has distinct named columns, so text-to-SQL can `GROUP BY participant` and get the EXACT count
 * — the occurrence-counter (which tallies a name across ALL columns, over-counting when the name also
 * appears in another column) must NOT intercept it. Only a genuinely header-less grid, where there is
 * no real column to GROUP BY, falls to the tally. Shared by all three grid detectors. Pure.
 */
export function isGridShaped(table: TableSchema): boolean {
  const dataCols = table.columns.filter((c) => !ANCHOR_COLS.has(c.name.toLowerCase()));
  if (dataCols.length < 4) return false;
  const textCols = dataCols.filter((c) => (c.type || "TEXT").toUpperCase() !== "REAL");
  if (textCols.length < Math.max(3, Math.ceil(dataCols.length / 2))) return false;
  // The DISCRIMINATOR: a true grid's columns are mostly placeholders (no header row to GROUP BY on).
  // If MOST data columns are distinct, meaningful headers, this is a CLEAN table → let text-to-SQL
  // read/query the real columns (exact COUNT/GROUP BY), do NOT route to the occurrence-tally.
  const placeholderCols = dataCols.filter((c) => isPlaceholderColumnName(c.name));
  return placeholderCols.length >= Math.ceil(dataCols.length / 2);
}

/**
 * Extract the TARGET integer N a filter-by-count question filters on ("exactly 5 times" → 5). We
 * take the first bare integer in the question (the count words "exactly/בדיוק" sit beside it). A
 * money/decimal/year is not a plain occurrence count. Returns null when there is no plain integer.
 * Pure + exported so the parse is unit-tested.
 */
export function filterTargetCount(question: string): number | null {
  // First standalone 1–3 digit integer not part of a larger number/decimal/currency.
  const m = question.match(/(?<![\d.,$])\d{1,3}(?![\d.,])/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * THE PURE FILTER-BY-COUNT (no LLM, no DB). Given the accumulated occurrences, the classified
 * entity set (the asked-for KIND), and a target count N, return the entities whose occurrence count
 * EQUALS N, sorted, each with its real table-qualified anchors for citation. Empty when none match
 * (an HONEST "no one is scheduled exactly N times" — never fabricated). Pure + exported.
 */
export function entitiesAtCount(occ: OccMap, entities: string[], n: number): TallyEntry[] {
  const entitySet = new Set(entities);
  return [...occ.keys()]
    .filter((v) => entitySet.has(v) && (occ.get(v)?.count ?? 0) === n)
    .map((entity) => {
      const e = occ.get(entity)!;
      const anchors = [...e.anchors.values()].sort((a, b) => a.table.localeCompare(b.table) || a.id - b.id);
      return { entity, count: e.count, rowIds: anchors.map((a) => a.id), anchors };
    })
    .sort((a, b) => a.entity.localeCompare(b.entity));
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
 * A candidate grid's RECURRENCE PROFILE for a tally question: the distinct cell values that
 * RECUR (occur more than once across the grid's cells), with their max occurrence. Computed in
 * CODE (deterministic). A grid where NOTHING recurs (every value occurs once — a normalized
 * relational table like a `people`/`payroll` roster) has no "most frequent X" to rank, so it is
 * NOT a frequency grid for a tally question and must not be selected. Pure (no LLM).
 */
export type GridRecurrence = { table: string; recurringValues: string[]; maxCount: number };
export function gridRecurrenceProfile(occ: OccMap): { recurringValues: string[]; maxCount: number } {
  let maxCount = 0;
  const recurringValues: string[] = [];
  for (const [value, e] of occ) {
    if (e.count > 1) recurringValues.push(value);
    if (e.count > maxCount) maxCount = e.count;
  }
  return { recurringValues, maxCount };
}

/**
 * GRID SELECTION BY ENTITY KIND — the fix for the cross-corpus mis-routing.
 *
 * THE RECORDED MISS (live RED): an English superlative "who is the most active PERSON" over a
 * DEMO account (whose catalog holds BOTH her uploaded scheduling sheets AND the bundled demo
 * corpus — contracts/payroll/people) tallied the WRONG grid. The Hebrew phrasing narrows to her
 * scheduling family via a Hebrew name cue; the English phrasing has no such cue, so candidate-grid
 * selection fell to ALL grid-shaped tables and the planner+family-narrowing landed on the bundled
 * `contracts` grid — answering with COMPANY names ("Blogspan and Brainsphere") instead of the
 * most-scheduled PERSON (נגה מאירסון @29).
 *
 * THE GENERAL FIX: the candidate grid must match the QUESTION'S ENTITY KIND. We already have the
 * question-driven classifier (it reads the question to decide PERSON vs ACTIVITY/PLACE). Here we
 * use it to SCORE/SELECT the candidate grid, not just to classify within an already-chosen one:
 *   • A grid qualifies only if some value the classifier judges to be the asked-for KIND actually
 *     RECURS (count > 1). This rejects `contracts` (its recurring values are COMPANIES, not the
 *     asked-for PERSON kind) AND rejects a normalized `people`/`payroll` roster (person-names, but
 *     each appears once → no recurrence → no "most").
 *   • Among the qualifying grids we keep the strongest recurrence family — but a grid only enters
 *     "strongest" if it qualified on KIND, so a contracts grid with a high company recurrence can
 *     never win a PERSON question.
 * So an English "most active person" lands on the people-scheduling grid the same way the Hebrew
 * family-narrowing does — keyed off the question's entity kind + the grid's CONTENT, never a
 * hardcoded table or corpus name. When all candidates already share one family (the normal Hebrew
 * path), this is a no-op fast-path: nothing to disambiguate, no extra LLM call.
 *
 * Fail-open: if the kind classifier can't decide for any grid, return the candidates unchanged
 * (the prior behaviour) — selection narrows, it never sinks an answerable question.
 */
export async function selectTallyGridsByKind(
  question: string,
  candidateTables: string[],
  catalog: TableSchema[],
  scope?: CatalogScope
): Promise<{ tables: string[]; usages: ChatUsage[] }> {
  const usages: ChatUsage[] = [];
  // Fast-path: 0/1 candidate, or all candidates already in ONE name-family → nothing to
  // disambiguate. The single-corpus (normal Hebrew) path pays no extra LLM cost.
  if (candidateTables.length <= 1) return { tables: candidateTables, usages };

  // Per-grid recurrence profile (pure, deterministic) — the distinct values that recur + the max.
  const profiles: { table: string; occ: OccMap; recurringValues: string[]; maxCount: number }[] = [];
  for (const table of candidateTables) {
    if (!catalog.some((c) => c.table === table)) continue;
    let rows: SqlRow[];
    try {
      rows = selectWithIds(`SELECT * FROM "${table}" LIMIT ${HARD_ROW_CAP}`, table, catalog, scope);
    } catch {
      continue;
    }
    const occ: OccMap = new Map();
    accumulateOccurrences(occ, table, rows);
    const { recurringValues, maxCount } = gridRecurrenceProfile(occ);
    profiles.push({ table, occ, recurringValues, maxCount });
  }
  if (profiles.length <= 1) return { tables: profiles.map((p) => p.table), usages };

  // ONE classifier call over the UNION of every grid's RECURRING values — which of them are the
  // asked-for KIND? We classify only recurring values (the ones that could ever be a "most"), and
  // only ONCE for the whole pool, so the cost is a single LLM call regardless of how many grids the
  // demo catalog holds (the cross-corpus case has ~10+ grids — per-grid calls would be too slow).
  const unionRecurring = [...new Set(profiles.flatMap((p) => p.recurringValues))];
  if (unionRecurring.length === 0) return { tables: candidateTables, usages };
  const { entities, usage } = await classifyEntities(question, unionRecurring);
  usages.push(usage);
  if (entities.length === 0) return { tables: candidateTables, usages }; // classifier hiccup → fail-open
  const kindSet = new Set(entities);
  // A grid qualifies iff some value the classifier judged to be the asked-for KIND actually RECURS
  // (count > 1) IN THAT GRID. The strongest such recurrence is the grid's real "most X" signal.
  const qualifying: { table: string; kindRecurrence: number }[] = [];
  for (const p of profiles) {
    let kindRecurrence = 0;
    for (const v of p.recurringValues) {
      if (!kindSet.has(v)) continue;
      const c = p.occ.get(v)?.count ?? 0;
      if (c > kindRecurrence) kindRecurrence = c;
    }
    if (kindRecurrence > 1) qualifying.push({ table: p.table, kindRecurrence });
  }

  // Fail-open: if NO grid qualified on kind (the classifier couldn't separate them), keep all the
  // candidates — never sink an answerable question on a classifier hiccup.
  if (qualifying.length === 0) return { tables: candidateTables, usages };

  // Select the qualifying grids in the SAME name-family as the strongest-recurrence qualifier — so
  // a multi-sheet scheduling family is tallied together (the true cross-sheet max), while the
  // wrong-corpus grids (contracts/payroll) are dropped. Family = shared distinguishing name segment.
  qualifying.sort((a, b) => b.kindRecurrence - a.kindRecurrence);
  const best = qualifying[0].table;
  const chosen = qualifying
    .filter((q) => q.table === best || shareGridFamily(best, q.table, question))
    .map((q) => q.table);
  return { tables: chosen.length > 0 ? chosen : [best], usages };
}

// Do two grid table names share a distinguishing name segment (the same family of sheets), with
// any segment the QUESTION itself mentions excluded (a scope word, not a family identifier)? Mirror
// of text-to-sql's shareNameFamily, kept local so grid SELECTION stays inside the tally module.
// Pure. Splits each sanitized identifier on `_`/digits, keeps segments of length ≥ 3.
function shareGridFamily(a: string, b: string, question: string): boolean {
  const q = question.normalize("NFC").toLowerCase();
  const segs = (t: string) =>
    t.normalize("NFC").toLowerCase().split(/[_\d]+/).filter((s) => s.length >= 3);
  const sb = new Set(segs(b));
  for (const s of segs(a)) {
    if (q.includes(s)) continue;
    if (sb.has(s)) return true;
  }
  return false;
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
  //    dates, activity/event/place labels)? ONE JSON call over the union of distinct values. The
  //    classifier is an LLM call that very occasionally returns an empty/unparseable result; a
  //    bare-empty result would make the lane bail and fall through to a generic SQL GROUP BY that
  //    fabricates monthly totals (the observed intermittency). So we RETRY ONCE on empty before
  //    giving up — cheap, and it removes the flaky fall-through.
  let { entities, usage } = await classifyEntities(question, distinct);
  usages.push(usage);
  if (entities.length === 0) {
    const retry = await classifyEntities(question, distinct);
    usages.push(retry.usage);
    entities = retry.entities;
  }
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

export type CellCountResult = {
  // The named value the count is FOR (verbatim as it appears in the grid), or null if the model
  // couldn't pin one from the question.
  entity: string | null;
  // The EXACT occurrence count across every cell of the spanned tables (0 if it never appears).
  count: number;
  // One citable row per table where it occurs (so [S:table#rowid] resolves).
  rows: SqlRow[];
  tables: string[];
  ok: boolean;
  note?: string;
  usages: ChatUsage[];
};

/**
 * SPECIFIC-VALUE OCCURRENCE COUNT over the grid ("how many times is <X> scheduled"). The model
 * extracts the NAMED value from the question and matches it to the closest real distinct cell value
 * (so a slight spelling/spacing difference still resolves); CODE then counts that value's exact
 * occurrences across every cell of the spanned tables. This fixes the live RED where the SQL lane
 * wrote a one-column COUNT and answered "0" for a name that appears 15× across the sheets. Honest:
 * if the value genuinely never appears, it returns count 0 with ok:true and no rows — the generator
 * then says "X does not appear" rather than fabricating. Fail-soft: any error → {ok:false}.
 */
export async function countNamedEntityAcross(
  question: string,
  tables: string[],
  catalog: TableSchema[],
  scope?: CatalogScope
): Promise<CellCountResult> {
  const usages: ChatUsage[] = [];
  const present = tables.filter((t) => catalog.some((c) => c.table === t));
  if (present.length === 0) {
    return { entity: null, count: 0, rows: [], tables: [], ok: false, note: "no table in catalog", usages };
  }
  // 1. Accumulate occurrences across every spanned table (same machinery as the tally).
  const occ: OccMap = new Map();
  let totalRows = 0;
  for (const table of present) {
    let rows: SqlRow[];
    try {
      rows = selectWithIds(`SELECT * FROM "${table}" LIMIT ${HARD_ROW_CAP}`, table, catalog, scope);
    } catch {
      usages.push({ live: false, provider: "—", model: "—" } as ChatUsage);
      continue;
    }
    totalRows += rows.length;
    accumulateOccurrences(occ, table, rows);
  }
  if (totalRows === 0) return { entity: null, count: 0, rows: [], tables: present, ok: false, note: "no rows", usages };

  // 2. MODEL: which DISTINCT cell value does the question name (the closest exact match to the
  //    person/value the user asked to count)? One JSON call. Returns a verbatim distinct value.
  const distinct = [...occ.keys()];
  const { value, usage } = await extractNamedValue(question, distinct);
  usages.push(usage);
  if (!value) {
    return { entity: null, count: 0, rows: [], tables: present, ok: false, note: "could not pin the named value", usages };
  }

  // 3. CODE: the EXACT count for that value (0 if absent — an HONEST zero, not a fabrication).
  const e = occ.get(value);
  const count = e?.count ?? 0;
  const anchors = e ? [...e.anchors.values()].sort((a, b) => a.table.localeCompare(b.table) || a.id - b.id) : [];
  // Cite up to a few real rows where it occurs (one per table is enough for traceability).
  const seenTables = new Set<string>();
  const rows: SqlRow[] = [];
  for (const a of anchors) {
    if (seenTables.has(a.table)) continue;
    seenTables.add(a.table);
    rows.push({ table: a.table, id: a.id, data: { entity: value, occurrences: count } });
  }
  return { entity: value, count, rows, tables: present, ok: true, usages };
}

export type CellFilterResult = {
  // The target count the question filters on (N).
  targetCount: number;
  // The classified entities (the asked-for KIND) whose occurrence count EQUALS N, sorted. Empty
  // when none match — an HONEST empty set ("no one is scheduled exactly N times"), never fabricated.
  members: { entity: string; count: number; anchors: { table: string; id: number }[] }[];
  // One citable row per member (so [S:table#rowid] resolves).
  rows: SqlRow[];
  tables: string[];
  ok: boolean;
  note?: string;
  usages: ChatUsage[];
};

/**
 * FILTER-BY-COUNT over the grid ("who is scheduled EXACTLY N times" / "מי משובצת בדיוק N פעמים").
 * Accumulates occurrences across the spanned tables, asks the kind classifier which distinct values
 * are the asked-for ENTITY KIND (people vs activities/places), then keeps ONLY those whose exact
 * occurrence count EQUALS N. Returns the full matching SET, cited. Honest: an empty set when no
 * entity of the kind hits N (never fabricated). Fail-soft: any error → {ok:false}.
 */
export async function filterEntitiesAtCountAcross(
  question: string,
  targetCount: number,
  tables: string[],
  catalog: TableSchema[],
  scope?: CatalogScope
): Promise<CellFilterResult> {
  const usages: ChatUsage[] = [];
  const present = tables.filter((t) => catalog.some((c) => c.table === t));
  if (present.length === 0) {
    return { targetCount, members: [], rows: [], tables: [], ok: false, note: "no table in catalog", usages };
  }
  // 1. Accumulate occurrences across every spanned table (same machinery as the tally/count).
  const occ: OccMap = new Map();
  let totalRows = 0;
  for (const table of present) {
    let rows: SqlRow[];
    try {
      rows = selectWithIds(`SELECT * FROM "${table}" LIMIT ${HARD_ROW_CAP}`, table, catalog, scope);
    } catch {
      usages.push({ live: false, provider: "—", model: "—" } as ChatUsage);
      continue;
    }
    totalRows += rows.length;
    accumulateOccurrences(occ, table, rows);
  }
  if (totalRows === 0) return { targetCount, members: [], rows: [], tables: present, ok: false, note: "no rows", usages };

  // 2. MODEL: which distinct values are the asked-for ENTITY KIND (people vs activities/places)?
  //    We classify only the values that actually hit the target count — the only ones that could be
  //    members — to keep the classification focused (and exclude an activity that happens to hit N).
  const distinct = [...occ.keys()];
  const atTarget = distinct.filter((v) => (occ.get(v)?.count ?? 0) === targetCount);
  if (atTarget.length === 0) {
    // HONEST empty: nothing occurs exactly N times. ok:true (a real, code-verified empty answer).
    return { targetCount, members: [], rows: [], tables: present, ok: true, note: `no value occurs exactly ${targetCount} times`, usages };
  }
  const { entities, usage } = await classifyEntities(question, atTarget);
  usages.push(usage);
  // 3. CODE: keep only the classified entities at exactly N (the pure, unit-pinned filter).
  const members = entitiesAtCount(occ, entities, targetCount);
  const rows: SqlRow[] = members.map((m) => ({
    table: m.anchors[0].table,
    id: m.anchors[0].id,
    data: { entity: m.entity, occurrences: m.count },
  }));
  return {
    targetCount,
    members: members.map((m) => ({ entity: m.entity, count: m.count, anchors: m.anchors })),
    rows,
    tables: present,
    ok: true,
    usages,
  };
}

// Extract the single DISTINCT cell value the question names (the value to count). Returns a verbatim
// member of `distinct` or null. JSON, temperature 0. Kept null-safe: the model must pick from the
// real list (it cannot invent a value), so the count is always over a value that truly exists.
async function extractNamedValue(
  question: string,
  distinct: string[]
): Promise<{ value: string | null; usage: ChatUsage }> {
  const system = `The user's QUESTION asks HOW MANY TIMES a specific named thing (usually a person's name) appears in a spreadsheet. You are given the QUESTION and the list of DISTINCT cell values. Pick the ONE distinct value that is the thing the question names (the closest exact match — allow for minor spelling/spacing differences, but it must clearly be the same name/thing). Return ONLY JSON: {"value": "<the exact distinct value, copied verbatim>"} — or {"value": null} if NONE of the distinct values is the named thing. Copy the value EXACTLY as written. Do not invent a value that is not in the list.`;
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
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed.value === "string" && distinct.includes(parsed.value)) {
      return { value: parsed.value, usage };
    }
  } catch {
    /* fall through to null */
  }
  return { value: null, usage };
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
 * Classify which of the distinct cell values are the ENTITY KIND the QUESTION ranks. The kind is
 * QUESTION-DRIVEN, not hardcoded: a "who / which person is scheduled most" question ranks PEOPLE
 * (so activities/places/dates are excluded); a "which ACTIVITY / event / place appears most"
 * question ranks ACTIVITIES/PLACES (so PEOPLE are excluded). A pure day/date header is ALWAYS
 * excluded (it is bookkeeping, never the answer to either). Returns the verbatim subset. JSON,
 * temperature 0 — deterministic; copies values exactly so the code tally matches.
 */
async function classifyEntities(
  question: string,
  distinct: string[]
): Promise<{ entities: string[]; usage: ChatUsage }> {
  const system = `You are given the QUESTION a user asked about a spreadsheet, and a list of DISTINCT cell values from that spreadsheet. The question ranks SOME KIND OF THING by how often it appears. Your job: FIRST read the question to determine WHICH KIND of thing it is ranking, THEN return only the listed values that ARE that kind.

STEP 1 — what KIND does the question rank? Read the question:
- If it asks WHO / which PERSON / which girl / which volunteer / who is scheduled / who is most active → the kind is a PERSON (a human name). Include the person names; EXCLUDE activity/event/task/workshop/outing labels and place/room/location labels and dates.
- If it asks which ACTIVITY / event / task / workshop / outing / session, or which PLACE / room / location → the kind is an ACTIVITY-or-PLACE label. Include those labels; EXCLUDE person names and dates.
- If the question's kind is genuinely ambiguous, default to PERSON names.

STEP 2 — ALWAYS EXCLUDE, regardless of the kind: a day-of-week or date header (e.g. a weekday name followed by a date), a bare month or holiday name, a pure number, and a column-header/label string. These are bookkeeping — never the answer to "most X".

Return ONLY JSON: {"entities": ["...the values that ARE the kind the question ranks..."]}.
- Include a value ONLY if it matches the KIND the question is about (per step 1). Do NOT include a person when the question ranks activities/places, and do NOT include an activity/place when the question ranks people.
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
