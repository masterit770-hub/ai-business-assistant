import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { admin, supabaseEnabled } from "@/lib/engine/supabase";
import { groupSessions, type AskRow } from "@/lib/engine/ask-history";

// Ask history API — the caller's past asks grouped into conversation SESSIONS, newest
// session first. A session = the ask_history rows sharing one session_id; its title is
// the first turn's question, its turn_count/last_at summarise the thread. AUTH:
// requires a signed-in, enabled user (401 otherwise). Per-user isolation: a MEMBER
// gets ONLY their own sessions; an ADMIN gets EVERYONE's (with the owner's email).
//
// We use the service-role client (admin()) and scope by owner_id IN CODE for members,
// so the same path serves both roles; RLS on the table is the defense-in-depth layer
// (a member's own JWT can only ever read their own rows).
export const runtime = "nodejs";

// Pull enough recent rows to group into a reasonable number of sessions. (Rows, not
// sessions — a chatty session is several rows.)
const ROW_LIMIT = 500;

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  if (!supabaseEnabled()) {
    // No persistent store configured → an honest empty history (never a 500).
    return NextResponse.json({ sessions: [] });
  }

  const isAdmin = user.role === "admin";
  try {
    let query = admin()
      .from("ask_history")
      .select("id, owner_id, session_id, question, created_at")
      .order("created_at", { ascending: false })
      .limit(ROW_LIMIT);
    // A member is scoped to their OWN rows; an admin sees everyone's.
    if (!isAdmin) query = query.eq("owner_id", user.id);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const rows = (data ?? []) as AskRow[];

    // For an admin, attach the owner's email so the cross-user view is legible.
    let emailOf: Map<string, string> | undefined;
    if (isAdmin && rows.length > 0) {
      const ownerIds = [...new Set(rows.map((r) => r.owner_id))];
      const { data: profiles } = await admin()
        .from("profiles")
        .select("id, email")
        .in("id", ownerIds);
      emailOf = new Map((profiles ?? []).map((p) => [p.id as string, (p.email as string) ?? ""]));
    }

    // Collapse the rows into one entry per conversation, newest session first.
    const sessions = groupSessions(rows, emailOf);
    return NextResponse.json({ sessions });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to load history" },
      { status: 500 }
    );
  }
}
