import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { listDocsWithMeta } from "@/lib/engine/doc-store";
import { removeRuntimeDoc } from "@/lib/engine/runtime-store";
import { bundledSources, enrichBundledUrgency } from "@/lib/engine/bundled-sources";
import {
  refreshDeletedSources,
  markSourceDeleted,
  type DeletedKind,
} from "@/lib/engine/deleted-sources";
import { listManifestEntries, removeOriginalFile } from "@/lib/engine/doc-files";
import { admin, supabaseEnabled } from "@/lib/engine/supabase";
import { SAMPLE_DATA_SESSION_ID, SAMPLE_DATA_SESSION_LABEL } from "@/lib/engine/virtual-sessions";

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

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Member → scope to own uploads; admin → all uploads (read every entry for the owner).
  // Note: manifest is owner-keyed by folder (each owner has <ownerId>/_files.json) so
  // for a member we read ONLY their own manifest. For an admin we read their manifest too
  // (admin's own uploads); cross-user admin listing is not in scope for this path.
  const ownerId = user.id;
  // Per-chat scoping (migration 015 — STRICT): optional ?session_id= to scope the doc
  // list to a specific chat. Omitted (Sources page) = all the owner's docs. Present
  // (chat view) = ONLY this chat's docs (strict — no NULL-session fallback).
  const chatId = new URL(req.url).searchParams.get("session_id") || null;
  // Knowledge Space scoping (migration 016): optional ?space_id= to scope to a space.
  // ?global=1 returns all owner files across all spaces with space_id attribution.
  const spaceIdParam = new URL(req.url).searchParams.get("space_id") || null;
  const globalParam = new URL(req.url).searchParams.get("global") === "1";
  try {
    // Refresh the hidden-set so the bundled list omits admin-deleted sources.
    await refreshDeletedSources();

    // SPREADSHEET extensions: manifest entries whose type/extension indicates a
    // spreadsheet go into structuredTables; everything else (pdf/docx/…) goes into
    // documents. The manifest type field was set at ingest time by updateFilesManifest:
    //   xlsx/xls → "spreadsheet", pdf → "pdf", csv → "csv", other → "file".
    const SPREADSHEET_TYPES = new Set(["spreadsheet", "csv", "xlsx", "xls"]);

    let uploaded: {
      doc: string;
      label: string;
      urgency: "high" | "medium" | "low" | null;
      session_id?: string | null;
      chatLabel?: string | null;
      space_id?: string | null;
      spaceLabel?: string | null;
    }[];
    let structuredTablesRaw: {
      doc: string;
      label: string;
      rows: number;
      detail: string;
      session_id?: string | null;
      chatLabel?: string | null;
      space_id?: string | null;
      spaceLabel?: string | null;
    }[];

    if (supabaseEnabled()) {
      // Read from the _files.json manifest — the single source of truth.
      // Space scoping (migration 016): pass space opts when present.
      const spaceOpts = spaceIdParam || globalParam
        ? { spaceId: spaceIdParam ?? null, globalMode: globalParam }
        : undefined;
      const entries = await listManifestEntries(ownerId, chatId ?? undefined, spaceOpts);
      // Split by kind: spreadsheets → structuredTablesRaw; docs → uploaded.
      uploaded = [];
      structuredTablesRaw = [];
      for (const e of entries) {
        if (SPREADSHEET_TYPES.has(e.type)) {
          structuredTablesRaw.push({
            doc: e.docId,
            label: e.displayName,
            rows: 0,
            detail: "spreadsheet",
            session_id: e.session_id ?? null,
            space_id: e.space_id ?? null,
          });
        } else {
          uploaded.push({
            doc: e.docId,
            label: e.displayName,
            urgency: null,
            session_id: e.session_id ?? null,
            space_id: e.space_id ?? null,
          });
        }
      }
    } else {
      // Dev/offline path: fall back to the in-memory doc-store (no Supabase).
      uploaded = (await listDocsWithMeta()).map((d) => ({
        doc: d.doc,
        label: d.label ?? d.doc,
        urgency: d.urgency ?? null,
      }));
      structuredTablesRaw = [];
    }

    // ── Chat-label resolution (global Sources view only, chatId === null) ────────────
    // When showing all docs (no chat filter), annotate each item with a human-readable
    // chat name so the user can see which chat each doc belongs to. Skipped for the
    // per-chat view (chatId present) — the UI already knows which chat it is.
    if (chatId === null && supabaseEnabled()) {
      // Collect all distinct non-null session_ids across docs + tables.
      const sessionIds = [
        ...new Set([
          ...uploaded.map((d) => d.session_id).filter((s): s is string => !!s),
          ...structuredTablesRaw.map((t) => t.session_id).filter((s): s is string => !!s),
        ]),
      ];
      if (sessionIds.length > 0) {
        // Build chat name map: prefer user-set title from session_titles, fall back to
        // first question in ask_history (truncated to ~40 chars), then "Untitled chat".
        const chatNameOf = new Map<string, string>();

        // 1. User-set titles from session_titles.
        const { data: titles } = await admin()
          .from("session_titles")
          .select("session_id, title")
          .in("session_id", sessionIds);
        for (const t of titles ?? []) {
          if (t.title) chatNameOf.set(t.session_id as string, t.title as string);
        }

        // 2. First-question fallback for sessions without a user-set title.
        const needsFirstQ = sessionIds.filter((id) => !chatNameOf.has(id));
        if (needsFirstQ.length > 0) {
          const { data: histRows } = await admin()
            .from("ask_history")
            .select("session_id, question")
            .in("session_id", needsFirstQ)
            .order("created_at", { ascending: true });
          // Pick the first question per session_id in JS (stable, avoids GROUP BY complications).
          for (const r of histRows ?? []) {
            const sid = r.session_id as string;
            if (!chatNameOf.has(sid) && r.question) {
              const q = r.question as string;
              chatNameOf.set(sid, q.length > 40 ? q.slice(0, 40) + "…" : q);
            }
          }
        }

        // Annotate each item with its resolved chatLabel.
        uploaded = uploaded.map((d) => ({
          ...d,
          chatLabel: d.session_id ? (chatNameOf.get(d.session_id) ?? "Untitled chat") : null,
        }));
        structuredTablesRaw = structuredTablesRaw.map((t) => ({
          ...t,
          chatLabel: t.session_id ? (chatNameOf.get(t.session_id) ?? "Untitled chat") : null,
        }));
      }
    }

    // SPACE LABEL RESOLUTION (global view + space-scoped view): annotate each item with
    // a human-readable space name so the UI can show a SPACE badge. Skipped for per-chat
    // views (chatId present) — the chat already knows its space context.
    if ((chatId === null) && supabaseEnabled()) {
      // Collect distinct non-null space_ids across docs + tables.
      const spaceIds = [
        ...new Set([
          ...uploaded.map((d) => d.space_id).filter((s): s is string => !!s),
          ...structuredTablesRaw.map((t) => t.space_id).filter((s): s is string => !!s),
        ]),
      ];
      if (spaceIds.length > 0) {
        const { data: spaces } = await admin()
          .from("knowledge_spaces")
          .select("id, name")
          .in("id", spaceIds);
        const spaceNameOf = new Map<string, string>(
          (spaces ?? []).map((s) => [s.id as string, s.name as string])
        );
        uploaded = uploaded.map((d) => ({
          ...d,
          spaceLabel: d.space_id ? (spaceNameOf.get(d.space_id) ?? null) : null,
        }));
        structuredTablesRaw = structuredTablesRaw.map((t) => ({
          ...t,
          spaceLabel: t.space_id ? (spaceNameOf.get(t.space_id) ?? null) : null,
        }));
      }
    }

    // DEMO BUNDLED SOURCES — tagged with the SAMPLE_DATA_SESSION_ID virtual session so
    // they appear under "Sample data" in the global Sources view rather than floating as
    // "Built-in" with no chat context. Empty for non-demo users (they start clean).
    // Only returned in the global view (chatId === null); per-chat views never show bundled.
    const bundledRaw = (user.isDemo && chatId === null)
      ? await enrichBundledUrgency(bundledSources())
      : [];
    const bundled = bundledRaw.map((b) => ({
      ...b,
      session_id: SAMPLE_DATA_SESSION_ID,
      chatLabel: SAMPLE_DATA_SESSION_LABEL,
    }));

    return NextResponse.json({
      documents: uploaded,
      // Uploaded STRUCTURED sources (spreadsheets) — rendered with the [S] chip + a row
      // viewer, distinct from the document (RAG) list above.
      structuredTables: structuredTablesRaw,
      // Bundled sample corpus — demo accounts only, tagged to the "Sample data" virtual
      // session so they display as chat-linked (not a floating "Built-in" class).
      bundled,
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

  // ── UPLOADED doc/table → remove from Storage blob + _files.json manifest + in-memory registry ─
  // The manifest is now the single source of truth (no doc_chunks/uploaded_rows writes).
  // Owner-scoped: the caller may only delete their OWN uploads (removeOriginalFile asserts
  // the Storage path starts with ownerId/ before any delete).
  try {
    if (supabaseEnabled()) {
      // Remove the Storage blob + _files.json manifest entry. removeOriginalFile is
      // owner-scoped by ownerId and asserts the path before deleting.
      await removeOriginalFile(user.id, doc);
    }
    removeRuntimeDoc(doc);
    return NextResponse.json({ ok: true, doc, removedFromStore: 1, rowsRemoved: 0 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to delete document" },
      { status: 500 }
    );
  }
}
