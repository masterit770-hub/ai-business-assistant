-- 008 — persist the full retrieval TRACE with each ask so a resumed/historical answer
-- replays its REAL inspector (route, retrieved passages, steps, method, confidence,
-- cost) instead of a fabricated one. Before this, ask_history stored only the answer +
-- citations + route, so replaying a past turn rebuilt a HOLLOW trace ("Route NONE / 0
-- passages / no documents retrieved") next to a genuinely grounded, cited answer — an
-- incoherent panel. `inspector` holds the InspectorTrace (counts + steps, lightweight);
-- `evidence` holds the retrieved rows/chunks (a few KB) so the evidence panel + the
-- citation count replay faithfully. Both are nullable: rows written before this
-- migration simply have no recorded trace and the UI says so honestly.
alter table public.ask_history add column if not exists inspector jsonb;
alter table public.ask_history add column if not exists evidence  jsonb;
