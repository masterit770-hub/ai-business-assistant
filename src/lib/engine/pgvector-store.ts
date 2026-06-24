// Self-hosted HYBRID document RAG store — uploaded-document chunks + their embeddings
// in Supabase pgvector. This is the UPLOADED-doc lane that REPLACES Gemini File Search:
// chunks are embedded with the SAME local multilingual-e5 model the bundled index
// uses (384-dim) and persisted in public.doc_chunks (migration 006), then retrieved by
// a HYBRID RPC (hybrid_match): a DENSE cosine ranking × a LEXICAL BM25/ts_rank_cd
// ranking, fused with Reciprocal Rank Fusion (RRF, k=60 — the same fusion the bundled
// in-process lane uses). No Gemini, no external document API.
//
// Per-user isolation is a HARD gate: every chunk carries its uploader's owner_id, and
// searchDocChunks scopes the RPC to the caller (or all rows for an admin). RLS on the
// table is the defense-in-depth layer; the owner filter in the RPC is the primary one
// for the service-role reads this module makes.
//
// FAIL-OPEN: neither storeDocChunks nor searchDocChunks throws into the ingest/query
// pipeline. A storage/search failure is logged and degrades gracefully (the bundled
// lane + structured lane still answer), never crashing the request.
import { admin, supabaseEnabled } from "./supabase.ts";
import { pdfToken } from "./citations.ts";
import { detectLang, type DocLang } from "./bundled-sources.ts";
import type { DocChunk } from "./retrieval.ts";

// One chunk ready to persist: its page, text, citation token, and the local-embedder
// passage vector (384-dim). The caller (ingest) computes the embedding with
// embedPassage so this module never touches the model.
export type StorableChunk = {
  page: number;
  text: string;
  token: string;
  embedding: number[];
};

// The raw e5 query text → the BM25/lexical lane of the hybrid search. We pass it to
// the RPC, which feeds websearch_to_tsquery('simple', …) on the SQL side. Exported so
// the formatting contract (trim, never null into the param) is unit-testable.
export function toQueryText(question: string): string {
  return (question ?? "").trim();
}

// The FAIL-CLOSED isolation gate, as a pure predicate so the per-user-isolation rule
// is unit-tested directly: a search may run ONLY when the caller is an admin (sees
// all) OR has a concrete owner id (sees ONLY their own). A non-admin with NO owner id
// must match NOTHING — we never run an unscoped search that could leak another user's
// chunks. (The SQL RPC + RLS enforce this again server-side; this is the first gate.)
export function canSearchOwner(ownerId: string | undefined, isAdmin: boolean): boolean {
  return isAdmin || !!ownerId;
}

// The VERIFIED-WRITE decision (task #82), as a pure function so the false-green-prevention
// rule is unit-tested directly: given how many chunks we asked to write (`requested`) and
// how many a post-insert read-back found committed (`verified`), the count we REPORT as
// `persisted` is ALWAYS the verified one — never the requested one. The old code returned
// `requested` (rows.length), so a silent row-drop (RLS/constraint with error null) reported
// a full write that never landed → route=[] → fabrication. `dropped()` flags the mismatch
// so ingest can log it loudly instead of lying. `verified` is clamped to >= 0.
export function reportedPersistCount(requested: number, verified: number): number {
  return Math.max(0, verified);
}
export function persistDropped(requested: number, verified: number): boolean {
  return Math.max(0, verified) < requested;
}

// pgvector accepts a vector literal as a bracketed, comma-joined list: "[0.1,0.2,...]".
// supabase-js sends it as a JSON string param; Postgres casts text → vector(384). We
// format it ourselves (rather than rely on driver coercion) so the on-wire shape is
// explicit and unit-testable. Non-finite values (NaN/Infinity) would make Postgres
// reject the whole literal, so they're coerced to 0 — a defensive no-op for a healthy
// L2-normalized e5 vector, but it keeps one bad value from failing an entire batch.
export function toVectorLiteral(embedding: number[]): string {
  const parts = embedding.map((n) => (Number.isFinite(n) ? n : 0));
  return `[${parts.join(",")}]`;
}

/**
 * Persist a document's chunks to pgvector (batch insert via the service-role client).
 * A re-upload of the same doc REPLACES its prior chunks first (delete-then-insert), so
 * re-ingesting doesn't double-count. owner_id tags every row for per-user isolation.
 *
 * VERIFIED COUNT (task #82): the returned number is a READ-BACK count — after the insert
 * we re-query how many of this (owner, doc) chunks actually landed and return THAT, not
 * `rows.length` (the intent). Reporting the intended count meant a silent write failure
 * (an RLS policy or a column constraint that drops rows with `error: null`) would report
 * `persisted = N` while ZERO rows committed — a false-green that made every uploaded-doc
 * question fabricate (the "route=[] → general → Beyoncé" bug) while the ingest log claimed
 * success. A read-back makes `persisted = N` MEAN "N rows are committed for this owner",
 * so a drop surfaces as persisted < requested (logged) instead of a confident lie.
 *
 * FAIL-OPEN: returns the VERIFIED count, or 0 on any failure (logged) — never throws into
 * ingest. The doc registry / dashboard listing is independent of this.
 */
export async function storeDocChunks(
  ownerId: string | undefined,
  docId: string,
  docLabel: string,
  chunks: StorableChunk[],
  // The doc's LLM-classified urgency, stored on every chunk so the dashboard badge is
  // DURABLE (survives a serverless cold start). Null when not classified.
  urgency?: "high" | "medium" | "low" | null
): Promise<number> {
  if (!supabaseEnabled()) {
    console.warn(
      "[pgvector-store] Supabase not configured — uploaded-doc chunks not persisted " +
        "(set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for durable, isolated document RAG)."
    );
    return 0;
  }
  if (chunks.length === 0) return 0;
  try {
    const db = admin();
    // Re-upload replaces a doc's prior chunks (scoped to this owner so we never touch
    // another user's rows even if two users upload a doc with the same id).
    const del = db.from("doc_chunks").delete().eq("doc_id", docId);
    await (ownerId ? del.eq("owner_id", ownerId) : del.is("owner_id", null));

    const rows = chunks.map((c, i) => ({
      owner_id: ownerId ?? null,
      doc_id: docId,
      doc_label: docLabel,
      page: c.page,
      chunk_index: i,
      content: c.text,
      token: c.token,
      urgency: urgency ?? null,
      embedding: toVectorLiteral(c.embedding),
    }));
    const { error } = await db.from("doc_chunks").insert(rows);
    if (error) {
      console.error("[pgvector-store] insert failed:", error.message);
      return 0;
    }
    // VERIFIED WRITE (task #82): re-read how many chunks ACTUALLY committed for this
    // (owner, doc) and return that count — never the requested `rows.length`. If a row-
    // dropping policy/constraint silently ate the insert (error null but nothing landed),
    // this read-back returns the true (smaller) number, so a downstream "persisted=N"
    // can never claim a write that didn't happen. Scoped to (owner, doc) so a concurrent
    // ingest of another doc/owner can't inflate the count; head:true keeps it a cheap
    // COUNT(*) with no row transfer.
    const verify = db
      .from("doc_chunks")
      .select("id", { count: "exact", head: true })
      .eq("doc_id", docId);
    const { count, error: verr } = await (ownerId
      ? verify.eq("owner_id", ownerId)
      : verify.is("owner_id", null));
    if (verr) {
      // The insert reported success but we couldn't confirm it — report 0 rather than an
      // unverified number, so ingest never over-claims a write it couldn't prove landed.
      console.error("[pgvector-store] insert succeeded but read-back failed:", verr.message);
      return 0;
    }
    const verified = count ?? 0;
    if (persistDropped(rows.length, verified)) {
      // Surfacing a partial/dropped write loudly — this is the exact silent-failure mode
      // (#82) that produced a false-green. The ingest result will carry the true count.
      console.error(
        `[pgvector-store] VERIFIED WRITE MISMATCH: requested ${rows.length} chunks for ` +
          `doc=${docId} owner=${ownerId ?? "null"}, but only ${verified} committed.`
      );
    }
    return reportedPersistCount(rows.length, verified);
  } catch (e) {
    console.error(
      "[pgvector-store] storeDocChunks failed:",
      e instanceof Error ? e.message : e
    );
    return 0;
  }
}

/**
 * Cosine-nearest uploaded chunks for a query embedding, scoped to the caller.
 * Returns the engine's DocChunk shape ({doc,page,text,score}) so the result merges
 * 1:1 with the bundled vectorSearch chunks and cites with the same [P:doc#page] token.
 *
 * ISOLATION: an admin (isAdmin=true) sees every owner's chunks; everyone else sees
 * ONLY their own (owner_id = ownerId). A non-admin with no ownerId matches nothing
 * (fail-closed) — we never leak another user's chunks. Enforced in the SQL function
 * (match_doc_chunks) AND, defensively, by RLS on the table.
 *
 * FAIL-OPEN: returns [] on any failure (logged) — never throws into the answer
 * pipeline; the bundled + structured lanes still produce an answer.
 */
export async function searchDocChunks(
  ownerId: string | undefined,
  isAdmin: boolean,
  queryEmbedding: number[],
  k = 8
): Promise<DocChunk[]> {
  if (!supabaseEnabled()) return [];
  // Fail-closed isolation: a non-admin with no owner id can match nothing — never
  // run an unscoped search that could return another user's chunks.
  if (!canSearchOwner(ownerId, isAdmin)) return [];
  try {
    const db = admin();
    const { data, error } = await db.rpc("match_doc_chunks", {
      query_embedding: toVectorLiteral(queryEmbedding),
      p_owner: ownerId ?? null,
      p_is_admin: isAdmin,
      match_count: k,
    });
    if (error) {
      console.error("[pgvector-store] match_doc_chunks failed:", error.message);
      return [];
    }
    type Row = {
      doc_id: string;
      doc_label: string | null;
      page: number | null;
      content: string;
      token: string | null;
      score: number | null;
    };
    return ((data ?? []) as Row[]).map((r) => ({
      doc: r.doc_id,
      page: typeof r.page === "number" ? r.page : 1,
      text: r.content,
      // Prefer the stored token; fall back to recomputing it from doc+page so a chunk
      // that predates the token column still cites correctly.
      // (DocChunk itself doesn't carry the token — the answer pipeline recomputes it
      // via pdfToken — but recomputing here keeps the page consistent.)
      score: typeof r.score === "number" ? r.score : 0,
    }));
  } catch (e) {
    console.error(
      "[pgvector-store] searchDocChunks failed:",
      e instanceof Error ? e.message : e
    );
    return [];
  }
}

/**
 * WHOLE-DOCUMENT FETCH — every chunk of ONE specific document, in chunk order, owner-scoped. Used
 * by the enumeration/summary recall boost (the MENDA fix): when a question asks to ENUMERATE or
 * SUMMARIZE one document ("how many options are there and which is preferred?"), hybrid ranking can
 * surface only the FIRST chunk and miss the later ones that hold the rest of the list + the
 * conclusion — so the answer reports a partial list and "the preferred one isn't stated". Pulling
 * the doc's full chunk set (capped) makes the whole document available to the generator. GENERAL —
 * any document, keyed off the question being an enumeration/summary of ONE doc, never a doc name.
 *
 * ISOLATION: same fail-closed owner scoping as the search paths (a non-admin with no ownerId reads
 * nothing). FAIL-OPEN: returns [] on any failure (logged) — never throws into the pipeline.
 */
export async function fetchDocChunksByDoc(
  ownerId: string | undefined,
  isAdmin: boolean,
  docId: string,
  cap = 12
): Promise<DocChunk[]> {
  if (!supabaseEnabled()) return [];
  if (!canSearchOwner(ownerId, isAdmin)) return [];
  try {
    const db = admin();
    let q = db
      .from("doc_chunks")
      .select("doc_id, page, content, chunk_index")
      .eq("doc_id", docId)
      .order("chunk_index", { ascending: true })
      .limit(cap);
    // Owner scoping: an admin reads any owner's chunks for this doc; a member only their own.
    if (!isAdmin) q = q.eq("owner_id", ownerId!);
    const { data, error } = await q;
    if (error) {
      console.error("[pgvector-store] fetchDocChunksByDoc failed:", error.message);
      return [];
    }
    type Row = { doc_id: string; page: number | null; content: string; chunk_index: number | null };
    return ((data ?? []) as Row[]).map((r) => ({
      doc: r.doc_id,
      page: typeof r.page === "number" ? r.page : 1,
      text: r.content,
      score: 0,
    }));
  } catch (e) {
    console.error(
      "[pgvector-store] fetchDocChunksByDoc failed:",
      e instanceof Error ? e.message : e
    );
    return [];
  }
}

/**
 * HYBRID search over the uploaded chunks — the PRIMARY uploaded-doc retrieval. Calls
 * the SQL `hybrid_match` RPC, which computes a DENSE (cosine) ranking × a LEXICAL
 * (BM25/ts_rank_cd) ranking and fuses them with Reciprocal Rank Fusion (RRF, k=60).
 * Returns the engine's DocChunk shape carrying the REAL per-chunk denseRank /
 * bm25Rank / rrfScore, so an uploaded chunk merges 1:1 with the bundled hybrid lane
 * AND the inspector shows honest hybrid numbers for both. `score` is the RRF fused
 * score (the value the result is ranked by).
 *
 * ISOLATION: an admin (isAdmin=true) sees every owner's chunks; everyone else sees
 * ONLY their own (owner_id = ownerId). A non-admin with no ownerId matches nothing
 * (fail-closed) — we never leak another user's chunks. Enforced in the SQL function
 * AND, defensively, by RLS on the table.
 *
 * FAIL-OPEN: returns [] on any failure (logged) — never throws into the answer
 * pipeline; the bundled + structured lanes still produce an answer.
 */
export async function hybridSearch(
  ownerId: string | undefined,
  isAdmin: boolean,
  queryEmbedding: number[],
  queryText: string,
  k = 8
): Promise<DocChunk[]> {
  if (!supabaseEnabled()) return [];
  // Fail-closed isolation: a non-admin with no owner id can match nothing — never
  // run an unscoped search that could return another user's chunks.
  if (!canSearchOwner(ownerId, isAdmin)) return [];
  try {
    const db = admin();
    const { data, error } = await db.rpc("hybrid_match", {
      query_embedding: toVectorLiteral(queryEmbedding),
      query_text: toQueryText(queryText),
      p_owner: ownerId ?? null,
      p_is_admin: isAdmin,
      k,
    });
    if (error) {
      console.error("[pgvector-store] hybrid_match failed:", error.message);
      return [];
    }
    type Row = {
      doc_id: string;
      doc_label: string | null;
      page: number | null;
      content: string;
      token: string | null;
      dense_rank: number | null;
      bm25_rank: number | null;
      rrf_score: number | null;
    };
    return ((data ?? []) as Row[]).map((r) => ({
      doc: r.doc_id,
      page: typeof r.page === "number" ? r.page : 1,
      text: r.content,
      // Headline score = the fused RRF score (what the RPC ordered by).
      score: typeof r.rrf_score === "number" ? r.rrf_score : 0,
      denseRank: typeof r.dense_rank === "number" ? r.dense_rank : 0,
      bm25Rank: typeof r.bm25_rank === "number" ? r.bm25_rank : 0,
      rrfScore: typeof r.rrf_score === "number" ? r.rrf_score : 0,
    }));
  } catch (e) {
    console.error(
      "[pgvector-store] hybridSearch failed:",
      e instanceof Error ? e.message : e
    );
    return [];
  }
}

// One uploaded document as the dashboard lists it — derived DURABLY from the
// pgvector store (distinct doc_id), owner-scoped. Mirrors the doc-store DocMeta shape.
// `lang` is the doc's PRIMARY language detected from its real indexed text (not its
// filename) — so a Hebrew invoice named "hebrew-invoice.pdf" is correctly tagged HE.
export type UploadedDocMeta = {
  doc: string;
  label: string;
  urgency: "high" | "medium" | "low" | null;
  lang: DocLang;
  pages: number; // distinct page count (for the "PDF · N pages" detail), 0 if unknown
};

/**
 * The caller's uploaded documents, rebuilt DURABLY from the pgvector store (one entry
 * per distinct doc_id), owner-scoped for per-user isolation. An admin (no ownerId)
 * sees all; a member sees only their own. Urgency isn't stored on doc_chunks (it's a
 * dashboard badge classified at ingest and kept in the in-memory registry), so it's
 * null here — the route can merge it from the registry when present.
 *
 * FAIL-OPEN: returns [] on any failure (logged) so the dashboard still renders the
 * bundled sources.
 */
export async function listUploadedDocs(ownerId?: string): Promise<UploadedDocMeta[]> {
  if (!supabaseEnabled()) return [];
  try {
    const db = admin();
    // Pull content (for language detection), page (for the page-count detail), and the
    // durable urgency (the badge) so the rebuilt list is complete without the in-memory
    // registry.
    let q = db.from("doc_chunks").select("doc_id, doc_label, owner_id, content, page, urgency");
    if (ownerId) q = q.eq("owner_id", ownerId);
    const { data, error } = await q;
    if (error) {
      console.error("[pgvector-store] listUploadedDocs failed:", error.message);
      return [];
    }
    const byDoc = new Map<
      string,
      { label: string; pages: Set<number>; urgency: "high" | "medium" | "low" | null }
    >();
    // Accumulate a BOUNDED sample of each doc's text for language detection (a few KB
    // is plenty; avoids holding a whole corpus in memory).
    const sample = new Map<string, string>();
    const SAMPLE_CAP = 4000;
    type Row = {
      doc_id: string;
      doc_label: string | null;
      content: string | null;
      page: number | null;
      urgency: "high" | "medium" | "low" | null;
    };
    for (const r of (data ?? []) as Row[]) {
      let agg = byDoc.get(r.doc_id);
      if (!agg) {
        agg = { label: r.doc_label || r.doc_id, pages: new Set(), urgency: null };
        byDoc.set(r.doc_id, agg);
      }
      if (typeof r.page === "number") agg.pages.add(r.page);
      if (r.urgency && !agg.urgency) agg.urgency = r.urgency;
      const acc = sample.get(r.doc_id) ?? "";
      if (acc.length < SAMPLE_CAP && r.content) {
        sample.set(r.doc_id, (acc + " " + r.content).slice(0, SAMPLE_CAP));
      }
    }
    return [...byDoc.entries()].map(([doc, agg]) => ({
      doc,
      label: agg.label,
      urgency: agg.urgency,
      lang: detectLang(sample.get(doc) ?? ""),
      pages: agg.pages.size,
    }));
  } catch (e) {
    console.error("[pgvector-store] listUploadedDocs failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * Delete an uploaded document's chunks from the pgvector store, scoped to the owner so
 * a member can NEVER delete another user's doc. An admin (no ownerId) may delete any
 * doc by id. Returns the number of chunks removed (best-effort; 0 on failure).
 */
export async function deleteUploadedDoc(ownerId: string | undefined, docId: string, isAdmin = false): Promise<number> {
  if (!supabaseEnabled()) return 0;
  // Fail-closed: a non-admin with no owner id must not run an unscoped delete.
  if (!isAdmin && !ownerId) return 0;
  try {
    const db = admin();
    let del = db.from("doc_chunks").delete({ count: "exact" }).eq("doc_id", docId);
    // A non-admin delete is ALWAYS owner-scoped; an admin delete is global by doc id.
    if (!isAdmin) del = del.eq("owner_id", ownerId!);
    const { count, error } = await del;
    if (error) {
      console.error("[pgvector-store] deleteUploadedDoc failed:", error.message);
      return 0;
    }
    return count ?? 0;
  } catch (e) {
    console.error("[pgvector-store] deleteUploadedDoc failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}

// Re-export so callers (ingest) can build the token without importing citations
// separately when assembling StorableChunk lists.
export { pdfToken };
