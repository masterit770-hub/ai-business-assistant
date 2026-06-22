import { Suspense } from "react";
import { ShieldAlert } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { SimpleTabs } from "@/components/simple-tabs";
import { UsersPanel } from "@/components/users-panel";
import { PromptsPanel } from "@/components/prompts-panel";
import { ModelsPanel } from "@/components/models-panel";
import { getCurrentUser } from "@/lib/supabase/auth";

// Settings is an ADMIN-only surface (user management + answer prompts). The
// middleware already requires a session; here we additionally gate on role so a
// regular member who navigates to /settings directly gets an honest "admins
// only" message instead of forbidden-banner dead-ends.
export default async function SettingsPage() {
  const user = await getCurrentUser();
  const isAdmin = user?.role === "admin";

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <AppSidebar active="settings" />

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="border-b border-line bg-surface px-7 py-4">
          <h1 className="font-display text-xl font-bold tracking-tight text-ink">
            Settings
          </h1>
          <p className="text-sm text-faint">
            {isAdmin
              ? "Manage users, the assistant’s answer prompts, and the AI model."
              : "Workspace settings."}
          </p>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-6">
          <div className="mx-auto max-w-4xl">
            {isAdmin ? (
              <Suspense fallback={null}>
                <SimpleTabs
                  defaultValue="users"
                  tabs={[
                    { value: "prompts", label: "Prompts", content: <PromptsPanel /> },
                    { value: "models", label: "Models", content: <ModelsPanel /> },
                    { value: "users", label: "Users", content: <UsersPanel /> },
                  ]}
                />
              </Suspense>
            ) : (
              <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-6 shadow-soft">
                <ShieldAlert className="mt-0.5 size-5 shrink-0 text-faint" />
                <div>
                  <h2 className="font-display text-base font-semibold text-ink">
                    Admins only
                  </h2>
                  <p className="mt-1 text-sm text-faint">
                    User management and prompt configuration are available to workspace
                    admins. Ask an admin if you need access changed.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
