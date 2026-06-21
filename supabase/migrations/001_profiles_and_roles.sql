-- Nucleus auth: per-user profiles with role + disabled flag.
-- Idempotent (safe to re-run). Backs the admin Users panel (list/create/kick-out)
-- and per-user document isolation (the engine scopes uploads by the user id we
-- pass as X-Nucleus-User). The bundled corpus stays shared; only UPLOADED docs
-- are per-user.

-- ── profiles: one row per auth user ─────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  role       text not null default 'user',          -- 'user' | 'admin'
  disabled   boolean not null default false,         -- admin kick-out flag
  created_at timestamptz not null default now()
);

-- role must be one of the known values (idempotent add)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_role_chk'
  ) then
    alter table public.profiles
      add constraint profiles_role_chk check (role in ('user', 'admin'));
  end if;
end $$;

-- ── RLS: a user can read their OWN profile; writes go through service-role ───
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

-- (No user-facing insert/update/delete policies: profile creation is via the
-- signup trigger, and admin mutations use the service-role key which bypasses
-- RLS. This keeps role/disabled tamper-proof from the client.)

-- ── auto-create a profile when an auth user is created ──────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, role, disabled)
  values (new.id, new.email, 'user', false)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── backfill profiles for any users that already exist ──────────────────────
insert into public.profiles (id, email, role, disabled)
select u.id, u.email, 'user', false
from auth.users u
on conflict (id) do nothing;

-- ── seed the FIRST user as admin (so there's always an admin to manage the rest)
-- Only promotes if there is currently NO admin, picking the earliest-created user.
do $$
declare first_user uuid;
begin
  if not exists (select 1 from public.profiles where role = 'admin') then
    select id into first_user from public.profiles order by created_at asc limit 1;
    if first_user is not null then
      update public.profiles set role = 'admin' where id = first_user;
    end if;
  end if;
end $$;
