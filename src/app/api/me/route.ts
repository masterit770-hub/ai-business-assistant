import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { getSetting } from "@/lib/engine/settings";
import { runWithOwner } from "@/lib/engine/request-context";

// Lightweight "who am I" endpoint — the signed-in user's id, email, and role.
// Client components (the sidebar) use it to gate admin-only UI on the real role
// (server gating already enforces access; this just hides dead-end links).
//
// Also returns the active `system_prompt` (the assistant's answering style) so the
// chat's Answer Setup strip can show the CURRENT style to EVERY signed-in user
// read-only — members can't edit it (that's admin-only via /api/settings), but they
// can see the prompt integration exists. The prompt is the assistant's own
// instruction, not user data, so it's safe to surface read-only.
export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ user: null }, { status: 200 });
  let system_prompt = "";
  try {
    system_prompt = await runWithOwner(user.id, () => getSetting("system_prompt"));
  } catch {
    /* non-fatal: the strip falls back to a neutral style label */
  }
  return NextResponse.json({
    user: { id: user.id, email: user.email, role: user.role },
    system_prompt,
  });
}
