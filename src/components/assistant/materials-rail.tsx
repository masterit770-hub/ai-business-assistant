"use client";

import { useEffect, useState } from "react";
import { FileText, Database, Trash2, Loader2, RefreshCw, Download, Table } from "lucide-react";
import { UploadButton } from "@/components/upload-button";
import { UrgencyBadge } from "@/components/urgency-badge";
import { TableViewer } from "@/components/assistant/table-viewer";
import type { Urgency } from "@/lib/mock";

type DocLang = "en" | "he" | null;
type DocMeta = { doc: string; label: string; urgency: Urgency | null; lang?: DocLang };
type BundledSource = {
  doc: string;
  label: string;
  kind: "document" | "structured";
  detail: string;
  lang?: DocLang;
};

// Fallback language guess for an uploaded doc when the server didn't supply a
// content-detected language (older rows / Supabase off): infer from the label.
// PREFER the server's `lang` (detected from the doc's REAL indexed text) — a Hebrew
// invoice named "hebrew-invoice.pdf" must read HE from its content, not EN from its
// Latin filename. Hebrew letters → "he", Latin → "en", neither → null (chip omitted).
function labelLang(label: string): DocLang {
  if (/[֐-׿]/.test(label)) return "he";
  if (/[A-Za-z]/.test(label)) return "en";
  return null;
}

// The "Your materials" rail — the real sources the assistant can answer from, with
// the upload control. Each item carries a [P] (document) or [S] (structured) chip so
// it visibly maps to the citation tokens the answers use. Real data from
// /api/documents (owner-scoped uploads + the bundled corpus). Publishes counts on
// `nucleus:docs` / `nucleus:bundled` so the dashboard stat cards stay in sync.
export function MaterialsRail() {
  const [uploaded, setUploaded] = useState<DocMeta[] | null>(null);
  const [bundled, setBundled] = useState<BundledSource[] | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // The structured table currently open in the viewer (FIX 1), or null.
  const [viewing, setViewing] = useState<{ table: string; label: string } | null>(null);
  // Retrievability of each UPLOADED doc's original file, probed via HEAD (FIX 3):
  // undefined = unknown/checking, true = downloadable, false = no stored original.
  const [retrievable, setRetrievable] = useState<Record<string, boolean>>({});

  async function load() {
    try {
      const res = await fetch("/api/documents");
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "failed to load");
      const docs: DocMeta[] = d.documents ?? [];
      const b: BundledSource[] = d.bundled ?? [];
      setUploaded(docs);
      setBundled(b);
      setRole(d.role ?? null);
      setError(null);
      // Probe each uploaded doc's original-file retrievability (FIX 3) so the rail only
      // offers a download for docs whose original is actually stored — never a dead 404.
      probeRetrievability(docs);
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

  // For each uploaded doc, HEAD /api/documents/file to learn whether its original is
  // retrievable. 200 → show download; 404 → no stored original (show a clear tooltip,
  // not a dead link). Bundled docs always have a committed original, so we don't probe.
  async function probeRetrievability(docs: DocMeta[]) {
    await Promise.all(
      docs.map(async (d) => {
        try {
          const res = await fetch(`/api/documents/file?doc=${encodeURIComponent(d.doc)}`, {
            method: "HEAD",
          });
          setRetrievable((m) => ({ ...m, [d.doc]: res.ok }));
        } catch {
          setRetrievable((m) => ({ ...m, [d.doc]: false }));
        }
      })
    );
  }

  useEffect(() => {
    load();
    const onUploaded = () => load();
    window.addEventListener("nucleus:uploaded", onUploaded);
    return () => window.removeEventListener("nucleus:uploaded", onUploaded);
  }, []);

  async function remove(
    doc: string,
    label: string,
    scope: "upload" | "bundled" = "upload",
    kind?: "document" | "structured"
  ) {
    const prompt =
      scope === "bundled"
        ? `Remove the built-in source “${label}”? It will no longer be used in answers for the whole workspace.`
        : `Remove “${label}”? It will no longer be searchable.`;
    if (!confirm(prompt)) return;
    setRemoving(doc);
    try {
      const q = new URLSearchParams({ doc, scope });
      if (kind) q.set("kind", kind);
      const res = await fetch(`/api/documents?${q.toString()}`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "remove failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "remove failed");
    } finally {
      setRemoving(null);
    }
  }

  // Open the original file in a new tab (PDFs render inline; others download).
  function openFile(doc: string) {
    window.open(`/api/documents/file?doc=${encodeURIComponent(doc)}`, "_blank", "noopener");
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
                <LangChip lang={d.lang ?? labelLang(d.label)} />
                {d.urgency && (
                  <span data-testid={`doc-urgency-${d.doc}`}>
                    <UrgencyBadge urgency={d.urgency} />
                  </span>
                )}
                {/* FIX 3: only offer the download when the original is retrievable.
                    Unknown (probe pending) → show it (optimistic); explicitly false →
                    a disabled, clearly-labelled control instead of a dead 404 link. */}
                {retrievable[d.doc] === false ? (
                  <span
                    data-testid={`doc-no-original-${d.doc}`}
                    title="Original file not stored — this upload was indexed but its source file isn’t kept, so it can’t be downloaded."
                    className="inline-flex size-6 cursor-default items-center justify-center rounded-md text-faint/40"
                  >
                    <Download className="size-3.5" />
                  </span>
                ) : (
                  <button
                    onClick={() => openFile(d.doc)}
                    data-testid={`doc-download-${d.doc}`}
                    title="Open / download"
                    className="inline-flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
                  >
                    <Download className="size-3.5" />
                  </button>
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
                {/* Documents carry an honest EN/HE chip from their indexed text; structured tables don't. */}
                {s.kind === "document" && <LangChip lang={s.lang ?? null} />}
                <span className="shrink-0 text-[11px] text-faint">{s.detail}</span>
                {/* Only a PDF/document source has an openable original file. */}
                {s.kind === "document" && (
                  <button
                    onClick={() => openFile(s.doc)}
                    data-testid={`bundled-download-${s.doc}`}
                    title="Open / download"
                    className="inline-flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
                  >
                    <Download className="size-3.5" />
                  </button>
                )}
                {/* FIX 1: a structured table is no longer a black box — View opens the
                    real columns + rows; Export CSV downloads them (GET /api/table). */}
                {s.kind === "structured" && (
                  <>
                    <button
                      onClick={() => setViewing({ table: s.doc, label: s.label })}
                      data-testid={`bundled-view-${s.doc}`}
                      title="View rows"
                      className="inline-flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
                    >
                      <Table className="size-3.5" />
                    </button>
                    <button
                      onClick={() =>
                        window.open(
                          `/api/table?table=${encodeURIComponent(s.doc)}&format=csv`,
                          "_blank",
                          "noopener"
                        )
                      }
                      data-testid={`bundled-export-${s.doc}`}
                      title="Export CSV"
                      className="inline-flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
                    >
                      <Download className="size-3.5" />
                    </button>
                  </>
                )}
                {/* Built-in data is SHARED → only an admin can remove it (workspace-wide). */}
                {role === "admin" && (
                  <button
                    onClick={() => remove(s.doc, s.label, "bundled", s.kind)}
                    disabled={removing === s.doc}
                    data-testid={`bundled-remove-${s.doc}`}
                    title="Remove built-in source (admin)"
                    className="inline-flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-high-soft hover:text-high disabled:opacity-50"
                  >
                    {removing === s.doc ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* FIX 1: the structured-table viewer modal (real columns + rows + paging + CSV). */}
      {viewing && (
        <TableViewer
          table={viewing.table}
          label={viewing.label}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

// A small per-document language chip ("EN"/"HE"). Rendered ONLY when the language is
// known (English/Hebrew); omitted otherwise so we never fabricate a tag. The engine
// answers in either language, so this honestly reflects each source's content.
function LangChip({ lang }: { lang: DocLang }) {
  if (lang !== "en" && lang !== "he") return null;
  const label = lang === "he" ? "HE" : "EN";
  const title = lang === "he" ? "Hebrew document" : "English document";
  return (
    <span
      data-testid={`doc-lang-${lang}`}
      title={title}
      className="inline-flex shrink-0 items-center rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-subtle"
    >
      {label}
    </span>
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
