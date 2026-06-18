import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { listDocsWithMeta } from "@/lib/engine/doc-store";
import {
  fileSearchEnabled,
  listStoreDocuments,
  deleteDocumentByDocId,
} from "@/lib/engine/file-search";
import { removeRuntimeDoc } from "@/lib/engine/runtime-store";
import { bundledSources } from "@/lib/engine/bundled-sources";

// Documents for the dashboard — engine logic IN-PROCESS (no proxy).
//   GET    → { documents: [the caller's uploads], bundled: [the real loaded corpus] }.
//            `documents` is owner-scoped from the session (a member sees only their
//            own uploads; an admin sees all). `bundled` is the included source docs
//            (contracts, maintenance, family-court, Carter story…) derived from the
//            actual index/schema — what the assistant can ALSO answer from.
//   DELETE → remove an UPLOADED doc (?doc=<id>) from the File Search store + registry.
// Requires a signed-in, enabled user.
export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Member → scope to own uploads; admin → all uploads (no owner filter).
  const scopeOwner = user.role === "admin" ? undefined : user.id;
  try {
    const uploaded = fileSearchEnabled()
      ? await listStoreDocuments(scopeOwner)
      : await listDocsWithMeta();
    return NextResponse.json({ documents: uploaded, bundled: bundledSources() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to list documents" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const doc = new URL(req.url).searchParams.get("doc");
  if (!doc) {
    return NextResponse.json({ error: "doc query param is required" }, { status: 400 });
  }
  try {
    let removed = 0;
    if (fileSearchEnabled()) {
      removed = await deleteDocumentByDocId(doc);
    }
    removeRuntimeDoc(doc);
    return NextResponse.json({ ok: true, doc, removedFromStore: removed });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to delete document" },
      { status: 500 }
    );
  }
}
