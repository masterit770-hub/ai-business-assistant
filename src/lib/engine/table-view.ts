// Pure helpers behind GET /api/table — the structured-table VIEWER + CSV export.
//
// These are deliberately pure (no I/O, no auth, no DB): the route wires them to
// introspectSchema()/the structured store + the session, and these functions do the
// paging math, the access policy, and the row→CSV serialization. Keeping them pure
// makes the load-bearing bits (CSV escaping, paging clamp, isolation policy) unit-
// testable without a DB or a live request — see tests/unit/table-view.test.mts.

export const MAX_PAGE = 100; // hard cap on rows returned per page (no unbounded dump)
export const DEFAULT_PAGE = 50;

export type Paging = { limit: number; offset: number };

/**
 * Clamp the caller's ?limit=&offset= into a safe window. A missing/invalid limit
 * falls back to DEFAULT_PAGE; anything over MAX_PAGE is capped (so the endpoint can
 * never be asked to dump an arbitrarily large table). A missing/invalid/negative
 * offset becomes 0. CSV export passes a larger requested limit but is still capped.
 */
export function clampPaging(
  rawLimit: string | null,
  rawOffset: string | null,
  max = MAX_PAGE
): Paging {
  const l = Number(rawLimit);
  const limit =
    Number.isFinite(l) && l > 0 ? Math.min(Math.floor(l), max) : Math.min(DEFAULT_PAGE, max);
  const o = Number(rawOffset);
  const offset = Number.isFinite(o) && o > 0 ? Math.floor(o) : 0;
  return { limit, offset };
}

// RFC-4180 CSV cell: quote when the value contains a comma, quote, CR or LF, and
// escape embedded quotes by doubling them. A null/undefined cell is an empty field.
function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Serialize an introspected page (column order from `columns`) into CSV text with a
 * header row, CRLF line endings (RFC-4180), and proper escaping. Each row is read by
 * COLUMN so the CSV column order matches the header exactly even when a row object's
 * key order differs or a column is missing (→ empty field). Pure: callers stream the
 * returned string as text/csv.
 */
export function rowsToCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines: string[] = [];
  lines.push(columns.map(csvCell).join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(row[c])).join(","));
  }
  return lines.join("\r\n");
}

export type TableKind = "bundled" | "uploaded";
export type AccessDecision =
  | { ok: true }
  | { ok: false; status: 403 | 404; error: string };

/**
 * The per-user ISOLATION policy for reading a structured table. Fail-closed:
 *   • a HIDDEN (admin-deleted) table is never served            → 404 (as if absent).
 *   • a BUNDLED, non-hidden table is shared business data         → any authed user.
 *   • an UPLOADED table (introspectable but not bundled) carries no verifiable owner
 *     in the runtime store, so a member must NOT be able to read another member's
 *     upload. We therefore restrict uploaded tables to an ADMIN (who already sees all
 *     uploads). A member asking for one gets 404 — it does not exist FOR THEM.
 *   • a table that isn't in the catalog at all                   → 404.
 * This guarantees a member can never view/export an uploaded table that isn't theirs,
 * without depending on owner metadata the runtime store doesn't carry.
 */
export function decideAccess(opts: {
  table: string;
  isHidden: boolean;
  kind: TableKind | null; // null = not in the catalog
  role: "user" | "admin";
}): AccessDecision {
  const { isHidden, kind, role } = opts;
  if (isHidden || kind === null) {
    return { ok: false, status: 404, error: "table not found" };
  }
  if (kind === "bundled") return { ok: true };
  // uploaded → admin-only (member can't verify ownership → treat as absent for them)
  if (role === "admin") return { ok: true };
  return { ok: false, status: 404, error: "table not found" };
}

/** A safe download filename for a table's CSV export (citation-safe id + .csv). */
export function csvFilename(table: string): string {
  const safe = table.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "table";
  return `${safe}.csv`;
}
