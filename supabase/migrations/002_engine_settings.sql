-- Engine settings: admin-editable key/value overrides that must PERSIST and be
-- shared across all serverless instances (otherwise editing the persona / system
-- prompt or flipping the Cloud<->Local model switch only affects one warm Lambda
-- and is lost on the next request — which is exactly the bug this fixes).
--
-- Read/written ONLY by the server-side service-role client (src/lib/engine/
-- settings.ts). Keys today: system_prompt, urgency_prompt, model_mode,
-- local_endpoint, local_model. Falls back to in-code DEFAULTS when a row is absent.

create table if not exists public.engine_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- Lock it down: RLS on, no public policies. The service-role key bypasses RLS, so
-- the server can read/write; anon/authenticated clients get nothing. No setting
-- value is secret, but there's no reason to expose this table to the browser.
alter table public.engine_settings enable row level security;
