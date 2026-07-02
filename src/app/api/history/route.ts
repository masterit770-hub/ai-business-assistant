import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { admin, supabaseEnabled } from "@/lib/engine/supabase";
import { groupSessions, mergeSessionSources, type AskRow } from "@/lib/engine/ask-history";
import { listManifestEntries } from "@/lib/engine/doc-files";
import {
  SAMPLE_DATA_SESSION_ID,
  SAMPLE_DATA_SESSION_LABEL,
  IMPORTED_SESSION_ID,
  IMPORTED_SESSION_LABEL,
} from "@/lib/engine/virtual-sessions";

// The reserved VIRTUAL session UUIDs are surfaced (when applicable) by their own
// dedicated branches below as "Sample data" / "Imported" — they must NEVER be folded
// into the real-session merge, or a demo/imported account would see them twice.
const VIRTUAL_SESSION_IDS = new Set<string>([SAMPLE_DATA_SESSION_ID, IMPORTED_SESSION_ID]);

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

    // Rename OVERRIDES: prefer a user-set title over the first question when present.
    // We fetch ALL of the caller's session_titles (not only the ones with ask rows),
    // scoped the same way as the rows — a member's overrides only, an admin sees all.
    // These are BOTH the title map for ask sessions AND the source of title-only chats
    // (a named chat that has no ask_history yet). Best-effort: a missing session_titles
    // table or read error simply yields no overrides (falls back to question titles).
    let titleOf: Map<string, string> | undefined;
    // session_id → the rename time, so a title-only chat (no ask turn) can still sort by
    // recency (newest-renamed on top) instead of all collapsing to epoch-0.
    let updatedAtOf: Map<string, string> | undefined;
    const titledIds = new Set<string>();
    {
      let tq = admin()
        .from("session_titles")
        .select("session_id, owner_id, title, updated_at")
        .order("updated_at", { ascending: false });
      if (!isAdmin) tq = tq.eq("owner_id", user.id);
      const { data: titles } = await tq;
      if (titles && titles.length > 0) {
        const typed = titles as { session_id: string; title: string | null; updated_at: string | null }[];
        titleOf = new Map(typed.map((t) => [t.session_id, t.title ?? ""]));
        updatedAtOf = new Map(
          typed.filter((t) => t.updated_at).map((t) => [t.session_id, t.updated_at as string])
        );
        for (const t of typed) {
          if (t.session_id && !VIRTUAL_SESSION_IDS.has(t.session_id)) titledIds.add(t.session_id);
        }
      }
    }

    // Sessions known only from UPLOADED DOCS (no ask, maybe no title) — derived from the
    // _files.json manifest (the single source of truth post-excision). Owner-scoped: each
    // owner's manifest is keyed by their own ownerId folder. A restored account whose
    // chats carry only titles + docs must still see every chat.
    const manifestEntries = await listManifestEntries(user.id);
    const docSessionIds = new Set<string>();
    for (const e of manifestEntries) {
      const id = e.session_id;
      if (id && !VIRTUAL_SESSION_IDS.has(id)) docSessionIds.add(id);
    }

    // Collapse the ask rows into one entry per conversation, then MERGE in the
    // title-only and doc-only sessions so the full set of the owner's chats appears.
    const askSessions = groupSessions(rows, emailOf, titleOf);
    const sessions = mergeSessionSources(askSessions, titledIds, docSessionIds, titleOf, updatedAtOf);

    // For demo accounts, append the "Sample data" virtual session so the bundled
    // corpus is always accessible as an openable chat.
    if (user.isDemo) {
      sessions.push({
        session_id: SAMPLE_DATA_SESSION_ID,
        title: SAMPLE_DATA_SESSION_LABEL,
        turn_count: 0,
        last_at: new Date(0).toISOString(),
      });
    }

    // "Imported" virtual session — append ONLY if the owner actually has docs
    // assigned to IMPORTED_SESSION_ID in the manifest. A clean client account with
    // no imported docs never sees this entry.
    {
      const importedEntries = await listManifestEntries(user.id, IMPORTED_SESSION_ID);
      if (importedEntries.length > 0) {
        sessions.push({
          session_id: IMPORTED_SESSION_ID,
          title: IMPORTED_SESSION_LABEL,
          turn_count: 0,
          last_at: new Date(0).toISOString(),
        });
      }
    }

    return NextResponse.json({ sessions });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to load history" },
      { status: 500 }
    );
  }
}
