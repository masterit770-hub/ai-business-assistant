"use client";

import { useRef, useState } from "react";
import { Upload, Loader2, Check, AlertCircle } from "lucide-react";
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
};

type Status =
  | { state: "idle" }
  | { state: "uploading"; name: string }
  | { state: "done"; result: IngestResult }
  | { state: "error"; message: string };

// The real Upload control. Opens a file picker, streams the chosen PDF/CSV to the
// Nucleus → engine ingestion proxy, and reports the REAL result (doc id + chunks),
// so the uploaded document is immediately query-able in the Ask panel with
// citations. No mock — a failure is surfaced honestly, never a fake success.
export function UploadButton() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;

    setStatus({ state: "uploading", name: file.name });
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/ingest", { method: "POST", body });
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

  const ing = status.state === "done" ? status.result.ingested : null;
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

  return (
    <div className="flex flex-col items-end gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.csv,.xlsx,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={onPick}
        data-testid="upload-input"
      />
      <Button
        size="lg"
        onClick={() => inputRef.current?.click()}
        disabled={status.state === "uploading"}
        data-testid="upload-button"
        className="h-10 gap-2 bg-accent text-accent-fg hover:bg-accent/90 shadow-soft disabled:opacity-60"
      >
        {status.state === "uploading" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Upload className="size-4" />
        )}
        {status.state === "uploading" ? "Ingesting…" : "Upload"}
      </Button>

      {status.state === "done" && (
        <div
          data-testid="upload-success"
          className="flex max-w-[320px] items-start gap-2 rounded-lg border border-accent-ring bg-accent-soft px-3 py-2 text-xs text-accent"
        >
          <Check className="mt-0.5 size-3.5 shrink-0" />
          <span>{summary}</span>
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
