"use client";

import { useCallback, useEffect, useState } from "react";
import { X, Download, Loader2, ChevronLeft, ChevronRight } from "lucide-react";

// The structured-table VIEWER — a modal that opens off a [S]-table row in the
// materials rail so a "Table · 760 rows" source is no longer a black box. It reads
// real columns + a page of rows from GET /api/table (the introspected store, owner-
// scoped + hidden-source-aware), pages through them, and offers a CSV export of the
// same /api/table endpoint (?format=csv). Reuses the rail's semantic tokens
// (bg-surface / border-line / text-ink / text-faint / text-accent) so it matches.

type Column = { name: string; type: string };
type Page = {
  table: string;
  kind: "bundled" | "uploaded";
  columns: Column[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

const PAGE_SIZE = 50;

export function TableViewer({
  table,
  label,
  onClose,
}: {
  table: string;
  label: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (off: number) => {
      setLoading(true);
      setError(null);
      try {
        const q = new URLSearchParams({
          table,
          limit: String(PAGE_SIZE),
          offset: String(off),
        });
        const res = await fetch(`/api/table?${q.toString()}`);
        const d = await res.json();
        if (!res.ok) throw new Error(d?.error ?? "failed to load table");
        setPage(d as Page);
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to load table");
        setPage(null);
      } finally {
        setLoading(false);
      }
    },
    [table]
  );

  useEffect(() => {
    load(offset);
  }, [load, offset]);

  // Close on Escape (a real modal affordance).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function exportCsv() {
    // Stream the CSV straight from the endpoint (attachment) in a new tab/download.
    const q = new URLSearchParams({ table, format: "csv" });
    window.open(`/api/table?${q.toString()}`, "_blank", "noopener");
  }

  const columns = page?.columns ?? [];
  const rows = page?.rows ?? [];
  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + rows.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Table ${label}`}
      data-testid="table-viewer"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-soft"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{label}</p>
            <p className="text-[11px] text-faint">
              {total.toLocaleString("en-US")} row{total === 1 ? "" : "s"} · {columns.length}{" "}
              column{columns.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportCsv}
              data-testid="table-export-csv"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-accent-soft hover:text-accent"
            >
              <Download className="size-3.5" />
              Export CSV
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              data-testid="table-viewer-close"
              className="inline-flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-5 py-12 text-sm text-faint">
              <Loader2 className="size-4 animate-spin" />
              Loading rows…
            </div>
          ) : error ? (
            <p className="px-5 py-12 text-center text-sm text-high">Couldn’t load table: {error}</p>
          ) : rows.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-faint">This table has no rows.</p>
          ) : (
            <table className="w-full border-collapse text-left text-xs" data-testid="table-viewer-grid">
              <thead className="sticky top-0 bg-surface-2">
                <tr>
                  {columns.map((c) => (
                    <th
                      key={c.name}
                      className="whitespace-nowrap border-b border-line px-3 py-2 font-semibold text-subtle"
                      title={c.type}
                    >
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                    {columns.map((c) => {
                      const v = row[c.name];
                      return (
                        <td
                          key={c.name}
                          className="max-w-[20rem] truncate px-3 py-1.5 text-ink"
                          title={v == null ? "" : String(v)}
                        >
                          {v == null || v === "" ? (
                            <span className="text-faint">—</span>
                          ) : (
                            String(v)
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer / paging */}
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-2.5">
          <span className="text-[11px] text-faint" data-testid="table-viewer-range">
            {from}–{to} of {total.toLocaleString("en-US")}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={loading || offset === 0}
              data-testid="table-viewer-prev"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-faint transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronLeft className="size-3.5" />
              Prev
            </button>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={loading || !page?.hasMore}
              data-testid="table-viewer-next"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-faint transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Next
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
