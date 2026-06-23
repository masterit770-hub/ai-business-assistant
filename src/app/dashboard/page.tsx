"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { AssistantConsole } from "@/components/assistant/assistant-console";
import { ConversationsColumn } from "@/components/assistant/conversations-column";

// Reads the ?session=<id> param (set when a user resumes a conversation from /history or
// the conversations column) and hands it to the console so it loads that thread. Wrapped
// in Suspense because useSearchParams suspends during prerender.
function ConsoleWithSession() {
  const params = useSearchParams();
  const sessionId = params.get("session") ?? undefined;
  // `key` so navigating to a different session (or back to none) remounts the console
  // and re-runs its resume/clear logic from a clean slate.
  return <AssistantConsole key={sessionId ?? "new"} initialSessionId={sessionId} />;
}

// CHAT — the assistant, now its OWN full-width page (Sources moved to /sources). A light
// context line shows how many documents the assistant can draw on, linking to Sources.
export default function DashboardPage() {
  const [docCount, setDocCount] = useState<number | null>(null);

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
      <AppSidebar active="chat" />

      {/* the user's conversations — a list/column to see + switch between her chats,
          plus a prominent New chat action (reuses the ?session= resume flow). */}
      <Suspense fallback={null}>
        <ConversationsColumn />
      </Suspense>

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="border-b border-line bg-surface px-7 py-4">
          <h1 className="font-display text-xl font-bold tracking-tight text-ink">Chat</h1>
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
        </header>

        {/* a roomy, single centered column — less dense than the old side-by-side */}
        <div className="flex flex-1 overflow-hidden p-5">
          <div className="mx-auto flex w-full max-w-4xl flex-1 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
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
