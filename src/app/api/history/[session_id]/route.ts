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
