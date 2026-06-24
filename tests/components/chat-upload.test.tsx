// ChatUpload — the paperclip uploader in the ask box (src/components/assistant/chat-upload.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug. This is the component that must NOT oversell:
// a zero-content file has to be WARNED about (not "added — ask about it now"), a failure
// has to surface honestly, and the rest of the app must be told to refresh. The cases pin
// the upload state machine + the honest done-message at every branch:
//   • idle: no status popover
//   • picking a file → working (uploading→indexing) spinner, button disabled
//   • success (pdf) → "added — N chunks" + a nucleus:uploaded event is dispatched
//   • success (rows) → "added — N rows"
//   • zeroContent → the AMBER warning ("nothing was added that the assistant can answer from")
//   • singular vs plural grammar (1 chunk / 1 row)
//   • a 4xx/5xx → the route's error surfaced, NO success, NO refresh event
//   • a network reject → an honest error
//   • the same file can be re-selected (the input value is cleared)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatUpload } from "@/components/assistant/chat-upload";
import { mockFetch } from "./helpers";

function file(name = "contract.pdf", type = "application/pdf") {
  return new File(["hello"], name, { type });
}

describe("ChatUpload", () => {
  beforeEach(() => vi.useRealTimers());

  it("renders idle with no status popover", () => {
    render(<ChatUpload />);
    expect(screen.getByTestId("chat-upload-button")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-upload-progress")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-upload-success")).not.toBeInTheDocument();
  });

  it("shows the working spinner and disables the button while uploading", async () => {
    mockFetch({ "/api/ingest": { pending: true } });
    render(<ChatUpload />);

    const input = screen.getByTestId("chat-upload-input") as HTMLInputElement;
    await userEvent.upload(input, file());

    await waitFor(() => expect(screen.getByTestId("chat-upload-progress")).toBeInTheDocument());
    expect(screen.getByTestId("chat-upload-button")).toBeDisabled();
  });

  it("a successful PDF upload shows 'added — N chunks' and dispatches nucleus:uploaded", async () => {
    const onRefresh = vi.fn();
    window.addEventListener("nucleus:uploaded", onRefresh);
    mockFetch({ "/api/ingest": { json: { ingested: { kind: "pdf", label: "Lease.pdf", chunks: 12 } } } });
    render(<ChatUpload />);

    await userEvent.upload(screen.getByTestId("chat-upload-input"), file("Lease.pdf"));

    await waitFor(() => expect(screen.getByTestId("chat-upload-success")).toBeInTheDocument());
    expect(screen.getByTestId("chat-upload-success")).toHaveTextContent(/Lease\.pdf.*12 chunks.*Ask about it now/);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    window.removeEventListener("nucleus:uploaded", onRefresh);
  });

  it("a successful spreadsheet upload shows 'added — N rows'", async () => {
    mockFetch({ "/api/ingest": { json: { ingested: { kind: "csv", table: "maintenance", rows: 34 } } } });
    render(<ChatUpload />);
    await userEvent.upload(screen.getByTestId("chat-upload-input"), file("data.csv", "text/csv"));

    await waitFor(() => expect(screen.getByTestId("chat-upload-success")).toBeInTheDocument());
    expect(screen.getByTestId("chat-upload-success")).toHaveTextContent(/maintenance.*34 rows/);
  });

  it("uses singular grammar for 1 chunk / 1 row", async () => {
    mockFetch({ "/api/ingest": { json: { ingested: { kind: "pdf", label: "One.pdf", chunks: 1 } } } });
    const { unmount } = render(<ChatUpload />);
    await userEvent.upload(screen.getByTestId("chat-upload-input"), file("One.pdf"));
    await waitFor(() => expect(screen.getByTestId("chat-upload-success")).toHaveTextContent("1 chunk."));
    expect(screen.getByTestId("chat-upload-success")).not.toHaveTextContent("1 chunks");
    unmount();

    mockFetch({ "/api/ingest": { json: { ingested: { kind: "csv", table: "t", rows: 1 } } } });
    render(<ChatUpload />);
    await userEvent.upload(screen.getByTestId("chat-upload-input"), file("one.csv", "text/csv"));
    await waitFor(() => expect(screen.getByTestId("chat-upload-success")).toHaveTextContent("1 row."));
  });

  it("a ZERO-CONTENT file is WARNED about, never oversold as answerable", async () => {
    // RED-first guard: if zeroContent were ignored, a scanned-blank PDF would show the
    // green "Ask about it now" success — the exact oversell this component forbids.
    mockFetch({ "/api/ingest": { json: { ingested: { kind: "pdf", label: "Blank.pdf" }, zeroContent: true } } });
    render(<ChatUpload />);
    await userEvent.upload(screen.getByTestId("chat-upload-input"), file("Blank.pdf"));

    await waitFor(() => expect(screen.getByTestId("chat-upload-zero")).toBeInTheDocument());
    expect(screen.getByTestId("chat-upload-zero")).toHaveTextContent(/no readable text or rows were extracted/);
    // It is NOT shown as a success.
    expect(screen.queryByTestId("chat-upload-success")).not.toBeInTheDocument();
  });

  it("a 4xx/5xx error surfaces the route's message, no success, no refresh event", async () => {
    const onRefresh = vi.fn();
    window.addEventListener("nucleus:uploaded", onRefresh);
    // The input's accept list passes the file to the handler; the SERVER is what rejects
    // it (e.g. a corrupt/empty body the route can't parse), so we use an accepted type.
    mockFetch({ "/api/ingest": { ok: false, status: 415, json: { error: "unsupported file type" } } });
    render(<ChatUpload />);

    await userEvent.upload(screen.getByTestId("chat-upload-input"), file("corrupt.pdf"));

    await waitFor(() => expect(screen.getByTestId("chat-upload-error")).toHaveTextContent("unsupported file type"));
    expect(screen.queryByTestId("chat-upload-success")).not.toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled(); // never tell the app to refresh on a failure
    window.removeEventListener("nucleus:uploaded", onRefresh);
  });

  it("a network reject shows an honest error", async () => {
    mockFetch({ "/api/ingest": { reject: new Error("Failed to fetch") } });
    render(<ChatUpload />);
    await userEvent.upload(screen.getByTestId("chat-upload-input"), file());
    await waitFor(() => expect(screen.getByTestId("chat-upload-error")).toHaveTextContent("Failed to fetch"));
  });

  it("clears the input value so the SAME file can be re-selected", async () => {
    mockFetch({ "/api/ingest": { json: { ingested: { kind: "pdf", label: "a.pdf", chunks: 2 } } } });
    render(<ChatUpload />);
    const input = screen.getByTestId("chat-upload-input") as HTMLInputElement;
    await userEvent.upload(input, file("a.pdf"));
    await waitFor(() => expect(screen.getByTestId("chat-upload-success")).toBeInTheDocument());
    // onPick sets e.target.value = "" so a re-pick of the identical file still fires change.
    expect(input.value).toBe("");
  });
});
