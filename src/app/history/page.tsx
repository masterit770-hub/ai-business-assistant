import { AppSidebar } from "@/components/app-sidebar";
import { HistoryPanel } from "@/components/history-panel";
import { getCurrentUser } from "@/lib/supabase/auth";

// History is a per-user surface: every signed-in member sees THEIR OWN past asks
// (question + answer + the sources/citations used). An ADMIN additionally sees
// everyone's. The middleware already requires a session for /history; here we read
// the role so the header copy + the panel reflect the member-vs-admin view. (The
// /api/history route is the real isolation boundary — RLS + owner_id scoping.)
export default async function HistoryPage() {
  const user = await getCurrentUser();
  const isAdmin = user?.role === "admin";

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <AppSidebar active="history" />

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="border-b border-line bg-surface px-7 py-4">
          <h1 className="font-display text-xl font-bold tracking-tight text-ink">
            History
          </h1>
          <p className="text-sm text-faint">
            {isAdmin
              ? "Every question asked across the workspace — with its answer and the sources used."
              : "Your past questions — with each answer and the sources used."}
          </p>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-6">
          <div className="mx-auto max-w-4xl">
            <HistoryPanel isAdmin={isAdmin} />
          </div>
        </div>
      </main>
    </div>
  );
}
