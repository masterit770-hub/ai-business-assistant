"use client";

import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { MaterialsRail } from "@/components/assistant/materials-rail";

// SOURCES — its own page (lifted out of the cramped dashboard side-rail). The one
// bucket of documents + data the assistant answers from, with the upload control, in a
// roomy centered column. MaterialsRail still publishes `nucleus:docs` so the header
// counts stay live.
export default function SourcesPage() {
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
    { label: "High urgency", value: counts ? String(counts.high) : null },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <AppSidebar active="sources" />

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-line bg-surface px-7 py-4">
          <div>
            <h1 className="font-display text-xl font-bold tracking-tight text-ink">Sources</h1>
            <p className="text-sm text-faint">The documents and data your assistant answers from.</p>
          </div>
          <div className="hidden items-center gap-3 md:flex">
            {stats.map((s) => (
              <div
                key={s.label}
                className="rounded-xl border border-line bg-surface px-4 py-2 text-center shadow-soft"
              >
                <p className="tabular text-lg font-semibold text-ink" data-testid={`stat-${s.label}`}>
                  {s.value ?? <span className="text-faint">—</span>}
                </p>
                <p className="text-[10px] font-medium uppercase tracking-wide text-faint">{s.label}</p>
              </div>
            ))}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-6">
          <div className="mx-auto max-w-3xl">
            <MaterialsRail />
          </div>
        </div>
      </main>
    </div>
  );
}
