-- KNOWLEDGE SPACES (migration 016)
--
-- A Knowledge Space is a named collection of documents and chats owned by one user.
-- Every chat (session) and every uploaded file belongs to exactly one space.
--
-- DESIGN:
--   • knowledge_spaces — the space catalogue (id, owner_id, name, created_at).
--   • The manifest (_files.json) is extended with a `space_id` field per entry
--     (handled in application code — doc-files.ts).
--   • session_spaces — maps session_id → space_id for the chat→space association.
--   • Space-aware scoping: when a space_id is provided, a chat sees ALL files in that
--     space (across all sessions in the space). Cross-space reads are BLOCKED unless
--     global mode is requested (handled in application/engine code, not SQL).
--   • Global mode: no space filter → the owner's full file corpus across all spaces.
--
-- GUARD RAILS:
--   • RLS on knowledge_spaces: owner sees only their own spaces.
--   • Every operation in application code asserts owner_id before touching a space.
--   • NEVER touch the live owner b01c311e (enforced in seed + journey scripts).
--
-- Idempotent: uses IF NOT EXISTS / CREATE OR REPLACE.

-- ── 1. knowledge_spaces table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.knowledge_spaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_spaces_owner_idx
  ON public.knowledge_spaces(owner_id);

ALTER TABLE public.knowledge_spaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users see own spaces" ON public.knowledge_spaces;
CREATE POLICY "users see own spaces"
  ON public.knowledge_spaces FOR ALL
  USING (owner_id = auth.uid());

-- ── 2. session_spaces: maps chat session_id → space ────────────────────────────────
-- Additive table rather than altering ask_history (many existing rows + migrations).
-- When a chat is opened/created inside a space the application writes one row here.
CREATE TABLE IF NOT EXISTS public.session_spaces (
  session_id  uuid PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  space_id    uuid NOT NULL REFERENCES public.knowledge_spaces(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_spaces_space_idx
  ON public.session_spaces(space_id);
CREATE INDEX IF NOT EXISTS session_spaces_owner_idx
  ON public.session_spaces(owner_id);

ALTER TABLE public.session_spaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users see own session_spaces" ON public.session_spaces;
CREATE POLICY "users see own session_spaces"
  ON public.session_spaces FOR ALL
  USING (owner_id = auth.uid());

-- ── 3. Helper: list session_ids belonging to a given space ─────────────────────────
CREATE OR REPLACE FUNCTION public.sessions_in_space(
  p_owner  uuid,
  p_space  uuid
)
RETURNS TABLE (session_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT ss.session_id
  FROM public.session_spaces ss
  WHERE ss.owner_id = p_owner
    AND ss.space_id = p_space;
$$;

-- Service-role (admin()) client bypasses RLS automatically — no extra policies needed
-- for backend operations that use the service-role key.
