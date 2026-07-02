import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { assignSessionToSpace, sessionsInSpace, spaceExistsForOwner } from "@/lib/engine/spaces";
import { admin, supabaseEnabled } from "@/lib/engine/supabase";
import { groupSessions, mergeSessionSources, type AskRow } from "@/lib/engine/ask-history";
import { listManifestEntries } from "@/lib/engine/doc-files";

// Knowledge Space → Sessions API.
//   GET  ?space=<id> → list sessions (chats) inside a space, with titles
//   POST             → body: { sessionId, spaceId } → assign a chat to a space
export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const spaceId = new URL(req.url).searchParams.get("space");
  if (!spaceId) {
    return NextResponse.json({ error: "space param required" }, { status: 400 });
  }
  if (!supabaseEnabled()) {
    return NextResponse.json({ sessions: [] });
  }
  try {
    // A chat can belong to a space via EITHER source:
    //   • an explicit session_spaces row (written on ask/upload in the space), OR
    //   • a manifest doc tagged with this space (the doc's session_id).
    // Real users' chats were never written to session_spaces before this fix, so gating on
    // sessionsInSpace() alone left the list permanently empty (F1). Merge BOTH id sources
    // and only short-circuit when the union is empty — so a space with only doc-derived
    // chats still lists them.
    const tableSessionIds = await sessionsInSpace(user.id, spaceId);

    // Sessions known from manifest docs (a doc uploaded into the space, maybe no ask yet).
    const manifestEntries = await listManifestEntries(user.id, null, { spaceId });
    const docSessionIds = new Set<string>();
    for (const e of manifestEntries) {
      if (e.session_id) docSessionIds.add(e.session_id);
    }

    // The full universe of this space's chat ids — the query set for titles + history.
    const sessionIds = Array.from(new Set<string>([...tableSessionIds, ...docSessionIds]));
    if (sessionIds.length === 0) {
      return NextResponse.json({ sessions: [] });
    }

    const client = admin();
    // Fetch ask_history rows for these sessions + title overrides.
    const { data: rows } = await client
      .from("ask_history")
      .select("id, owner_id, session_id, question, created_at")
      .in("session_id", sessionIds)
      .order("created_at", { ascending: false })
      .limit(500);

    const { data: titles } = await client
      .from("session_titles")
      .select("session_id, owner_id, title, updated_at")
      .in("session_id", sessionIds);

    const titleOf = titles
      ? new Map((titles as { session_id: string; title: string | null }[]).map((t) => [t.session_id, t.title ?? ""]))
      : undefined;
    const updatedAtOf = titles
      ? new Map(
          (titles as { session_id: string; updated_at: string | null }[])
            .filter((t) => t.updated_at)
            .map((t) => [t.session_id, t.updated_at as string])
        )
      : undefined;
    const titledIds = new Set<string>(titles?.map((t: { session_id: string }) => t.session_id) ?? []);

    // docSessionIds (the manifest-derived chats) was computed above; a doc-only chat with
    // no ask row still surfaces here as a zero-turn entry via mergeSessionSources.
    const askSessions = groupSessions((rows ?? []) as AskRow[], undefined, titleOf);
    const sessions = mergeSessionSources(askSessions, titledIds, docSessionIds, titleOf, updatedAtOf);

    return NextResponse.json({ sessions });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to list sessions" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  let sessionId = "";
  let spaceId = "";
  try {
    const body = await req.json();
    sessionId = (body?.sessionId ?? "").toString().trim();
    spaceId = (body?.spaceId ?? "").toString().trim();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!sessionId || !spaceId) {
    return NextResponse.json({ error: "sessionId and spaceId are required" }, { status: 400 });
  }
  try {
    // OWNERSHIP GATE (F7): only assign to a space the caller actually owns. Without this a
    // user could attach their chat to another user's space id. spaceExistsForOwner returns
    // the SAME false whether the space is missing OR foreign, and we return an identical 404
    // for both — never leaking whether the id exists.
    if (!(await spaceExistsForOwner(user.id, spaceId))) {
      return NextResponse.json({ error: "space not found" }, { status: 404 });
    }
    await assignSessionToSpace(user.id, sessionId, spaceId);
    return NextResponse.json({ ok: true, sessionId, spaceId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to assign session" },
      { status: 500 }
    );
  }
}
