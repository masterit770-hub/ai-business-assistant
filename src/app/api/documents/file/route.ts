import { getCurrentUser } from "@/lib/supabase/auth";
import {
  bundledFileFor,
  readBundledFile,
  fetchOriginalFile,
  findOwnerOfUpload,
} from "@/lib/engine/doc-files";

// Download / view the ORIGINAL file behind a document, so every doc is openable and
// verifiable — not just a name in the list.
//   GET /api/documents/file?doc=<id>
//     • BUNDLED doc (a DOCUMENTS id) → stream the committed source from data/.
//     • UPLOADED doc                → stream the original bytes from Supabase Storage
//        (bucket `documents`, path <owner_id>/<doc_id>). Owner-scoped: a member can
//        only download their OWN upload; an admin can download anyone's.
// Auth required. A missing/unstored original returns a clean 404 (never a crash) — an
// older upload with no stored original simply isn't downloadable.
export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }
  const doc = new URL(req.url).searchParams.get("doc");
  if (!doc) {
    return Response.json({ error: "doc query param is required" }, { status: 400 });
  }

  // ── BUNDLED doc → the committed file on disk ───────────────────────────────────
  const bundled = bundledFileFor(doc);
  if (bundled) {
    try {
      const bytes = await readBundledFile(bundled);
      return fileResponse(bytes, bundled.contentType, bundled.filename);
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "failed to read bundled file" },
        { status: 500 }
      );
    }
  }

  // ── UPLOADED doc → the original bytes from Storage (owner-scoped) ───────────────
  // A member reads only their own folder; an admin may read any (resolve the owner).
  let ownerId: string | null = user.id;
  if (user.role === "admin") {
    const owned = await fetchOriginalFile(user.id, doc);
    if (owned) return fileResponse(owned.bytes, owned.contentType, fileNameFor(doc, owned.contentType));
    ownerId = await findOwnerOfUpload(doc); // any owner
  }
  if (!ownerId) {
    return Response.json({ error: "document not found" }, { status: 404 });
  }
  const file = await fetchOriginalFile(ownerId, doc);
  if (!file) {
    return Response.json(
      { error: "no original file stored for this document" },
      { status: 404 }
    );
  }
  return fileResponse(file.bytes, file.contentType, fileNameFor(doc, file.contentType));
}

// Stream bytes with the right headers so the browser opens/downloads it. `inline` lets
// a PDF render in a viewer tab; the filename is the suggested save name.
function fileResponse(bytes: Uint8Array, contentType: string, filename: string): Response {
  return new Response(new Blob([bytes.slice()], { type: contentType }), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}

// Give an uploaded doc a sensible download filename + extension from its content type.
function fileNameFor(docId: string, contentType: string): string {
  const ext = contentType.includes("pdf")
    ? ".pdf"
    : contentType.includes("spreadsheetml")
      ? ".xlsx"
      : contentType.includes("csv")
        ? ".csv"
        : "";
  return docId.endsWith(ext) || !ext ? docId : `${docId}${ext}`;
}
