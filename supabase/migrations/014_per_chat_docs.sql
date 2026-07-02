-- PER-CHAT DOCUMENT SCOPING (migration 014)
--
-- Adds chat-level isolation on top of the existing owner-level isolation.
-- A "chat" in Nucleus is a session (session_id uuid) — the same id used in
-- ask_history and session_titles. We reuse that concept rather than creating a
-- new entity; the sessions table can be thought of as the named-chat table already.
--
-- DESIGN:
--   • doc_chunks.session_id (nullable uuid): the chat this document belongs to.
--   • uploaded_rows.session_id (nullable uuid): the chat this structured table belongs to.
--   • Retrieval scoping rule:
--       owner_id = p_owner AND (session_id = p_session OR session_id IS NULL)
--     meaning: a NULL session_id is LEGACY / SHARED — visible to all the owner's
--     chats. A non-null session_id is CHAT-SCOPED — visible ONLY to that chat.
--   • New uploads from a chat will carry that chat's session_id; uploads done
--     outside a named session (or before this migration) have session_id NULL
--     and remain visible to all the owner's chats (backward compat).
--
-- Idempotent: all ADD COLUMN statements use IF NOT EXISTS. The hybrid_match RPC
-- is recreated (safe: it was CREATE OR REPLACE).

-- ── doc_chunks: add session_id ────────────────────────────────────────────────
-- session_id is a plain uuid (no FK): sessions are identified by a UUID shared across
-- ask_history rows (and session_titles), but there is no sessions TABLE with a PK to
-- reference. The session_id is simply a grouping key, not a FK to a specific row.
ALTER TABLE public.doc_chunks
  ADD COLUMN IF NOT EXISTS session_id uuid;

-- Index for the new retrieval filter (owner + session lookup is the hot path).
CREATE INDEX IF NOT EXISTS doc_chunks_session_idx
  ON public.doc_chunks (owner_id, session_id);

-- ── uploaded_rows: add session_id ─────────────────────────────────────────────
ALTER TABLE public.uploaded_rows
  ADD COLUMN IF NOT EXISTS session_id uuid;

-- Index for the new retrieval filter.
CREATE INDEX IF NOT EXISTS uploaded_rows_session_idx
  ON public.uploaded_rows (owner_id, session_id);

-- ── hybrid_match: updated to accept an optional p_session filter ───────────────
-- When p_session IS NULL, returns all the owner's chunks (NULL + non-null session_id)
-- — backward compat / admin path. When p_session is provided, scopes to:
--   session_id = p_session OR session_id IS NULL  (own-chat + legacy/unassigned)
CREATE OR REPLACE FUNCTION public.hybrid_match(
  query_embedding vector(384),
  query_text      text,
  p_owner         uuid,
  p_is_admin      boolean,
  k               int,
  p_session       uuid DEFAULT NULL   -- NULL = no chat filter (all owner's chunks)
)
RETURNS TABLE (
  doc_id     text,
  doc_label  text,
  page       int,
  content    text,
  token      text,
  dense_rank int,
  bm25_rank  int,
  rrf_score  float
)
LANGUAGE sql
STABLE
AS $$
  WITH scoped AS (
    SELECT c.*
    FROM public.doc_chunks c
    WHERE c.embedding IS NOT NULL
      AND (
        p_is_admin
        OR (p_owner IS NOT NULL AND c.owner_id = p_owner)
      )
      -- Chat-scoping: when p_session is given, restrict to that chat's docs + legacy (NULL).
      -- When p_session is NULL, return all the owner's docs (no chat filter).
      AND (
        p_session IS NULL
        OR c.session_id = p_session
        OR c.session_id IS NULL
      )
  ),
  dense AS (
    SELECT
      s.id,
      ROW_NUMBER() OVER (ORDER BY s.embedding <=> query_embedding) AS d_rank
    FROM scoped s
  ),
  lexical AS (
    SELECT
      s.id,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(s.fts, websearch_to_tsquery('simple', query_text)) DESC
      ) AS l_rank
    FROM scoped s
    WHERE query_text IS NOT NULL
      AND query_text <> ''
      AND s.fts @@ websearch_to_tsquery('simple', query_text)
  ),
  fused AS (
    SELECT
      s.id,
      d.d_rank::int                                              AS dense_rank,
      l.l_rank::int                                             AS bm25_rank,
      (COALESCE(1.0 / (60 + d.d_rank), 0.0)
        + COALESCE(1.0 / (60 + l.l_rank), 0.0))::float8        AS rrf_score
    FROM scoped s
    LEFT JOIN dense   d ON d.id = s.id
    LEFT JOIN lexical l ON l.id = s.id
  )
  SELECT
    s.doc_id,
    s.doc_label,
    s.page,
    s.content,
    s.token,
    f.dense_rank,
    f.bm25_rank,
    f.rrf_score
  FROM fused f
  JOIN scoped s ON s.id = f.id
  ORDER BY f.rrf_score DESC
  LIMIT GREATEST(k, 1);
$$;

-- ── match_doc_chunks: also updated for p_session (dense-only fallback) ──────
CREATE OR REPLACE FUNCTION public.match_doc_chunks(
  query_embedding vector(384),
  p_owner         uuid,
  p_is_admin      boolean,
  match_count     int,
  p_session       uuid DEFAULT NULL
)
RETURNS TABLE (
  doc_id    text,
  doc_label text,
  page      int,
  content   text,
  token     text,
  score     float
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.doc_id,
    c.doc_label,
    c.page,
    c.content,
    c.token,
    1 - (c.embedding <=> query_embedding) AS score
  FROM public.doc_chunks c
  WHERE c.embedding IS NOT NULL
    AND (
      p_is_admin
      OR (p_owner IS NOT NULL AND c.owner_id = p_owner)
    )
    AND (
      p_session IS NULL
      OR c.session_id = p_session
      OR c.session_id IS NULL
    )
  ORDER BY c.embedding <=> query_embedding
  LIMIT GREATEST(match_count, 1);
$$;
