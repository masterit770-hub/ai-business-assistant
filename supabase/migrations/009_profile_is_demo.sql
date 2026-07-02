-- 009 — mark the SEED/demo accounts. The bundled sample corpus (the Carter case file,
-- the school-data tables, etc.) is TEST data that ships with the demo and is removed in
-- production. Rather than force it onto every account as an undeletable "Built-in"
-- section, it is shown + retrieved ONLY for accounts flagged `is_demo`. A real client
-- user (is_demo = false, the default) starts with a CLEAN bucket — only their own
-- uploads. This is a generic visibility flag, not engine-logic tuning: the retrieval
-- pipeline is unchanged; it just sees an empty bundled corpus for non-demo users.
alter table public.profiles add column if not exists is_demo boolean not null default false;
