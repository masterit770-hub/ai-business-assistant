"use client";

import { useEffect, useState } from "react";
import { Loader2, AlertCircle, RefreshCw, ChevronDown, History, FileText, Database } from "lucide-react";
import { cn } from "@/lib/utils";

// One persisted ask, as returned by GET /api/history. `citations` is the payload the
// /api/ask logger wrote: { tokens, sources }. `route` is the router decision. For an
// admin cross-user view, owner_id/owner_email are present.
type HistoryCitations = { tokens?: string[]; sources?: string[] } | null;
type HistoryRoute = { sources?: string[]; rationale?: string; docFilter?: string | null } | null;
type HistoryItem = {
  id: string;
  question: string;
  answer: string;
  mode: string | null;
  citations: HistoryCitations;
  route: HistoryRoute;
  created_at: string;
  owner_id?: string;
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

// The unique source/citation tokens to show as pills for one row: prefer the citation
// tokens the answer actually showed; fall back to the retrieved sources. A [S:...]
// token is structured (database), a [P:...] token is a document page.
function rowSources(item: HistoryItem): string[] {
  const c = item.citations ?? {};
  const tokens = (c.tokens?.length ? c.tokens : c.sources) ?? [];
  return [...new Set(tokens)];
}

export function HistoryPanel({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  async function load() {
    try {
      const res = await fetch("/api/history");
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "failed to load history");
      setItems(d.items ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load history");
    }
  }
  useEffect(() => {
    load();
  }, []);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="rounded-2xl border border-line bg-surface shadow-soft" data-testid="history-panel">
      <div className="flex items-center gap-3 border-b border-line px-6 py-4">
        <History className="size-4 text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-semibold text-ink">
            {isAdmin ? "All questions" : "Your questions"}
          </h2>
          <p className="text-sm text-faint">
            {items ? `${items.length} ask${items.length === 1 ? "" : "s"}` : "Loading…"}
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

      {!items && !error && (
        <div className="flex items-center gap-2 px-6 py-10 text-sm text-faint">
          <Loader2 className="size-4 animate-spin" /> Loading your history…
        </div>
      )}

      {items && items.length === 0 && !error && (
        <div className="px-6 py-12 text-center">
          <p className="text-sm text-faint">No questions yet — ask something on the dashboard.</p>
        </div>
      )}

      {items && items.length > 0 && (
        <ul className="divide-y divide-line">
          {items.map((item) => {
            const isOpen = open.has(item.id);
            const sources = rowSources(item);
            const grounded = item.mode === "grounded";
            return (
              <li key={item.id} data-testid="history-row" className="px-6 py-4">
                <button
                  onClick={() => toggle(item.id)}
                  className="flex w-full items-start gap-3 text-left"
                  data-testid="history-toggle"
                >
                  <ChevronDown
                    className={cn(
                      "mt-1 size-4 shrink-0 text-faint transition-transform",
                      isOpen && "rotate-180"
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-ink" title={item.question}>
                      {item.question}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
                      <span className="tabular">{when(item.created_at)}</span>
                      <span>·</span>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2 py-0.5 font-medium",
                          grounded
                            ? "border-accent-ring bg-accent-soft text-accent"
                            : "border-line bg-muted text-faint"
                        )}
                      >
                        {item.mode ?? "—"}
                      </span>
                      {isAdmin && item.owner_email && (
                        <>
                          <span>·</span>
                          <span className="truncate" title={item.owner_email}>
                            {item.owner_email}
                          </span>
                        </>
                      )}
                    </div>

                    {/* sources / citations used */}
                    {sources.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5" data-testid="history-sources">
                        {sources.map((tok) => {
                          const isDoc = tok.startsWith("[P:");
                          return (
                            <span
                              key={tok}
                              className="inline-flex items-center gap-1 rounded-md border border-line bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-subtle"
                            >
                              {isDoc ? (
                                <FileText className="size-3 text-faint" />
                              ) : (
                                <Database className="size-3 text-faint" />
                              )}
                              {tok}
                            </span>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-faint">
                        No sources cited — answered from general knowledge.
                      </p>
                    )}
                  </div>
                </button>

                {/* expanded: the full answer */}
                {isOpen && (
                  <div className="mt-3 ml-7 rounded-xl border border-line bg-canvas px-4 py-3" data-testid="history-answer">
                    {item.route?.rationale && (
                      <p className="mb-2 text-xs italic text-faint">{item.route.rationale}</p>
                    )}
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
                      {item.answer}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
