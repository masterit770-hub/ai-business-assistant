import { Suspense } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SimpleTabs } from "@/components/simple-tabs";
import { UsersPanel } from "@/components/users-panel";
import { PromptsPanel } from "@/components/prompts-panel";
import { ModelsPanel } from "@/components/models-panel";
import { IntegrationsPanel } from "@/components/integrations-panel";
import { getCurrentUser } from "@/lib/supabase/auth";

// Settings is PER-USER: every signed-in user manages their OWN answer prompt + AI model
// config (cloud / Azure-HIPAA / local, with their own keys). The ONLY admin-only tab is
// Users (adding/removing people). The middleware already requires a session; here we just
// decide which tabs to show by role.
export default async function SettingsPage() {
  const user = await getCurrentUser();
  const isAdmin = user?.role === "admin";

  // Everyone gets their own Prompts / Models / Integrations; only an admin gets Users.
  const tabs = [
    { value: "prompts", label: "Prompts", content: <PromptsPanel /> },
    { value: "models", label: "Models", content: <ModelsPanel /> },
    { value: "integrations", label: "Integrations", content: <IntegrationsPanel /> },
    ...(isAdmin ? [{ value: "users", label: "Users", content: <UsersPanel /> }] : []),
  ];

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
              ? "Your answer prompt and AI model — plus manage workspace users."
              : "Your answer prompt and AI model — these apply to your own chats."}
          </p>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-6">
          <div className="mx-auto max-w-4xl">
            <Suspense fallback={null}>
              <SimpleTabs defaultValue="prompts" tabs={tabs} />
            </Suspense>
          </div>
        </div>
      </main>
    </div>
  );
}
