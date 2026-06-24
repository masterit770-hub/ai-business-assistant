// TEXT-TO-SQL — the structured lane, generalized. Given a natural-language question
// and the LIVE introspected schema (any ingested table, bundled or uploaded), the
// model writes ONE SELECT; we validate it against the schema (sql-guard), run it
// read-only, and return the actual result rows cited to [S:<table>#<rowid>].
//
// This REPLACES the 7 hand-written intents. Nothing here knows about contracts /
// maintenance / Carter — it operates purely off the catalog, so it answers questions
// over a brand-new uploaded table identically to a bundled one.
//
// Safety + honesty:
//   • Every generated query passes the pure sql-guard (SELECT-only, known tables +
//     columns, enforced LIMIT, single statement) BEFORE execution.
//   • On an invalid/failing query we retry ONCE with the error fed back, then fail
//     gracefully ({ ok:false }) — never crash, never fabricate a number.
//   • The cited rows are the REAL rows the query returned, so the citation-fidelity
//     gate (validateAnswer) passes on real data.
import { chatWithUsage, type ChatUsage } from "./llm.ts";
import {
  introspectSchema,
  runGeneratedSelect,
  hydrateUploadedTables,
  type CatalogScope,
  type SqlRow,
} from "./structured-store.ts";
import type { TableSchema } from "./sql-guard.ts";
import {
  isCellTallyQuestion,
  isCellCountQuestion,
  isGridShaped,
  tallyCellOccurrencesAcross,
  countNamedEntityAcross,
  tableScopeForTally,
} from "./cell-tally.ts";

// `||` (not `??`) so an empty env value ("") falls through to the real date instead
// of producing a broken date filter like date('', '+90 days') → NULL.
const TODAY = process.env.ASSISTANT_TODAY || new Date().toISOString().slice(0, 10);

export type StructuredPlan = {
  // Tables the planner decided are relevant (subset of the catalog). Empty = none.
  tables: string[];
  reasoning: string;
};

export type StructuredResult = {
  // The chosen primary table + the SQL that ran (for the trace/inspector).
  table: string | null;
  sql: string | null;
  rows: SqlRow[];
  // True when a valid query ran and returned rows we can cite.
  ok: boolean;
  // A human note when we couldn't answer structurally (no table matched, or the
  // query failed twice) — surfaced honestly, never as a fabricated answer.
  note?: string;
  // The cell-tally lane's VERIFIED top-group summary (exact code counts + model-classified
  // entities), e.g. "X = 5, Y = 5; next: Z = 4". Distinct from `note` (a couldn't-answer
  // signal): this is AUTHORITATIVE evidence the grounded generator restates so it names every
  // co-leader, not just the one cited row. Undefined when the tally lane didn't run.
  verifiedTally?: string;
  // The STRUCTURED form of that verified top group — the exact max count and the FULL list of
  // tied leaders (entity names). The content-fidelity gate (validateCellTallyAnswer) uses this to
  // FAIL any answer whose stated max/leaders don't match the code-computed tally (a collapsed tie
  // or a non-max-as-max). Undefined when the cell-tally lane didn't run. The two fields move
  // together: `verifiedTally` is what the model restates; `verifiedTopGroup` is what the gate
  // checks the restatement AGAINST.
  verifiedTopGroup?: { maxCount: number; leaders: string[] };
  usages: ChatUsage[];
};

// Render the live catalog (tables + columns + a few sample rows) for the model. This
// is the ENTIRE basis for query generation — no hardcoded schema knowledge.
export function describeCatalog(
  catalog: TableSchema[],
  samples: Map<string, Record<string, unknown>[]>
): string {
  if (catalog.length === 0) return "(no structured tables are loaded)";
  return catalog
    .map((t) => {
      const cols = t.columns.map((c) => `${c.name} ${c.type}`).join(", ");
      const sample = samples.get(t.table) ?? [];
      const sampleStr =
        sample.length === 0
          ? ""
          : `\n    sample rows: ${sample.map((r) => JSON.stringify(r)).join(" ; ")}`;
      return `- TABLE ${t.table} (${cols})${sampleStr}`;
    })
    .join("\n");
}

/**
 * Pick the relevant table(s) for the question from the live catalog. A real model
 * call so it generalizes to any ingested table. Returns an empty list when no table
 * is relevant (the question is purely a document/general question).
 */
async function planTables(
  question: string,
  catalogText: string
): Promise<{ plan: StructuredPlan; usage: ChatUsage }> {
  const system = `You select which database TABLE(S) can help answer a question, from the catalog provided. You do NOT write SQL here. Return ONLY JSON: {"tables": ["..."], "reasoning": "one short sentence"}. Choose only tables whose columns actually relate to the question. If NO table is relevant (the question is not about this structured data), return {"tables": [], "reasoning": "..."}. You may pick MORE THAN ONE table if the question spans them.`;
  const user = `CATALOG (the only tables that exist):
${catalogText}

QUESTION: ${question}

Which table(s) are relevant? Return ONLY the JSON.`;
  const { content, usage } = await chatWithUsage(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { json: true, temperature: 0 }
  );
  let plan: StructuredPlan = { tables: [], reasoning: "" };
  try {
    const parsed = JSON.parse(content);
    const valid = new Set(catalogFromText(catalogText));
    const tables = Array.isArray(parsed.tables)
      ? parsed.tables.filter((t: unknown) => typeof t === "string" && valid.has(t))
      : [];
    plan = { tables, reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "" };
  } catch {
    plan = { tables: [], reasoning: "planner output unparseable" };
  }
  return { plan, usage };
}

// Extract the table names the catalog text advertises (so the planner can't pick a
// table that isn't real).
function catalogFromText(catalogText: string): string[] {
  const out: string[] = [];
  for (const m of catalogText.matchAll(/^- TABLE (\S+) /gm)) out.push(m[1]);
  return out;
}

/**
 * Generate ONE SELECT for the question against the chosen table's schema + samples.
 * Returns the raw SQL string (validated + executed by the caller).
 */
async function generateSql(
  question: string,
  table: string,
  catalog: TableSchema[],
  samples: Map<string, Record<string, unknown>[]>,
  priorError?: string
): Promise<{ sql: string; usage: ChatUsage }> {
  const t = catalog.find((c) => c.table === table)!;
  const cols = t.columns.map((c) => `${c.name} (${c.type})`).join(", ");
  const sample = samples.get(table) ?? [];
  const sampleStr = sample.map((r) => JSON.stringify(r)).join("\n");
  const system = `You write ONE SQLite SELECT query to answer a question over a single table. Rules:
- Output ONLY the SQL — no prose, no markdown fences, no comments.
- SELECT only. Never INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/ATTACH/PRAGMA.
- Use ONLY the columns listed for the table. Do not invent columns.
- For an aggregate question (total/sum/count/average/top-N), use SQL aggregates (SUM, COUNT, AVG, GROUP BY, ORDER BY … LIMIT). When the answer is a single aggregate, also SELECT the id column so the row can be cited.
- For a SUMMARIZE / OVERVIEW / "describe this data" / "summarize the <rows/invoices/records>" question (the user wants the big picture of the whole table, not a list of rows), you MUST return a SINGLE aggregate row — NEVER a list of individual rows. Compute: COUNT(*) of all rows, plus SUM over every clearly-numeric amount/cost/total/price/value column. Optionally add AVG. Do this as ONE row with no GROUP BY and no LIMIT-1 over raw rows. The headline of a summary is the row count and the column totals, so they MUST be computed, not sampled. (Include an id column alias if the table has one so the single aggregate row can be cited.) Example SHAPE (column names are illustrative — use the ACTUAL numeric columns from the schema): SELECT COUNT(*) AS n, SUM(<amount_col>) AS total_<amount_col> FROM <table>. This is general: derive which columns are numeric from the schema/sample rows; never assume a specific column name and never hardcode a figure.
- ALWAYS include the id column (the integer primary key) in the projection so each row can be cited — unless the query is a pure single-aggregate, in which case selecting the aggregate alone is fine.
- WRITE ONE SIMPLE SELECT — the only supported shape is: SELECT <columns/aggregates> FROM <table> [WHERE ...] [GROUP BY ...] [ORDER BY ...] [LIMIT ...]. The following are NOT supported and will be REJECTED — do NOT use them: WINDOW FUNCTIONS / OVER( ... ) clauses (e.g. SUM(x) OVER ()), Common Table Expressions / WITH clauses, subqueries in the FROM/SELECT, UNION, and JOINs.
- COMPOUND QUESTIONS (two things asked at once) — handle them in ONE plain SELECT, NO window functions / subqueries / WITH:
  • "HOW MANY … AND <which row is the X-est>" (a COUNT plus a single extreme row): put COUNT(*) in the projection ALONGSIDE the extreme row's columns and order by the extreme — write exactly this shape: SELECT COUNT(*) AS total, id, <key cols> FROM <table> ORDER BY <extreme col> [DESC] LIMIT 1. In SQLite, COUNT(*) beside non-aggregated columns returns the table-wide count next to the single row picked by ORDER BY + LIMIT 1 — so that one row carries BOTH the total count AND the extreme row. The "how many" part REQUIRES COUNT(*) — never drop it, and NEVER report a LIMIT-1 row as if it were the total count.
  • "which rows match AND their combined total / value" (a filtered set plus an overall SUM): the COMBINED TOTAL must be COMPUTED BY SQL, not left to be added up by hand from a long row list. Write a SINGLE aggregate SELECT that computes BOTH the count and the sum over the matching set: SELECT COUNT(*) AS n, SUM(<amount_col>) AS total_<amount_col>, MIN(id) AS id FROM <table> WHERE <filter>. That one aggregate row carries the count + the combined total (cite it with its id). Do NOT return every matching row and rely on the model to add them up — for a large matched set that is error-prone and can truncate. (If the user ALSO explicitly wants the individual rows listed, a few representative rows may be added, but the COMBINED TOTAL itself must come from the SUM aggregate, never from hand-addition.)
- A "how many" / count question's answer MUST include COUNT(*) — never answer a count with a single sampled row and call it the count.
- Add a LIMIT (<= 200). For "top N" use LIMIT N.
- A numeric column stored as TEXT may need CAST(col AS REAL) for math; a money string like "$1,234.50" is already numeric here if its column type is REAL.
- For DATE filtering, prefer a column already in ISO form (a column ending in "_iso" sorts/compares correctly as YYYY-MM-DD). To filter "within the next N days of today", use: column_iso BETWEEN '<today>' AND date('<today>', '+N days'). Today's date is provided below.`;
  const user = `TABLE ${table}
Columns: ${cols}
Sample rows:
${sampleStr || "(none)"}

Today's date is ${TODAY}.

Question: ${question}
${priorError ? `\nThe previous query FAILED with this error — fix it:\n${priorError}\n` : ""}
Write the single SELECT query now (SQL only).`;
  const { content, usage } = await chatWithUsage(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0 }
  );
  return { sql: content.trim(), usage };
}

/**
 * THE STRUCTURED LANE. Plan tables → for each chosen table, generate + validate +
 * run a SELECT (one retry on failure) → collect cited rows. Pure-ish: the only
 * external effects are the LLM calls and a read-only DB query.
 */
export async function answerStructured(
  question: string,
  // Demo accounts query the bundled sample tables; a non-demo user (includeBundled=false)
  // queries only their own uploaded tables — the sample data is invisible to them.
  includeBundled = true,
  // The OWNER-ISOLATION scope (per-user). A member scope materializes ONLY that owner's
  // uploaded tables; an admin scope sees all; undefined = legacy default (all uploaded
  // rows — single-user / direct callers / the existing tests). Threaded into the
  // introspect + every runGeneratedSelect so the guarded catalog == the queried DB.
  scope?: CatalogScope
): Promise<StructuredResult> {
  const usages: ChatUsage[] = [];
  // DURABLE COLD-START FIX: before the SYNCHRONOUS introspect, rehydrate this owner's
  // uploaded rows from Supabase into the runtime store (owner-scoped, fail-open). After a
  // Vercel cold start the in-memory store is empty, so without this the SQL lane would
  // have no uploaded tables and a spreadsheet question would wrongly answer "there are
  // none". No-op when Supabase is off or the caller is fail-closed.
  if (scope) await hydrateUploadedTables(scope.ownerId, !!scope.isAdmin);
  const { catalog, samples } = introspectSchema(3, includeBundled, scope);
  if (catalog.length === 0) {
    return { table: null, sql: null, rows: [], ok: false, note: "no structured tables loaded", usages };
  }
  const catalogText = describeCatalog(catalog, samples);

  const { plan, usage: planUsage } = await planTables(question, catalogText);
  usages.push(planUsage);
  // EARLY-RETURN GUARD — but NOT when the question is a grid tally/count over grids that EXIST.
  // The planner is a flaky LLM: for an UNSCOPED specific-person count ("how many times is <X>
  // scheduled", no month) the cryptic Hebrew sheet names give it no anchor, so it returns
  // tables:[] and we used to bail here with "no relevant table" — even though the cell-count
  // lane below counts that name across ALL her grids perfectly (the live RED: רינה אנטוב = 15
  // deflected to a general "couldn't find scheduling info, try COUNTIF"). The grid lanes already
  // own a "planner picked no grid → fall back to every matching grid" path (familyGrids), so when
  // THIS question is a grid tally/count and at least one grid table exists, we must NOT bail —
  // we let the lanes fire on the full-grid fallback. A non-grid question (the planner's empty
  // pick is genuinely correct) still returns the honest "no relevant table". GENERAL — keyed off
  // table SHAPE + the question's tally/count shape, never a dataset.
  const anyGrid = catalog.some((c) => isGridShaped(c));
  const isGridTallyOrCount =
    anyGrid &&
    catalog.some((c) => isCellTallyQuestion(question, c) || isCellCountQuestion(question, c));
  if (plan.tables.length === 0 && !isGridTallyOrCount) {
    return { table: null, sql: null, rows: [], ok: false, note: "no relevant table for this question", usages };
  }

  // Query each chosen table; aggregate rows. The FIRST table that returns rows is the
  // primary (for the trace's `table`/`sql`); a hybrid question can match several.
  const allRows: SqlRow[] = [];
  let primaryTable: string | null = null;
  let primarySql: string | null = null;
  let verifiedTally: string | undefined;
  let verifiedTopGroup: { maxCount: number; leaders: string[] } | undefined;
  // Set ONLY when the cell-count lane resolved a named value that occurs ZERO times — an HONEST
  // zero (the value genuinely never appears), carried so the answer states "X does not appear"
  // even though there are no rows to cite. Distinct from a query-failure note.
  let countZeroNote: string | undefined;
  const failures: string[] = [];

  // ── CELL-TALLY LANE (UNIFIED, runs ONCE across all the grid tables it spans) ──────────────
  // A "which <entity> recurs the MOST" question over a WIDE/GRID table that a single SELECT can't
  // express (a scheduling grid: a person spread across many day columns). The OLD code ran the
  // tally PER TABLE inside the loop below, overwriting one `verifiedTally` while accumulating each
  // sheet's local top group into the rows — so the stated leader/count and the cited rows
  // disagreed (a tie collapsed to one name; a non-max sheet reported as the max). We now run it
  // ONCE over ALL the grid tables the question spans and aggregate, so the tally and the cited
  // rows are consistent and a no-month / system-wide question surfaces the TRUE cross-sheet max.
  // GENERAL — keyed off the question shape + table shape, never a specific dataset.
  //
  // CANDIDATE GRID SET — expanded beyond the planner's picks to the planner-picked grid's FAMILY.
  // The planner is an LLM that, for a vague "how many times is <X> scheduled" / "who is scheduled
  // most", often picks just ONE sheet (the live RED: it picked a December sheet where the name
  // never appears and answered "0"). A tally/count over a scheduling grid is inherently a
  // CROSS-SHEET operation, so we expand to the OTHER grids in the SAME FAMILY as a planner-picked
  // grid — "same family" = they share a meaningful name segment (the monthly שיבוצים sheets share
  // their stem; an unrelated intake/assessment grid does NOT). This both fixes the wrong-single-
  // sheet bug AND avoids dragging in a different grid family (e.g. assessment forms whose names
  // merely also contain a month word). Then tableScopeForTally narrows by the question's month
  // words. Gated on "the planner routed to ≥1 grid" so a non-grid question is never hijacked.
  // GENERAL — keyed off table SHAPE + shared name segments, never a dataset.
  const plannerGrids = plan.tables.filter((t) => {
    const s = catalog.find((c) => c.table === t);
    return s && isGridShaped(s);
  });
  // The candidate grids for a predicate: ALL catalog grids matching it, narrowed to the planner-
  // picked grid's name-FAMILY *when the planner picked one* (so a month query stays in the right
  // family). When the planner picked NO grid (it is a FLAKY LLM that intermittently routes a
  // ranking-over-grids question to a non-grid table — the live RED where a system-wide count fell
  // to a SQL monthly-total GROUP BY), we do NOT gate the lane off: we fall back to every catalog
  // grid that matches the question, then tableScopeForTally narrows by the question's month words.
  // This makes the cell-tally/count lane fire DETERMINISTICALLY for a grid-ranking question instead
  // of depending on the planner's coin-flip. GENERAL — keyed off table SHAPE + the question.
  const familyGrids = (predicate: (s: TableSchema) => boolean): string[] => {
    const matching = catalog.filter((c) => predicate(c));
    const inFamily =
      plannerGrids.length > 0
        ? matching.filter((c) => plannerGrids.some((pt) => shareNameFamily(pt, c.table, question)))
        : [];
    // Prefer the planner's family; fall back to ALL matching grids when the planner picked no grid
    // (or its picks share no family with the matching grids).
    return (inFamily.length > 0 ? inFamily : matching).map((c) => c.table);
  };
  const gridTables = familyGrids((c) => isCellTallyQuestion(question, c));
  const handledByTally = new Set<string>();
  if (gridTables.length > 0) {
    const scopeTables = tableScopeForTally(question, gridTables);
    const t = await tallyCellOccurrencesAcross(question, scopeTables, catalog, scope);
    for (const u of t.usages) usages.push(u);
    if (t.ok && t.rows.length > 0) {
      for (const tbl of scopeTables) handledByTally.add(tbl);
      primaryTable = t.table ?? scopeTables[0];
      primarySql =
        scopeTables.length > 1
          ? `cell-tally across ${scopeTables.length} grid sheets (${scopeTables.join(", ")}) — occurrence frequency across cells, summed per entity`
          : `cell-tally over "${scopeTables[0]}" (occurrence frequency across cells)`;
      allRows.push(...t.rows);
      // Summarize the FULL verified EXTREME group so the grounded generator names EVERY co-leader,
      // not just one — and append the NEXT few (toward the other end) so the LLM can never re-rank
      // a tie. Counts are EXACT (code-computed, summed across the sheets); entities are
      // model-classified. The `tally` is sorted DESCENDING, so the extreme group is the FIRST few
      // for "most" and the LAST few for "least"; the "next:" entries step one rank inward.
      const least = t.direction === "least";
      const extremeCount = least ? t.tally[t.tally.length - 1].count : t.tally[0].count;
      const extreme = t.tally.filter((x) => x.count === extremeCount);
      const rest = least
        ? t.tally.filter((x) => x.count !== extremeCount).slice(-3).reverse()
        : t.tally.filter((x) => x.count !== extremeCount).slice(0, 3);
      const label = least ? "fewest" : "most";
      verifiedTally = `[${label}] ${extreme.map((x) => `${x.entity} = ${x.count}`).join(", ")}${
        rest.length > 0 ? `; next: ${rest.map((x) => `${x.entity} = ${x.count}`).join(", ")}` : ""
      }`;
      // The structured extreme group the GATE checks the answer against (exact extreme count + full
      // tie). `maxCount` here means "the count at the asked-for extreme" (max for most, min for
      // least) — the value the answer MUST state as the winner's count.
      verifiedTopGroup = { maxCount: extreme[0].count, leaders: extreme.map((x) => x.entity) };
    } else {
      // The tally is THE correct lane for this grid-ranking question but it couldn't apply this turn
      // (the classifier returned no entities even after a retry, or the tables were empty). We must
      // NOT let these grid sheets fall through to the generic SQL lane — a single-column GROUP BY
      // over a calendar grid produces a MISLEADING "monthly total" answer (the observed
      // intermittency: "each row shows a total of N schedules, no names"). Mark them handled so SQL
      // is skipped; with no rows cited, the generation layer gives an HONEST grounded-limit answer
      // ("I couldn't rank your sheets reliably this turn") rather than a fabricated aggregate.
      for (const tbl of scopeTables) handledByTally.add(tbl);
      if (!primaryTable) {
        primaryTable = scopeTables[0];
        primarySql = `cell-tally over ${scopeTables.length} grid sheet(s) — could not classify the ranked entity this turn (no fabricated aggregate)`;
      }
    }
  }

  // ── CELL-COUNT LANE (a SPECIFIC value's occurrence count over the grid) ────────────────────
  // "How many times is <X> scheduled?" is NOT a ranking — it asks for ONE named value's frequency
  // ACROSS the grid's many columns, which a single guarded GROUP BY on one column cannot express.
  // The live RED: the SQL lane wrote a one-column COUNT and answered "0" for a name that appears
  // 15× across the sheets — a fabricated wrong count. We count it in code (exact), spanning the
  // same scope the tally would. Runs only when the tally did NOT already handle these tables.
  // Candidate grids (via the same family-or-all fallback as the tally, so a flaky planner pick
  // doesn't gate the lane off), excluding any the tally already handled.
  const countGrids = familyGrids((c) => isCellCountQuestion(question, c)).filter(
    (t) => !handledByTally.has(t)
  );
  if (countGrids.length > 0) {
    const scopeTables = tableScopeForTally(question, countGrids);
    const c = await countNamedEntityAcross(question, scopeTables, catalog, scope);
    for (const u of c.usages) usages.push(u);
    if (c.ok && c.entity) {
      for (const tbl of scopeTables) handledByTally.add(tbl);
      if (!primaryTable) {
        primaryTable = c.tables[0] ?? scopeTables[0];
        primarySql = `cell-count of "${c.entity}" across ${scopeTables.length} grid sheet(s) — exact occurrence count across cells = ${c.count}`;
      }
      if (c.count > 0) {
        allRows.push(...c.rows);
      }
      // The verified count is AUTHORITATIVE (code-computed). Pass it as the tally so the grounded
      // generator states the exact number — including an HONEST 0 ("X does not appear") with no
      // fabrication. (A count is not a ranking, so no verifiedTopGroup/tie gate applies.)
      verifiedTally = `[count] ${c.entity} = ${c.count} occurrence(s) across ${scopeTables.length} sheet(s)`;
      if (c.count === 0) {
        countZeroNote = `the value "${c.entity}" does not appear in the spanned scheduling sheet(s) — its occurrence count is 0`;
      }
    }
    // If the count lane couldn't pin the named value, the grid tables fall through to SQL below.
  }

  for (const table of plan.tables) {
    if (handledByTally.has(table)) continue; // already answered by the unified cell-tally / count
    const outcome = await runForTable(question, table, catalog, samples, usages, scope);
    if (outcome.ok && outcome.rows.length > 0) {
      if (!primaryTable) { primaryTable = table; primarySql = outcome.sql; }
      allRows.push(...outcome.rows);
    } else if (outcome.ok && outcome.rows.length === 0) {
      // A valid query that returned zero rows is still an honest "none match" — record
      // its SQL so the trace shows what ran; no rows to cite.
      if (!primaryTable) { primaryTable = table; primarySql = outcome.sql; }
    } else if (outcome.note) {
      failures.push(`${table}: ${outcome.note}`);
    }
  }

  if (allRows.length > 0) {
    // verifiedTally (when set) is the cell-tally lane's authoritative top-group summary, passed
    // to the grounded generator so it restates every co-leader's exact count, not just one row.
    // verifiedTopGroup is its structured form, used by the content-fidelity gate downstream.
    return { table: primaryTable, sql: primarySql, rows: allRows, ok: true, verifiedTally, verifiedTopGroup, usages };
  }
  // HONEST-ZERO cell-count: the named value genuinely occurs 0 times. There are no rows to cite,
  // but this is an authoritative, code-verified answer (not a query failure) — return ok:true with
  // the count note + verifiedTally so the generator states "X does not appear" rather than
  // fabricating a number or punting to a generic "no matching rows".
  if (countZeroNote) {
    return { table: primaryTable, sql: primarySql, rows: [], ok: true, note: countZeroNote, verifiedTally, usages };
  }
  // No rows cited. If a table was chosen + a valid query ran but matched nothing, that
  // is an honest empty result (ok:true, zero rows) — the generation layer states "no
  // matching rows". If every attempt FAILED to produce valid SQL, surface that.
  const note = failures.length
    ? `couldn't run a valid query: ${failures.join("; ")}`
    : "the query returned no matching rows";
  return {
    table: primaryTable,
    sql: primarySql,
    rows: [],
    ok: failures.length === 0, // ok:true means "valid query, zero rows"; false = query failed
    note,
    usages,
  };
}

// Generate → validate+run → (on failure) retry ONCE with the error fed back → fail
// gracefully. Returns the rows + the SQL that ran (or a note on failure).
async function runForTable(
  question: string,
  table: string,
  catalog: TableSchema[],
  samples: Map<string, Record<string, unknown>[]>,
  usages: ChatUsage[],
  // The OWNER-ISOLATION scope — passed to runGeneratedSelect so the query runs against
  // the SAME per-owner handle the catalog was introspected from.
  scope?: CatalogScope
): Promise<{ ok: boolean; rows: SqlRow[]; sql: string | null; note?: string }> {
  let priorError: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const gen = await generateSql(question, table, catalog, samples, priorError);
    usages.push(gen.usage);
    const run = runGeneratedSelect(gen.sql, table, catalog, scope);
    if (run.ok) {
      return { ok: true, rows: run.rows, sql: cleanSql(gen.sql) };
    }
    priorError = run.reason;
  }
  return { ok: false, rows: [], sql: null, note: priorError };
}

// Strip a wrapping code fence / trailing semicolon for display in the trace.
function cleanSql(sql: string): string {
  return sql
    .replace(/^```(?:sql)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/;\s*$/, "")
    .trim();
}

// Do two table names belong to the SAME FAMILY of grids — i.e. do they share a meaningful name
// segment that is NOT just a scope word from the question? The monthly שיבוצים scheduling sheets
// share their stem "שיבוצים"; an unrelated intake/assessment grid does NOT — even though BOTH may
// also contain a month word like "אוגוסט". So the month word is NOT a family signal: we EXCLUDE any
// shared segment the question itself mentions (a month/scope word the user typed) and require a
// shared segment that survives that exclusion (the real family stem). We split each sanitized
// identifier on `_`/digits and keep segments of length ≥ 3 (a real word, not a number/short token).
// GENERAL — no dataset/month/stem is named; it compares the tables' OWN names against the question.
function shareNameFamily(a: string, b: string, question: string): boolean {
  const q = question.normalize("NFC").toLowerCase();
  const segs = (t: string) =>
    t.normalize("NFC").toLowerCase().split(/[_\d]+/).filter((s) => s.length >= 3);
  const sb = new Set(segs(b));
  for (const s of segs(a)) {
    // A segment the QUESTION mentions is a scope word (a month), not a family identifier — skip it.
    if (q.includes(s)) continue;
    if (sb.has(s)) return true;
  }
  return false;
}
