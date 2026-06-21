import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import {
  ingestPdf,
  ingestCsv,
  ingestXlsx,
  ingestDocumentToFileSearch,
} from "@/lib/engine/ingest";
import { supabaseEnabled } from "@/lib/engine/supabase";
import { fileSearchEnabled } from "@/lib/engine/file-search";
import { storeOriginalFile } from "@/lib/engine/doc-files";

// Runtime ingestion — engine logic IN-PROCESS (no proxy). The dashboard Upload
// button posts the chosen file here as multipart/form-data; we parse → (PDF →
// Gemini File Search; CSV/XLSX → the SQL + local-RAG lane) so the document is
// IMMEDIATELY query-able with citations via /api/ask. No mock.
//
// AUTH: requires a signed-in, enabled user. The doc is tagged with the uploader's
// id (from the session) for per-user isolation — a user only retrieves their OWN
// uploads. PDFs go to Gemini File Search (managed, durable, reads scans natively).
export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB upload cap

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "expected a multipart/form-data upload with a 'file' field" },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file provided (field 'file')" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "the uploaded file is empty" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `file too large (${(file.size / 1e6).toFixed(1)} MB; max 15 MB)` },
      { status: 413 }
    );
  }

  const name = file.name || "upload";
  const lower = name.toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());

  const isXlsx =
    lower.endsWith(".xlsx") ||
    file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const isPdf = lower.endsWith(".pdf") || file.type === "application/pdf";
  const isCsv = lower.endsWith(".csv") || file.type === "text/csv";

  // The uploader, straight from the session → tags the doc for per-user isolation.
  const ownerId = user.id;

  try {
    let result;
    let backend: "file-search" | "local" = "local";
    if (isCsv) {
      result = await ingestCsv(new TextDecoder().decode(buf), name, ownerId);
    } else if (isXlsx) {
      result = await ingestXlsx(buf, name, ownerId);
    } else if (isPdf) {
      if (fileSearchEnabled()) {
        result = await ingestDocumentToFileSearch(buf, name, "application/pdf", ownerId);
        backend = "file-search";
      } else {
        const label = (form.get("label") as string) || name;
        result = await ingestPdf(buf, name, label);
      }
    } else {
      return NextResponse.json(
        { error: `unsupported file type: ${name} (supported: .pdf, .csv, .xlsx)` },
        { status: 415 }
      );
    }

    // Persist the ORIGINAL file so it's downloadable/viewable later (not just a name
    // in the list). Best-effort: never fails the ingest if storage is off/unprovisioned
    // — the doc is already indexed + queryable. Path: <owner_id>/<doc_id>.
    const docId = result.doc ?? result.table;
    let originalStored = false;
    if (docId) {
      originalStored = await storeOriginalFile(buf, ownerId, docId, name);
    }

    const persistence =
      backend === "file-search"
        ? "stored in Gemini File Search — durable + managed (survives restarts, shared across instances). Queries use the Gemini generateContent quota."
        : supabaseEnabled()
          ? "stored in Supabase (Postgres + pgvector) — durable, client-owned."
          : "in-memory on this serverless instance — query-able now; NOT durable across cold starts/instances.";
    return NextResponse.json({ ok: true, ingested: result, backend, persistence, originalStored });
  } catch (e) {
    console.error("ingest error:", e);
    const msg = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
    return NextResponse.json({ error: msg || "ingestion failed" }, { status: 500 });
  }
}
