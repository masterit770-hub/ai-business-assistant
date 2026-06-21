"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, AlertCircle, RefreshCw, History, MessageSquare, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

// One conversation SESSION, as returned by GET /api/history. The title is the first
// turn's question; turn_count/last_at summarise the thread. For an admin cross-user
// view, owner_email is present. Clicking a session resumes it on the dashboard.
type SessionSummary = {
  session_id: string;
  title: string;
  turn_count: number;
  last_at: string;
  owner_email?: string | null;
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
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function HistoryPanel({ isAdmin }: { isAdmin: boolean }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/history");
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "failed to load history");
      setSessions(d.sessions ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load history");
    }
  }
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="rounded-2xl border border-line bg-surface shadow-soft" data-testid="history-panel">
      <div className="flex items-center gap-3 border-b border-line px-6 py-4">
        <History className="size-4 text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-semibold text-ink">
            {isAdmin ? "All conversations" : "Your conversations"}
          </h2>
          <p className="text-sm text-faint">
            {sessions
              ? `${sessions.length} conversation${sessions.length === 1 ? "" : "s"}`
              : "Loading…"}
          </p>
        </div>
        <button onClick={load} className="text-faint hover:text-ink" title="Refresh">
          <RefreshCw className="size-4" />
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-6 py-3 text-sm text-red-700">
          <AlertCircle className="size-4" />
          {error}
        </div>
      )}

      {!sessions && !error && (
        <div className="flex items-center gap-2 px-6 py-10 text-sm text-faint">
          <Loader2 className="size-4 animate-spin" /> Loading your conversations…
        </div>
      )}

      {sessions && sessions.length === 0 && !error && (
        <div className="px-6 py-12 text-center">
          <p className="text-sm text-faint">No conversations yet — ask something on the dashboard.</p>
        </div>
      )}

      {sessions && sessions.length > 0 && (
        <ul className="divide-y divide-line">
          {sessions.map((s) => (
            <li key={s.session_id} data-testid="history-row">
              {/* clicking a session navigates to the chat with it loaded + continuable */}
              <Link
                href={`/dashboard?session=${s.session_id}`}
                data-testid="resume-session"
                className="group flex w-full items-center gap-3 px-6 py-4 text-left transition-colors hover:bg-surface-2"
              >
                <MessageSquare className="mt-0.5 size-4 shrink-0 text-faint" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink" title={s.title}>
                    {s.title}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
                    <span className="tabular">{when(s.last_at)}</span>
                    <span>·</span>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-2 py-0.5 font-medium",
                        "border-accent-ring bg-accent-soft text-accent"
                      )}
                    >
                      {s.turn_count} turn{s.turn_count === 1 ? "" : "s"}
                    </span>
                    {isAdmin && s.owner_email && (
                      <>
                        <span>·</span>
                        <span className="truncate" title={s.owner_email}>
                          {s.owner_email}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <span className="flex items-center gap-1 text-xs font-medium text-faint transition-colors group-hover:text-accent">
                  Resume
                  <ArrowRight className="size-3.5" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
