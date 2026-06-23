"use client";

import { useEffect, useState } from "react";
import { FileText, Database, Trash2, Loader2, RefreshCw, Download, Table, Check, X } from "lucide-react";
import { UploadButton } from "@/components/upload-button";
import { UrgencyBadge } from "@/components/urgency-badge";
import { TableViewer } from "@/components/assistant/table-viewer";
import type { Urgency } from "@/lib/mock";

type DocLang = "en" | "he" | null;
type DocMeta = { doc: string; label: string; urgency: Urgency | null; lang?: DocLang; pages?: number };
// An uploaded STRUCTURED source (a spreadsheet) — answered by text-to-SQL, surfaced with
// the [S] chip + a row viewer. Durable + owner-scoped from /api/documents.structuredTables.
type StructuredTable = { doc: string; label: string; rows: number; detail: string };
type BundledSource = {
  doc: string;
  label: string;
  kind: "document" | "structured";
  detail: string;
  lang?: DocLang;
  urgency?: Urgency | null; // documents carry an urgency badge too, for a consistent bucket
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
  const [tables, setTables] = useState<StructuredTable[] | null>(null);
  const [bundled, setBundled] = useState<BundledSource[] | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // The source row awaiting a delete confirmation (its `doc` id), or null. We use an
  // INLINE confirm (Delete? / Delete / Cancel) instead of the native window.confirm()
  // dialog: native confirm() can be suppressed by the browser ("prevent this page from
  // creating more dialogs"), which made delete silently do nothing and feel unreachable.
  const [confirming, setConfirming] = useState<string | null>(null);
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
      const t: StructuredTable[] = d.structuredTables ?? [];
      const b: BundledSource[] = d.bundled ?? [];
      setUploaded(docs);
      setTables(t);
      setBundled(b);
      setRole(d.role ?? null);
      setError(null);
      // Probe each uploaded doc's original-file retrievability (FIX 3) so the rail only
      // offers a download for docs whose original is actually stored — never a dead 404.
      probeRetrievability(docs);
      // Publish the RAW counts (not a pre-summed "total") so every consumer computes its
      // own stat consistently and nothing double-counts: uploads, bundled, and the
      // high-urgency count across the WHOLE bucket (uploads + bundled docs).
      const high =
        docs.filter((x) => x.urgency === "high").length +
        b.filter((x) => x.urgency === "high").length;
      window.dispatchEvent(
        new CustomEvent("nucleus:docs", {
          // Uploaded count includes structured tables (spreadsheets) — they're sources too.
          detail: { uploaded: docs.length + t.length, bundled: b.length, high },
        })
      );
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

  // Delete a source (after the INLINE confirm). No native confirm() — the caller arms
  // the confirmation via `confirming`, this just performs the DELETE and refreshes the
  // list. Owner-scoped server-side; `scope: "bundled"` is the admin-only shared-source
  // soft-delete. On success the list reloads, which re-publishes the `nucleus:docs` count
  // event so the header stats and the chat's source count stay in sync.
  async function remove(
    doc: string,
    scope: "upload" | "bundled" = "upload",
    kind?: "document" | "structured"
  ) {
    setRemoving(doc);
    try {
      const q = new URLSearchParams({ doc, scope });
      if (kind) q.set("kind", kind);
      const res = await fetch(`/api/documents?${q.toString()}`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "remove failed");
      setConfirming(null);
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
          <p className="mt-1 text-xs text-faint">PDFs, scanned docs, Word, CSV or Excel</p>
          <div className="mt-3 flex justify-center">
            <UploadButton />
          </div>
        </div>
        {error && (
          <p className="mt-2 text-xs text-high">Couldn’t load materials: {error}</p>
        )}
      </div>

      {/* YOUR MATERIALS — ONE bucket: your uploads + (for demo accounts) the sample
          corpus, in a single list. There is no separate "Built-in business data"
          section: a real client user (non-demo) gets an empty bundled list from the
          API, so this is purely their own uploads; a demo account sees both together. */}
      <div className="rounded-2xl border border-line bg-surface shadow-soft" data-testid="uploaded-docs">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            Your materials
          </span>
          <span className="text-[11px] text-faint">
            {(uploaded?.length ?? 0) + (tables?.length ?? 0) + (bundled?.length ?? 0)} sources
          </span>
        </div>
        {uploaded === null ? (
          <p className="px-4 py-4 text-xs text-faint">Loading…</p>
        ) : uploaded.length === 0 && (tables?.length ?? 0) === 0 && (bundled?.length ?? 0) === 0 ? (
          <p className="px-4 py-4 text-xs text-faint">
            No materials yet. Upload a PDF, Word, CSV, or Excel — it appears here with a [P]/[S] chip and
            is answerable instantly.
          </p>
        ) : (
          <ul>
            {uploaded.map((d) => (
              <li
                key={d.doc}
                data-testid={`doc-row-${d.doc}`}
                className="border-b border-line px-4 py-3 last:border-0"
              >
                {/* line 1: the document NAME gets the full width (no longer crammed by
                    chips); only the action icons share the line. */}
                <div className="flex items-center gap-2">
                  <SourceChip kind="document" />
                  <span
                    data-testid={`doc-name-${d.doc}`}
                    title={d.label}
                    className="min-w-0 flex-1 truncate text-sm font-medium text-ink"
                  >
                    {d.label}
                  </span>
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
                  <DeleteControl
                    testid={`doc-remove-${d.doc}`}
                    confirming={confirming === d.doc}
                    busy={removing === d.doc}
                    onArm={() => {
                      setError(null);
                      setConfirming(d.doc);
                    }}
                    onCancel={() => setConfirming(null)}
                    onConfirm={() => remove(d.doc)}
                  />
                </div>
                {/* line 2: the metadata chips, indented under the name. */}
                <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-7">
                  <LangChip lang={d.lang ?? labelLang(d.label)} />
                  {typeof d.pages === "number" && d.pages > 0 && (
                    <span data-testid={`doc-pages-${d.doc}`} className="text-[11px] text-faint">
                      PDF · {d.pages} page{d.pages === 1 ? "" : "s"}
                    </span>
                  )}
                  {d.urgency && (
                    <span data-testid={`doc-urgency-${d.doc}`}>
                      <UrgencyBadge urgency={d.urgency} />
                    </span>
                  )}
                </div>
              </li>
            ))}
            {/* uploaded STRUCTURED tables (spreadsheets) — [S] chip + row viewer + CSV
                export + remove, in the SAME list. Durable + owner-scoped; they survive a
                serverless cold start (the text-to-SQL lane answers from uploaded_rows). */}
            {(tables ?? []).map((t) => (
              <li
                key={t.doc}
                data-testid={`table-row-${t.doc}`}
                className="border-b border-line px-4 py-3 last:border-0"
              >
                <div className="flex items-center gap-2">
                  <SourceChip kind="structured" />
                  <span
                    data-testid={`table-name-${t.doc}`}
                    title={t.label}
                    className="min-w-0 flex-1 truncate text-sm font-medium text-ink"
                  >
                    {t.label}
                  </span>
                  <button
                    onClick={() => setViewing({ table: t.doc, label: t.label })}
                    data-testid={`table-view-${t.doc}`}
                    title="View rows"
                    className="inline-flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
                  >
                    <Table className="size-3.5" />
                  </button>
                  <button
                    onClick={() =>
                      window.open(
                        `/api/table?table=${encodeURIComponent(t.doc)}&format=csv`,
                        "_blank",
                        "noopener"
                      )
                    }
                    data-testid={`table-export-${t.doc}`}
                    title="Export CSV"
                    className="inline-flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
                  >
                    <Download className="size-3.5" />
                  </button>
                  <DeleteControl
                    testid={`table-remove-${t.doc}`}
                    confirming={confirming === t.doc}
                    busy={removing === t.doc}
                    onArm={() => {
                      setError(null);
                      setConfirming(t.doc);
                    }}
                    onCancel={() => setConfirming(null)}
                    onConfirm={() => remove(t.doc)}
                  />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-7">
                  <span data-testid={`table-detail-${t.doc}`} className="text-[11px] text-faint">
                    {t.detail}
                  </span>
                </div>
              </li>
            ))}
            {/* the bundled sample corpus, in the SAME list (demo accounts only; empty
                for a real client user). data-testid kept so existing checks resolve. */}
            {(bundled ?? []).map((s) => (
              <li
                key={s.doc}
                data-testid={`bundled-row-${s.doc}`}
                className="border-b border-line px-4 py-3 last:border-0"
              >
                {/* line 1: full-width name + actions */}
                <div className="flex items-center gap-2">
                  <SourceChip kind={s.kind} />
                  <span
                    data-testid={`bundled-name-${s.doc}`}
                    title={s.label}
                    className="min-w-0 flex-1 truncate text-sm font-medium text-ink"
                  >
                    {s.label}
                  </span>
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
                  {role === "admin" && (
                    <DeleteControl
                      testid={`bundled-remove-${s.doc}`}
                      title="Remove built-in source (admin)"
                      confirming={confirming === s.doc}
                      busy={removing === s.doc}
                      onArm={() => {
                        setError(null);
                        setConfirming(s.doc);
                      }}
                      onCancel={() => setConfirming(null)}
                      onConfirm={() => remove(s.doc, "bundled", s.kind)}
                    />
                  )}
                </div>
                {/* line 2: metadata — lang (docs only) + detail + urgency badge */}
                <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-7">
                  {s.kind === "document" && <LangChip lang={s.lang ?? null} />}
                  <span className="text-[11px] text-faint">{s.detail}</span>
                  {s.urgency && (
                    <span data-testid={`bundled-urgency-${s.doc}`}>
                      <UrgencyBadge urgency={s.urgency} />
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

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

// The per-source DELETE control. Two states, no native dialog:
//   • disarmed → a labelled "Delete" button (text, not just a bare trash icon) so a
//     non-technical user can actually find how to remove a source. This is the fix for
//     "the sources are not reachable for deleting them" — the affordance was an
//     easy-to-miss icon, and the native confirm() it used could be browser-suppressed.
//   • armed (`confirming`) → an INLINE "Delete this source? Delete / Cancel" confirm,
//     mirroring the conversation-delete pattern in history-panel.tsx. While the DELETE
//     is in flight (`busy`) the confirm button shows a spinner and both are disabled.
function DeleteControl({
  testid,
  title = "Remove source",
  confirming,
  busy,
  onArm,
  onCancel,
  onConfirm,
}: {
  testid: string;
  title?: string;
  confirming: boolean;
  busy: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (confirming) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5" data-testid={`${testid}-confirm`}>
        <span className="hidden text-[11px] font-medium text-high sm:inline">Delete?</span>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          data-testid={`${testid}-yes`}
          className="inline-flex items-center gap-1 rounded-md bg-high px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-high/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
          Delete
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          data-testid={`${testid}-no`}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-subtle transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
        >
          <X className="size-3" />
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onArm}
      disabled={busy}
      data-testid={testid}
      title={title}
      aria-label={title}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-subtle transition-colors hover:border-high/40 hover:bg-high-soft hover:text-high disabled:opacity-50"
    >
      <Trash2 className="size-3.5" />
      <span className="hidden sm:inline">Delete</span>
    </button>
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
