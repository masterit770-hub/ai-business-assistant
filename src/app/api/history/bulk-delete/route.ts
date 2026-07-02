import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { admin, supabaseEnabled } from "@/lib/engine/supabase";
import { listManifestEntries, removeOriginalFile } from "@/lib/engine/doc-files";

// POST /api/history/bulk-delete
//
// Removes multiple chat sessions at once. The cascade removes:
//   1. ask_history rows for the given session_ids
//   2. session_titles overrides for the given session_ids
//   3. Storage blob + _files.json manifest entry for every doc tagged with those
//      session_ids (read from the owner's manifest — the single source of truth)
//
// OWNER ISOLATION (HARD REQUIREMENT):
//   • ALL callers (member AND admin): every delete is scoped to owner_id = caller.
//     An admin bulk-delete MUST NOT delete another owner's rows — it only deletes
//     sessions that belong to the calling admin user. This is the post-incident fix:
//     the original `if (!isAdmin)` guard allowed an admin to wipe another owner's data.
//
// We use the admin() (service-role) client and ALWAYS scope by owner_id = user.id.
// This matches the single-delete handler in /api/history/[session_id].
//
// Returns: { deleted: number } — count of ask_history rows removed.

export const runtime = "nodejs";

const MAX_IDS = 100; // Prevent abuse: at most 100 sessions per bulk-delete call.

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  // Validate body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("session_ids" in body) ||
    !Array.isArray((body as Record<string, unknown>).session_ids)
  ) {
    return NextResponse.json({ error: "session_ids must be an array" }, { status: 400 });
  }
  const session_ids = (body as Record<string, unknown>).session_ids as unknown[];
  if (!session_ids.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "session_ids must be an array of strings" }, { status: 400 });
  }
  const raw_ids = session_ids as string[];

  // Abuse guard: cap the number of ids per request (before parsing to avoid
  // bypassing with non-UUID ids that all resolve to the fast-path).
  if (raw_ids.length > MAX_IDS) {
    return NextResponse.json(
      { error: `Too many session_ids — max ${MAX_IDS} per request` },
      { status: 400 }
    );
  }

  // The UI may send two kinds of session IDs:
  //
  //   1. Real UUID sessions  — "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  //      These are stored in ask_history.session_id (a uuid column). Delete by
  //      session_id IN (...).
  //
  //   2. Synthetic "row:" sessions — "row:<ask_history.id>"
  //      Legacy single-shot asks (session_id IS NULL) are keyed in the UI by
  //      `row:<row.id>` (see groupSessions() in ask-history.ts). The DB column
  //      is uuid; there is no row where session_id = 'row:…'. The correct delete
  //      is: WHERE id = <row.id> AND session_id IS NULL.
  //
  // Sending the "row:…" strings as-is to Postgres's uuid column causes:
  //   "invalid input syntax for type uuid: "row:af19f24b-…"" → 500 for the batch.
  //
  // General fix: split the input, handle each kind correctly.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuidIds = raw_ids.filter((id) => UUID_RE.test(id));
  const legacyIds = raw_ids
    .filter((id) => id.startsWith("row:"))
    .map((id) => id.slice(4))         // strip "row:" prefix → the actual ask_history.id
    .filter((id) => UUID_RE.test(id)); // must be a valid UUID or we skip it

  // Fast path: nothing to delete.
  if (uuidIds.length === 0 && legacyIds.length === 0) {
    return NextResponse.json({ deleted: 0 });
  }

  // No persistent store configured → honest no-op (never 500).
  if (!supabaseEnabled()) {
    return NextResponse.json({ deleted: 0 });
  }

  try {
    // 1. Delete ask_history rows for the requested sessions.
    //    ALWAYS scoped to owner_id = caller — a session_id that belongs to another owner
    //    will never match and is safely ignored (fail-closed), regardless of role.
    let totalDeleted = 0;

    if (uuidIds.length > 0) {
      const { data: deleted, error: delErr } = await admin()
        .from("ask_history")
        .delete()
        .in("session_id", uuidIds)
        .eq("owner_id", user.id)
        .select("id");
      if (delErr) {
        return NextResponse.json({ error: delErr.message }, { status: 500 });
      }
      totalDeleted += deleted?.length ?? 0;
    }

    // 1b. Legacy "row:<id>" sessions: session_id IS NULL in the DB. Delete by row id.
    if (legacyIds.length > 0) {
      const { data: ldeleted, error: ldelErr } = await admin()
        .from("ask_history")
        .delete()
        .in("id", legacyIds)
        .is("session_id", null)
        .eq("owner_id", user.id)
        .select("id");
      if (ldelErr) {
        // Non-fatal: legacy rows may already be gone; log but don't block.
        console.warn("[bulk-delete] legacy row delete warning:", ldelErr.message);
      } else {
        totalDeleted += ldeleted?.length ?? 0;
      }
    }

    // 2. Best-effort: clear any rename overrides (session_titles) for these sessions.
    //    A failure here never blocks the delete — the conversation turns are already gone.
    if (uuidIds.length > 0) {
      await admin()
        .from("session_titles")
        .delete()
        .in("session_id", uuidIds)
        .eq("owner_id", user.id);
    }

    // 3. Remove Storage blob + _files.json manifest entry for each doc tagged with the
    //    deleted session_ids. The manifest is now the single source of truth — read the
    //    caller's manifest once, filter by the session_ids being deleted, then remove
    //    each doc's blob + manifest entry. Owner-scoped to the CALLER (user.id) —
    //    removeOriginalFile asserts that the Storage path starts with `${ownerId}/` before
    //    any delete. Best-effort: a failure here never blocks the session delete.
    if (uuidIds.length > 0) {
      try {
        // Read the caller's manifest without a chat filter to get all entries, then
        // filter in JS to the sessions being deleted.
        const allEntries = await listManifestEntries(user.id);
        const deletingSet = new Set(uuidIds);
        for (const e of allEntries) {
          if (e.session_id && deletingSet.has(e.session_id)) {
            await removeOriginalFile(user.id, e.docId).catch((err) =>
              console.warn(
                `[bulk-delete] removeOriginalFile failed for '${e.docId}': ${err instanceof Error ? err.message : err}`
              )
            );
          }
        }
      } catch (e) {
        console.warn(`[bulk-delete] manifest-based doc cleanup failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    return NextResponse.json({ deleted: totalDeleted });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to bulk-delete sessions" },
      { status: 500 }
    );
  }
}
