import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { ingestPdf, ingestCsv, ingestXlsx } from "@/lib/engine/ingest";
import { supabaseEnabled } from "@/lib/engine/supabase";
import { storeOriginalFile } from "@/lib/engine/doc-files";

// Runtime ingestion — engine logic IN-PROCESS (no proxy). The dashboard Upload
// button posts the chosen file here as multipart/form-data; we parse → (PDF → the
// SELF-HOSTED HYBRID document lane: unpdf text extraction + best-effort OCR +
// local e5 embeddings → Supabase pgvector; CSV/XLSX → the SQL + local-RAG lane) so
// the document is IMMEDIATELY query-able with citations via /api/ask. No Gemini.
//
// AUTH: requires a signed-in, enabled user. The doc is tagged with the uploader's
// id (from the session) for per-user isolation — a user only retrieves their OWN
// uploads (RLS + owner-scoped retrieval). The hybrid (dense × BM25 → RRF) search
// reads scanned PDFs via best-effort OCR; born-digital PDFs via the text layer.
export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB upload cap
const SUPPORTED_FORMATS = ["PDF", "CSV", "XLSX"] as const;

// The upload control reads the REAL cap + supported formats from here, so the limits it
// shows up front always match what POST actually enforces (single source of truth).
export async function GET() {
  return NextResponse.json({
    maxBytes: MAX_BYTES,
    maxMb: Math.round(MAX_BYTES / (1024 * 1024)),
    formats: SUPPORTED_FORMATS,
  });
}

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
    const backend: "pgvector" | "local" = supabaseEnabled() ? "pgvector" : "local";
    if (isCsv) {
      result = await ingestCsv(new TextDecoder().decode(buf), name, ownerId);
    } else if (isXlsx) {
      result = await ingestXlsx(buf, name, ownerId);
    } else if (isPdf) {
      const label = (form.get("label") as string) || name;
      result = await ingestPdf(buf, name, label, ownerId);
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
      backend === "pgvector"
        ? "stored in Supabase (Postgres + pgvector) — durable, client-owned. Retrieved by hybrid search (dense × BM25 → RRF)."
        : "in-memory on this serverless instance — query-able now; NOT durable across cold starts/instances.";

    // ZERO-CONTENT signal: a file we accepted but from which we extracted nothing
    // usable (e.g. an image-only scan whose text layer is empty AND OCR couldn't read
    // it). Every lane (PDF hybrid → chunks; CSV/XLSX → rows) reports a unit count, so
    // we can assert zero honestly. When true, the UI must NOT say "ask about it now" —
    // it warns that nothing readable was extracted.
    const countable = (result.chunks ?? 0) + (result.rows ?? 0);
    const zeroContent = countable === 0;

    return NextResponse.json({
      ok: true,
      ingested: result,
      backend,
      persistence,
      originalStored,
      zeroContent,
    });
  } catch (e) {
    console.error("ingest error:", e);
    const msg = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
    return NextResponse.json({ error: msg || "ingestion failed" }, { status: 500 });
  }
}
