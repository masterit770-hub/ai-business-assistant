import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { docIdFromFilename } from "@/lib/engine/ingest";
import { runWithOwner } from "@/lib/engine/request-context";
import { supabaseEnabled } from "@/lib/engine/supabase";
import { storeOriginalFile } from "@/lib/engine/doc-files";
import { assignSessionToSpace } from "@/lib/engine/spaces";

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
const SUPPORTED_FORMATS = ["PDF", "Word", "Excel", "CSV"] as const;

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
  // Keep a PRISTINE copy of the original bytes for storage BEFORE ingest runs: pdf.js
  // (in ingestPdf) DETACHES the buffer it reads, which would leave storeOriginalFile
  // with an emptied buffer (the bug that made uploaded PDFs un-downloadable).
  const originalBytes = buf.slice();

  // REQUIREMENT (Chris): every document belongs to a chat — an unassigned doc must never
  // exist. The client always sends the active chat's session_id (the in-chat uploader mints
  // one if the chat is brand-new). A request with NO session_id is rejected (fail-closed) so
  // a doc can never become orphaned — the bug where a file uploaded before the first message
  // (or via the old global Sources button) was stored unassigned and invisible in every chat.
  const chatId = (form.get("session_id") as string | null)?.trim() || null;
  // Knowledge Space tagging (migration 016): space_id from the upload form. A document may be
  // uploaded EITHER into a chat (session_id) OR directly into a Knowledge Space's Sources area
  // (space_id, no active chat). At least one is required so a doc is never orphaned/invisible.
  const spaceId = (form.get("space_id") as string | null)?.trim() || null;
  if (!chatId && !spaceId) {
    return NextResponse.json(
      { error: "a document must be uploaded into a chat or a Knowledge Space (missing session_id and space_id)." },
      { status: 400 }
    );
  }

  const isXlsx =
    lower.endsWith(".xlsx") ||
    file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const isPdf = lower.endsWith(".pdf") || file.type === "application/pdf";
  const isCsv = lower.endsWith(".csv") || file.type === "text/csv";
  const isDocx =
    lower.endsWith(".docx") ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  // The uploader, straight from the session → tags the doc for per-user isolation.
  const ownerId = user.id;

  // Validate file type BEFORE storing — so an unsupported format is rejected cleanly.
  if (!isPdf && !isDocx && !isXlsx && !isCsv) {
    return NextResponse.json(
      { error: `unsupported file type: ${name} (supported: PDF, Word .docx, Excel .xlsx, CSV)` },
      { status: 415 }
    );
  }

  try {
    return await runWithOwner(ownerId, async () => {
    // Derive the doc id from the filename AND the upload scope (the chat's session_id,
    // or the space_id for a space-direct upload). Scoping the id is what stops the same
    // filename in two different chats/spaces from colliding on one Storage key + manifest
    // entry (bug F4). The route always has at least one of chatId/spaceId (guarded above),
    // so the id is always scope-qualified. It stays the stable, opaque id the agent reads
    // from the manifest and uses to fetch the original bytes from Storage.
    const docId = docIdFromFilename(name, chatId ?? spaceId);

    // Persist the ORIGINAL file + update the _files.json manifest. This is the ONLY
    // write path: no doc_chunks (pgvector RAG) or uploaded_rows (text-to-SQL) writes.
    // The agentic engine reads the manifest + raw Storage bytes directly — no indexing.
    // Pass spaceId (may be null) so the manifest entry is tagged with the Knowledge Space.
    const originalStored = await storeOriginalFile(originalBytes, ownerId, docId, name, chatId, spaceId);

    // Knowledge Space bookkeeping: an in-space chat upload carries BOTH a chat (session_id)
    // and a space (space_id). Register the session→space association so the space's "chats"
    // list surfaces this chat and its delete-cleanup can reach it — mirroring /api/ask, so a
    // chat gets associated whether its first activity is a question or an upload. BEST-EFFORT:
    // never throws, never blocks the ingest response.
    if (chatId && spaceId) {
      await assignSessionToSpace(ownerId, chatId, spaceId).catch(() => {});
    }

    const backend: "supabase" | "local" = supabaseEnabled() ? "supabase" : "local";
    const persistence =
      backend === "supabase"
        ? "stored in Supabase Storage — durable, client-owned. Read directly by the agentic engine."
        : "in-memory on this serverless instance — NOT durable across cold starts.";

    // The agentic engine always reads the raw file, so there is no extractable-content
    // gate. zeroContent is always false — any file we accepted is readable by the agent.
    return NextResponse.json({
      ok: true,
      ingested: { doc: docId, label: name, chunks: 0, rows: 0 },
      backend,
      persistence,
      originalStored,
      zeroContent: false,
    });
    });
  } catch (e) {
    console.error("ingest error:", e);
    const msg = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
    return NextResponse.json({ error: msg || "ingestion failed" }, { status: 500 });
  }
}
