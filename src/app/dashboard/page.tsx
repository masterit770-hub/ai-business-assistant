"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AssistantConsole } from "@/components/assistant/assistant-console";
import { UnifiedSidebar } from "@/components/assistant/unified-sidebar";

// Reads the ?session=<id> param (set when a user resumes a conversation from /history or
// the conversations column) and hands it to the console so it loads that thread. Wrapped
// in Suspense because useSearchParams suspends during prerender.
function ConsoleWithSession({
  activeSpaceId,
  globalMode,
}: {
  activeSpaceId?: string | null;
  globalMode?: boolean;
}) {
  const params = useSearchParams();
  const sessionId = params.get("session") ?? undefined;
  // `key` so navigating to a different session (or back to none) remounts the console
  // and re-runs its resume/clear logic from a clean slate.
  return (
    <AssistantConsole
      key={sessionId ?? "new"}
      initialSessionId={sessionId}
      activeSpaceId={activeSpaceId}
      globalMode={globalMode}
    />
  );
}

// CHAT — the assistant, now its OWN full-width page (Sources moved to /sources). A light
// context line shows how many documents the assistant can draw on, linking to Sources.
export default function DashboardPage() {
  const [docCount, setDocCount] = useState<number | null>(null);
  // Knowledge Spaces state — lifted here so sidebar + console share it.
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [globalMode, setGlobalMode] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/documents")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setDocCount((d.documents?.length ?? 0) + (d.bundled?.length ?? 0));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Suspense fallback={null}>
        <UnifiedSidebar
          active="chat"
          activeSpaceId={activeSpaceId}
          onSpaceChange={setActiveSpaceId}
          globalMode={globalMode}
          onGlobalModeChange={setGlobalMode}
        />
      </Suspense>

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="border-b border-line bg-surface px-7 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="font-display text-xl font-bold tracking-tight text-ink">
                {globalMode
                  ? "Chat — Entire Workspace"
                  : activeSpaceId
                  ? "Chat — Space"
                  : "Chat"}
              </h1>
              <p className="text-sm text-faint">
                {docCount === null ? (
                  "Your transparent, cited AI assistant."
                ) : (
                  <>
                    Answering from{" "}
                    <span className="font-medium text-ink" data-testid="chat-source-count">
                      {docCount} {docCount === 1 ? "source" : "sources"}
                    </span>{" "}
                    in your knowledge base.{" "}
                    <Link href="/sources" className="font-medium text-accent hover:underline">
                      Manage sources
                    </Link>
                  </>
                )}
              </p>
            </div>
            {/* Global Search toggle in the header */}
            <button
              type="button"
              onClick={() => {
                const next = !globalMode;
                setGlobalMode(next);
                if (next) setActiveSpaceId(null);
              }}
              data-testid="header-global-toggle"
              className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
                globalMode
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-line bg-surface text-subtle hover:border-accent-ring hover:text-ink"
              }`}
            >
              {globalMode ? "Searching: Entire Workspace" : "Search entire workspace"}
            </button>
          </div>
        </header>

        {/* a roomy, single centered column */}
        <div className="flex flex-1 overflow-hidden p-5">
          <div className="mx-auto flex w-full max-w-4xl flex-1 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
            <div className="flex flex-1 flex-col overflow-hidden">
              <Suspense
                fallback={
                  <AssistantConsole activeSpaceId={activeSpaceId} globalMode={globalMode} />
                }
              >
                <ConsoleWithSession
                  activeSpaceId={activeSpaceId}
                  globalMode={globalMode}
                />
              </Suspense>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
