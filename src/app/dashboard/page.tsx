"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { AssistantConsole } from "@/components/assistant/assistant-console";
import { MaterialsRail } from "@/components/assistant/materials-rail";

// Reads the ?session=<id> param (set when a user resumes a conversation from /history)
// and hands it to the console so it loads that thread. Wrapped in Suspense because
// useSearchParams suspends during prerender.
function ConsoleWithSession() {
  const params = useSearchParams();
  const sessionId = params.get("session") ?? undefined;
  // `key` so navigating to a different session (or back to none) remounts the console
  // and re-runs its resume/clear logic from a clean slate.
  return <AssistantConsole key={sessionId ?? "new"} initialSessionId={sessionId} />;
}

export default function DashboardPage() {
  // Real counts from /api/documents, published by MaterialsRail as RAW counts so every
  // stat is computed here from the same source — no pre-summed "total" that could
  // double-count. Sources = uploads + bundled (the whole bucket); Your uploads = uploads
  // only; High urgency = high-urgency docs across the bucket.
  const [counts, setCounts] = useState<{ uploaded: number; bundled: number; high: number } | null>(
    null
  );

  useEffect(() => {
    const onDocs = (e: Event) => setCounts((e as CustomEvent).detail);
    window.addEventListener("nucleus:docs", onDocs);
    return () => window.removeEventListener("nucleus:docs", onDocs);
  }, []);

  const stats = [
    { label: "Sources", value: counts ? String(counts.uploaded + counts.bundled) : null },
    { label: "Your uploads", value: counts ? String(counts.uploaded) : null },
    { label: "High urgency", value: counts ? String(counts.high) : null },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <AppSidebar active="documents" />

      <main className="flex flex-1 flex-col overflow-hidden">
        {/* topbar */}
        <header className="flex items-center justify-between border-b border-line bg-surface px-7 py-4">
          <div>
            <h1 className="font-display text-xl font-bold tracking-tight text-ink">Workspace</h1>
            <p className="text-sm text-faint">
              Your materials and a transparent, cited AI assistant over them.
            </p>
          </div>
          <div className="hidden items-center gap-3 md:flex">
            {stats.map((s) => (
              <div
                key={s.label}
                className="rounded-xl border border-line bg-surface px-4 py-2 text-center shadow-soft"
              >
                <p
                  className="tabular text-lg font-semibold text-ink"
                  data-testid={`stat-${s.label}`}
                >
                  {s.value ?? <span className="text-faint">—</span>}
                </p>
                <p className="text-[10px] font-medium uppercase tracking-wide text-faint">
                  {s.label}
                </p>
              </div>
            ))}
          </div>
        </header>

        {/* the workspace: materials rail + the assistant console */}
        <div className="flex flex-1 gap-5 overflow-hidden p-5">
          {/* left: materials */}
          <div className="hidden w-[420px] shrink-0 lg:block">
            <MaterialsRail />
          </div>

          {/* right: the AI Business Assistant console (resumes ?session=<id> if present) */}
          <div className="flex flex-1 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
            <div className="flex flex-1 flex-col overflow-hidden">
              <Suspense fallback={<AssistantConsole />}>
                <ConsoleWithSession />
              </Suspense>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
