// DELETED (hidden) shared sources — the workspace-level soft-delete of BUNDLED data.
//
// The bundled corpus (the pre-loaded Carter PDFs + the bundled SQLite tables) is
// SHARED and lives on a read-only on-disk index, so it can't be physically removed
// per-user the way a Gemini File Search upload can. Instead an ADMIN records the
// source id in `public.deleted_sources`, and retrieval excludes it:
//   • vectorSearch (RAG)          skips any chunk whose doc id is hidden
//   • introspectSchema (text-to-SQL) drops any hidden bundled table from the catalog
//   • bundledSources (the UI list)   marks hidden sources (so the list can omit them)
//
// THE SYNC SEAM. vectorSearch / introspectSchema are synchronous, but the hidden-set
// lives in Supabase (async). So we keep a process-wide SNAPSHOT (a Set of ids) and a
// synchronous getter the retrieval code reads, plus an async `refreshDeletedSources()`
// the request entrypoints (the answer pipeline, the documents route) call at the top
// of a request to (re)load the snapshot — "cached per request": each request refreshes
// it once, then every sync read in that request uses the same snapshot.
//
// BACKWARD-COMPATIBLE: when Supabase isn't configured, or the table is empty / missing,
// the snapshot is empty → retrieval behaves EXACTLY as before (nothing is excluded).
import { admin, supabaseEnabled } from "./supabase.ts";

export type DeletedKind = "document" | "structured";
export type DeletedSource = { source_id: string; kind: string; deleted_at?: string };

// Process-wide snapshot of hidden source ids. Empty by default (→ nothing excluded).
const g = globalThis as unknown as { __nucleusDeletedSources?: Set<string> };
function snapshot(): Set<string> {
  if (!g.__nucleusDeletedSources) g.__nucleusDeletedSources = new Set();
  return g.__nucleusDeletedSources;
}

// Coalesce concurrent refreshes within a request so we hit Supabase at most once even
// when several lanes (route + retrieve + bundled list) all ask to refresh.
let _inflight: Promise<Set<string>> | null = null;

/**
 * (Re)load the hidden-set from Supabase into the process snapshot, then return it.
 * Call this once at the top of a request (answer pipeline / documents route) so the
 * synchronous retrieval reads below see a fresh, consistent set. Never throws — on any
 * error (Supabase off, table missing, transient) it leaves the snapshot empty so
 * retrieval is unaffected (fail-OPEN: a transient read error must not silently hide
 * real data, and must not crash a query).
 */
export async function refreshDeletedSources(): Promise<Set<string>> {
  if (!supabaseEnabled()) {
    snapshot().clear();
    return snapshot();
  }
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const { data, error } = await admin()
        .from("deleted_sources")
        .select("source_id");
      const next = new Set<string>();
      if (!error && Array.isArray(data)) {
        for (const r of data as { source_id?: string }[]) {
          if (r.source_id) next.add(r.source_id);
        }
      }
      const s = snapshot();
      s.clear();
      for (const id of next) s.add(id);
      return s;
    } catch {
      // Leave whatever snapshot we had; don't crash a query over a hidden-set read.
      return snapshot();
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** The current hidden-set snapshot (synchronous — used by vectorSearch/introspect). */
export function deletedSourceIds(): Set<string> {
  return snapshot();
}

/** Is this source id currently hidden? (synchronous) */
export function isSourceDeleted(id: string): boolean {
  return snapshot().has(id);
}

/**
 * Record a shared source as deleted (admin action). Upserts the id so a repeat delete
 * is idempotent, and updates the live snapshot immediately so the change takes effect
 * within the same process without waiting for the next refresh. Returns true when the
 * row was written (Supabase configured) — false when Supabase is off (the caller
 * surfaces that the workspace store isn't configured).
 */
export async function markSourceDeleted(sourceId: string, kind: DeletedKind): Promise<boolean> {
  if (!supabaseEnabled()) return false;
  const { error } = await admin()
    .from("deleted_sources")
    .upsert({ source_id: sourceId, kind }, { onConflict: "source_id" });
  if (error) throw new Error(error.message);
  snapshot().add(sourceId);
  return true;
}

/** Test/hot-reload helper: replace the in-memory snapshot (no Supabase round-trip). */
export function setDeletedSnapshotForTest(ids: string[]): void {
  const s = snapshot();
  s.clear();
  for (const id of ids) s.add(id);
}
