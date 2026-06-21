import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { admin, supabaseEnabled } from "@/lib/engine/supabase";

// Ask history API — the caller's own past asks (question + answer + sources/citations
// used + routing decision), most recent first. AUTH: requires a signed-in, enabled
// user (401/403 like the settings route). Per-user isolation: a MEMBER gets ONLY
// their own rows; an ADMIN gets EVERYONE's (with the owner's email when available).
//
// We use the service-role client (admin()) and scope by owner_id IN CODE for members,
// so the same path serves both roles; RLS on the table is the defense-in-depth layer
// (a member's own JWT can only ever read their own rows).
export const runtime = "nodejs";

const LIMIT = 100;

type HistoryRow = {
  id: string;
  owner_id: string;
  question: string;
  answer: string;
  mode: string | null;
  citations: unknown;
  route: unknown;
  created_at: string;
};

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  if (!supabaseEnabled()) {
    // No persistent store configured → an honest empty history (never a 500).
    return NextResponse.json({ items: [] });
  }

  const isAdmin = user.role === "admin";
  try {
    let query = admin()
      .from("ask_history")
      .select("id, owner_id, question, answer, mode, citations, route, created_at")
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    // A member is scoped to their OWN rows; an admin sees everyone's.
    if (!isAdmin) query = query.eq("owner_id", user.id);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const rows = (data ?? []) as HistoryRow[];

    // For an admin, attach the owner's email so the cross-user view is legible.
    let emailOf = new Map<string, string>();
    if (isAdmin && rows.length > 0) {
      const ownerIds = [...new Set(rows.map((r) => r.owner_id))];
      const { data: profiles } = await admin()
        .from("profiles")
        .select("id, email")
        .in("id", ownerIds);
      emailOf = new Map((profiles ?? []).map((p) => [p.id as string, (p.email as string) ?? ""]));
    }

    const items = rows.map((r) => ({
      id: r.id,
      question: r.question,
      answer: r.answer,
      mode: r.mode,
      citations: r.citations,
      route: r.route,
      created_at: r.created_at,
      // owner_id/email only for the admin cross-user view (a member sees only self).
      ...(isAdmin ? { owner_id: r.owner_id, owner_email: emailOf.get(r.owner_id) ?? null } : {}),
    }));

    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to load history" },
      { status: 500 }
    );
  }
}
