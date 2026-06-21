"use client";

import { useEffect, useState } from "react";
import { FileText, Database, Download, Trash2, Loader2 } from "lucide-react";

type BundledSource = {
  doc: string;
  label: string;
  kind: "document" | "structured";
  detail: string;
};

// The "Built-in business data" section — the REAL source documents the engine
// answers from (the bundled corpus behind the [S:...]/[P:...] citations), pulled
// live from /api/documents. So what the user SEES matches what the assistant can
// ANSWER from. Reports its count via `nucleus:bundled` so the stat cards include
// it in the real total.
export function BundledDocs() {
  const [sources, setSources] = useState<BundledSource[] | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  function load() {
    fetch("/api/documents")
      .then((r) => r.json())
      .then((d) => {
        const b: BundledSource[] = d.bundled ?? [];
        setSources(b);
        setRole(d.role ?? null);
        window.dispatchEvent(new CustomEvent("nucleus:bundled", { detail: { count: b.length } }));
      })
      .catch(() => setSources([]));
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(s: BundledSource) {
    if (
      !confirm(
        `Remove the built-in source “${s.label}”? It will no longer be used in answers for the whole workspace.`
      )
    )
      return;
    setRemoving(s.doc);
    try {
      const q = new URLSearchParams({ doc: s.doc, scope: "bundled", kind: s.kind });
      const res = await fetch(`/api/documents?${q.toString()}`, { method: "DELETE" });
      if (res.ok) load();
    } finally {
      setRemoving(null);
    }
  }

  if (!sources || sources.length === 0) return null;

  return (
    <div
      className="overflow-hidden rounded-xl border border-line bg-surface shadow-soft"
      data-testid="bundled-docs"
    >
      <div className="flex items-center justify-between border-b border-line bg-canvas/60 px-5 py-2.5">
        <span className="text-xs font-semibold text-faint">
          Built-in business data · {sources.length}
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wide text-faint">
          included with the demo
        </span>
      </div>
      <table className="w-full border-collapse text-sm">
        <tbody>
          {sources.map((s) => (
            <tr
              key={s.doc}
              data-testid={`bundled-row-${s.doc}`}
              className="border-b border-line last:border-0 hover:bg-canvas/50"
            >
              <td className="px-5 py-3">
                <span className="inline-flex items-center gap-2 font-medium text-ink">
                  {s.kind === "structured" ? (
                    <Database className="size-4 text-accent" />
                  ) : (
                    <FileText className="size-4 text-accent" />
                  )}
                  {s.label}
                </span>
              </td>
              <td className="px-5 py-3 text-right text-xs text-faint">{s.detail}</td>
              <td className="px-4 py-3 text-right whitespace-nowrap">
                {s.kind === "document" && (
                  <a
                    href={`/api/documents/file?doc=${encodeURIComponent(s.doc)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`bundled-download-${s.doc}`}
                    title="Open / download"
                    className="mr-1 inline-flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
                  >
                    <Download className="size-4" />
                  </a>
                )}
                {role === "admin" && (
                  <button
                    onClick={() => remove(s)}
                    disabled={removing === s.doc}
                    data-testid={`bundled-remove-${s.doc}`}
                    title="Remove built-in source (admin)"
                    className="inline-flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  >
                    {removing === s.doc ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
