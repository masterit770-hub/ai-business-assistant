-- STRICT PER-CHAT DOCUMENT SCOPING (migration 015)
--
-- PREVIOUS DESIGN (migration 014):
--   session_id IS NULL → "legacy/unassigned" visible to ALL the owner's chats.
-- That caused NULL-session docs to leak into every new empty chat, breaking the
-- "a new empty chat sees nothing" invariant.
--
-- NEW DESIGN:
--   • When p_session IS NULL  → no chat filter (admin / Sources page "all docs" view)
--   • When p_session IS NOT NULL → STRICT: only that chat's docs (session_id = p_session)
--     NULL-session docs are NO LONGER a shared fallback.
--
-- MIGRATION: existing NULL-session uploads are reassigned to a fixed "Imported" session
-- per owner so they don't vanish. The well-known UUID below is deterministic so the
-- migration is idempotent:
--   '00000000-0000-0000-0000-000000000001'  →  "Imported"  (legacy uploads)
-- This virtual session_id is never a real ask_history / session_titles row; it is
-- simply the stable grouping key for pre-015 uploads. The UI can detect it and
-- label those docs as "Imported".
--
-- The hybrid_match and match_doc_chunks RPCs are recreated with strict scoping.
-- Idempotent: all migrations use IF NOT EXISTS / CREATE OR REPLACE.

-- ── Well-known "Imported" session UUID ──────────────────────────────────────────
-- Use a reserved UUID that won't collide with real user sessions.
-- Owner-specific virtual session = '00000000-0000-0000-0000-000000000001'
-- Demo "Sample data" virtual session = '00000000-0000-0000-0000-000000000002'
-- These must never be inserted into ask_history or session_titles (they are
-- placeholder session_ids only for doc scoping).

-- ── Migrate existing NULL-session docs to the "Imported" session ────────────────
UPDATE public.doc_chunks
SET session_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE session_id IS NULL;

-- ── Migrate existing NULL-session uploaded rows ──────────────────────────────────
UPDATE public.uploaded_rows
SET session_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE session_id IS NULL;

-- ── hybrid_match: strict per-chat, no NULL fallback ──────────────────────────────
-- When p_session IS NULL → no chat filter (admin / Sources page).
-- When p_session IS NOT NULL → ONLY that chat's docs (strict).
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
      -- STRICT per-chat scoping (migration 015):
      -- When p_session is given, return ONLY that chat's docs (no NULL fallback).
      -- When p_session is NULL, return all the owner's docs (no chat filter).
      AND (
        p_session IS NULL
        OR c.session_id = p_session
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

-- ── match_doc_chunks: strict per-chat, no NULL fallback ─────────────────────────
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
    -- STRICT per-chat scoping (migration 015):
    -- When p_session is given, ONLY that chat's docs (no NULL fallback).
    AND (
      p_session IS NULL
      OR c.session_id = p_session
    )
  ORDER BY c.embedding <=> query_embedding
  LIMIT GREATEST(match_count, 1);
$$;
