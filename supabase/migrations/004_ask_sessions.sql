-- Multi-turn chat sessions. A "session" is a conversation thread: a run of asks that
-- share one session_id, ordered by created_at. There is NO separate sessions table —
-- the session is the GROUP of ask_history rows that carry the same session_id. The
-- session's title is the first turn's question; its turns are its rows in time order.
--
-- session_id is NULLABLE so every pre-existing single-shot row (logged before this
-- migration) stays valid — those rows are simply not part of any chat thread. New
-- asks from /api/ask always carry a session_id (the server mints one if the client
-- didn't send one), so the running conversation + resume work off this column.
-- Idempotent (safe to re-run), matching 001/002/003.

alter table public.ask_history
  add column if not exists session_id uuid;

-- A session is always read as "all rows for one session_id, oldest first" (the
-- ordered turns) → index that exact path. Also serves the "group rows into sessions"
-- listing (scan by session_id) cheaply.
create index if not exists ask_history_session_created_idx
  on public.ask_history (session_id, created_at);

-- RLS is unchanged: the existing 003 policies already scope SELECT to the owner (a
-- member sees only their own rows; an admin sees all). Sessions inherit that — a
-- member can only ever read/load a session whose rows they own.
