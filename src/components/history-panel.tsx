"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  AlertCircle,
  RefreshCw,
  History,
  MessageSquare,
  ArrowRight,
  Pencil,
  Trash2,
  Check,
  X,
} from "lucide-react";
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
  // Per-row UI state. `editing` = the session_id whose title is being inline-edited;
  // `draft` = its in-progress text. `confirmDelete` = the session_id awaiting a delete
  // confirm. `busy` = the session_id of an in-flight rename/delete (disables its row).
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

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

  function startRename(s: SessionSummary) {
    setRowError(null);
    setConfirmDelete(null);
    setEditing(s.session_id);
    setDraft(s.title);
  }
  function cancelRename() {
    setEditing(null);
    setDraft("");
  }

  // Persist a rename via PATCH, then refresh the list so the new title is authoritative
  // (the server prefers the override). A blank/unchanged title just closes the editor.
  async function saveRename(s: SessionSummary) {
    const title = draft.trim();
    if (!title || title === s.title) {
      cancelRename();
      return;
    }
    setBusy(s.session_id);
    setRowError(null);
    try {
      const res = await fetch(`/api/history/${s.session_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "rename failed");
      cancelRename();
      await load();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : "rename failed");
    } finally {
      setBusy(null);
    }
  }

  // Delete a conversation (after the inline confirm), then refresh the list.
  async function doDelete(s: SessionSummary) {
    setBusy(s.session_id);
    setRowError(null);
    try {
      const res = await fetch(`/api/history/${s.session_id}`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "delete failed");
      setConfirmDelete(null);
      await load();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : "delete failed");
    } finally {
      setBusy(null);
    }
  }

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

      {(error || rowError) && (
        <div
          data-testid="history-error"
          className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-6 py-3 text-sm text-red-700"
        >
          <AlertCircle className="size-4" />
          {error ?? rowError}
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
          {sessions.map((s) => {
            const isEditing = editing === s.session_id;
            const isConfirming = confirmDelete === s.session_id;
            const isBusy = busy === s.session_id;
            return (
              <li key={s.session_id} data-testid="history-row" className="group/row">
                <div className="flex items-center gap-2 px-6 py-4 transition-colors hover:bg-surface-2">
                  <MessageSquare className="size-4 shrink-0 text-faint" />

                  {isEditing ? (
                    // ── INLINE RENAME — edit the conversation's title, then save/cancel ──
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveRename(s);
                          if (e.key === "Escape") cancelRename();
                        }}
                        maxLength={200}
                        disabled={isBusy}
                        data-testid="rename-input"
                        aria-label="Conversation title"
                        className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
                      />
                      <button
                        type="button"
                        onClick={() => saveRename(s)}
                        disabled={isBusy}
                        data-testid="rename-save"
                        title="Save title"
                        className="rounded-md p-1.5 text-accent hover:bg-accent-soft disabled:opacity-50"
                      >
                        {isBusy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                      </button>
                      <button
                        type="button"
                        onClick={cancelRename}
                        disabled={isBusy}
                        data-testid="rename-cancel"
                        title="Cancel"
                        className="rounded-md p-1.5 text-faint hover:bg-surface-2 hover:text-ink disabled:opacity-50"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  ) : (
                    <>
                      {/* clicking a session navigates to the chat with it loaded + continuable */}
                      <Link
                        href={`/dashboard?session=${s.session_id}`}
                        data-testid="resume-session"
                        className="group flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
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
                        <span className="hidden items-center gap-1 text-xs font-medium text-faint transition-colors group-hover:text-accent sm:flex">
                          Resume
                          <ArrowRight className="size-3.5" />
                        </span>
                      </Link>

                      {/* ── ROW ACTIONS — rename + delete (with an inline confirm) ── */}
                      {isConfirming ? (
                        <div className="flex shrink-0 items-center gap-2" data-testid="delete-confirm">
                          <span className="text-xs font-medium text-red-700">Delete?</span>
                          <button
                            type="button"
                            onClick={() => doDelete(s)}
                            disabled={isBusy}
                            data-testid="delete-confirm-yes"
                            className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                          >
                            {isBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(null)}
                            disabled={isBusy}
                            data-testid="delete-confirm-no"
                            className="rounded-md px-2 py-1 text-xs font-medium text-faint hover:bg-surface-2 hover:text-ink disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex shrink-0 items-center gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover/row:opacity-100">
                          <button
                            type="button"
                            onClick={() => startRename(s)}
                            disabled={isBusy}
                            data-testid="rename-button"
                            title="Rename conversation"
                            aria-label="Rename conversation"
                            className="rounded-md p-1.5 text-faint hover:bg-surface-2 hover:text-ink disabled:opacity-50"
                          >
                            <Pencil className="size-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRowError(null);
                              setEditing(null);
                              setConfirmDelete(s.session_id);
                            }}
                            disabled={isBusy}
                            data-testid="delete-button"
                            title="Delete conversation"
                            aria-label="Delete conversation"
                            className="rounded-md p-1.5 text-faint hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
