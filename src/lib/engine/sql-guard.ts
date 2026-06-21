// SQL SAFETY VALIDATOR — the gate every model-generated query must pass before it
// touches the read-only structured store. PURE (no DB, no LLM) so it is exhaustively
// unit-testable, and it is the security boundary for the text-to-SQL lane.
//
// What it enforces (all structural — a generated query that fails ANY rule is
// rejected and never executed):
//   1. SELECT-ONLY. The statement must begin with SELECT (after stripping a leading
//      WITH … CTE). Any write/DDL/admin keyword anywhere — INSERT/UPDATE/DELETE/
//      DROP/ALTER/CREATE/ATTACH/DETACH/REPLACE/TRUNCATE/PRAGMA/VACUUM/REINDEX — is
//      rejected. (A read-only DB handle is the second layer; this is the first.)
//   2. SINGLE STATEMENT. No stacked statements — a `;` may appear only as an
//      optional trailing terminator, never to chain a second statement.
//   3. NO COMMENTS. `--` and block comments can smuggle keywords past a scanner, so
//      they are rejected outright (a generated analytical query never needs them).
//   4. KNOWN TABLES + COLUMNS. Every table referenced must exist in the live schema
//      catalog, and every bare/qualified column identifier must resolve to a real
//      column of an in-scope table (or be `*`/`rowid`). This is what makes "cite a
//      column that doesn't exist" impossible — the introspected schema is the
//      allow-list, so it works for ANY ingested table, bundled or uploaded.
//   5. LIMIT enforced. If the query has no LIMIT we add a default cap; if it has one
//      above the hard cap we clamp it. The store never returns an unbounded scan.
//
// The catalog passed in is the REAL introspected schema (PRAGMA table_info per
// table), so this validator is not tuned to any specific dataset.

export type TableSchema = {
  table: string;
  columns: { name: string; type: string }[];
};

export type SqlGuardResult =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

// Hard cap on rows the structured lane will ever return in one query.
export const HARD_ROW_CAP = 200;
// Applied when the model omits a LIMIT entirely.
export const DEFAULT_ROW_LIMIT = 50;

// Forbidden keywords anywhere in the statement. Word-boundary matched, case
// insensitive. ATTACH/DETACH/PRAGMA/VACUUM/REINDEX are admin/escape verbs; the rest
// are writes/DDL. SELECT-only by construction once these are gone.
const FORBIDDEN = [
  "insert", "update", "delete", "drop", "alter", "create", "replace",
  "attach", "detach", "truncate", "pragma", "vacuum", "reindex", "grant",
  "revoke", "trigger",
];
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN.join("|")})\\b`, "i");

// A SQL identifier (optionally schema/table-qualified): foo, foo.bar, "Quoted Name".
// We capture qualified column refs (a.b) and bare idents separately during scanning.
const IDENT = `(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)`;

/**
 * Validate (and lightly normalize) a model-generated SQL string against the live
 * schema. Returns the safe-to-run SQL (with an enforced LIMIT) or a rejection reason.
 * Never throws — a malformed input is a rejection, not a crash.
 */
export function validateGeneratedSql(
  rawSql: string,
  catalog: TableSchema[]
): SqlGuardResult {
  if (typeof rawSql !== "string") return { ok: false, reason: "query is not a string" };
  let sql = rawSql.trim();
  // Strip a single wrapping markdown code fence if the model added one.
  sql = sql.replace(/^```(?:sql)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!sql) return { ok: false, reason: "empty query" };

  // Rule 3 — no comments (they can hide keywords from the scanner).
  if (/--/.test(sql) || /\/\*/.test(sql) || /\*\//.test(sql)) {
    return { ok: false, reason: "comments are not allowed in generated SQL" };
  }

  // Rule 2 — single statement. Allow exactly one optional trailing semicolon.
  const withoutTrailing = sql.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return { ok: false, reason: "multiple statements are not allowed" };
  }
  sql = withoutTrailing.trim();

  // Rule 1 — must be a SELECT (a leading WITH … CTE is allowed; it still resolves to
  // a SELECT). Then: no forbidden keyword anywhere.
  if (!/^(select|with)\b/i.test(sql)) {
    return { ok: false, reason: "only SELECT queries are allowed" };
  }
  const forbidden = sql.match(FORBIDDEN_RE);
  if (forbidden) {
    return { ok: false, reason: `forbidden keyword '${forbidden[1].toUpperCase()}' is not allowed` };
  }
  // A WITH must still contain a SELECT (no WITH … DELETE, already blocked above, but
  // also reject a WITH that never SELECTs).
  if (/^with\b/i.test(sql) && !/\bselect\b/i.test(sql)) {
    return { ok: false, reason: "only SELECT queries are allowed" };
  }

  // Rule 4 — known tables + columns, derived from the live catalog (the allow-list).
  const known = new Map<string, Set<string>>();
  for (const t of catalog) {
    known.set(t.table.toLowerCase(), new Set(t.columns.map((c) => c.name.toLowerCase())));
  }

  // The tables this query references (FROM / JOIN). Must all be known.
  const referenced = referencedTables(sql);
  if (referenced.length === 0) {
    return { ok: false, reason: "query references no table" };
  }
  for (const t of referenced) {
    if (!known.has(t.toLowerCase())) {
      return { ok: false, reason: `unknown table '${t}'` };
    }
  }

  // Aliases (FROM contracts c / JOIN x AS y) map to a real table's columns.
  const aliasToTable = collectAliases(sql, known);

  // Every column identifier must resolve to a real column of an in-scope table.
  const colCheck = checkColumns(sql, referenced, aliasToTable, known);
  if (!colCheck.ok) return colCheck;

  // Rule 5 — enforce a LIMIT.
  sql = enforceLimit(sql);

  return { ok: true, sql };
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Tables named after FROM / JOIN. Conservative: captures the identifier directly
// following the keyword (handles `FROM contracts`, `JOIN sales s`, `from "My Table"`).
function referencedTables(sql: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(`\\b(?:from|join)\\s+(${IDENT})`, "gi");
  for (const m of sql.matchAll(re)) out.add(unquote(m[1]));
  return [...out];
}

// alias → table, from `FROM t alias` / `FROM t AS alias` / `JOIN t alias`. Only
// records an alias when the thing being aliased is a KNOWN base table (so we don't
// treat a SQL keyword like WHERE/GROUP as an alias).
function collectAliases(
  sql: string,
  known: Map<string, Set<string>>
): Map<string, string> {
  const aliases = new Map<string, string>();
  const re = new RegExp(`\\b(?:from|join)\\s+(${IDENT})(?:\\s+(?:as\\s+)?(${IDENT}))?`, "gi");
  const reserved = new Set([
    "on", "where", "group", "order", "limit", "join", "inner", "left", "right",
    "outer", "cross", "using", "having", "and", "or", "natural",
  ]);
  for (const m of sql.matchAll(re)) {
    const table = unquote(m[1]).toLowerCase();
    if (!known.has(table)) continue;
    const alias = m[2] ? unquote(m[2]).toLowerCase() : "";
    if (alias && !reserved.has(alias)) aliases.set(alias, table);
    // The bare table name also acts as its own qualifier (FROM contracts → contracts.x).
    aliases.set(table, table);
  }
  return aliases;
}

// Scan for column identifiers and verify each resolves. We check:
//   • qualified refs   alias.col / table.col  → that table must HAVE col
//   • bare identifiers col                    → must exist in SOME in-scope table
// Tolerant of SQL keywords, function names, numbers, string/quoted literals, and
// `*` / `rowid` (always allowed). The goal is to REJECT a hallucinated column name,
// not to be a full SQL parser — anything we can't confidently classify as a column
// is skipped (we never reject a real query for being too clever, but a bare word
// that is NOT a keyword/function and NOT any table's column IS rejected).
function checkColumns(
  sql: string,
  referenced: string[],
  aliasToTable: Map<string, string>,
  known: Map<string, Set<string>>
): SqlGuardResult {
  // All columns available across the referenced tables (for bare-identifier checks).
  const allCols = new Set<string>();
  for (const t of referenced) {
    for (const c of known.get(t.toLowerCase()) ?? []) allCols.add(c);
  }

  // RESULT-COLUMN ALIASES: a `… AS name` introduces `name` as a label, not a real
  // column — it is legitimate and must not be flagged as "unknown column". Collect
  // every alias name so the bare-identifier scan treats them as known.
  const aliasNames = new Set<string>();
  for (const m of sql.matchAll(new RegExp(`\\bas\\s+(${IDENT})`, "gi"))) {
    aliasNames.add(unquote(m[1]).toLowerCase());
  }

  // 1. Qualified references: alias.col  — the strongest signal of a real column ref.
  const qualRe = new RegExp(`(${IDENT})\\.(${IDENT})`, "g");
  for (const m of sql.matchAll(qualRe)) {
    const q = unquote(m[1]).toLowerCase();
    const col = unquote(m[2]).toLowerCase();
    if (col === "*" || col === "rowid") continue;
    const table = aliasToTable.get(q);
    if (!table) {
      // Qualifier isn't a known alias/table → the model invented a table qualifier.
      return { ok: false, reason: `unknown table/alias '${unquote(m[1])}'` };
    }
    const cols = known.get(table);
    if (cols && !cols.has(col)) {
      return { ok: false, reason: `unknown column '${unquote(m[2])}' on table '${table}'` };
    }
  }

  // 2. Bare identifiers that sit where a column belongs: after SELECT, WHERE, AND, OR,
  //    ON, GROUP BY, ORDER BY, HAVING, or a comparison/operator. We extract candidate
  //    bare words and reject any that is clearly a column position but matches no
  //    known column. Keywords, functions (ident directly followed by `(`), aliases,
  //    table names, and literals are excluded.
  const stripped = stripStringsAndQualified(sql);
  for (const word of stripped.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const w = word[0];
    const lw = w.toLowerCase();
    if (SQL_KEYWORDS.has(lw) || SQL_FUNCS.has(lw)) continue;
    if (aliasToTable.has(lw) || known.has(lw)) continue; // a table/alias name
    if (aliasNames.has(lw)) continue; // a result-column alias (… AS name)
    // Skip if it's actually a function call `name(` (the `(` survives stripping).
    const idx = word.index ?? 0;
    if (stripped[idx + w.length] === "(") continue;
    // A bare candidate column that no in-scope table has → a hallucinated column.
    if (!allCols.has(lw)) {
      return { ok: false, reason: `unknown column '${w}'` };
    }
  }

  return { ok: true, sql };
}

// Remove string literals and qualified refs (alias.col) so the bare-identifier scan
// doesn't re-flag the column half of a qualified ref or trip on literal text. We
// replace qualified refs and strings with spaces (preserving offsets) so the `(`
// function-call lookahead still lines up.
function stripStringsAndQualified(sql: string): string {
  let s = sql.replace(/'(?:[^']|'')*'/g, (m) => " ".repeat(m.length)); // 'literals'
  s = s.replace(new RegExp(`(${IDENT})\\.(${IDENT})`, "g"), (m) => " ".repeat(m.length));
  return s;
}

function enforceLimit(sql: string): string {
  const m = sql.match(/\blimit\s+(\d+)\b/i);
  if (!m) return `${sql} LIMIT ${DEFAULT_ROW_LIMIT}`;
  const n = Number(m[1]);
  if (n > HARD_ROW_CAP) {
    return sql.replace(/\blimit\s+\d+\b/i, `LIMIT ${HARD_ROW_CAP}`);
  }
  return sql;
}

function unquote(s: string): string {
  return s.replace(/^"|"$/g, "");
}

// SQL keywords + clause words we never treat as a column. Lowercased.
const SQL_KEYWORDS = new Set([
  "select", "from", "where", "and", "or", "not", "in", "is", "null", "as",
  "join", "inner", "left", "right", "outer", "cross", "natural", "on", "using",
  "group", "by", "order", "having", "limit", "offset", "asc", "desc", "distinct",
  "with", "union", "all", "except", "intersect", "case", "when", "then", "else",
  "end", "like", "between", "exists", "true", "false", "collate", "nocase",
  "cast", "escape", "glob",
]);

// Aggregate / scalar functions a generated analytical query commonly uses. An ident
// directly followed by `(` is also treated as a function, so this is a backstop.
const SQL_FUNCS = new Set([
  "count", "sum", "avg", "min", "max", "round", "abs", "length", "lower", "upper",
  "trim", "coalesce", "ifnull", "nullif", "substr", "substring", "replace",
  "cast", "strftime", "date", "datetime", "julianday", "total", "group_concat",
  "instr", "printf", "typeof", "iif",
]);
