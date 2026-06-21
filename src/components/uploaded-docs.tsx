"use client";

import { useEffect, useState } from "react";
import { FileText, RefreshCw, Trash2, Loader2, Download } from "lucide-react";
import { UrgencyBadge } from "@/components/urgency-badge";
import type { Urgency } from "@/lib/mock";

type DocMeta = { doc: string; label: string; urgency: Urgency | null };

// The REAL uploaded documents, with their LLM-classified urgency badge + a remove
// action. Fetches the engine (via the Nucleus proxy) so the dashboard reflects
// what's actually been ingested — not mock rows. Re-fetches on the
// `nucleus:uploaded` event; reports its count via `nucleus:docs` so the stat
// cards stay in sync. `filter` narrows the list (wired to the search box).
export function UploadedDocs({ filter = "" }: { filter?: string }) {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/documents");
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "failed to load documents");
      const list: DocMeta[] = d.documents ?? [];
      setDocs(list);
      setError(null);
      // Publish counts for the stat cards.
      window.dispatchEvent(
        new CustomEvent("nucleus:docs", {
          detail: { total: list.length, high: list.filter((x) => x.urgency === "high").length },
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load documents");
    }
  }

  useEffect(() => {
    load();
    const onUploaded = () => load();
    window.addEventListener("nucleus:uploaded", onUploaded);
    return () => window.removeEventListener("nucleus:uploaded", onUploaded);
  }, []);

  async function remove(doc: string, label: string) {
    if (!confirm(`Remove “${label}”? It will no longer be searchable.`)) return;
    setRemoving(doc);
    try {
      const res = await fetch(`/api/documents?doc=${encodeURIComponent(doc)}`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "remove failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "remove failed");
    } finally {
      setRemoving(null);
    }
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        Couldn’t load uploaded documents: {error}
      </div>
    );
  }
  if (!docs) return null;

  const shown = filter.trim()
    ? docs.filter((d) => d.label.toLowerCase().includes(filter.trim().toLowerCase()))
    : docs;

  if (docs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-canvas px-4 py-3 text-sm text-faint">
        No uploaded documents yet. Use Upload to ingest a PDF, CSV, or Excel file —
        it’ll appear here with a real urgency badge and be answerable in Ask.
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-xl border border-line bg-surface shadow-soft"
      data-testid="uploaded-docs"
    >
      <div className="flex items-center justify-between border-b border-line bg-canvas/60 px-5 py-2.5">
        <span className="text-xs font-semibold text-faint">
          Your uploaded documents · {shown.length}
          {filter.trim() && shown.length !== docs.length ? ` of ${docs.length}` : ""}
        </span>
        <button
          onClick={load}
          className="inline-flex items-center gap-1 text-xs text-faint hover:text-ink"
          title="Refresh"
        >
          <RefreshCw className="size-3" />
          Refresh
        </button>
      </div>
      {shown.length === 0 ? (
        <div className="px-5 py-4 text-sm text-faint">No documents match “{filter}”.</div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <tbody>
            {shown.map((d) => (
              <tr
                key={d.doc}
                data-testid={`doc-row-${d.doc}`}
                className="border-b border-line last:border-0 hover:bg-canvas/50"
              >
                <td className="px-5 py-3">
                  <span className="inline-flex items-center gap-2 font-medium text-ink">
                    <FileText className="size-4 text-accent" />
                    {d.label}
                  </span>
                </td>
                <td className="px-3 py-3 text-right">
                  {d.urgency ? (
                    <span data-testid={`doc-urgency-${d.doc}`}>
                      <UrgencyBadge urgency={d.urgency} />
                    </span>
                  ) : (
                    <span className="text-xs text-faint">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <a
                    href={`/api/documents/file?doc=${encodeURIComponent(d.doc)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`doc-download-${d.doc}`}
                    title="Open / download"
                    className="mr-1 inline-flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
                  >
                    <Download className="size-4" />
                  </a>
                  <button
                    onClick={() => remove(d.doc, d.label)}
                    disabled={removing === d.doc}
                    data-testid={`doc-remove-${d.doc}`}
                    title="Remove document"
                    className="inline-flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  >
                    {removing === d.doc ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
