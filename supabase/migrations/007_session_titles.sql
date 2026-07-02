-- Session title OVERRIDES — let a user RENAME a conversation without rewriting the
-- immutable first question. A "session" is still just the group of ask_history rows
-- sharing one session_id (see 004); its DEFAULT title is the first turn's question.
-- This table holds an OPTIONAL override: when a row exists for a session_id, the
-- history listing prefers its `title` over that first question.
--
-- We DON'T touch ask_history.question (the real, logged turn) — renaming a thread is
-- a presentation concern, so it lives in its own tiny table keyed by session_id.
-- Idempotent (safe to re-run), matching 001–006.

create table if not exists public.session_titles (
  session_id text primary key,                       -- the ask_history.session_id this titles
  owner_id   uuid not null references auth.users (id) on delete cascade,
  title      text not null,
  updated_at timestamptz not null default now()
);

-- ── RLS: a member manages ONLY their own session titles; an admin manages any ──────
-- Mirrors 003/005: the owner can read/write their own override row, and an admin
-- (a profiles row with role='admin', via the is_admin() helper from 005) any row.
-- The server uses the service-role key (bypasses RLS) and ALSO enforces ownership in
-- the route handler; RLS is the defense-in-depth layer so the table is tamper-proof
-- even from a direct client holding a user JWT.
alter table public.session_titles enable row level security;

drop policy if exists "session_titles_select_own_or_admin" on public.session_titles;
create policy "session_titles_select_own_or_admin"
  on public.session_titles for select
  to authenticated
  using (auth.uid() = owner_id or public.is_admin());

drop policy if exists "session_titles_insert_own_or_admin" on public.session_titles;
create policy "session_titles_insert_own_or_admin"
  on public.session_titles for insert
  to authenticated
  with check (auth.uid() = owner_id or public.is_admin());

drop policy if exists "session_titles_update_own_or_admin" on public.session_titles;
create policy "session_titles_update_own_or_admin"
  on public.session_titles for update
  to authenticated
  using (auth.uid() = owner_id or public.is_admin())
  with check (auth.uid() = owner_id or public.is_admin());

drop policy if exists "session_titles_delete_own_or_admin" on public.session_titles;
create policy "session_titles_delete_own_or_admin"
  on public.session_titles for delete
  to authenticated
  using (auth.uid() = owner_id or public.is_admin());
