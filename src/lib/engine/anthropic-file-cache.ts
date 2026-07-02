// DURABLE REUSE CACHE for Anthropic Files API uploads (migration 017).
//
// The Messages-API answer engine attaches the owner's files to Anthropic's Files API so
// the model can read them. Without this cache it re-uploaded EVERY in-scope file on EVERY
// ask — per-ask latency plus unbounded file accumulation on the billed org key. This maps
// (owner_id, doc_id, content_sha256) → the Anthropic file_id, so identical bytes upload
// ONCE and are reused on every later ask.
//
// EVERYTHING here is BEST-EFFORT. A cache read/write must NEVER make answering worse than
// it was with no cache: on ANY error (or when Supabase is disabled) a read behaves as a
// MISS (returns null) and a write / invalidate is a silent NO-OP. The caller then uploads
// fresh, exactly as before. The cache can only save an upload — it can never break an answer.
import { supabaseEnabled, admin } from "./supabase.ts";

const TABLE = "anthropic_file_cache";

/**
 * The cached Anthropic file_id for this owner's doc at this exact content hash, or null on
 * a miss / any failure (fail-as-miss). The sha is part of the key so edited bytes never
 * reuse a stale file_id.
 */
export async function getCachedFileId(
  ownerId: string,
  docId: string,
  sha: string
): Promise<string | null> {
  if (!supabaseEnabled()) return null;
  try {
    const { data, error } = await admin()
      .from(TABLE)
      .select("anthropic_file_id")
      .eq("owner_id", ownerId)
      .eq("doc_id", docId)
      .eq("content_sha256", sha)
      .maybeSingle();
    if (error) return null;
    const id = (data as { anthropic_file_id?: string } | null)?.anthropic_file_id;
    return id && id.trim() ? id : null;
  } catch {
    return null;
  }
}

/**
 * Record the Anthropic file_id for (owner, doc, content). Best-effort: a failed write just
 * means the next ask re-uploads (today's behavior) — it never propagates.
 */
export async function putCachedFileId(
  ownerId: string,
  docId: string,
  sha: string,
  anthropicFileId: string
): Promise<void> {
  if (!supabaseEnabled()) return;
  try {
    await admin()
      .from(TABLE)
      .upsert(
        { owner_id: ownerId, doc_id: docId, content_sha256: sha, anthropic_file_id: anthropicFileId },
        { onConflict: "owner_id,doc_id,content_sha256" }
      );
  } catch {
    // best-effort — swallow.
  }
}

/**
 * Drop every cached file_id for these docs (all content hashes) for this owner. Used when a
 * cached id turns out to be stale/expired at answer time so the next lookup re-uploads.
 * Best-effort: no-op on any failure.
 */
export async function invalidateFileIds(ownerId: string, docIds: string[]): Promise<void> {
  if (!supabaseEnabled() || docIds.length === 0) return;
  try {
    await admin().from(TABLE).delete().eq("owner_id", ownerId).in("doc_id", docIds);
  } catch {
    // best-effort — swallow.
  }
}
