-- Deleted (hidden) shared sources — workspace-level soft-delete of the BUNDLED
-- corpus (the pre-loaded Carter docs + the bundled SQLite tables). Bundled data is
-- SHARED across the workspace and lives on disk (read-only index), so it can't be
-- physically removed per-user the way an upload can. Instead an ADMIN records the
-- source id here, and retrieval (vectorSearch / introspectSchema) excludes any id
-- in this set — so a "deleted" bundled doc/table never appears in answers again.
--
-- Idempotent (safe to re-run). Mirrors 001's admin model: any authenticated user
-- can SEE what's hidden, but only an admin (a profiles row with role='admin') can
-- hide (INSERT) or un-hide (DELETE) a shared source. Re-adding is out of scope here;
-- a DELETE policy is provided so a future "restore" stays admin-gated.

create table if not exists public.deleted_sources (
  source_id  text primary key,                       -- the doc/table id (e.g. 'family-court', 'contracts')
  kind       text not null,                           -- 'document' | 'structured' (informational)
  deleted_at timestamptz not null default now()
);

-- ── RLS: everyone authenticated can read the hidden-set; only admins mutate it ──
alter table public.deleted_sources enable row level security;

-- Helper: is the calling auth user an admin? (a profiles row with role='admin')
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

drop policy if exists "deleted_sources_select_authenticated" on public.deleted_sources;
create policy "deleted_sources_select_authenticated"
  on public.deleted_sources for select
  to authenticated
  using (true);

drop policy if exists "deleted_sources_insert_admin" on public.deleted_sources;
create policy "deleted_sources_insert_admin"
  on public.deleted_sources for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "deleted_sources_delete_admin" on public.deleted_sources;
create policy "deleted_sources_delete_admin"
  on public.deleted_sources for delete
  to authenticated
  using (public.is_admin());

-- NOTE: the server uses the service-role key (bypasses RLS); the role check is also
-- enforced in the route handler (requireAdmin). RLS is the defense-in-depth layer so
-- the table is tamper-proof even from a direct client with a user JWT.
