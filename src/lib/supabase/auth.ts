import { createClient, createAdminClient } from "./server";

// Server-side auth helpers shared by route handlers. Resolve the signed-in user
// and their profile (role + disabled) from the session cookie, using the
// service-role client to read the profile (RLS-safe, never trusts the client).

export type NucleusUser = {
  id: string;
  email: string | null;
  role: "user" | "admin";
  disabled: boolean;
};

// The current request's user + profile, or null if not signed in.
export async function getCurrentUser(): Promise<NucleusUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Read role/disabled with the service role so it's authoritative (not a value
  // the browser could spoof). Default to a plain, enabled user if no row yet.
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, disabled")
    .eq("id", user.id)
    .maybeSingle();

  return {
    id: user.id,
    email: user.email ?? null,
    role: (profile?.role as "user" | "admin") ?? "user",
    disabled: Boolean(profile?.disabled),
  };
}

// Guard for admin-only routes: returns the admin user, or null to reject.
export async function requireAdmin(): Promise<NucleusUser | null> {
  const user = await getCurrentUser();
  if (!user || user.disabled || user.role !== "admin") return null;
  return user;
}
