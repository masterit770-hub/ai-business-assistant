// ORIGINAL-FILE persistence + retrieval — so every document is openable/verifiable,
// not just a name in a list.
//
//   • BUNDLED docs   → the committed source file under data/ (mapped from DOCUMENTS).
//   • UPLOADED docs  → the original bytes stored in the Supabase Storage bucket
//                      `documents` at path <owner_id>/<doc_id>, streamed back here.
//
// The bucket is created lazily on first write (idempotent). If the bucket can't be
// created (e.g. the service role lacks storage admin, or a plan limit), the write is
// best-effort: ingest still SUCCEEDS (the doc is indexed + queryable) and download
// simply returns "not stored" — the lead can provision the bucket and re-uploads work.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { admin, supabaseEnabled } from "./supabase.ts";
import { DOCUMENTS } from "./documents.ts";

export const DOCS_BUCKET = "documents";
const ROOT = process.cwd();

// MIME by extension (best-effort) so a download has the right Content-Type.
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  txt: "text/plain",
  json: "application/json",
};
export function mimeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

// ── BUNDLED: map a doc id → its committed source file under data/ ────────────────

export type BundledFile = { path: string; filename: string; contentType: string };

/** The committed source file for a bundled doc id, or null if this id isn't a bundled
 *  doc (or its file isn't present on disk). */
export function bundledFileFor(docId: string): BundledFile | null {
  const spec = DOCUMENTS.find((d) => d.doc === docId);
  if (!spec) return null;
  const path = join(ROOT, "data", spec.file);
  if (!existsSync(path)) return null;
  return { path, filename: spec.file, contentType: mimeForName(spec.file) };
}

/** Read a bundled doc's bytes (after bundledFileFor confirmed it exists). */
export async function readBundledFile(file: BundledFile): Promise<Uint8Array> {
  return new Uint8Array(await readFile(file.path));
}

// ── UPLOADED: persist + fetch the original bytes from Supabase Storage ───────────

function storagePath(ownerId: string, docId: string): string {
  return `${ownerId}/${docId}`;
}

/**
 * Best-effort: store an uploaded file's ORIGINAL bytes so it can be downloaded later.
 * Idempotent (upsert). NEVER throws — a storage failure must not fail the ingest (the
 * doc is still indexed + queryable). Returns true on a confirmed store, false otherwise
 * (Supabase off, bucket missing + uncreatable, or a transient error — all logged).
 */
export async function storeOriginalFile(
  buf: Uint8Array,
  ownerId: string,
  docId: string,
  filename: string
): Promise<boolean> {
  if (!supabaseEnabled()) return false;
  try {
    const client = admin();
    const path = storagePath(ownerId, docId);
    const contentType = mimeForName(filename);
    const body = new Blob([buf.slice()], { type: contentType });
    let { error } = await client.storage
      .from(DOCS_BUCKET)
      .upload(path, body, { contentType, upsert: true });
    if (error && /bucket not found|not found/i.test(error.message)) {
      // Lazily create the (private) bucket, then retry once.
      const { error: createErr } = await client.storage.createBucket(DOCS_BUCKET, {
        public: false,
      });
      if (createErr && !/already exists/i.test(createErr.message)) {
        console.warn(
          `[doc-files] could not create the '${DOCS_BUCKET}' storage bucket: ${createErr.message}. ` +
            `Original-file download is disabled until the bucket is provisioned.`
        );
        return false;
      }
      ({ error } = await client.storage
        .from(DOCS_BUCKET)
        .upload(path, body, { contentType, upsert: true }));
    }
    if (error) {
      console.warn(`[doc-files] storing original of '${docId}' failed: ${error.message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[doc-files] storing original of '${docId}' threw: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

export type FetchedFile = { bytes: Uint8Array; contentType: string; filename: string };

/**
 * Fetch an uploaded doc's original bytes for a given owner. Returns null when there's
 * no stored original (older uploads, Supabase off, or bucket missing) — the caller
 * returns a clean 404, never a crash. `ownerId` scopes the read so a member can only
 * download their OWN upload; the caller passes the doc owner (admin → any owner).
 */
export async function fetchOriginalFile(
  ownerId: string,
  docId: string
): Promise<FetchedFile | null> {
  if (!supabaseEnabled()) return null;
  try {
    const path = storagePath(ownerId, docId);
    const { data, error } = await admin().storage.from(DOCS_BUCKET).download(path);
    if (error || !data) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    const contentType = data.type || mimeForName(docId);
    return { bytes, contentType, filename: docId };
  } catch {
    return null;
  }
}

/**
 * Find which owner's folder holds an uploaded doc (admin download path). The bucket is
 * laid out as <owner_id>/<doc_id>; we list folders and probe for the doc. Returns the
 * owner id, or null if not found. Used only for admins (who may download any upload).
 */
export async function findOwnerOfUpload(docId: string): Promise<string | null> {
  if (!supabaseEnabled()) return null;
  try {
    const client = admin();
    const { data: folders, error } = await client.storage.from(DOCS_BUCKET).list("", {
      limit: 1000,
    });
    if (error || !folders) return null;
    for (const folder of folders) {
      // Storage list returns folder entries (no id) and file entries; probe each folder.
      const { data: files } = await client.storage
        .from(DOCS_BUCKET)
        .list(folder.name, { limit: 1000 });
      if (files?.some((f) => f.name === docId)) return folder.name;
    }
    return null;
  } catch {
    return null;
  }
}
