// Pure, dependency-free per-chat file scoping. Exported and used by BOTH the agent
// (answer-agentic.ts listOwnerFiles) AND the per-chat-scoping unit test, so the test
// exercises the REAL logic instead of a re-implementation that can silently drift.
//
// REQUIREMENT (Chris): EVERY document belongs to a chat. There is NO "global" tier — an
// unassigned (session_id = null) document must never exist (uploads are tagged with the
// chat they were added to; the upload path fails closed if it has no chat). Scoping is
// therefore STRICT: a chat sees ONLY the documents tagged to it.
//
//   • chatId provided  → only that chat's docs (session_id === chatId).
//   • chatId null/undef → no chat filter (admin / "all docs" view).
//
// A null-session doc is a BUG upstream (an upload that failed to link to its chat), not a
// "shared" doc — it is intentionally NOT surfaced here so the bug is visible, not masked.

export function filterFilesForChat<T extends { session_id?: string | null }>(
  files: T[],
  chatId: string | null | undefined
): T[] {
  if (chatId == null) return files; // no chat context (admin / all-docs view) → everything
  return files.filter((f) => f.session_id === chatId); // STRICT: only this chat's docs
}
