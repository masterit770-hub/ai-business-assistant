// UploadedDocs — the dashboard's uploaded-document list (src/components/uploaded-docs.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug. Promises:
//   • lists the real docs and publishes its count via nucleus:docs (stat cards stay in sync)
//   • remove is CONFIRM-gated: cancelling makes NO request and removes nothing
//   • a confirmed remove DELETEs by doc id and refreshes the list
//   • the filter narrows the list + shows "of N" / a no-match message
//   • a load failure surfaces the error; the empty state invites an upload
// We mock ONLY fetch + window.confirm — never the list's own state machine.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UploadedDocs } from "@/components/uploaded-docs";
import { mockFetch } from "./helpers";

const DOCS = [
  { doc: "d1", label: "Lease Agreement", urgency: "high" },
  { doc: "d2", label: "Invoice March", urgency: "low" },
];

describe("UploadedDocs", () => {
  beforeEach(() => vi.spyOn(window, "confirm").mockReturnValue(true));
  afterEach(() => vi.restoreAllMocks());

  it("lists the docs and publishes its count via nucleus:docs", async () => {
    const onDocs = vi.fn();
    window.addEventListener("nucleus:docs", onDocs as EventListener);
    mockFetch({ "/api/documents": { json: { documents: DOCS } } });
    render(<UploadedDocs />);
    await waitFor(() => expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument());
    expect(screen.getByText("Lease Agreement")).toBeInTheDocument();
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(expect.objectContaining({ detail: { total: 2, high: 1 } })),
    );
    window.removeEventListener("nucleus:docs", onDocs as EventListener);
  });

  it("remove is CONFIRM-gated: cancelling makes NO delete request", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const fn = mockFetch({ "/api/documents": { json: { documents: DOCS } } });
    render(<UploadedDocs />);
    await waitFor(() => expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument());

    const before = fn.mock.calls.length;
    await userEvent.click(screen.getByTestId("doc-remove-d1"));
    // no DELETE fired
    expect(fn.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
    expect(fn.mock.calls.length).toBe(before);
    // the row is still there
    expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument();
  });

  it("a confirmed remove DELETEs by doc id and refreshes the list", async () => {
    let deletedDoc: string | null = null;
    let docs = [...DOCS];
    mockFetch({
      "/api/documents": (url, init) => {
        if (init?.method === "DELETE") {
          deletedDoc = new URL(url, "http://x").searchParams.get("doc");
          docs = docs.filter((d) => d.doc !== deletedDoc);
          return { json: { ok: true } };
        }
        return { json: { documents: docs } };
      },
    });
    render(<UploadedDocs />);
    await waitFor(() => expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("doc-remove-d1"));
    expect(deletedDoc).toBe("d1");
    // after the refresh, the row is gone
    await waitFor(() => expect(screen.queryByTestId("doc-row-d1")).not.toBeInTheDocument());
    expect(screen.getByTestId("doc-row-d2")).toBeInTheDocument();
  });

  it("the filter narrows the list and shows the 'of N' count", async () => {
    mockFetch({ "/api/documents": { json: { documents: DOCS } } });
    render(<UploadedDocs filter="lease" />);
    await waitFor(() => expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument());
    expect(screen.queryByTestId("doc-row-d2")).not.toBeInTheDocument();
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
  });

  it("a filter matching nothing shows the no-match message", async () => {
    mockFetch({ "/api/documents": { json: { documents: DOCS } } });
    render(<UploadedDocs filter="zzz-nope" />);
    await waitFor(() => expect(screen.getByText(/No documents match/i)).toBeInTheDocument());
  });

  it("a load failure surfaces the error", async () => {
    mockFetch({ "/api/documents": { ok: false, status: 500, json: { error: "engine down" } } });
    render(<UploadedDocs />);
    await waitFor(() => expect(screen.getByText(/engine down/)).toBeInTheDocument());
  });

  it("an empty list shows the upload-invite empty state", async () => {
    mockFetch({ "/api/documents": { json: { documents: [] } } });
    render(<UploadedDocs />);
    await waitFor(() => expect(screen.getByText(/No uploaded documents yet/i)).toBeInTheDocument());
  });
});
