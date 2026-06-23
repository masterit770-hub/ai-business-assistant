"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, Loader2, Check, AlertCircle, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

// The engine's ingestion response shape (Contract-Retriever-RAG /api/ingest).
type IngestResult = {
  ok: boolean;
  ingested: {
    kind: "pdf" | "csv" | "xlsx";
    doc?: string;
    label?: string;
    chunks?: number;
    pages?: number;
    table?: string;
    rows?: number;
    sheets?: number;
    ocr?: boolean;
  };
  persistence: string;
  // True when we accepted the file but extracted nothing usable (e.g. an image-only
  // scan) — the success copy must then warn instead of saying "ask about it now".
  zeroContent?: boolean;
};

// The upload limits, read from GET /api/ingest so what we show up front always matches
// what the server actually enforces (single source of truth — no drift).
type Limits = { maxMb: number; formats: string[] };

type Status =
  // `phase` distinguishes the two real stages so the user sees progress, not a static
  // spinner: "uploading" = bytes in flight, "indexing" = server is chunking/embedding.
  | { state: "idle" }
  | { state: "working"; name: string; phase: "uploading" | "indexing" }
  | { state: "done"; result: IngestResult }
  | { state: "error"; message: string };

// The real Upload control. Opens a file picker, streams the chosen PDF/CSV/XLSX to the
// Nucleus → engine ingestion proxy, and reports the REAL result (doc id + chunks/rows),
// so the uploaded document is immediately query-able in the Ask panel with citations.
// No mock — a failure is surfaced honestly, never a fake success; a zero-content file is
// warned about rather than oversold.
export function UploadButton() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [limits, setLimits] = useState<Limits | null>(null);

  // Fetch the real cap + supported formats once, to show them up front.
  useEffect(() => {
    let alive = true;
    fetch("/api/ingest")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d) setLimits({ maxMb: d.maxMb, formats: d.formats });
      })
      .catch(() => {
        /* fall back to the static hint below */
      });
    return () => {
      alive = false;
    };
  }, []);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;

    setStatus({ state: "working", name: file.name, phase: "uploading" });
    try {
      const body = new FormData();
      body.append("file", file);
      // Once the request is sent, the bytes are in flight; the server then chunks/embeds
      // into the self-hosted pgvector store — reflect that as the "indexing" phase.
      const req = fetch("/api/ingest", { method: "POST", body });
      setStatus({ state: "working", name: file.name, phase: "indexing" });
      const res = await req;
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "upload failed");
      setStatus({ state: "done", result: data as IngestResult });
      // Tell the dashboard's uploaded-docs list to refresh (new doc + its badge).
      window.dispatchEvent(new CustomEvent("nucleus:uploaded"));
    } catch (err) {
      setStatus({
        state: "error",
        message: err instanceof Error ? err.message : "upload failed",
      });
    }
  }

  const fmtLabel = limits ? limits.formats.join(", ") : "PDF, CSV, XLSX";
  const capLabel = limits ? `${limits.maxMb} MB` : "15 MB";

  const ing = status.state === "done" ? status.result.ingested : null;
  const zero = status.state === "done" && status.result.zeroContent === true;
  const summary =
    ing?.kind === "pdf"
      ? // File Search ingest returns just the doc (no local chunk/page counts);
        // the local fallback returns chunks/pages. Phrase it for both.
        ing.chunks != null
        ? `“${ing.label}” added — ${ing.chunks} chunks across ${ing.pages} pages. Ask about it now.`
        : `“${ing.label}” indexed. Ask about it now.`
      : ing?.kind === "xlsx"
        ? `“${ing.table}” added — ${ing.rows} rows across ${ing.sheets} sheet${ing.sheets === 1 ? "" : "s"}. Ask about it now.`
        : ing?.kind === "csv"
          ? `“${ing.table}” added — ${ing.rows} rows. Ask about it now.`
          : "";
  // The honest zero-content message — no "ask about it now".
  const zeroMessage = `“${ing?.label ?? ing?.table ?? "This file"}” was uploaded, but no readable text or rows were extracted — it may be an image-only scan or an empty sheet. Nothing was added that the assistant can answer from.`;

  const working = status.state === "working";

  return (
    <div className="flex w-full flex-col items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.csv,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={onPick}
        data-testid="upload-input"
      />
      <Button
        size="lg"
        onClick={() => inputRef.current?.click()}
        disabled={working}
        data-testid="upload-button"
        className="h-10 gap-2 bg-accent text-accent-fg hover:bg-accent/90 shadow-soft disabled:opacity-60"
      >
        {working ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        {working ? (status.phase === "uploading" ? "Uploading…" : "Indexing…") : "Upload"}
      </Button>

      {/* FIX 2: supported formats + size cap shown UP FRONT (from the real server limit). */}
      <p className="text-[11px] text-faint" data-testid="upload-limits">
        {fmtLabel} · up to {capLabel}
      </p>

      {/* Real progress feedback: the filename + the current phase, not a bare spinner. */}
      {working && (
        <div
          data-testid="upload-progress"
          className="flex max-w-[320px] items-center gap-2 rounded-lg border border-accent-ring bg-accent-soft px-3 py-2 text-xs text-accent"
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span className="min-w-0 truncate">
            {status.phase === "uploading" ? "Uploading" : "Indexing"} “{status.name}”…
          </span>
        </div>
      )}

      {status.state === "done" && !zero && (
        <div
          data-testid="upload-success"
          className="flex max-w-[320px] items-start gap-2 rounded-lg border border-accent-ring bg-accent-soft px-3 py-2 text-xs text-accent"
        >
          <Check className="mt-0.5 size-3.5 shrink-0" />
          <span>{summary}</span>
        </div>
      )}
      {/* FIX 2: a zero-content file is warned about, never oversold as answerable. */}
      {status.state === "done" && zero && (
        <div
          data-testid="upload-zero-content"
          className="flex max-w-[320px] items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{zeroMessage}</span>
        </div>
      )}
      {status.state === "error" && (
        <div
          data-testid="upload-error"
          className="flex max-w-[320px] items-start gap-2 rounded-lg border border-high/30 bg-high-soft px-3 py-2 text-xs text-high"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>{status.message}</span>
        </div>
      )}
    </div>
  );
}
