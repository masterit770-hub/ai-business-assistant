-- ANTHROPIC FILE-UPLOAD CACHE (migration 017)
--
-- The Messages-API answer engine (answer-messages.ts) attaches the owner's files to
-- Anthropic's Files API so the model can read them. WITHOUT this cache it re-uploaded
-- EVERY in-scope file on EVERY ask — added latency per question and accumulated files
-- without bound on the billed org key. This table caches the Anthropic file_id per
-- (owner, doc, exact content) so identical bytes are uploaded ONCE and then reused
-- across every subsequent ask.
--
-- KEY = (owner_id, doc_id, content_sha256): the sha256 of the file BYTES is part of the
-- key, so a re-uploaded / edited document (same doc_id, NEW bytes) gets a fresh file_id
-- instead of silently reusing the wrong one. A stale/expired Anthropic file_id is
-- recovered at answer time (the engine invalidates the row, re-uploads, and retries the
-- create ONCE), so this cache can only SAVE an upload — it never makes answering less
-- reliable than having no cache at all.
--
-- GUARD RAILS:
--   • RLS: an owner sees only their own cache rows. The service-role (admin()) client
--     the engine uses bypasses RLS automatically, exactly like the other engine tables.
--   • Additive + idempotent (IF NOT EXISTS). NEVER destructive on existing data.
--   • NEVER touch the live owner b01c311e (this table is purely additive per-owner).
--
-- Idempotent: uses IF NOT EXISTS / CREATE OR REPLACE-style guards.

CREATE TABLE IF NOT EXISTS public.anthropic_file_cache (
  owner_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  doc_id            text        NOT NULL,
  content_sha256    text        NOT NULL,
  anthropic_file_id text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, doc_id, content_sha256)
);

CREATE INDEX IF NOT EXISTS anthropic_file_cache_owner_idx
  ON public.anthropic_file_cache(owner_id);

ALTER TABLE public.anthropic_file_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users see own file cache" ON public.anthropic_file_cache;
CREATE POLICY "users see own file cache"
  ON public.anthropic_file_cache FOR ALL
  USING (owner_id = auth.uid());

-- Service-role (admin()) client bypasses RLS automatically — no extra policies needed
-- for the engine's backend reads/writes that use the service-role key.
