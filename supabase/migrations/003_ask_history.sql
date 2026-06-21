-- Ask history: every question a user asks is persisted with its answer AND the
-- sources/citations used, so the user can review their past asks (session / query /
-- source history). Each MEMBER sees ONLY their own rows; an ADMIN sees everyone's.
--
-- Written by /api/ask AFTER a successful answer (best-effort, via the service-role
-- client). Read by /api/history: a member reads their own rows under RLS; an admin
-- reads all rows via the service-role client (which bypasses RLS).
-- Idempotent (safe to re-run), matching 001/002.

create table if not exists public.ask_history (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  question   text not null,
  answer     text not null,
  mode       text,                                  -- 'grounded' | 'general'
  citations  jsonb,                                 -- citation tokens / sources used
  route      jsonb,                                 -- router sources + rationale
  created_at timestamptz not null default now()
);

-- The history list is always "most recent first, for one owner" → index that path.
create index if not exists ask_history_owner_created_idx
  on public.ask_history (owner_id, created_at desc);

-- ── RLS: a member reads ONLY their own rows; an admin reads ALL ─────────────────
-- Mirrors 001's admin expression: an admin is a profiles row with role = 'admin'.
-- Writes are NOT exposed to clients — inserts come from the server-side service-role
-- client (which bypasses RLS), keeping history tamper-proof from the browser.
alter table public.ask_history enable row level security;

drop policy if exists "ask_history_select_own" on public.ask_history;
create policy "ask_history_select_own"
  on public.ask_history for select
  using (auth.uid() = owner_id);

drop policy if exists "ask_history_select_admin" on public.ask_history;
create policy "ask_history_select_admin"
  on public.ask_history for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );
