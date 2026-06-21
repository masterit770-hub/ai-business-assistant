-- 011 — persist an uploaded doc's urgency on its chunks so the dashboard badge is
-- DURABLE. Urgency was classified at ingest but kept only in the in-memory registry,
-- so after a serverless cold start (or on another instance) the badge vanished. Storing
-- it on doc_chunks (same row the durable list is rebuilt from) makes the badge survive.
alter table public.doc_chunks add column if not exists urgency text;
