// KNOWLEDGE SPACES ENGINE LAYER
//
// Centralises all space-aware operations so both answer engines (agentic + messages)
// call the same scoping seam without duplicating logic.
//
// Space scoping (the core promise):
//   • A chat in space X sees ALL files whose space_id = X across ANY chat in that space.
//   • A chat in space X NEVER sees another space's files (unless globalMode = true).
//   • Global mode: the lookup returns files across ALL of the owner's spaces (union).
//
// The file manifest (_files.json) is extended with a `space_id` field per entry.
// Session→space mapping lives in the `session_spaces` Supabase table (migration 016).

import { admin, supabaseEnabled } from "./supabase.ts";
import { getSetting, setSetting } from "./settings.ts";

// ── Types ──────────────────────────────────────────────────────────────────────────

export type SpaceMeta = {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
};

// The extended manifest entry shape — adds `space_id` on top of the per-chat `session_id`.
export type ManifestEntryWithSpace = {
  docId: string;
  displayName: string;
  type: string;
  session_id?: string | null;
  space_id?: string | null;
};

// ── Default spaces (lazy-seeded on first listSpaces call) ─────────────────────────

/** The 6 default Knowledge Spaces created once per account on first access. */
const DEFAULT_SPACE_NAMES = [
  "Finance",
  "Contracts",
  "HR",
  "Projects",
  "Legal",
  "Sales",
] as const;

/**
 * Seed the 6 default spaces for an owner, idempotently (skips names that exist).
 * Marks `spaces_seeded = "1"` in settings when done so this only ever runs ONCE.
 * Called from listSpaces; do NOT call elsewhere.
 */
async function seedDefaultSpaces(ownerId: string): Promise<void> {
  if (!supabaseEnabled()) return;
  try {
    const client = admin();
    // Fetch existing space names for this owner so we can skip duplicates.
    const { data: existing } = await client
      .from("knowledge_spaces")
      .select("name")
      .eq("owner_id", ownerId);
    const existingNames = new Set((existing ?? []).map((r: { name: string }) => r.name));

    // Insert only the missing defaults.
    const toInsert = DEFAULT_SPACE_NAMES
      .filter((n) => !existingNames.has(n))
      .map((name) => ({ owner_id: ownerId, name }));

    if (toInsert.length > 0) {
      const { error } = await client.from("knowledge_spaces").insert(toInsert);
      if (error) {
        console.warn(`[spaces] seedDefaultSpaces insert failed: ${error.message}`);
        // Don't mark seeded — will retry next call.
        return;
      }
    }

    // Mark seeded — gate on this flag (not "0 spaces") so deletion doesn't re-trigger.
    await setSetting("spaces_seeded", "1", ownerId);
  } catch (e) {
    console.warn(`[spaces] seedDefaultSpaces threw: ${e instanceof Error ? e.message : e}`);
  }
}

// ── Space CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Create a new Knowledge Space for the given owner.
 * Returns the created space row, or throws on error.
 */
export async function createSpace(ownerId: string, name: string): Promise<SpaceMeta> {
  if (!supabaseEnabled()) throw new Error("Supabase required for Knowledge Spaces");
  const client = admin();
  const { data, error } = await client
    .from("knowledge_spaces")
    .insert({ owner_id: ownerId, name: name.trim() })
    .select()
    .single();
  if (error) throw new Error(`createSpace failed: ${error.message}`);
  return data as SpaceMeta;
}

/**
 * List all Knowledge Spaces for the given owner, newest first.
 * Lazy-seeds the 6 default spaces on the owner's FIRST call (gates on the
 * `spaces_seeded` flag — deletion does NOT re-trigger). Returns an empty array
 * when Supabase is off or the table doesn't exist yet.
 */
export async function listSpaces(ownerId: string): Promise<SpaceMeta[]> {
  if (!supabaseEnabled()) return [];
  try {
    // Lazy-init: seed default spaces exactly once per owner.
    const seeded = await getSetting("spaces_seeded", ownerId);
    if (seeded !== "1") {
      await seedDefaultSpaces(ownerId);
    }

    const client = admin();
    const { data, error } = await client
      .from("knowledge_spaces")
      .select("id, owner_id, name, created_at")
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false });
    if (error) {
      console.warn(`[spaces] listSpaces failed: ${error.message}`);
      return [];
    }
    return (data ?? []) as SpaceMeta[];
  } catch (e) {
    console.warn(`[spaces] listSpaces threw: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/**
 * Ownership guard: does `spaceId` exist AND belong to `ownerId`?
 *
 * Used by write paths (e.g. assigning a chat to a space) to fail closed before touching
 * a space the caller doesn't own. Returns the SAME `false` whether the space is missing
 * OR owned by someone else, so a caller can 404 both cases identically without leaking
 * whether the id exists. Never throws — any error (Supabase off, transient) → false.
 */
export async function spaceExistsForOwner(ownerId: string, spaceId: string): Promise<boolean> {
  if (!supabaseEnabled()) return false;
  try {
    const client = admin();
    const { data, error } = await client
      .from("knowledge_spaces")
      .select("id")
      .eq("id", spaceId)
      .eq("owner_id", ownerId)
      .single();
    return !error && !!data;
  } catch {
    return false;
  }
}

/**
 * Delete a Knowledge Space AND all its dependent rows:
 *   • session_spaces rows (cascades via FK, but we also clean the manifest)
 *   • knowledge_spaces row itself (cascades session_spaces via FK)
 *
 * The manifest (_files.json) entries whose space_id = spaceId are NOT automatically
 * removed — the caller must separately clean the manifest (see removeSpaceFromManifest).
 * This is a hard-owner check: throws if the space doesn't belong to ownerId.
 */
export async function deleteSpace(ownerId: string, spaceId: string): Promise<void> {
  if (!supabaseEnabled()) throw new Error("Supabase required for Knowledge Spaces");
  const client = admin();
  // Verify ownership before delete.
  const { data: existing, error: findErr } = await client
    .from("knowledge_spaces")
    .select("id, owner_id")
    .eq("id", spaceId)
    .eq("owner_id", ownerId)
    .single();
  if (findErr || !existing) {
    throw new Error(`Space ${spaceId} not found for owner ${ownerId}`);
  }
  const { error } = await client
    .from("knowledge_spaces")
    .delete()
    .eq("id", spaceId)
    .eq("owner_id", ownerId);
  if (error) throw new Error(`deleteSpace failed: ${error.message}`);
}

// ── Session ↔ Space mapping ────────────────────────────────────────────────────────

/**
 * Associate a chat session with a space. Idempotent — upserts the session_spaces row.
 * Called from every seam that ties a chat to a space (ask, upload, the explicit POST).
 *
 * OWNERSHIP is enforced HERE, at the single seam, not per-caller: a spaceId the owner
 * doesn't own (foreign or nonexistent) is refused — otherwise a crafted ask/upload body
 * could write bookkeeping rows against another user's space id. (No data ever leaked —
 * all reads are owner-scoped — but garbage rows are still wrong.) Best-effort like the
 * rest of this module: refusal/failure logs and returns, never throws.
 */
export async function assignSessionToSpace(
  ownerId: string,
  sessionId: string,
  spaceId: string
): Promise<void> {
  if (!supabaseEnabled()) return;
  try {
    if (!(await spaceExistsForOwner(ownerId, spaceId))) {
      console.warn(`[spaces] assignSessionToSpace refused: space not owned by caller`);
      return;
    }
    const client = admin();
    const { error } = await client
      .from("session_spaces")
      .upsert(
        { session_id: sessionId, owner_id: ownerId, space_id: spaceId },
        { onConflict: "session_id" }
      );
    if (error) {
      console.warn(`[spaces] assignSessionToSpace failed: ${error.message}`);
    }
  } catch (e) {
    console.warn(`[spaces] assignSessionToSpace threw: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Look up which space a given session belongs to, or null if none.
 */
export async function spaceForSession(
  ownerId: string,
  sessionId: string
): Promise<string | null> {
  if (!supabaseEnabled()) return null;
  try {
    const client = admin();
    const { data, error } = await client
      .from("session_spaces")
      .select("space_id")
      .eq("session_id", sessionId)
      .eq("owner_id", ownerId)
      .single();
    if (error || !data) return null;
    return (data as { space_id: string }).space_id;
  } catch {
    return null;
  }
}

/**
 * Return all session_ids that belong to the given space+owner.
 */
export async function sessionsInSpace(
  ownerId: string,
  spaceId: string
): Promise<string[]> {
  if (!supabaseEnabled()) return [];
  try {
    const client = admin();
    const { data, error } = await client
      .from("session_spaces")
      .select("session_id")
      .eq("owner_id", ownerId)
      .eq("space_id", spaceId);
    if (error || !data) return [];
    return (data as { session_id: string }[]).map((r) => r.session_id);
  } catch {
    return [];
  }
}

// ── File scoping (the core filter) ────────────────────────────────────────────────

/**
 * Space-aware file filter.
 *
 *   • spaceId provided + globalMode=false → return ONLY files with space_id = spaceId.
 *     This is the strict cross-chat in-space view: files from ALL chats in that space,
 *     but ZERO files from any other space.
 *   • globalMode=true → return ALL of the owner's files (no space filter).
 *   • spaceId=null + globalMode=false → fall back to the legacy per-chat filter
 *     (filterFilesForChat — keeps the existing behaviour for chats not in a space).
 *
 * This is the ONLY place where the space→file scoping decision lives. Both the agentic
 * engine (answer-agentic.ts) and the messages engine (answer-messages.ts) call
 * listOwnerFiles which calls this function — keeping the shared seam stable.
 */
export function filterFilesForSpace<T extends { space_id?: string | null; session_id?: string | null }>(
  files: T[],
  opts: {
    spaceId?: string | null;
    globalMode?: boolean;
  }
): T[] {
  const { spaceId, globalMode } = opts;
  if (globalMode) return files; // global search: all files across all spaces
  if (spaceId) {
    // Space-scoped: only files tagged to this space, regardless of which chat uploaded them.
    const result = files.filter((f) => f.space_id === spaceId);
    console.log(
      `[spaces] filterFilesForSpace space=${spaceId} total=${files.length} visible=${result.length}`
    );
    return result;
  }
  // No space context → return everything (legacy: unspaced chats see all owner files).
  return files;
}
