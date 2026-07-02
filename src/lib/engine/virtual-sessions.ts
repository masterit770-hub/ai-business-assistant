// VIRTUAL SESSION IDs — reserved UUIDs for pseudo-sessions that are not real
// ask_history / session_titles rows. These are STABLE group keys used only for
// document scoping; they must never be inserted into ask_history or session_titles.
//
// These UUIDs correspond to the session_ids used in migration 015 for:
//   IMPORTED_SESSION_ID  — pre-015 NULL-session uploads reassigned here so they
//                          don't appear in every new empty chat.
//   SAMPLE_DATA_SESSION_ID — the bundled demo corpus is presented as belonging
//                            to a "Sample data" chat for demo accounts, rather
//                            than floating as "Built-in" with no chat context.

/** Legacy/imported uploads — pre-migration NULL-session docs go here. */
export const IMPORTED_SESSION_ID = "00000000-0000-0000-0000-000000000001";

/** Demo "Sample data" virtual session — bundled sample corpus for is_demo accounts. */
export const SAMPLE_DATA_SESSION_ID = "00000000-0000-0000-0000-000000000002";

/** Human-readable label for the imported session (shown as "chat" name). */
export const IMPORTED_SESSION_LABEL = "Imported";

/** Human-readable label for the sample data session. */
export const SAMPLE_DATA_SESSION_LABEL = "Sample data";
