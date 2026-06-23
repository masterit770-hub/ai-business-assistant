"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MessageSquare, MessageSquarePlus, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

// One conversation SESSION, as returned by GET /api/history (already per-user isolated:
// a member sees only their own sessions). Mirrors the shape history-panel.tsx consumes.
type SessionSummary = {
  session_id: string;
  title: string;
  turn_count: number;
  last_at: string;
};

function when(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// CONVERSATIONS COLUMN — a left-of-chat list of the user's saved conversations, so she
// can SEE and SWITCH between her different chats without digging into the History tab.
// This surfaces the multi-conversation support that already exists (session ids +
// resume-by-?session=ID): "New chat" starts a fresh thread, and each row resumes a past
// one via the SAME ?session= flow the History page uses. The list re-fetches whenever a
// turn lands (the console dispatches `nucleus:session`) so a brand-new conversation
// appears here as soon as its first answer is saved. Per-user — /api/history isolates.
export function ConversationsColumn() {
  const params = useSearchParams();
  const activeSession = params.get("session");

  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/history");
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "failed to load conversations");
      setSessions(d.sessions ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load conversations");
    }
  }

  useEffect(() => {
    load();
    // A new turn was saved (or a fresh session minted) → refresh so the list reflects it
    // and the newly-created conversation shows up without a manual reload.
    const onSession = () => load();
    window.addEventListener("nucleus:session", onSession);
    return () => window.removeEventListener("nucleus:session", onSession);
  }, []);

  return (
    <aside
      data-testid="conversations-column"
      className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex"
    >
      {/* New chat — a prominent, full-width primary action at the top of the column. A
          plain link to /dashboard (no ?session) so the console remounts on a clean slate. */}
      <div className="border-b border-line p-3">
        <Link
          href="/dashboard"
          data-testid="new-chat-link"
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-3 py-2.5 text-sm font-semibold text-accent-fg shadow-soft transition-colors hover:bg-accent-strong",
            !activeSession && "ring-2 ring-accent/20"
          )}
        >
          <MessageSquarePlus className="size-4" strokeWidth={2.2} />
          New chat
        </Link>
      </div>

      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
          Your chats
        </span>
        <button
          onClick={load}
          className="text-faint transition-colors hover:text-ink"
          title="Refresh"
          aria-label="Refresh conversations"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {error && (
          <p data-testid="conversations-error" className="px-2 py-2 text-xs text-high">
            {error}
          </p>
        )}

        {!sessions && !error && (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-faint">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        )}

        {sessions && sessions.length === 0 && !error && (
          <p className="px-2 py-3 text-xs text-faint">
            No conversations yet. Start one with “New chat”.
          </p>
        )}

        {sessions && sessions.length > 0 && (
          <ul className="space-y-0.5">
            {sessions.map((s) => {
              const isActive = s.session_id === activeSession;
              return (
                <li key={s.session_id}>
                  <Link
                    href={`/dashboard?session=${s.session_id}`}
                    data-testid="conversation-item"
                    data-active={isActive ? "true" : "false"}
                    className={cn(
                      "flex items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                      isActive
                        ? "bg-accent-soft text-accent"
                        : "text-subtle hover:bg-muted hover:text-ink"
                    )}
                  >
                    <MessageSquare
                      className={cn("mt-0.5 size-4 shrink-0", isActive ? "text-accent" : "text-faint")}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium" title={s.title}>
                        {s.title}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-faint">
                        {when(s.last_at)} · {s.turn_count} turn{s.turn_count === 1 ? "" : "s"}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
