import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { listDocsWithMeta } from "@/lib/engine/doc-store";
import { listUploadedDocs, deleteUploadedDoc } from "@/lib/engine/pgvector-store";
import { removeRuntimeDoc } from "@/lib/engine/runtime-store";
import { bundledSources } from "@/lib/engine/bundled-sources";
import {
  refreshDeletedSources,
  markSourceDeleted,
  type DeletedKind,
} from "@/lib/engine/deleted-sources";
import { supabaseEnabled } from "@/lib/engine/supabase";

// Documents for the dashboard — engine logic IN-PROCESS (no proxy).
//   GET    → { documents, bundled, role }.
//            `documents` = the caller's uploads, owner-scoped from the session (a
//            member sees only their own; an admin sees all). `bundled` = the included
//            source docs/tables (contracts, family-court, Carter story…) derived from
//            the actual index/schema, EXCLUDING any an admin has hidden (deleted_sources).
//            `role` lets the UI show delete controls only to admins for bundled rows.
//   DELETE → ?doc=<id>&scope=upload  → remove the caller's UPLOADED doc (File Search + registry).
//            ?doc=<id>&scope=bundled → ADMIN-only: record the shared bundled doc/table
//            in deleted_sources so retrieval excludes it (workspace-level soft-delete).
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
    // Refresh the hidden-set so the bundled list omits admin-deleted sources.
    await refreshDeletedSources();
    // DURABLE, owner-isolated uploaded-doc list from the pgvector store (doc_chunks),
    // when Supabase is configured; otherwise the in-memory dev/offline registry.
    // Urgency lives only in the in-memory registry (classified at ingest), so we
    // overlay it onto the durable list when the same doc id is still in memory.
    let uploaded: { doc: string; label: string; urgency: "high" | "medium" | "low" | null }[];
    if (supabaseEnabled()) {
      const durable = await listUploadedDocs(scopeOwner);
      const memMeta = new Map((await listDocsWithMeta()).map((d) => [d.doc, d.urgency]));
      uploaded = durable.map((d) => ({ ...d, urgency: memMeta.get(d.doc) ?? d.urgency }));
    } else {
      uploaded = await listDocsWithMeta();
    }
    return NextResponse.json({
      documents: uploaded,
      bundled: bundledSources(),
      role: user.role,
    });
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
  const params = new URL(req.url).searchParams;
  const doc = params.get("doc");
  const scope = params.get("scope") ?? "upload";
  if (!doc) {
    return NextResponse.json({ error: "doc query param is required" }, { status: 400 });
  }

  // ── BUNDLED (shared) source → workspace-level soft-delete, ADMIN-only ──────────
  if (scope === "bundled") {
    if (user.role !== "admin") {
      return NextResponse.json(
        { error: "only an admin can remove a shared (built-in) source" },
        { status: 403 }
      );
    }
    if (!supabaseEnabled()) {
      return NextResponse.json(
        { error: "the workspace store (Supabase) is not configured, so shared sources can't be hidden" },
        { status: 503 }
      );
    }
    const kind: DeletedKind = params.get("kind") === "structured" ? "structured" : "document";
    try {
      await markSourceDeleted(doc, kind);
      return NextResponse.json({ ok: true, doc, scope: "bundled", kind });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "failed to hide source" },
        { status: 500 }
      );
    }
  }

  // ── UPLOADED doc → per-user removal from the pgvector store + in-memory registry ─
  // Owner-scoped so a member can only delete their OWN doc; an admin may delete any.
  try {
    let removed = 0;
    if (supabaseEnabled()) {
      const scopeOwner = user.role === "admin" ? undefined : user.id;
      removed = await deleteUploadedDoc(scopeOwner, doc, user.role === "admin");
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
