-- 013_per_user_settings.sql — make engine_settings PER-USER.
--
-- Client decision: every user sets their OWN system prompt + model config (cloud /
-- Azure-HIPAA / local, incl. their own keys), individually. Only managing USERS stays
-- admin-only. So settings move from one shared global row per key to one row per
-- (owner_id, key).
--
-- BACKWARD-COMPAT: existing rows keep owner_id NULL = the SHARED WORKSPACE DEFAULT. A
-- user's read prefers their own row and falls back to the NULL-owner default, then to the
-- code DEFAULTS — so the workspace answers exactly as before until a user customizes, and
-- `bundled_urgency` (a workspace-level cache, NOT a user setting) stays on the NULL row.
--
-- Idempotent (safe to re-run).

alter table public.engine_settings
  add column if not exists owner_id uuid references auth.users (id) on delete cascade;

-- `key` is no longer globally unique (each user has their own row per key). Drop the
-- key-only PK and enforce uniqueness on (owner_id, key) instead. NULLS NOT DISTINCT
-- (PG15+) makes the single NULL-owner default row unique per key, and lets upsert
-- ON CONFLICT (owner_id, key) update it.
alter table public.engine_settings drop constraint if exists engine_settings_pkey;
create unique index if not exists engine_settings_owner_key_idx
  on public.engine_settings (owner_id, key) nulls not distinct;

-- ── RLS — a user reads their OWN rows + the shared (NULL-owner) defaults; the server
-- writes via the service-role key (which bypasses RLS), so these are the defense-in-depth
-- read gate. A user can NEVER read another user's saved key/config. ───────────────────
drop policy if exists "engine_settings_select_own_or_default" on public.engine_settings;
create policy "engine_settings_select_own_or_default"
  on public.engine_settings for select
  to authenticated
  using (owner_id = auth.uid() or owner_id is null);
