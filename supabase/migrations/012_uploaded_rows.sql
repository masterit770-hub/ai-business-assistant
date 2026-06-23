-- 012 — DURABLE structured rows for uploaded spreadsheets (CSV / XLSX).
--
-- THE BUG this fixes: an uploaded spreadsheet's rows lived ONLY in the per-Lambda
-- in-memory runtime store (globalThis.__nucleusRuntimeStore.sqlRows). On a Vercel
-- serverless COLD START that memory is empty, so the text-to-SQL lane had NO uploaded
-- tables and the router's structured catalog was empty — a spreadsheet question routed
-- to nothing and answered "there are none" for a real uploaded table.
--
-- THE LANE: spreadsheets are STRUCTURED data — answered by text-to-SQL (real
-- counts/sums/filters/lookups over the introspected schema), NOT by RAG/pgvector. So
-- their durable home is THIS table (one row per spreadsheet row), materialized back
-- into the per-owner SQLite catalog on demand. It is the structured-lane sibling of
-- doc_chunks (migration 006): same owner-isolation model, same RLS shape, same
-- service-role-writes-bypass-RLS discipline.
--
-- Per-user isolation is a HARD gate: every row carries its uploader's owner_id, and
-- rehydration is owner-scoped (the server filters by owner; RLS is the defense-in-depth
-- read gate). A NULL owner_id = a shared / single-user upload. Idempotent (safe to re-run).

-- ── uploaded_rows: one row per ingested spreadsheet row ─────────────────────────
-- `table_name` is the sanitized table id the runtime materializer uses (matches the
-- runtime table id), so a rehydrated row lands in the SAME SQLite table the warm path
-- built. `row_id` is the 1-based per-table id that anchors a [S:<table>#<row>] citation
-- (it becomes rowid_anchor in the materialized table). `data` is the full keyed row
-- object (the original headers → values) the materializer infers types from.
create table if not exists public.uploaded_rows (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references auth.users (id) on delete cascade,  -- NULL = shared/single-user
  table_name  text not null,                 -- the sanitized runtime table id
  label       text,                          -- human label for the Sources listing
  row_id      integer not null,              -- 1-based per-table id → [S:table#row] citation anchor
  data        jsonb not null,                -- the full keyed row (headers → values)
  created_at  timestamptz not null default now()
);

-- Owner-scoped rehydration + the Sources listing are the hot paths → index
-- (owner_id, table_name). Re-upload replaces a table's rows scoped to this pair.
create index if not exists uploaded_rows_owner_table_idx
  on public.uploaded_rows (owner_id, table_name);

-- ── RLS: a user reads ONLY their own rows; an admin reads all ───────────────────
-- Mirrors doc_chunks / migration 006: writes go through the service-role key (which
-- bypasses RLS) at ingest time, so owner_id is tamper-proof from a client; this SELECT
-- policy is the defense-in-depth read gate so a direct client JWT can NEVER read
-- another user's rows. public.is_admin() is created in 005/006.
alter table public.uploaded_rows enable row level security;

-- is_admin() is created in 005; recreate defensively so 012 is independently runnable.
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

drop policy if exists "uploaded_rows_select_own_or_admin" on public.uploaded_rows;
create policy "uploaded_rows_select_own_or_admin"
  on public.uploaded_rows for select
  to authenticated
  using (owner_id = auth.uid() or public.is_admin());

-- (No user-facing insert/update/delete policies: ingest + delete use the service-role
-- key, which bypasses RLS. A user can never write a row attributed to someone else.)
