// UploadButton — the dashboard Upload control (src/components/upload-button.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug. The promises (and the "no mock passed off
// as done" discipline):
//   • shows the REAL cap + formats up front (from GET /api/ingest), so it can't drift
//   • a successful upload shows the right per-kind summary ("N chunks", "N rows")
//   • a ZERO-CONTENT file is WARNED about, never oversold as "ask about it now"
//   • a failed upload surfaces the error honestly, never a fake success
//   • a successful upload dispatches the refresh event so the docs list updates
// We mock ONLY fetch (the network) — never the component's own status state machine.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UploadButton } from "@/components/upload-button";
import { mockFetch } from "./helpers";

const LIMITS = { maxMb: 15, formats: ["PDF", "Word", "Excel", "CSV"] };

function pickFile(name: string, type = "application/pdf") {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

describe("UploadButton", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.restoreAllMocks());

  it("shows the REAL cap + formats up front from GET /api/ingest", async () => {
    mockFetch({ "/api/ingest": { json: LIMITS } });
    render(<UploadButton />);
    await waitFor(() => expect(screen.getByTestId("upload-limits")).toHaveTextContent(/up to 15 MB/));
    expect(screen.getByTestId("upload-limits")).toHaveTextContent(/PDF, Word, Excel, CSV/);
  });

  it("a successful PDF upload shows the chunk/page summary", async () => {
    mockFetch({
      "/api/ingest": (_url, init) =>
        init?.method === "POST"
          ? { json: { ok: true, ingested: { kind: "pdf", label: "Lease.pdf", chunks: 12, pages: 4 }, persistence: "x" } }
          : { json: LIMITS },
    });
    render(<UploadButton />);
    await waitFor(() => expect(screen.getByTestId("upload-limits")).toBeInTheDocument());
    await userEvent.upload(screen.getByTestId("upload-input"), pickFile("Lease.pdf"));
    const ok = await screen.findByTestId("upload-success");
    expect(ok).toHaveTextContent(/12 chunks across 4 pages/);
    expect(ok).toHaveTextContent(/Ask about it now/);
  });

  it("a CSV upload shows the row count", async () => {
    mockFetch({
      "/api/ingest": (_url, init) =>
        init?.method === "POST"
          ? { json: { ok: true, ingested: { kind: "csv", table: "rents", rows: 88 }, persistence: "x" } }
          : { json: LIMITS },
    });
    render(<UploadButton />);
    await waitFor(() => expect(screen.getByTestId("upload-limits")).toBeInTheDocument());
    await userEvent.upload(screen.getByTestId("upload-input"), pickFile("rents.csv", "text/csv"));
    expect(await screen.findByTestId("upload-success")).toHaveTextContent(/88 rows/);
  });

  it("a ZERO-CONTENT file is WARNED about, never sold as answerable", async () => {
    mockFetch({
      "/api/ingest": (_url, init) =>
        init?.method === "POST"
          ? { json: { ok: true, ingested: { kind: "pdf", label: "scan.pdf" }, persistence: "x", zeroContent: true } }
          : { json: LIMITS },
    });
    render(<UploadButton />);
    await waitFor(() => expect(screen.getByTestId("upload-limits")).toBeInTheDocument());
    await userEvent.upload(screen.getByTestId("upload-input"), pickFile("scan.pdf"));
    const warn = await screen.findByTestId("upload-zero-content");
    expect(warn).toHaveTextContent(/no readable text or rows were extracted/i);
    // it must NOT show the success card or the "ask about it now" oversell
    expect(screen.queryByTestId("upload-success")).not.toBeInTheDocument();
    expect(warn).not.toHaveTextContent(/ask about it now/i);
  });

  it("a FAILED upload surfaces the error, never a fake success", async () => {
    mockFetch({
      "/api/ingest": (_url, init) =>
        init?.method === "POST"
          ? { ok: false, status: 413, json: { error: "file too large (20 MB; max 15 MB)" } }
          : { json: LIMITS },
    });
    render(<UploadButton />);
    await waitFor(() => expect(screen.getByTestId("upload-limits")).toBeInTheDocument());
    await userEvent.upload(screen.getByTestId("upload-input"), pickFile("big.pdf"));
    const err = await screen.findByTestId("upload-error");
    expect(err).toHaveTextContent(/file too large/i);
    expect(screen.queryByTestId("upload-success")).not.toBeInTheDocument();
  });

  it("a successful upload dispatches nucleus:uploaded so the docs list refreshes", async () => {
    mockFetch({
      "/api/ingest": (_url, init) =>
        init?.method === "POST"
          ? { json: { ok: true, ingested: { kind: "csv", table: "t", rows: 1 }, persistence: "x" } }
          : { json: LIMITS },
    });
    const onRefresh = vi.fn();
    window.addEventListener("nucleus:uploaded", onRefresh);
    render(<UploadButton />);
    await waitFor(() => expect(screen.getByTestId("upload-limits")).toBeInTheDocument());
    await userEvent.upload(screen.getByTestId("upload-input"), pickFile("t.csv", "text/csv"));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    window.removeEventListener("nucleus:uploaded", onRefresh);
  });
});
