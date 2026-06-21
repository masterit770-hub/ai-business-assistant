import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { admin, supabaseEnabled } from "@/lib/engine/supabase";

// One conversation's ORDERED turns — the rows of a single session, oldest first, so the
// chat can be RESUMED and continued. AUTH: requires a signed-in, enabled user. Per-user
// isolation: a MEMBER may load ONLY a session whose rows they own; an ADMIN may load any
// session. We resolve the session by its session_id and (for a member) require the rows
// to belong to the caller — RLS is the defense-in-depth layer behind this code check.
export const runtime = "nodejs";

const ROW_LIMIT = 200;

type TurnRow = {
  owner_id: string;
  question: string;
  answer: string;
  mode: string | null;
  citations: unknown;
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
      .select("owner_id, question, answer, mode, citations, created_at")
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
    // A member asking for a session that isn't theirs (or an unknown id) gets an empty,
    // honest result — never another user's turns.
    if (rows.length === 0) {
      return NextResponse.json({ turns: [] });
    }

    const turns = rows.map((r) => ({
      question: r.question,
      answer: r.answer,
      mode: r.mode,
      citations: r.citations,
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

    return NextResponse.json({ deleted: deleted?.length ?? 0 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to delete session" },
      { status: 500 }
    );
  }
}
