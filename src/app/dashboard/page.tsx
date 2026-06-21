"use client";

import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { AssistantConsole } from "@/components/assistant/assistant-console";
import { MaterialsRail } from "@/components/assistant/materials-rail";

export default function DashboardPage() {
  // Real stats from /api/documents (published by MaterialsRail): uploaded count +
  // high-urgency (`nucleus:docs`) and the bundled source count (`nucleus:bundled`).
  // "Sources" = the REAL total (bundled + uploaded).
  const [uploaded, setUploaded] = useState<{ total: number; high: number } | null>(null);
  const [bundled, setBundled] = useState<number | null>(null);

  useEffect(() => {
    const onDocs = (e: Event) => setUploaded((e as CustomEvent).detail);
    const onBundled = (e: Event) => setBundled((e as CustomEvent).detail.count);
    window.addEventListener("nucleus:docs", onDocs);
    window.addEventListener("nucleus:bundled", onBundled);
    return () => {
      window.removeEventListener("nucleus:docs", onDocs);
      window.removeEventListener("nucleus:bundled", onBundled);
    };
  }, []);

  const total = uploaded !== null && bundled !== null ? uploaded.total + bundled : null;
  const stats = [
    { label: "Sources", value: total !== null ? String(total) : null },
    { label: "Your uploads", value: uploaded ? String(uploaded.total) : null },
    { label: "High urgency", value: uploaded ? String(uploaded.high) : null },
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
          <div className="hidden w-[340px] shrink-0 lg:block">
            <MaterialsRail />
          </div>

          {/* right: the AI Business Assistant console */}
          <div className="flex flex-1 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
            <div className="flex flex-1 flex-col overflow-hidden">
              <AssistantConsole />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
