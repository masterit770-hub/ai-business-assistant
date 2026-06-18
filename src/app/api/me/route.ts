import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";

// Lightweight "who am I" endpoint — the signed-in user's id, email, and role.
// Client components (the sidebar) use it to gate admin-only UI on the real role
// (server gating already enforces access; this just hides dead-end links).
export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ user: null }, { status: 200 });
  return NextResponse.json({
    user: { id: user.id, email: user.email, role: user.role },
  });
}
