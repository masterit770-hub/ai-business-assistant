import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/supabase/auth";

// Admin Users API — REAL Supabase users via the admin API. ADMIN-GATED: the
// caller must have role 'admin' (and not be disabled); a plain user gets 403.
//   GET  → list users (id, email, role, status, created, last sign-in)
//   POST → { id, action: "deactivate" | "reactivate" } bans/un-bans the user
//          { action: "create", email, password }        creates an account
//          { id, action: "setRole", role: "user"|"admin" } promote/demote
//
// "Kick out" is enforced on two layers so it's immediate AND durable:
//   1. profiles.disabled flag → the middleware bounces them on the next request
//   2. an auth ban + global signOut → their live sessions/tokens are revoked now
export const runtime = "nodejs";

type AdminUser = {
  id: string;
  email?: string;
  created_at: string;
  last_sign_in_at?: string | null;
  banned_until?: string | null;
};

function isBanned(u: AdminUser): boolean {
  return Boolean(u.banned_until && new Date(u.banned_until).getTime() > Date.now());
}

export async function GET() {
  const caller = await requireAdmin();
  if (!caller) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Roles + disabled flag come from the profiles table (authoritative).
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, role, disabled");
  const roleOf = new Map((profiles ?? []).map((p) => [p.id, p.role as string]));
  const disabledOf = new Map((profiles ?? []).map((p) => [p.id, Boolean(p.disabled)]));

  const users = (data.users as unknown as AdminUser[]).map((u) => ({
    id: u.id,
    email: u.email ?? "(no email)",
    role: (roleOf.get(u.id) as "user" | "admin") ?? "user",
    // Deactivated if banned at the auth layer OR flagged in profiles.
    status:
      isBanned(u) || disabledOf.get(u.id)
        ? ("deactivated" as const)
        : ("active" as const),
    createdAt: u.created_at,
    lastSignInAt: u.last_sign_in_at ?? null,
    isSelf: u.id === caller.id,
  }));
  // Newest first.
  users.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return NextResponse.json({ users });
}

export async function POST(req: Request) {
  const caller = await requireAdmin();
  if (!caller) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { id?: string; action?: string; email?: string; password?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { id, action } = body;
  const admin = createAdminClient();

  // ── create a new account (pre-confirmed) ──────────────────────────────────
  if (action === "create") {
    const email = (body.email ?? "").toString().trim();
    const password = (body.password ?? "").toString();
    if (!email || password.length < 6) {
      return NextResponse.json(
        { error: "email and a password of at least 6 characters are required" },
        { status: 400 }
      );
    }
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, id: data.user?.id, status: "active" });
  }

  // ── promote / demote ──────────────────────────────────────────────────────
  if (action === "setRole") {
    const role = (body.role ?? "").toString();
    if (!id || !["user", "admin"].includes(role)) {
      return NextResponse.json({ error: "id and a valid role are required" }, { status: 400 });
    }
    const { error } = await admin.from("profiles").update({ role }).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id, role });
  }

  // ── kick out (deactivate) / restore (reactivate) ──────────────────────────
  if (action !== "deactivate" && action !== "reactivate") {
    return NextResponse.json(
      { error: "action must be 'create', 'setRole', 'deactivate', or 'reactivate'" },
      { status: 400 }
    );
  }
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (id === caller.id && action === "deactivate") {
    return NextResponse.json({ error: "you cannot deactivate yourself" }, { status: 400 });
  }

  const disabled = action === "deactivate";
  // 1. profiles.disabled — the middleware reads this to gate EVERY request.
  const { error: pErr } = await admin.from("profiles").update({ disabled }).eq("id", id);
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
  // 2. auth ban ("876000h" ≈ 100y, or "none" to lift) — rejects their tokens.
  const { error } = await admin.auth.admin.updateUserById(id, {
    ban_duration: disabled ? "876000h" : "none",
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // 3. revoke live sessions so the kick-out is immediate, not on token expiry.
  if (disabled) {
    await admin.auth.admin.signOut(id, "global").catch(() => {});
  }
  return NextResponse.json({ ok: true, id, status: disabled ? "deactivated" : "active" });
}
