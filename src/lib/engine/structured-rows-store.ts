// DURABLE structured-rows store — uploaded spreadsheet (CSV/XLSX) rows in Supabase
// (public.uploaded_rows, migration 012). This is the STRUCTURED-lane sibling of
// pgvector-store.ts (which is the DOCUMENT lane): spreadsheets are structured data
// answered by text-to-SQL, so their durable home is a row table the per-owner SQLite
// catalog is rehydrated FROM — never doc_chunks/RAG.
//
// THE BUG it fixes: uploaded rows lived ONLY in the per-Lambda in-memory runtime store,
// so a Vercel serverless COLD START wiped them — the text-to-SQL lane then had no
// uploaded tables and the router's structured catalog was empty. Persisting here +
// rehydrating before the sync introspect makes the SQL lane durable across cold starts.
//
// Per-user isolation is a HARD gate: every row carries its uploader's owner_id, and
// rehydration is owner-scoped (the server filters by owner; RLS is the defense-in-depth
// read gate). A non-admin with no owner id reads NOTHING (fail-closed), so we never
// leak one owner's tables to another — critical under Fluid Compute, where one instance
// serves concurrent requests from different users.
//
// FAIL-OPEN on writes: storeUploadedRows never throws into ingest (a Supabase blip must
// not break an upload) — it logs and returns 0, mirroring storeDocChunks.
import { admin, supabaseEnabled } from "./supabase.ts";
import { isTransientOwnerFkError } from "./pgvector-store.ts";

// One uploaded structured row ready to persist: the sanitized table id, its 1-based
// per-table row id (the [S:<table>#row] citation anchor), and the full keyed row data.
export type StorableRow = {
  table: string;
  rowId: number;
  data: Record<string, unknown>;
};

// The owner-scoped rows a rehydrate fetches. `owner` is the row's TRUE owner_id from the
// durable store (null = shared) — carried so an ADMIN hydrate (which pulls every owner's
// rows) re-tags each row with its real owner in memory, preserving member isolation.
export type HydratedRow = {
  table: string;
  rowId: number;
  data: Record<string, unknown>;
  owner: string | null;
};

// The FAIL-CLOSED isolation gate as a pure predicate (unit-tested directly): a read may
// run ONLY when the caller is an admin (sees all) OR has a concrete owner id (sees ONLY
// their own). A non-admin with no owner id must read NOTHING — we never run an unscoped
// read that could leak another user's rows. (RLS enforces this again server-side.)
export function canReadOwner(ownerId: string | undefined, isAdmin: boolean): boolean {
  return isAdmin || !!ownerId;
}

/**
 * Persist an uploaded table's rows to uploaded_rows (service-role client). A re-upload
 * of the same table REPLACES its prior rows first (delete-then-insert, owner-scoped), so
 * re-ingesting doesn't double-count — mirrors storeDocChunks for doc_chunks. owner_id
 * tags every row for per-user isolation.
 *
 * FAIL-OPEN: returns the count inserted, or 0 on any failure (logged) — never throws
 * into ingest. The in-memory runtime store (the warm fast-path) is populated separately.
 */
export async function storeUploadedRows(
  ownerId: string | undefined,
  table: string,
  label: string,
  rows: StorableRow[],
  // Per-chat scoping (migration 014): tag rows with the active chat's session_id so
  // retrieval can scope to (owner + chat). NULL = legacy/unassigned (visible to all
  // the owner's chats). Only non-null when an explicit chatId is passed in.
  chatId?: string | null
): Promise<number> {
  if (!supabaseEnabled()) {
    console.warn(
      "[structured-rows-store] Supabase not configured — uploaded spreadsheet rows not " +
        "persisted (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for durable, isolated text-to-SQL)."
    );
    return 0;
  }
  if (rows.length === 0) return 0;
  try {
    const db = admin();
    // Re-upload replaces a table's prior rows (scoped to this owner so we never touch
    // another user's rows even if two users upload a table with the same id).
    const del = db.from("uploaded_rows").delete().eq("table_name", table);
    await (ownerId ? del.eq("owner_id", ownerId) : del.is("owner_id", null));

    const payload = rows.map((r) => ({
      owner_id: ownerId ?? null,
      table_name: table,
      label,
      row_id: r.rowId,
      data: r.data,
      // Per-chat scoping (migration 014): tag with the active chat's session_id.
      // NULL = legacy/unassigned — visible to all the owner's chats (backward compat).
      session_id: chatId ?? null,
    }));
    // INSERT with a retry on a TRANSIENT owner_id FK violation (same race as doc_chunks): a just-
    // created owner isn't yet FK-visible, so an immediate ingest is rejected → 0 rows → empty catalog.
    // The owner becomes visible moments later, so retry. A non-FK error is NOT retried.
    let error = (await db.from("uploaded_rows").insert(payload)).error;
    for (let attempt = 0; attempt < 4 && error && isTransientOwnerFkError(error); attempt++) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      error = (await db.from("uploaded_rows").insert(payload)).error;
    }
    if (error) {
      console.error("[structured-rows-store] insert failed:", error.message);
      return 0;
    }
    return payload.length;
  } catch (e) {
    console.error(
      "[structured-rows-store] storeUploadedRows failed:",
      e instanceof Error ? e.message : e
    );
    return 0;
  }
}

// PostgREST's default page cap is 1000 rows per unbounded .select(). With a ≥1000-row
// table present, any subsequent table's rows fall past the first page and become
// invisible to an unbounded read. We range-paginate in chunks of this size until we get
// a short page (< PAGE_SIZE), guaranteeing we read ALL rows regardless of total count.
const PAGE_SIZE = 1000;

/**
 * The caller's durable uploaded rows (owner-scoped), for rehydrating the per-owner SQL
 * catalog after a cold start. An admin (isAdmin=true) sees every owner's rows; everyone
 * else sees ONLY their own (owner_id = ownerId). A non-admin with no ownerId reads
 * NOTHING (fail-closed) — we never leak another user's rows.
 *
 * Paginated: range-pages through ALL rows so a ≥1000-row table never hides a second
 * table that falls past PostgREST's default page cap.
 *
 * FAIL-OPEN: returns [] on any failure (logged) so the warm in-memory rows still answer.
 */
export async function fetchUploadedRows(
  ownerId: string | undefined,
  isAdmin: boolean,
  // Per-chat scoping (migration 014): when provided, fetch only rows from this chat +
  // legacy NULL-session rows. Undefined = no chat filter (all owner's rows).
  chatId?: string | null
): Promise<HydratedRow[]> {
  if (!supabaseEnabled()) return [];
  // Fail-closed isolation: a non-admin with no owner id reads nothing — never run an
  // unscoped read that could return another user's rows.
  if (!canReadOwner(ownerId, isAdmin)) return [];
  try {
    const db = admin();
    type Row = {
      table_name: string;
      row_id: number;
      data: Record<string, unknown>;
      owner_id: string | null;
    };
    const all: Row[] = [];
    let from = 0;
    // Range-paginate until we receive a page shorter than PAGE_SIZE (meaning we've
    // read the last page). This is correct for ANY total row count.
    for (;;) {
      let q = db
        .from("uploaded_rows")
        .select("table_name, row_id, data, owner_id")
        .range(from, from + PAGE_SIZE - 1);
      // An admin read is global (all owners); everyone else is scoped to their own rows.
      if (!isAdmin) q = q.eq("owner_id", ownerId!);
      // Per-chat scoping (migration 015 — STRICT): when chatId is provided, return ONLY
      // this chat's rows. The NULL-session fallback is removed; migration 015 reassigned
      // NULL-session rows to the "Imported" virtual session. Undefined = all owner rows.
      if (chatId !== undefined && chatId !== null) {
        q = q.eq("session_id", chatId);
      }
      const { data, error } = await q;
      if (error) {
        console.error("[structured-rows-store] fetchUploadedRows failed:", error.message);
        return [];
      }
      const page = (data ?? []) as Row[];
      all.push(...page);
      if (page.length < PAGE_SIZE) break; // last page reached
      from += PAGE_SIZE;
    }
    return all.map((r) => ({
      table: r.table_name,
      rowId: r.row_id,
      data: r.data ?? {},
      owner: r.owner_id ?? null,
    }));
  } catch (e) {
    console.error(
      "[structured-rows-store] fetchUploadedRows failed:",
      e instanceof Error ? e.message : e
    );
    return [];
  }
}

// One uploaded table as the Sources listing shows it — derived DURABLY from
// uploaded_rows (distinct table_name), owner-scoped, with its row count + label.
export type UploadedTableMeta = {
  table: string;
  label: string;
  rows: number;
  session_id: string | null; // the chat this table was uploaded into, or null (legacy / unassigned)
};

/**
 * The caller's uploaded STRUCTURED tables, rebuilt DURABLY from uploaded_rows (one entry
 * per distinct table_name with its row count + label), owner-scoped for per-user
 * isolation. An admin (no ownerId) sees all; a member sees only their own. Used by the
 * Sources/Documents listing so a spreadsheet surfaces as a "table · N rows" source even
 * after a cold start (it is NOT a pgvector doc).
 *
 * Paginated: range-pages through ALL rows so a ≥1000-row table never hides a second
 * table that falls past PostgREST's default page cap.
 *
 * FAIL-OPEN: returns [] on any failure (logged) so the listing still renders the rest.
 */
export async function listUploadedTables(ownerId?: string, chatId?: string | null): Promise<UploadedTableMeta[]> {
  if (!supabaseEnabled()) return [];
  try {
    const db = admin();
    const byTable = new Map<string, { label: string; rows: number; session_id: string | null }>();
    type Row = { table_name: string; label: string | null; session_id: string | null };
    let from = 0;
    // Range-paginate until we receive a page shorter than PAGE_SIZE — covers any total
    // row count so a large first table can never hide subsequent tables.
    for (;;) {
      let q = db
        .from("uploaded_rows")
        .select("table_name, label, session_id")
        .range(from, from + PAGE_SIZE - 1);
      if (ownerId) q = q.eq("owner_id", ownerId);
      // Per-chat scoping (migration 015 — STRICT): when chatId is provided, list ONLY
      // this chat's tables. The NULL-session fallback is removed; migration 015 reassigned
      // NULL-session rows to the "Imported" virtual session. Undefined = all owner tables.
      if (chatId !== undefined && chatId !== null) {
        q = q.eq("session_id", chatId);
      }
      const { data, error } = await q;
      if (error) {
        console.error("[structured-rows-store] listUploadedTables failed:", error.message);
        return [];
      }
      const page = (data ?? []) as Row[];
      for (const r of page) {
        const agg = byTable.get(r.table_name) ?? { label: r.label || r.table_name, rows: 0, session_id: null };
        agg.rows += 1;
        if (r.label && agg.label === r.table_name) agg.label = r.label;
        // Track session_id: use the first non-null value seen (all rows of a table share one).
        if (r.session_id && !agg.session_id) agg.session_id = r.session_id;
        byTable.set(r.table_name, agg);
      }
      if (page.length < PAGE_SIZE) break; // last page reached
      from += PAGE_SIZE;
    }
    return [...byTable.entries()].map(([table, agg]) => ({
      table,
      label: agg.label,
      rows: agg.rows,
      session_id: agg.session_id,
    }));
  } catch (e) {
    console.error(
      "[structured-rows-store] listUploadedTables failed:",
      e instanceof Error ? e.message : e
    );
    return [];
  }
}

/**
 * Delete an uploaded table's rows from the durable store, scoped to the owner so a
 * member can NEVER delete another user's table. An admin (no ownerId) may delete any
 * table by id. Returns the number of rows removed (best-effort; 0 on failure).
 */
export async function deleteUploadedTable(
  ownerId: string | undefined,
  table: string,
  isAdmin = false
): Promise<number> {
  if (!supabaseEnabled()) return 0;
  // Fail-closed: a non-admin with no owner id must not run an unscoped delete.
  if (!isAdmin && !ownerId) return 0;
  try {
    const db = admin();
    let del = db.from("uploaded_rows").delete({ count: "exact" }).eq("table_name", table);
    if (!isAdmin) del = del.eq("owner_id", ownerId!);
    const { count, error } = await del;
    if (error) {
      console.error("[structured-rows-store] deleteUploadedTable failed:", error.message);
      return 0;
    }
    return count ?? 0;
  } catch (e) {
    console.error(
      "[structured-rows-store] deleteUploadedTable failed:",
      e instanceof Error ? e.message : e
    );
    return 0;
  }
}
