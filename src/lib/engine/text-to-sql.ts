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
  type SqlRow,
} from "./structured-store.ts";
import type { TableSchema } from "./sql-guard.ts";

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
- ALWAYS include the id column (the integer primary key) in the projection so each row can be cited — unless the query is a pure single-aggregate, in which case selecting the aggregate alone is fine.
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
export async function answerStructured(question: string): Promise<StructuredResult> {
  const usages: ChatUsage[] = [];
  const { catalog, samples } = introspectSchema();
  if (catalog.length === 0) {
    return { table: null, sql: null, rows: [], ok: false, note: "no structured tables loaded", usages };
  }
  const catalogText = describeCatalog(catalog, samples);

  const { plan, usage: planUsage } = await planTables(question, catalogText);
  usages.push(planUsage);
  if (plan.tables.length === 0) {
    return { table: null, sql: null, rows: [], ok: false, note: "no relevant table for this question", usages };
  }

  // Query each chosen table; aggregate rows. The FIRST table that returns rows is the
  // primary (for the trace's `table`/`sql`); a hybrid question can match several.
  const allRows: SqlRow[] = [];
  let primaryTable: string | null = null;
  let primarySql: string | null = null;
  const failures: string[] = [];

  for (const table of plan.tables) {
    const outcome = await runForTable(question, table, catalog, samples, usages);
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
    return { table: primaryTable, sql: primarySql, rows: allRows, ok: true, usages };
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
  usages: ChatUsage[]
): Promise<{ ok: boolean; rows: SqlRow[]; sql: string | null; note?: string }> {
  let priorError: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const gen = await generateSql(question, table, catalog, samples, priorError);
    usages.push(gen.usage);
    const run = runGeneratedSelect(gen.sql, table, catalog);
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
