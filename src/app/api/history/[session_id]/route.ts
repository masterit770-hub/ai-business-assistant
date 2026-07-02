import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { admin, supabaseEnabled } from "@/lib/engine/supabase";
import { removeRuntimeDoc } from "@/lib/engine/runtime-store";
import { listManifestEntries, removeOriginalFile } from "@/lib/engine/doc-files";

// One conversation's ORDERED turns — the rows of a single session, oldest first, so the
// chat can be RESUMED and continued. AUTH: requires a signed-in, enabled user. Per-user
// isolation: a MEMBER may load ONLY a session whose rows they own; an ADMIN may load any
// session. We resolve the session by its session_id and (for a member) require the rows
// to belong to the caller — RLS is the defense-in-depth layer behind this code check.
export const runtime = "nodejs";

const ROW_LIMIT = 200;

// Does this session EXIST for the caller even though it has no ask_history turns? A
// chat is real if the owner has a rename (session_titles) row OR a manifest entry tagged
// with this sessionId — e.g. a restored account whose chats carry only titles + uploaded
// files and zero asks. Owner-scoped (member: own rows; admin treated as member-scoped
// to their own id so they can only open sessions they own).
// Best-effort: any read error counts as "not found" rather than throwing. This lets the
// client distinguish a REAL but empty chat (open it, continue, its docs are in scope)
// from a genuinely unknown/foreign id (the honest "couldn't be found" notice).
async function sessionExistsForOwner(
  sessionId: string,
  ownerId: string | null
): Promise<boolean> {
  try {
    // 1. Check session_titles (a rename/title means the chat is real).
    let tq = admin()
      .from("session_titles")
      .select("session_id", { count: "exact", head: true })
      .eq("session_id", sessionId);
    if (ownerId) tq = tq.eq("owner_id", ownerId);
    const { count: titlesCount } = await tq;
    if ((titlesCount ?? 0) > 0) return true;

    // 2. Check the _files.json manifest for any doc tagged with this session.
    // ownerId null means admin looking at any session — we use the caller's id
    // (passed as null if admin) for the manifest read; admins only see their own manifest.
    // If ownerId is null we can't do a manifest check here (we'd need the session owner's
    // id, which we don't know). In that case fall through to false — an admin with no
    // title and no docs in their own manifest can't confirm a foreign session this way.
    if (ownerId) {
      const manifestEntries = await listManifestEntries(ownerId, sessionId);
      if (manifestEntries.length > 0) return true;
    }

    return false;
  } catch {
    return false;
  }
}

type TurnRow = {
  owner_id: string;
  question: string;
  answer: string;
  mode: string | null;
  citations: unknown;
  route: unknown;
  inspector: unknown;
  evidence: unknown;
  validation: unknown;
  created_at: string;
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ session_id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { session_id: sessionId } = await params;
  if (!sessionId) {
    return NextResponse.json({ error: "session_id is required" }, { status: 400 });
  }
  if (!supabaseEnabled()) {
    // No persistent store configured → an honest empty session (never a 500).
    return NextResponse.json({ turns: [] });
  }

  const isAdmin = user.role === "admin";
  try {
    let query = admin()
      .from("ask_history")
      .select("owner_id, question, answer, mode, citations, route, inspector, evidence, validation, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true }) // oldest first → the thread in order
      .limit(ROW_LIMIT);
    // OWNERSHIP SCOPING: a member can only load their OWN session; an admin any session.
    if (!isAdmin) query = query.eq("owner_id", user.id);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const rows = (data ?? []) as TurnRow[];
    // No ask_history turns. That can mean two very different things, so we disambiguate:
    //   • the session EXISTS for this owner (it has a title and/or uploaded docs) — a
    //     real, openable chat with zero asks yet (e.g. a restored account). Return
    //     exists:true so the client opens it to the welcome state, scoped to its docs,
    //     rather than the "couldn't be found" dead-end.
    //   • it's a genuinely unknown id, or a member's guess at another user's session —
    //     exists:false → the honest not-found notice.
    if (rows.length === 0) {
      const exists = await sessionExistsForOwner(sessionId, isAdmin ? null : user.id);
      return NextResponse.json({ turns: [], exists });
    }

    const turns = rows.map((r) => ({
      question: r.question,
      answer: r.answer,
      mode: r.mode,
      citations: r.citations,
      // The REAL persisted trace (null for rows written before migration 008) — the
      // dashboard replays these so a resumed answer shows its true inspector, not a
      // fabricated "Route NONE / 0 passages".
      route: r.route ?? null,
      inspector: r.inspector ?? null,
      evidence: r.evidence ?? null,
      validation: r.validation ?? null,
      created_at: r.created_at,
    }));
    return NextResponse.json({ turns });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to load session" },
      { status: 500 }
    );
  }
}

// Title length cap — a rename is a short label, not a document. Generous, but bounded
// so a pathological paste can't bloat the row. Trimmed first; an empty/blank rename is
// rejected (the UI should fall back to the original question rather than blank it).
const MAX_TITLE = 200;

/**
 * RENAME a conversation — store/replace a session_titles OVERRIDE for this session.
 * We DON'T touch the immutable first question (the logged turn); the listing simply
 * prefers this override when present. AUTH + per-user isolation: a MEMBER may rename
 * only a session whose ask_history rows they OWN; an ADMIN may rename any. We verify
 * ownership by reading the session's rows first (a member who doesn't own the session,
 * or an unknown id, gets a 404 — never another user's thread), then upsert keyed by
 * session_id with that owner.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ session_id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { session_id: sessionId } = await params;
  if (!sessionId) {
    return NextResponse.json({ error: "session_id is required" }, { status: 400 });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (title.length > MAX_TITLE) {
    return NextResponse.json(
      { error: `title must be ${MAX_TITLE} characters or fewer` },
      { status: 400 }
    );
  }
  if (!supabaseEnabled()) {
    // No persistent store → nothing to rename. Honest, never a 500.
    return NextResponse.json({ error: "history is not configured" }, { status: 503 });
  }

  const isAdmin = user.role === "admin";
  try {
    // Resolve the session's OWNER from its rows (and confirm it exists + the caller may
    // touch it). A member can only see their own rows; an admin sees any.
    let ownerQ = admin()
      .from("ask_history")
      .select("owner_id")
      .eq("session_id", sessionId)
      .limit(1);
    if (!isAdmin) ownerQ = ownerQ.eq("owner_id", user.id);
    const { data: ownerRows, error: ownerErr } = await ownerQ;
    if (ownerErr) {
      return NextResponse.json({ error: ownerErr.message }, { status: 500 });
    }
    const ownerId = (ownerRows?.[0] as { owner_id?: string } | undefined)?.owner_id;
    if (!ownerId) {
      // Unknown id, or a member's session that isn't theirs → 404 (never reveal it).
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }

    const { error: upErr } = await admin()
      .from("session_titles")
      .upsert(
        { session_id: sessionId, owner_id: ownerId, title, updated_at: new Date().toISOString() },
        { onConflict: "session_id" }
      );
    if (upErr) {
      return NextResponse.json({ error: upErr.message }, { status: 500 });
    }
    return NextResponse.json({ session_id: sessionId, title });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to rename session" },
      { status: 500 }
    );
  }
}

/**
 * DELETE a conversation — remove this session's ask_history rows (and any rename
 * override). AUTH + per-user isolation: a MEMBER may delete only a session they OWN;
 * an ADMIN may delete any. The delete is scoped by owner_id IN CODE for a member, so a
 * member can never delete another user's thread even with a guessed id; RLS is the
 * defense-in-depth layer behind this.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ session_id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { session_id: sessionId } = await params;
  if (!sessionId) {
    return NextResponse.json({ error: "session_id is required" }, { status: 400 });
  }
  if (!supabaseEnabled()) {
    // No persistent store → nothing to delete. Honest, idempotent no-op.
    return NextResponse.json({ deleted: 0 });
  }

  const isAdmin = user.role === "admin";
  try {
    // Delete the session's history rows. A member is scoped to their OWN rows (so a
    // guessed id can't touch another user's thread); an admin may delete any session.
    let del = admin().from("ask_history").delete().eq("session_id", sessionId);
    if (!isAdmin) del = del.eq("owner_id", user.id);
    const { data: deleted, error } = await del.select("id");
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Best-effort: clear any rename override for this session too (same scoping). A
    // failure here never blocks the delete — the conversation's turns are already gone.
    let tdel = admin().from("session_titles").delete().eq("session_id", sessionId);
    if (!isAdmin) tdel = tdel.eq("owner_id", user.id);
    await tdel;

    // CASCADE the session's UPLOADED DOCS. The manifest is now the single source of
    // truth: list all entries tagged with this sessionId, remove each blob + manifest
    // entry + runtime registry entry. Deleting only the conversation would leave orphaned
    // docs that RESURRECT the chat in the sidebar — the "deleted thing keeps coming back"
    // bug. Owner-scoped to the caller (user.id). Best-effort — the conversation's turns
    // are already gone, so a cleanup failure must never error the delete.
    try {
      const docsForSession = await listManifestEntries(user.id, sessionId);
      for (const e of docsForSession) {
        await removeOriginalFile(user.id, e.docId);
        removeRuntimeDoc(e.docId);
      }
    } catch {
      /* best-effort doc cascade — never block the conversation delete */
    }

    return NextResponse.json({ deleted: deleted?.length ?? 0 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to delete session" },
      { status: 500 }
    );
  }
}
