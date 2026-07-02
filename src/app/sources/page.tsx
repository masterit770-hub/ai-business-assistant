"use client";

import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { MaterialsRail } from "@/components/assistant/materials-rail";
import { SpacesSidebar } from "@/components/assistant/spaces-sidebar";
import { ConnectedSources } from "@/components/assistant/connected-sources";

// SOURCES — its own page (lifted out of the cramped dashboard side-rail). The one
// bucket of documents + data the assistant answers from, with the upload control, in a
// roomy centered column. MaterialsRail still publishes `nucleus:docs` so the header
// counts stay live.
//
// KNOWLEDGE SPACES (migration 016): Sources can be filtered by space. The SpacesSidebar
// sits in the left gutter so the user can navigate spaces, and the MaterialsRail shows
// only that space's files. "Entire Workspace" shows all files with SPACE badges.
export default function SourcesPage() {
  const [counts, setCounts] = useState<{ uploaded: number; bundled: number; high: number } | null>(
    null
  );
  // Space state — defaults to no space (shows all uploaded docs, the pre-016 view).
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [globalMode, setGlobalMode] = useState(false);

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

      {/* Spaces sidebar — narrow left gutter between nav and main content */}
      <aside className="flex h-full w-56 shrink-0 flex-col border-r border-line bg-surface px-3 py-4">
        <SpacesSidebar
          activeSpaceId={activeSpaceId}
          onSpaceChange={setActiveSpaceId}
          globalMode={globalMode}
          onGlobalModeChange={(on) => {
            setGlobalMode(on);
            if (on) setActiveSpaceId(null);
          }}
        />
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-line bg-surface px-7 py-4">
          <div>
            <h1 className="font-display text-xl font-bold tracking-tight text-ink">
              {globalMode ? "Sources — Entire Workspace" : activeSpaceId ? "Sources — Space" : "Sources"}
            </h1>
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
            {/* When a specific space is active (not global mode), show the full
                Connected Sources panel (uploaded docs reframed as a named source +
                mocked connector cards). In global/no-space mode, fall back to the
                plain MaterialsRail view (all files across all spaces). */}
            {activeSpaceId && !globalMode ? (
              <ConnectedSources spaceId={activeSpaceId} mode="global" />
            ) : (
              <MaterialsRail
                mode="global"
                spaceId={activeSpaceId}
                globalMode={globalMode}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
