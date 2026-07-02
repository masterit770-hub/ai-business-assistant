import { getCurrentUser } from "@/lib/supabase/auth";
import {
  bundledFileFor,
  readBundledFile,
  fetchOriginalFile,
  findOwnerOfUpload,
} from "@/lib/engine/doc-files";

// Download / view the ORIGINAL file behind a document, so every doc is openable and
// verifiable — not just a name in the list.
//   GET  /api/documents/file?doc=<id>  → stream the file (below).
//     • BUNDLED doc (a DOCUMENTS id) → stream the committed source from data/.
//     • UPLOADED doc                → stream the original bytes from Supabase Storage
//        (bucket `documents`, path <owner_id>/<doc_id>). Owner-scoped: a member can
//        only download their OWN upload; an admin can download anyone's.
//   HEAD /api/documents/file?doc=<id>  → 200 if that original is retrievable for the
//     caller, 404 otherwise — NO body. The materials rail probes this so it only
//     offers a download button when the original actually exists (no dead 404 link).
// Auth required. A missing/unstored original returns a clean 404 (never a crash) — an
// older upload with no stored original simply isn't downloadable.
export const runtime = "nodejs";

// Resolve the original bytes for a doc for THIS caller, honoring owner-scoping.
// Returns the streamable file, or a status to fail with (400/404). Shared by GET +
// HEAD so the "is it retrievable?" probe uses the exact same access logic as download.
type Resolved =
  | { ok: true; bytes: Uint8Array; contentType: string; filename: string }
  | { ok: false; status: 400 | 404; error: string };

async function resolveOriginal(req: Request, user: { id: string; role: string }): Promise<Resolved> {
  const doc = new URL(req.url).searchParams.get("doc");
  if (!doc) return { ok: false, status: 400, error: "doc query param is required" };

  // ── BUNDLED doc → the committed file on disk ───────────────────────────────────
  const bundled = bundledFileFor(doc);
  if (bundled) {
    const bytes = await readBundledFile(bundled);
    return { ok: true, bytes, contentType: bundled.contentType, filename: bundled.filename };
  }

  // ── UPLOADED doc → the original bytes from Storage (owner-scoped) ───────────────
  // A member reads only their own folder; an admin may read any (resolve the owner).
  let ownerId: string | null = user.id;
  if (user.role === "admin") {
    const owned = await fetchOriginalFile(user.id, doc);
    if (owned)
      return { ok: true, bytes: owned.bytes, contentType: owned.contentType, filename: fileNameFor(doc, owned.contentType) };
    ownerId = await findOwnerOfUpload(doc); // any owner
  }
  if (!ownerId) return { ok: false, status: 404, error: "document not found" };
  const file = await fetchOriginalFile(ownerId, doc);
  if (!file) return { ok: false, status: 404, error: "no original file stored for this document" };
  return { ok: true, bytes: file.bytes, contentType: file.contentType, filename: fileNameFor(doc, file.contentType) };
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }
  try {
    const r = await resolveOriginal(req, user);
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
    return fileResponse(r.bytes, r.contentType, r.filename);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "failed to read file" },
      { status: 500 }
    );
  }
}

// Cheap retrievability probe — same auth + owner-scoping as GET, but no bytes in the
// response. Lets the UI offer a download button only when the original is actually
// retrievable, instead of letting the user click into a 404.
export async function HEAD(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) return new Response(null, { status: 401 });
  try {
    const r = await resolveOriginal(req, user);
    return new Response(null, { status: r.ok ? 200 : r.status });
  } catch {
    return new Response(null, { status: 500 });
  }
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
