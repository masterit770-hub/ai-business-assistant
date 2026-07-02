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
import { createHash } from "node:crypto";
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

/**
 * Build a Storage object key that is ALWAYS ASCII-safe, regardless of the docId's
 * character set. Supabase Storage rejects object keys that contain non-ASCII bytes
 * (e.g. Hebrew, CJK, Arabic) — a file named "שיבוצים-יוני-2024.xlsx" has a docId
 * "שיבוצים-יוני-2024" whose raw UTF-8 bytes fail the object-key validation.
 *
 * Note: percent-encoding (encodeURIComponent) is NOT sufficient — the Supabase Storage
 * JS client passes the path directly to the REST API, whose framework URL-decodes path
 * parameters before the key validator runs. So `%D7%A9...` → Hebrew → still rejected.
 *
 * Fix: use a SHA-256 hex digest of the docId as the Storage filename. The digest is
 * always 64 lowercase hex characters (completely ASCII, no special chars), deterministic
 * (same docId → same key every time), and general (any Unicode input → same output
 * format). The original filename is preserved separately as `displayName` in the
 * _files.json manifest (and as the `docId` field), so round-trip name recovery is
 * manifest-driven, not key-decoding-driven.
 *
 * Round-trip: storagePath() is used identically in store and fetch, so both sides
 * always agree on the Storage key.
 */
function storageKeyFromDocId(docId: string): string {
  return createHash("sha256").update(docId, "utf8").digest("hex");
}

function storagePath(ownerId: string, docId: string): string {
  return `${ownerId}/${storageKeyFromDocId(docId)}`;
}

/**
 * Exported for testing: the Storage filename segment derived from a docId.
 * The full Storage path is `<ownerId>/<storageKeyForDocId(docId)>`.
 * Always returns a 64-char lowercase hex string — completely ASCII, no special chars.
 */
export function storageKeyForDocId(docId: string): string {
  return storageKeyFromDocId(docId);
}

/**
 * Best-effort: store an uploaded file's ORIGINAL bytes so it can be downloaded later.
 * Idempotent (upsert). NEVER throws — a storage failure must not fail the ingest (the
 * doc is still indexed + queryable). Returns true on a confirmed store, false otherwise
 * (Supabase off, bucket missing + uncreatable, or a transient error — all logged).
 *
 * chatId (migration 014): when provided, updates the _files.json index to tag this file
 * with its session_id so prepareOwnerFiles() can filter by chat. NULL = legacy/unassigned.
 * spaceId (migration 016): when provided, tags the file with a Knowledge Space so
 * space-aware retrieval returns all files in the space across chats.
 */
export async function storeOriginalFile(
  buf: Uint8Array,
  ownerId: string,
  docId: string,
  filename: string,
  chatId?: string | null,
  spaceId?: string | null
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
    // ── Per-chat + space scoping: update the _files.json manifest to include this
    // file's session_id and space_id so engines can filter by chat and/or space.
    // Best-effort: a manifest write failure must not fail the ingest or return false.
    await updateFilesManifest(client, ownerId, docId, filename, chatId ?? null, spaceId ?? null).catch(
      (e) => console.warn(`[doc-files] _files.json update failed: ${e instanceof Error ? e.message : e}`)
    );
    return true;
  } catch (e) {
    console.warn(`[doc-files] storing original of '${docId}' threw: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

// ── _files.json manifest updater (per-chat scoping, migration 014) ───────────
// The manifest at <owner_id>/_files.json is the index prepareOwnerFiles() uses to
// discover an owner's files. Each entry carries session_id (chat scope) and now also
// space_id (Knowledge Space scope, migration 016). Both are nullable for legacy entries.
// Read → merge (upsert this file) → write back. Best-effort: never throws.
type ManifestEntry = {
  docId: string;
  displayName: string;
  type: string;
  session_id?: string | null;
  space_id?: string | null; // Knowledge Space (migration 016)
};

// ── Per-owner serialization of _files.json mutations (fixes lost-update race F5) ─────
// _files.json is a read-modify-write blob with NO compare-and-swap. Two concurrent
// mutations for the SAME owner — the UI's parallel-tab double upload, or an upload
// racing a delete — each download the manifest, each merge their change, and each write
// back: last writer wins, silently dropping the other's entry (the blob still exists but
// is invisible to the engine, which reads only the manifest). A per-owner promise chain
// forces every mutation to run only after the previous one has fully committed, so each
// one sees the latest manifest before merging.
//
// SCOPE / LIMITATION: this serializes only WITHIN A SINGLE PROCESS. It fully closes the
// realistic same-instance race (parallel-tab uploads land on one dev/Fly instance; a
// Vercel serverless burst for one user is typically one warm instance). It does NOT
// close a true CROSS-INSTANCE race (two separate server instances mutating the same
// owner's manifest at the same moment) — no in-memory lock can. The durable fix,
// DESIGNED but deliberately NOT shipped in this overnight change, is to move the manifest
// out of a JSON blob into an atomic Postgres table (one row per (owner_id, doc_id),
// written with upsert/delete under RLS, lazily backfilled from _files.json on first
// access). That is a Storage→DB migration tracked as the F5 follow-up and must not be
// attempted piecemeal here.
const manifestLocks = new Map<string, Promise<unknown>>();

function withManifestLock<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
  const prev = manifestLocks.get(ownerId) ?? Promise.resolve();
  // Run `fn` only after the previous mutation SETTLES — success or failure, so a failed
  // prior write can't wedge the queue for this owner.
  const run = prev.then(() => fn(), () => fn());
  // The stored tail never rejects, so one failed mutation can't break the chain.
  const tail = run.then(() => undefined, () => undefined);
  manifestLocks.set(ownerId, tail);
  // Drop the map entry once this owner's queue has fully drained (no unbounded growth).
  void tail.finally(() => {
    if (manifestLocks.get(ownerId) === tail) manifestLocks.delete(ownerId);
  });
  return run;
}

async function updateFilesManifest(
  client: ReturnType<typeof import("./supabase.ts").admin>,
  ownerId: string,
  docId: string,
  filename: string,
  sessionId: string | null,
  spaceId?: string | null // Knowledge Space (migration 016) — optional, preserves old callers
): Promise<void> {
  // Serialize the whole read-merge-write per owner so a concurrent upload/delete for the
  // same owner can't clobber this update (F5).
  await withManifestLock(ownerId, async () => {
    const manifestPath = `${ownerId}/_files.json`;
    // Read current manifest (may not exist yet).
    let entries: ManifestEntry[] = [];
    const { data: existing } = await client.storage.from(DOCS_BUCKET).download(manifestPath);
    if (existing) {
      try {
        const text = await existing.text();
        entries = JSON.parse(text) as ManifestEntry[];
      } catch {
        entries = [];
      }
    }
    // Derive the file type from extension (mirrors listOwnerFiles fallback logic).
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    const type =
      ext === "xlsx" || ext === "xls" ? "spreadsheet"
      : ext === "pdf" ? "pdf"
      : ext === "csv" ? "csv"
      : "file";
    // Upsert: replace existing entry for this docId, or append.
    const idx = entries.findIndex((e) => e.docId === docId);
    const entry: ManifestEntry = {
      docId,
      displayName: filename,
      type,
      session_id: sessionId,
      space_id: spaceId ?? null,
    };
    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }
    const body = new Blob([JSON.stringify(entries)], { type: "application/json" });
    await client.storage.from(DOCS_BUCKET).upload(manifestPath, body, {
      contentType: "application/json",
      upsert: true,
    });
  });
}

// ── removeOriginalFile: delete blob + manifest entry for a given owner's doc ─────────
/**
 * Owner-scoped removal of an uploaded file's Storage blob AND its _files.json manifest
 * entry. Called from both delete paths (single-doc and bulk-chat) so a deleted document
 * is truly gone from the agentic engine (which reads manifest + Storage, not DB rows).
 *
 * HARD SAFETY RULE: the Storage blob path is asserted to start with `${ownerId}/` before
 * any delete call — we must never remove a blob outside the caller's folder.
 *
 * Idempotent + best-effort: if the blob or manifest entry is already absent the call is
 * still a success (not an error). Logs on failure but never throws.
 */
export async function removeOriginalFile(ownerId: string, docId: string): Promise<void> {
  if (!supabaseEnabled()) return;
  if (!ownerId) {
    console.warn(`[doc-files] removeOriginalFile: ownerId is empty, refusing to delete`);
    return;
  }
  try {
    const client = admin();
    const path = storagePath(ownerId, docId);

    // ── HARD SAFETY: assert the path is strictly inside the caller's folder ──────────
    if (!path.startsWith(`${ownerId}/`)) {
      // This should be structurally impossible (storagePath prefixes ownerId/), but we
      // fail-closed rather than silently deleting a blob from another owner's folder.
      console.error(
        `[doc-files] removeOriginalFile: safety assertion failed — ` +
          `path '${path}' does not start with '${ownerId}/' — refusing delete`
      );
      return;
    }

    // 1. Remove the Storage blob (best-effort; 404 = already gone = fine).
    const { error: removeErr } = await client.storage.from(DOCS_BUCKET).remove([path]);
    if (removeErr) {
      console.warn(`[doc-files] removeOriginalFile: blob remove failed for '${docId}': ${removeErr.message}`);
      // Continue — still try to clean the manifest entry.
    }

    // 2. Remove the entry from the owner's _files.json manifest — serialized per owner
    //    (same lock as updateFilesManifest) so a delete racing a concurrent upload for
    //    the same owner can't lose either mutation (F5: read-modify-write on the blob).
    await withManifestLock(ownerId, async () => {
      const manifestPath = `${ownerId}/_files.json`;
      const { data: existing } = await client.storage.from(DOCS_BUCKET).download(manifestPath);
      if (!existing) return; // No manifest → nothing to clean up.
      let entries: ManifestEntry[] = [];
      try {
        const text = await existing.text();
        entries = JSON.parse(text) as ManifestEntry[];
      } catch {
        return; // Corrupt manifest — can't meaningfully remove an entry.
      }
      const filtered = entries.filter((e) => e.docId !== docId);
      if (filtered.length === entries.length) return; // Entry not present — already clean.
      const body = new Blob([JSON.stringify(filtered)], { type: "application/json" });
      const { error: manifestErr } = await client.storage
        .from(DOCS_BUCKET)
        .upload(manifestPath, body, { contentType: "application/json", upsert: true });
      if (manifestErr) {
        console.warn(
          `[doc-files] removeOriginalFile: manifest write failed for owner '${ownerId}': ${manifestErr.message}`
        );
      }
    });
  } catch (e) {
    console.warn(
      `[doc-files] removeOriginalFile threw for '${docId}': ${e instanceof Error ? e.message : e}`
    );
  }
}

// ── listManifestEntries: public reader for the _files.json manifest ────────────
/**
 * Read the owner's _files.json manifest and return its entries.
 * When chatId is provided (not null/undefined), filters to entries whose
 * session_id matches exactly — mirrors the filterFilesForChat logic used by
 * the agentic engine (answer-agentic.ts → listOwnerFiles). When chatId is
 * null or undefined, returns all entries (no chat filter).
 *
 * Returns an empty array when Supabase is off, the manifest doesn't exist yet,
 * or parsing fails — never throws.
 */
export async function listManifestEntries(
  ownerId: string,
  chatId?: string | null,
  opts?: { spaceId?: string | null; globalMode?: boolean }
): Promise<{ docId: string; displayName: string; type: string; session_id: string | null; space_id: string | null }[]> {
  if (!supabaseEnabled()) return [];
  try {
    const client = admin();
    const manifestPath = `${ownerId}/_files.json`;
    const { data } = await client.storage.from(DOCS_BUCKET).download(manifestPath);
    if (!data) return [];
    let entries: ManifestEntry[] = [];
    try {
      const text = await data.text();
      entries = JSON.parse(text) as ManifestEntry[];
    } catch {
      return [];
    }
    // Normalize: ensure every entry has session_id and space_id fields.
    const normalized = entries.map((e) => ({
      docId: e.docId,
      displayName: e.displayName,
      type: e.type,
      session_id: e.session_id ?? null,
      space_id: e.space_id ?? null,
    }));

    // Knowledge Space scoping (migration 016):
    //   globalMode=true → return all (no space filter; owner-wide search)
    //   spaceId provided → return ONLY files in that space (across all chats in the space)
    //   chatId provided (no space) → strict per-chat filter (migration 015 behaviour)
    //   neither → return all entries (admin / all-docs view)
    const { spaceId, globalMode } = opts ?? {};
    if (globalMode) {
      return normalized; // cross-space: return everything
    }
    if (spaceId) {
      // Space-scoped: every file whose space_id matches, regardless of which chat it came from.
      return normalized.filter((e) => e.space_id === spaceId);
    }
    // Legacy per-chat scoping (migration 015): filter when chatId is supplied.
    if (chatId !== null && chatId !== undefined) {
      return normalized.filter((e) => e.session_id === chatId);
    }
    return normalized;
  } catch (e) {
    console.warn(`[doc-files] listManifestEntries failed for owner '${ownerId}': ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

export type FetchedFile = { bytes: Uint8Array; contentType: string; filename: string };

/**
 * Fetch an uploaded doc's original bytes for a given owner. Returns null when there's
 * no stored original (older uploads, Supabase off, or bucket missing) — the caller
 * returns a clean 404, never a crash. `ownerId` scopes the read so a member can only
 * download their OWN upload; the caller passes the doc owner (admin → any owner).
 *
 * Key encoding: storagePath() maps the docId to a SHA-256 hex digest so non-ASCII
 * filenames (Hebrew, CJK, etc.) always map to a valid ASCII-only Storage key. For
 * backwards-compat with files uploaded before this fix (raw non-ASCII keys that were
 * silently rejected by Storage), we fall back to the raw path on a primary miss.
 */
export async function fetchOriginalFile(
  ownerId: string,
  docId: string
): Promise<FetchedFile | null> {
  if (!supabaseEnabled()) return null;
  try {
    const client = admin();
    // Primary: SHA-256 hex key (new path — always ASCII, always accepted by Storage)
    const path = storagePath(ownerId, docId);
    const { data, error } = await client.storage.from(DOCS_BUCKET).download(path);
    if (!error && data) {
      const bytes = new Uint8Array(await data.arrayBuffer());
      const contentType = data.type || mimeForName(docId);
      return { bytes, contentType, filename: docId };
    }
    // Fallback: raw (unencoded) key — for ASCII docIds that existed before this fix.
    // When docId is non-ASCII (Hebrew, etc.), the old path was also rejected by Storage
    // and produced no stored file, so the fallback is only meaningful for ASCII docIds
    // where the raw key == hash key are different but the raw key might exist from
    // an older deployment that predated the hash-key scheme.
    const hasNonAscii = /[^\x00-\x7F]/.test(docId);
    if (!hasNonAscii) {
      const legacyPath = `${ownerId}/${docId}`;
      const { data: legacyData, error: legacyErr } = await client.storage
        .from(DOCS_BUCKET)
        .download(legacyPath);
      if (!legacyErr && legacyData) {
        const bytes = new Uint8Array(await legacyData.arrayBuffer());
        const contentType = legacyData.type || mimeForName(docId);
        return { bytes, contentType, filename: docId };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find which owner's folder holds an uploaded doc (admin download path). The bucket is
 * laid out as <owner_id>/<sha256_of_docId>; we list folders and probe for the doc.
 * Returns the owner id, or null if not found. Used only for admins (who may download
 * any upload).
 *
 * Key encoding: Storage files are stored under the SHA-256 hex digest of the docId
 * (see storagePath/storageKeyFromDocId). For backwards-compat with ASCII docIds that
 * may have been stored under the raw docId in older deployments, we also match by
 * the raw docId (ASCII-only legacy paths only).
 */
export async function findOwnerOfUpload(docId: string): Promise<string | null> {
  if (!supabaseEnabled()) return null;
  try {
    const client = admin();
    const { data: folders, error } = await client.storage.from(DOCS_BUCKET).list("", {
      limit: 1000,
    });
    if (error || !folders) return null;
    const hashedKey = storageKeyFromDocId(docId);
    // Legacy path only meaningful for ASCII docIds (non-ASCII ones were always rejected
    // by Storage anyway and produced no stored file).
    const hasNonAscii = /[^\x00-\x7F]/.test(docId);
    for (const folder of folders) {
      // Storage list returns folder entries (no id) and file entries; probe each folder.
      const { data: files } = await client.storage
        .from(DOCS_BUCKET)
        .list(folder.name, { limit: 1000 });
      // Match by SHA-256 key (new) or raw docId (legacy ASCII uploads only).
      if (files?.some((f) => f.name === hashedKey || (!hasNonAscii && f.name === docId))) {
        return folder.name;
      }
    }
    return null;
  } catch {
    return null;
  }
}
