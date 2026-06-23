import { getCurrentUser } from "@/lib/supabase/auth";
import {
  getStore,
  introspectSchema,
  hydrateUploadedTables,
  type CatalogScope,
} from "@/lib/engine/structured-store";
import { refreshDeletedSources, deletedSourceIds } from "@/lib/engine/deleted-sources";
import { bundledSources } from "@/lib/engine/bundled-sources";
import {
  clampPaging,
  rowsToCsv,
  decideAccess,
  csvFilename,
  type TableKind,
} from "@/lib/engine/table-view";

// VIEW a structured table — so a [S]-table source in "Your materials" is no longer a
// black box ("Table · 760 rows") but real, verifiable columns + rows.
//
//   GET /api/table?table=<name>[&limit=&offset=][&format=csv]
//     • Returns the table's columns + a page of rows from the INTROSPECTED structured
//       store (PRAGMA-derived catalog → never a hardcoded shape).
//     • Paging: ?limit (default 50, capped 100) & ?offset. Response carries total +
//       hasMore so the viewer can page.
//     • ?format=csv → a CSV download (Content-Type: text/csv, attachment) of the page.
//
// AUTH + ISOLATION (fail-closed, see decideAccess):
//     • requires a signed-in, enabled user.
//     • HIDDEN (admin-deleted) tables are never served (404) — excluded everywhere.
//     • BUNDLED business tables (contracts, maintenance, …) are shared → any authed user.
//     • UPLOADED tables now carry a verifiable owner (uploaded_rows.owner_id), and the
//       catalog is introspected OWNER-SCOPED below — so a member's scoped catalog holds
//       ONLY their own uploaded tables. An uploaded table present in the caller's scoped
//       catalog is therefore theirs (or, for an admin, any owner's) → readable; a table
//       belonging to another member never appears in the caller's catalog (resolves to
//       null → 404). Isolation is enforced by the scope, not a blanket admin-only rule.
export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }

  const params = new URL(req.url).searchParams;
  const table = params.get("table");
  if (!table) {
    return Response.json({ error: "table query param is required" }, { status: 400 });
  }

  // Refresh the workspace hidden-set so an admin-deleted table is excluded here too.
  await refreshDeletedSources();
  const hidden = deletedSourceIds();

  // OWNER-SCOPED catalog: an admin sees all uploaded tables; a member only their own.
  // Presence in this scoped catalog encodes ownership, so isolation is enforced here
  // (a member never sees another member's table → resolves to null → 404). Hydrate the
  // caller's durable rows first so a table they uploaded is visible after a cold start.
  const isAdmin = user.role === "admin";
  const scope: CatalogScope = { ownerId: isAdmin ? undefined : user.id, isAdmin };
  await hydrateUploadedTables(scope.ownerId, isAdmin);

  // The introspected catalog already drops hidden + internal tables. Find the exact
  // match (case-insensitively) so we use the catalog's canonical name + column list.
  const { catalog } = introspectSchema(3, true, scope);
  const entry = catalog.find((t) => t.table.toLowerCase() === table.toLowerCase());

  // Is this a BUNDLED (shared) structured table, or an uploaded/runtime one?
  const bundledTableIds = new Set(
    bundledSources()
      .filter((s) => s.kind === "structured")
      .map((s) => s.doc.toLowerCase())
  );
  let kind: TableKind | null = null;
  if (entry) {
    kind = bundledTableIds.has(entry.table.toLowerCase()) ? "bundled" : "uploaded";
  }

  const access = decideAccess({
    table,
    isHidden: hidden.has(table) || (entry ? hidden.has(entry.table) : false),
    kind,
    role: user.role,
  });
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }

  // entry is non-null here (decideAccess returns 404 when kind === null).
  const canonical = entry!.table;
  const columns = entry!.columns.map((c) => c.name);

  // CSV export = the WHOLE table, so a one-click download is never silently truncated
  // to a UI page (the bug: it capped at 50/100 while the header advertised the true
  // total). The interactive viewer still pages via clampPaging. A high hard bound still
  // guards against a pathological unbounded dump.
  const isCsv = params.get("format") === "csv";
  const CSV_MAX_ROWS = 1_000_000;
  const { limit, offset } = clampPaging(params.get("limit"), params.get("offset"));

  let total = 0;
  let rows: Record<string, unknown>[] = [];
  try {
    const db = getStore(scope);
    // Identifiers (table + columns) come from the INTROSPECTED catalog, not raw user
    // input; values (limit/offset) are bound parameters → no SQL injection surface.
    const colList = columns.map((c) => `"${c}"`).join(", ");
    total = (db.prepare(`SELECT COUNT(*) AS n FROM "${canonical}"`).get() as { n: number }).n;
    rows = isCsv
      ? (db
          .prepare(`SELECT ${colList} FROM "${canonical}" LIMIT ?`)
          .all(CSV_MAX_ROWS) as Record<string, unknown>[])
      : (db
          .prepare(`SELECT ${colList} FROM "${canonical}" LIMIT ? OFFSET ?`)
          .all(limit, offset) as Record<string, unknown>[]);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "failed to read table" },
      { status: 500 }
    );
  }

  if (isCsv) {
    const csv = rowsToCsv(columns, rows);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFilename(canonical)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  return Response.json({
    table: canonical,
    kind,
    columns: entry!.columns, // { name, type }
    rows,
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  });
}
