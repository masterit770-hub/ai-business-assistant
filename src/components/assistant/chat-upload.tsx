"use client";

import { useRef, useState } from "react";
import { Paperclip, Loader2, Check, AlertCircle, AlertTriangle } from "lucide-react";

// COMPACT chat-side uploader — a paperclip in the ask box so a file can be added
// WITHOUT leaving the chat (the client couldn't find the upload, which lives on the
// Sources page). Posts the chosen file to the SAME /api/ingest the Sources upload uses
// (PDF / Word .docx / Excel .xlsx / CSV), reports the REAL result inline, and tells the
// rest of the app to refresh its source list (nucleus:uploaded). No mock — a failure is
// surfaced honestly; a zero-content file is warned about, never oversold as answerable.
type Result = {
  ingested?: { kind?: string; label?: string; table?: string; chunks?: number; rows?: number };
  zeroContent?: boolean;
};

type Status =
  | { state: "idle" }
  | { state: "working"; name: string; phase: "uploading" | "indexing" }
  | { state: "done"; name: string; result: Result }
  | { state: "error"; message: string };

export function ChatUpload() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;

    setStatus({ state: "working", name: file.name, phase: "uploading" });
    try {
      const body = new FormData();
      body.append("file", file);
      const req = fetch("/api/ingest", { method: "POST", body });
      setStatus({ state: "working", name: file.name, phase: "indexing" });
      const res = await req;
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "upload failed");
      setStatus({ state: "done", name: file.name, result: data as Result });
      // Sources page + dashboard counts listen for this to refresh.
      window.dispatchEvent(new CustomEvent("nucleus:uploaded"));
    } catch (err) {
      setStatus({
        state: "error",
        message: err instanceof Error ? err.message : "upload failed",
      });
    }
  }

  const working = status.state === "working";

  // A concise, honest one-liner for the done state — mirrors the Sources uploader.
  function doneMessage(r: Result): { warn: boolean; text: string } {
    const ing = r.ingested ?? {};
    const name = ing.label ?? ing.table ?? "This file";
    if (r.zeroContent) {
      return {
        warn: true,
        text: `“${name}” uploaded, but no readable text or rows were extracted — nothing was added that the assistant can answer from.`,
      };
    }
    const count =
      ing.chunks != null && ing.kind === "pdf"
        ? `${ing.chunks} chunk${ing.chunks === 1 ? "" : "s"}`
        : ing.rows != null
          ? `${ing.rows} row${ing.rows === 1 ? "" : "s"}`
          : "indexed";
    return { warn: false, text: `“${name}” added — ${count}. Ask about it now.` };
  }

  return (
    <div className="relative shrink-0">
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.csv,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={onPick}
        data-testid="chat-upload-input"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={working}
        data-testid="chat-upload-button"
        title="Add a file (PDF, Word, Excel, CSV)"
        className="flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-subtle transition-colors hover:border-accent-ring hover:text-ink disabled:opacity-60"
      >
        {working ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
      </button>

      {/* inline status popover — sits above the paperclip so it never shifts the input */}
      {status.state !== "idle" && (
        <div className="absolute bottom-full left-0 z-10 mb-2 w-[280px]">
          {working && (
            <div
              data-testid="chat-upload-progress"
              className="flex items-center gap-2 rounded-lg border border-accent-ring bg-accent-soft px-3 py-2 text-xs text-accent shadow-soft"
            >
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              <span className="min-w-0 truncate">
                {status.phase === "uploading" ? "Uploading" : "Indexing"} “{status.name}”…
              </span>
            </div>
          )}
          {status.state === "done" &&
            (() => {
              const m = doneMessage(status.result);
              return m.warn ? (
                <div
                  data-testid="chat-upload-zero"
                  className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-700 shadow-soft dark:text-amber-300"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{m.text}</span>
                </div>
              ) : (
                <div
                  data-testid="chat-upload-success"
                  className="flex items-start gap-2 rounded-lg border border-accent-ring bg-accent-soft px-3 py-2 text-xs text-accent shadow-soft"
                >
                  <Check className="mt-0.5 size-3.5 shrink-0" />
                  <span>{m.text}</span>
                </div>
              );
            })()}
          {status.state === "error" && (
            <div
              data-testid="chat-upload-error"
              className="flex items-start gap-2 rounded-lg border border-high/30 bg-high-soft px-3 py-2 text-xs text-high shadow-soft"
            >
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>{status.message}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
