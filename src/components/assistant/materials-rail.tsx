"use client";

import { useEffect, useState } from "react";
import { FileText, Database, Trash2, Loader2, RefreshCw } from "lucide-react";
import { UploadButton } from "@/components/upload-button";
import { UrgencyBadge } from "@/components/urgency-badge";
import type { Urgency } from "@/lib/mock";

type DocMeta = { doc: string; label: string; urgency: Urgency | null };
type BundledSource = {
  doc: string;
  label: string;
  kind: "document" | "structured";
  detail: string;
};

// The "Your materials" rail — the real sources the assistant can answer from, with
// the upload control. Each item carries a [P] (document) or [S] (structured) chip so
// it visibly maps to the citation tokens the answers use. Real data from
// /api/documents (owner-scoped uploads + the bundled corpus). Publishes counts on
// `nucleus:docs` / `nucleus:bundled` so the dashboard stat cards stay in sync.
export function MaterialsRail() {
  const [uploaded, setUploaded] = useState<DocMeta[] | null>(null);
  const [bundled, setBundled] = useState<BundledSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/documents");
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "failed to load");
      const docs: DocMeta[] = d.documents ?? [];
      const b: BundledSource[] = d.bundled ?? [];
      setUploaded(docs);
      setBundled(b);
      setError(null);
      window.dispatchEvent(
        new CustomEvent("nucleus:docs", {
          detail: { total: docs.length, high: docs.filter((x) => x.urgency === "high").length },
        })
      );
      window.dispatchEvent(new CustomEvent("nucleus:bundled", { detail: { count: b.length } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
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

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto" data-testid="materials-rail">
      {/* ADD SOURCES */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            Add sources
          </span>
          <button
            onClick={load}
            className="inline-flex items-center gap-1 text-[11px] text-faint hover:text-ink"
            title="Refresh"
          >
            <RefreshCw className="size-3" />
            Refresh
          </button>
        </div>
        <div className="mt-3 rounded-xl border border-dashed border-line bg-surface-2 px-4 py-5 text-center">
          <p className="text-sm font-medium text-ink">Upload PDF or spreadsheet</p>
          <p className="mt-1 text-xs text-faint">PDFs, scanned docs, CSV or Excel</p>
          <div className="mt-3 flex justify-center">
            <UploadButton />
          </div>
        </div>
        {error && (
          <p className="mt-2 text-xs text-high">Couldn’t load materials: {error}</p>
        )}
      </div>

      {/* YOUR MATERIALS — uploads */}
      <div className="rounded-2xl border border-line bg-surface shadow-soft" data-testid="uploaded-docs">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            Your materials
          </span>
          <span className="text-[11px] text-faint">{uploaded?.length ?? 0} uploaded</span>
        </div>
        {uploaded === null ? (
          <p className="px-4 py-4 text-xs text-faint">Loading…</p>
        ) : uploaded.length === 0 ? (
          <p className="px-4 py-4 text-xs text-faint">
            No uploads yet. Upload a PDF, CSV, or Excel — it appears here with a [P]/[S] chip and
            is answerable instantly.
          </p>
        ) : (
          <ul>
            {uploaded.map((d) => (
              <li
                key={d.doc}
                data-testid={`doc-row-${d.doc}`}
                className="flex items-center gap-2 border-b border-line px-4 py-2.5 last:border-0"
              >
                <SourceChip kind="document" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{d.label}</span>
                {d.urgency && (
                  <span data-testid={`doc-urgency-${d.doc}`}>
                    <UrgencyBadge urgency={d.urgency} />
                  </span>
                )}
                <button
                  onClick={() => remove(d.doc, d.label)}
                  disabled={removing === d.doc}
                  data-testid={`doc-remove-${d.doc}`}
                  title="Remove"
                  className="inline-flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-high-soft hover:text-high disabled:opacity-50"
                >
                  {removing === d.doc ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* BUILT-IN business data */}
      {bundled && bundled.length > 0 && (
        <div className="rounded-2xl border border-line bg-surface shadow-soft" data-testid="bundled-docs">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              Built-in business data
            </span>
            <span className="text-[11px] text-faint">{bundled.length} sources</span>
          </div>
          <ul>
            {bundled.map((s) => (
              <li
                key={s.doc}
                data-testid={`bundled-row-${s.doc}`}
                className="flex items-center gap-2 border-b border-line px-4 py-2.5 last:border-0"
              >
                <SourceChip kind={s.kind} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{s.label}</span>
                <span className="shrink-0 text-[11px] text-faint">{s.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// The [S] (structured) / [P] (document) chip mirroring the citation namespaces.
function SourceChip({ kind }: { kind: "document" | "structured" }) {
  const isStructured = kind === "structured";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-accent-ring bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent"
      title={isStructured ? "Structured (SQL) source — [S:…] citations" : "Document source — [P:…] citations"}
    >
      {isStructured ? <Database className="size-3" /> : <FileText className="size-3" />}
      {isStructured ? "S" : "P"}
    </span>
  );
}
