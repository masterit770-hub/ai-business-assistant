-- Self-hosted HYBRID document RAG — uploaded-document chunks + their embeddings in
-- Supabase pgvector. This REPLACES the Gemini File Search lane for UPLOADED docs:
-- our own text extraction (unpdf) + OCR (Tesseract, best-effort) + our own embeddings
-- (multilingual-e5-small, 384-dim, the SAME local embedder the bundled index uses)
-- are stored here, and retrieval is a HYBRID of a DENSE (pgvector cosine) ranking and
-- a LEXICAL (BM25-style ts_rank_cd) ranking, fused with Reciprocal Rank Fusion (RRF).
-- No Gemini, no external document API.
--
-- Per-user isolation is a HARD gate: a chunk is owned by its uploader (owner_id),
-- and retrieval is scoped to the caller (or all rows for an admin). RLS enforces
-- this even against a direct client JWT; the server additionally scopes every
-- search by owner (see hybridSearch). Idempotent (safe to re-run).

-- pgvector — the embedding column + the cosine ANN index need it.
create extension if not exists vector;

-- ── doc_chunks: one row per embedded chunk of an uploaded document ──────────────
-- `fts` is a GENERATED tsvector (to_tsvector('simple', content)): Postgres maintains
-- it automatically on insert/update, so the lexical lane never needs a separate write.
-- 'simple' (no language stemming, no stop-list) keeps EN + Hebrew + any language
-- searchable uniformly — matching the in-process bundled tokenizer (see hybrid.ts).
create table if not exists public.doc_chunks (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references auth.users (id) on delete cascade,
  doc_id      text not null,                 -- the [P:<doc_id>#page] citation namespace
  doc_label   text,                          -- human label for the dashboard
  page        int,                           -- citable page number
  chunk_index int,                           -- chunk order within the doc (stable)
  content     text not null,                 -- the chunk text (also the cited evidence)
  token       text,                          -- precomputed [P:<doc>#<page>] citation token
  embedding   vector(384),                   -- multilingual-e5-small passage embedding
  fts         tsvector generated always as (to_tsvector('simple', coalesce(content, ''))) stored,
  created_at  timestamptz not null default now()
);

-- Owner-scoped retrieval is the hot path → index owner_id.
create index if not exists doc_chunks_owner_idx on public.doc_chunks (owner_id);
-- Doc-scoped delete/list (re-upload replaces a doc's chunks) → index (owner_id, doc_id).
create index if not exists doc_chunks_owner_doc_idx on public.doc_chunks (owner_id, doc_id);

-- ── DENSE lane index: cosine similarity over the embedding ──────────────────────
-- ivfflat with vector_cosine_ops: embeddings are L2-normalized (e5), so cosine
-- distance (<=>) ranks them. lists=100 is a sane default for a small/medium corpus;
-- it can be retuned as the table grows. (ivfflat over hnsw: it builds fast and has
-- no build-memory ceiling on the small managed instance.)
create index if not exists doc_chunks_embedding_idx
  on public.doc_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- ── LEXICAL lane index: GIN over the generated FTS column (BM25/keyword lane) ────
create index if not exists doc_chunks_fts_idx
  on public.doc_chunks
  using gin (fts);

-- ── RLS: a user reads ONLY their own chunks; an admin reads all ─────────────────
-- Mirrors 001/005's admin model (public.is_admin() = a profiles row role='admin').
-- Writes go through the service-role key (bypasses RLS) at ingest time; these
-- policies are the defense-in-depth read gate so a direct client JWT can NEVER
-- read another user's chunks.
alter table public.doc_chunks enable row level security;

-- is_admin() is created in 005; recreate defensively so 006 is independently runnable.
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

drop policy if exists "doc_chunks_select_own_or_admin" on public.doc_chunks;
create policy "doc_chunks_select_own_or_admin"
  on public.doc_chunks for select
  to authenticated
  using (owner_id = auth.uid() or public.is_admin());

-- (No user-facing insert/update/delete policies: ingest + delete use the
-- service-role key, which bypasses RLS. This keeps owner_id tamper-proof from a
-- client and ensures a user can never write a chunk attributed to someone else.)

-- ── hybrid_match: DENSE × BM25 → RRF, owner-scoped ──────────────────────────────
-- Called by hybridSearch via the service-role client, so RLS does NOT apply to this
-- read — isolation is enforced HERE in SQL by the (p_owner / p_is_admin) filter:
-- an admin (p_is_admin = true) sees every owner's chunks; everyone else sees ONLY
-- rows whose owner_id matches p_owner. A null p_owner with p_is_admin false matches
-- nothing (fail-closed: never leak another user's chunks).
--
-- HOW THE HYBRID IS COMPUTED:
--   scoped     — the owner-filtered candidate set (the ONLY rows either lane sees).
--   dense      — every scoped row, ranked by cosine distance (embedding <=> query).
--                dense_rank = row_number() over (order by embedding <=> q). Every row
--                gets a dense rank (cosine is always defined).
--   lexical    — rows whose fts MATCHES websearch_to_tsquery('simple', query_text),
--                ranked by ts_rank_cd(fts, query) DESC. bm25_rank only exists for a
--                row with real keyword overlap (a row with no match has no lexical
--                rank → contributes nothing to its RRF, exactly like the JS lane).
--   rrf        — Reciprocal Rank Fusion: 1/(60 + dense_rank) + 1/(60 + bm25_rank),
--                where a MISSING rank contributes 0 (coalesced). k=60 matches the
--                in-process bundled lane (hybrid.ts RRF_K) so scores are comparable.
-- Returns the top `k` rows by rrf_score, carrying the REAL dense_rank, bm25_rank, and
-- rrf_score so the inspector shows honest per-chunk numbers.
create or replace function public.hybrid_match(
  query_embedding vector(384),
  query_text      text,
  p_owner         uuid,
  p_is_admin      boolean,
  k               int
)
returns table (
  doc_id     text,
  doc_label  text,
  page       int,
  content    text,
  token      text,
  dense_rank int,
  bm25_rank  int,
  rrf_score  float
)
language sql
stable
as $$
  with scoped as (
    select c.*
    from public.doc_chunks c
    where c.embedding is not null
      and (
        p_is_admin
        or (p_owner is not null and c.owner_id = p_owner)
      )
  ),
  dense as (
    select
      s.id,
      row_number() over (order by s.embedding <=> query_embedding) as d_rank
    from scoped s
  ),
  lexical as (
    select
      s.id,
      row_number() over (
        order by ts_rank_cd(s.fts, websearch_to_tsquery('simple', query_text)) desc
      ) as l_rank
    from scoped s
    where query_text is not null
      and query_text <> ''
      and s.fts @@ websearch_to_tsquery('simple', query_text)
  ),
  fused as (
    select
      s.id,
      d.d_rank::int                                              as dense_rank,
      l.l_rank::int                                              as bm25_rank,
      -- RRF = Σ 1/(k + rank); a missing (NULL) rank contributes 0. Cast to float8 to
      -- match the declared return type exactly (the 1.0 literal is numeric).
      (coalesce(1.0 / (60 + d.d_rank), 0.0)
        + coalesce(1.0 / (60 + l.l_rank), 0.0))::float8          as rrf_score
    from scoped s
    left join dense   d on d.id = s.id
    left join lexical l on l.id = s.id
  )
  select
    s.doc_id,
    s.doc_label,
    s.page,
    s.content,
    s.token,
    f.dense_rank,
    f.bm25_rank,
    f.rrf_score
  from fused f
  join scoped s on s.id = f.id
  order by f.rrf_score desc
  limit greatest(k, 1);
$$;

-- ── match_doc_chunks: dense-only fallback (kept for compatibility) ──────────────
-- The hybrid path above is the primary retrieval. This dense-only RPC is retained so
-- a caller (or an older deployment) that asks for pure cosine still works; isolation
-- is identical (the p_owner / p_is_admin filter). `score` is cosine SIMILARITY
-- (1 - distance), the 0..1 scale the bundled cosineSim returns.
create or replace function public.match_doc_chunks(
  query_embedding vector(384),
  p_owner uuid,
  p_is_admin boolean,
  match_count int
)
returns table (
  doc_id    text,
  doc_label text,
  page      int,
  content   text,
  token     text,
  score     float
)
language sql
stable
as $$
  select
    c.doc_id,
    c.doc_label,
    c.page,
    c.content,
    c.token,
    1 - (c.embedding <=> query_embedding) as score
  from public.doc_chunks c
  where c.embedding is not null
    and (
      p_is_admin
      or (p_owner is not null and c.owner_id = p_owner)
    )
  order by c.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;
