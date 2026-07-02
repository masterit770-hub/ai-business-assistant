import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { createSpace, listSpaces, deleteSpace } from "@/lib/engine/spaces";
import { sessionsInSpace } from "@/lib/engine/spaces";
import { admin, supabaseEnabled } from "@/lib/engine/supabase";
import { listManifestEntries, removeOriginalFile } from "@/lib/engine/doc-files";

// Knowledge Spaces API — owner-scoped CRUD.
//   GET  → list the caller's spaces
//   POST → create a new space (body: { name: string })
//   DELETE ?space=<id> → delete a space + its chats + its files
// Auth: requires a signed-in, enabled user.
export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  try {
    const spaces = await listSpaces(user.id);
    return NextResponse.json({ spaces });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to list spaces" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  let name = "";
  try {
    const body = await req.json();
    name = (body?.name ?? "").toString().trim();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  try {
    const space = await createSpace(user.id, name);
    return NextResponse.json({ space });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to create space" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const spaceId = new URL(req.url).searchParams.get("space");
  if (!spaceId) {
    return NextResponse.json({ error: "space query param is required" }, { status: 400 });
  }
  if (!supabaseEnabled()) {
    return NextResponse.json({ error: "Supabase required" }, { status: 503 });
  }

  try {
    const client = admin();

    // 1. Collect all session_ids in this space for cleanup — from the UNION of two sources.
    //    session_spaces alone was empty for real users (F1), so gating history/title cleanup
    //    on it orphaned every chat's rows when a space was deleted (F2). The manifest is the
    //    other source of truth: any doc tagged with this space carries its chat's session_id.
    const tableSessionIds = await sessionsInSpace(user.id, spaceId);

    // 2. Delete all files whose space_id = spaceId from Storage + manifest.
    //    Read manifest entries for this space, then remove each. (Also the second cleanup
    //    session source: their session_id values.)
    const spaceFiles = await listManifestEntries(user.id, null, { spaceId });
    for (const f of spaceFiles) {
      await removeOriginalFile(user.id, f.docId).catch((e) =>
        console.warn(`[spaces] removeOriginalFile ${f.docId}: ${e instanceof Error ? e.message : e}`)
      );
    }

    const manifestSessionIds = spaceFiles
      .map((f) => f.session_id)
      .filter((s): s is string => !!s);
    const sessionIds = Array.from(new Set<string>([...tableSessionIds, ...manifestSessionIds]));

    // 3. Delete ask_history rows for the space's sessions (best-effort).
    if (sessionIds.length > 0) {
      await client
        .from("ask_history")
        .delete()
        .eq("owner_id", user.id)
        .in("session_id", sessionIds)
        .then(({ error }) => {
          if (error) console.warn(`[spaces] ask_history delete: ${error.message}`);
        });

      // 4. Delete session_titles rows.
      await client
        .from("session_titles")
        .delete()
        .eq("owner_id", user.id)
        .in("session_id", sessionIds)
        .then(({ error }) => {
          if (error) console.warn(`[spaces] session_titles delete: ${error.message}`);
        });

      // 5. Delete session_spaces rows (also cascades from space delete, but belt+suspenders).
      await client
        .from("session_spaces")
        .delete()
        .eq("owner_id", user.id)
        .in("session_id", sessionIds)
        .then(({ error }) => {
          if (error) console.warn(`[spaces] session_spaces delete: ${error.message}`);
        });
    }

    // 6. Delete the space itself (cascades remaining session_spaces rows via FK).
    await deleteSpace(user.id, spaceId);

    return NextResponse.json({
      ok: true,
      spaceId,
      sessionsDeleted: sessionIds.length,
      filesDeleted: spaceFiles.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to delete space" },
      { status: 500 }
    );
  }
}
