-- 010 — persist the grounding VALIDATION verdict with each ask. Migration 008 saved the
-- retrieval trace, but NOT validation, so a resumed turn re-fabricated `{ ok: true }` —
-- replaying a validateAnswer-REJECTED grounded answer as a falsely GREEN "verified /
-- Grounded" panel (it showed a RED "Rejected" pill when first answered). Persist the
-- real verdict so resume replays the truth. Nullable: rows written before this migration
-- have no recorded verdict (the UI already flags those turns as "trace not recorded").
alter table public.ask_history add column if not exists validation jsonb;
