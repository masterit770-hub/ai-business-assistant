"use client";

import { useEffect, useRef, useState } from "react";
import { Paperclip, Loader2, Check, AlertCircle, AlertTriangle } from "lucide-react";

// COMPACT chat-side uploader — a paperclip in the ask box so a file can be added
// WITHOUT leaving the chat (the client couldn't find the upload, which lives on the
// Sources page). Posts the chosen file(s) to the SAME /api/ingest the Sources upload uses
// (PDF / Word .docx / Excel .xlsx / CSV), reports the REAL result inline, and tells the
// rest of the app to refresh its source list (nucleus:uploaded). No mock — a failure is
// surfaced honestly; a zero-content file is warned about, never oversold as answerable.
//
// MULTIPLE FILES: the input is `multiple`, and onPick uploads each selected file in turn
// (one /api/ingest POST per file), then reports an aggregate result. The client asked to
// add several files at once.
//
// PER-CHAT SCOPING (migration 014): when sessionId is provided, it's sent to /api/ingest
// as `session_id` so the uploaded file is linked to THIS chat only and is not visible
// to other chats. The Sources page uploader (UploadButton) doesn't have a session context,
// so its uploads remain NULL-session (the owner's global library — visible to all chats).
type Result = {
  ingested?: { kind?: string; label?: string; table?: string; chunks?: number; rows?: number };
  zeroContent?: boolean;
};

type Status =
  | { state: "idle" }
  | { state: "working"; name: string; phase: "uploading" | "indexing" }
  | { state: "done"; name: string; result: Result; more: number; failed: number }
  | { state: "error"; message: string };

export function ChatUpload({
  sessionId,
  onSessionId,
  spaceId,
}: {
  sessionId?: string;
  // Lift a freshly-minted chat id to the parent so the upload AND the first question
  // continue the SAME chat (the server honours a client-provided session_id).
  onSessionId?: (id: string) => void;
  // Knowledge Space: when provided, tags the uploaded file to this space.
  spaceId?: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Auto-dismiss timer for the "done" confirmation so it never lingers forever (the bug:
  // the "<file> added" toast stayed on screen permanently across chats).
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });

  // Clear any pending auto-dismiss timer when the component unmounts (e.g. switching chats).
  useEffect(() => () => {
    if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
  }, []);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-selecting the same file(s)
    if (files.length === 0) return;
    // Cancel any pending auto-dismiss from a previous upload before starting a new one.
    if (doneTimerRef.current) {
      clearTimeout(doneTimerRef.current);
      doneTimerRef.current = null;
    }

    // EVERY uploaded document MUST be linked to a chat — an unassigned doc must never exist.
    // If this is a brand-new chat with no session id yet (the user uploads BEFORE sending
    // their first message), mint one NOW and lift it to the parent so this file is tagged
    // and the first question continues the same chat.
    let sid = sessionId;
    if (!sid) {
      sid = crypto.randomUUID();
      onSessionId?.(sid);
    }

    let lastOk: { name: string; result: Result } | null = null;
    const failures: { name: string; message: string }[] = [];

    // Upload each file in turn (one ingest per file). Sequential keeps the inline
    // progress legible and avoids hammering the ingest route with parallel large files.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const label = files.length > 1 ? `${file.name} (${i + 1}/${files.length})` : file.name;
      setStatus({ state: "working", name: label, phase: "uploading" });
      try {
        const body = new FormData();
        body.append("file", file);
        // Always tag the chat — sid is guaranteed non-null here (minted above if needed).
        body.append("session_id", sid);
        // Tag the Knowledge Space when uploading inside a space.
        if (spaceId) body.append("space_id", spaceId);
        const req = fetch("/api/ingest", { method: "POST", body });
        setStatus({ state: "working", name: label, phase: "indexing" });
        const res = await req;
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "upload failed");
        lastOk = { name: file.name, result: data as Result };
      } catch (err) {
        failures.push({ name: file.name, message: err instanceof Error ? err.message : "upload failed" });
      }
    }

    if (lastOk) {
      // At least one upload succeeded — tell the Sources page + dashboard counts to refresh.
      // (Never fire this on a total failure: nothing changed, and the app must not refresh.)
      window.dispatchEvent(new CustomEvent("nucleus:uploaded"));
      // `more` = other files that also succeeded (beyond the one whose detail we show).
      const more = files.length - failures.length - 1;
      setStatus({ state: "done", name: lastOk.name, result: lastOk.result, more, failed: failures.length });
      // Auto-dismiss the confirmation after a few seconds so it doesn't persist forever.
      doneTimerRef.current = setTimeout(() => setStatus({ state: "idle" }), 6000);
    } else {
      // All failed. A single failure surfaces the REAL error (route message / network
      // error); multiple failures show an aggregate count.
      setStatus({
        state: "error",
        message: failures.length === 1 ? failures[0].message : `All ${failures.length} uploads failed.`,
      });
    }
  }

  const working = status.state === "working";

  // A concise, honest one-liner for the done state — mirrors the Sources uploader.
  function doneMessage(r: Result, more: number, failed: number): { warn: boolean; text: string } {
    const ing = r.ingested ?? {};
    const name = ing.label ?? ing.table ?? "This file";
    let text: string;
    let warn = false;
    if (r.zeroContent) {
      warn = true;
      text = `“${name}” uploaded, but no readable text or rows were extracted — nothing was added that the assistant can answer from.`;
    } else {
      // The agentic engine reads the raw file directly — there are no "chunks"/"rows"
      // to count (that was the old RAG catalog, now excised). Just confirm it's added.
      text = `“${name}” added. Ask about it now.`;
    }
    if (more > 0) text += ` (+${more} more file${more === 1 ? "" : "s"} added.)`;
    if (failed > 0) {
      warn = true;
      text += ` ${failed} file${failed === 1 ? "" : "s"} failed.`;
    }
    return { warn, text };
  }

  return (
    <div className="relative shrink-0">
      <input
        ref={inputRef}
        type="file"
        multiple
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
        title="Add file(s) (PDF, Word, Excel, CSV)"
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
              const m = doneMessage(status.result, status.more, status.failed);
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
