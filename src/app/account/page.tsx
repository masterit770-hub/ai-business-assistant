import { AppSidebar } from "@/components/app-sidebar";
import { AccountPanel } from "@/components/account-panel";
import { getCurrentUser } from "@/lib/supabase/auth";

// Account is a per-user surface reachable by EVERY signed-in member (NOT admin-only):
// change your own password, set a display name, pick light/dark. The middleware
// already requires a session for /account (it's in the PROTECTED list), so an
// unauthenticated visitor is bounced to /sign-in before this renders. We read the
// user only for the friendly header label.
export default async function AccountPage() {
  const user = await getCurrentUser();

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <AppSidebar active="account" />

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="border-b border-line bg-surface px-7 py-4">
          <h1 className="font-display text-xl font-bold tracking-tight text-ink">Account</h1>
          <p className="text-sm text-faint">
            {user?.email
              ? `Manage your account — ${user.email}.`
              : "Manage your password, display name, and theme."}
          </p>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-6">
          <div className="mx-auto max-w-4xl">
            <AccountPanel />
          </div>
        </div>
      </main>
    </div>
  );
}
