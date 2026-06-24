// MaterialsRail — "Your materials" rail with upload + per-source delete/view/download
// (src/components/assistant/materials-rail.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug. The client's literal complaint was "the
// sources are not reachable for deleting them", so the DELETE flow is the headline:
// an INLINE arm→confirm (never a browser-suppressible native confirm), a spinner while
// the DELETE is in flight, a reload on success, an error on failure. Plus the rail
// publishes the source COUNT the dashboard trusts, and only offers a download when the
// original is actually stored. The cases pin each:
//   • loading → "Loading…"; empty → the empty-bucket copy
//   • a populated load lists uploaded docs + structured tables + (demo) bundled sources
//   • the source count = uploaded + tables + bundled
//   • dispatches nucleus:docs with {uploaded: docs+tables, bundled, high}
//   • a doc with NO stored original shows the disabled download (no dead 404 link)
//   • delete is a TWO-STEP inline confirm: arm → Delete/Cancel; Cancel disarms
//   • confirming → DELETE issued, list reloads
//   • a failed DELETE surfaces the error, leaves the source in the list
//   • the bundled-source delete is admin-ONLY (hidden for a non-admin)
//
// We stub /api/documents (load), /api/documents/file (HEAD retrievability probe),
// /api/ingest (the child UploadButton's GET-limits call) and the DELETE.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MaterialsRail } from "@/components/assistant/materials-rail";
import { mockFetch } from "./helpers";

const INGEST_LIMITS = { json: { maxMb: 25, formats: ["pdf", "csv", "xlsx", "docx"] } };

function docsBody(over: Record<string, unknown> = {}) {
  return {
    documents: [{ doc: "d1", label: "Lease.pdf", urgency: "high", lang: "en", pages: 4 }],
    structuredTables: [{ doc: "t1", label: "maintenance.csv", rows: 34, detail: "34 rows · 6 cols" }],
    bundled: [],
    role: "member",
    ...over,
  };
}

// Default stub: a load with one doc + one table, the doc's original retrievable, the
// upload limits, and a DELETE handler. `onDelete` lets a test capture/branch the DELETE.
function stub(opts: {
  docs?: Record<string, unknown>;
  retrievable?: boolean;
  onDelete?: (url: string) => Parameters<typeof mockFetch>[0][string];
} = {}) {
  const { docs = docsBody(), retrievable = true, onDelete } = opts;
  return mockFetch({
    "/api/documents/file": { ok: retrievable, status: retrievable ? 200 : 404, json: {} },
    "/api/documents": (url, init) => {
      if (init?.method === "DELETE") {
        return (onDelete ? onDelete(url) : { json: { ok: true } }) as never;
      }
      return { json: docs };
    },
    "/api/ingest": INGEST_LIMITS,
  });
}

describe("MaterialsRail", () => {
  beforeEach(() => vi.useRealTimers());

  it("shows Loading… before the first load resolves", async () => {
    mockFetch({
      "/api/documents/file": { ok: true, json: {} },
      "/api/documents": { pending: true },
      "/api/ingest": INGEST_LIMITS,
    });
    render(<MaterialsRail />);
    // The documents fetch never resolves → the materials list stays in its Loading state.
    // (waitFor lets the child UploadButton's GET-limits state settle so there's no
    // post-assertion act warning; the rail itself is still loading.)
    await waitFor(() => expect(screen.getByText("Loading…")).toBeInTheDocument());
    expect(screen.queryByTestId("doc-row-d1")).not.toBeInTheDocument();
  });

  it("renders the empty-bucket copy when there are no materials", async () => {
    stub({ docs: docsBody({ documents: [], structuredTables: [], bundled: [] }) });
    render(<MaterialsRail />);
    await waitFor(() => expect(screen.getByText(/No materials yet/i)).toBeInTheDocument());
    expect(screen.getByText("0 sources")).toBeInTheDocument();
  });

  it("lists uploaded docs + structured tables and a correct source count", async () => {
    stub();
    render(<MaterialsRail />);
    await waitFor(() => expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument());
    expect(screen.getByTestId("doc-name-d1")).toHaveTextContent("Lease.pdf");
    expect(screen.getByTestId("table-row-t1")).toBeInTheDocument();
    expect(screen.getByTestId("table-name-t1")).toHaveTextContent("maintenance.csv");
    // 1 doc + 1 table + 0 bundled.
    expect(screen.getByText("2 sources")).toBeInTheDocument();
  });

  it("publishes nucleus:docs with the raw counts (uploaded = docs + tables) and high-urgency", async () => {
    let detail: { uploaded: number; bundled: number; high: number } | null = null;
    const onDocs = (e: Event) => {
      detail = (e as CustomEvent).detail;
    };
    window.addEventListener("nucleus:docs", onDocs);
    stub({
      docs: docsBody({
        documents: [
          { doc: "d1", label: "Lease.pdf", urgency: "high" },
          { doc: "d2", label: "Memo.pdf", urgency: "low" },
        ],
        structuredTables: [{ doc: "t1", label: "m.csv", rows: 3, detail: "3 rows" }],
        bundled: [{ doc: "b1", label: "sample", kind: "document", detail: "x", urgency: "high" }],
      }),
    });
    render(<MaterialsRail />);
    await waitFor(() => expect(detail).not.toBeNull());
    // uploaded = 2 docs + 1 table = 3; bundled = 1; high = 1 doc + 1 bundled = 2.
    expect(detail).toEqual({ uploaded: 3, bundled: 1, high: 2 });
    window.removeEventListener("nucleus:docs", onDocs);
  });

  it("offers a real download when the original is stored, a DISABLED one when it isn't", async () => {
    // Retrievable → an active download button.
    stub({ retrievable: true });
    const { unmount } = render(<MaterialsRail />);
    await waitFor(() => expect(screen.getByTestId("doc-download-d1")).toBeInTheDocument());
    expect(screen.queryByTestId("doc-no-original-d1")).not.toBeInTheDocument();
    unmount();

    // Not retrievable → the disabled "no original" affordance (no dead 404 link).
    stub({ retrievable: false });
    render(<MaterialsRail />);
    await waitFor(() => expect(screen.getByTestId("doc-no-original-d1")).toBeInTheDocument());
    expect(screen.queryByTestId("doc-download-d1")).not.toBeInTheDocument();
  });

  it("delete is a two-step INLINE confirm: arm → Delete/Cancel, and Cancel disarms", async () => {
    stub();
    render(<MaterialsRail />);
    await waitFor(() => expect(screen.getByTestId("doc-remove-d1")).toBeInTheDocument());

    // Disarmed: the Delete button is present, the confirm is not.
    expect(screen.queryByTestId("doc-remove-d1-confirm")).not.toBeInTheDocument();

    // Arm it.
    await userEvent.click(screen.getByTestId("doc-remove-d1"));
    expect(screen.getByTestId("doc-remove-d1-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("doc-remove-d1-yes")).toBeInTheDocument();

    // Cancel disarms (no native dialog involved at any point).
    await userEvent.click(screen.getByTestId("doc-remove-d1-no"));
    expect(screen.queryByTestId("doc-remove-d1-confirm")).not.toBeInTheDocument();
  });

  it("confirming a delete issues the DELETE and reloads the list", async () => {
    let deleteUrl: string | null = null;
    let loadCount = 0;
    const fetchFn = mockFetch({
      "/api/documents/file": { ok: true, json: {} },
      "/api/documents": (url, init) => {
        if (init?.method === "DELETE") {
          deleteUrl = url;
          return { json: { ok: true } };
        }
        loadCount += 1;
        // After the delete, the doc is gone from the reloaded list.
        return { json: loadCount === 1 ? docsBody() : docsBody({ documents: [] }) };
      },
      "/api/ingest": INGEST_LIMITS,
    });
    render(<MaterialsRail />);
    await waitFor(() => expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("doc-remove-d1"));
    await userEvent.click(screen.getByTestId("doc-remove-d1-yes"));

    // The DELETE went out with the right doc + scope...
    await waitFor(() => expect(deleteUrl).toContain("doc=d1"));
    expect(deleteUrl).toContain("scope=upload");
    // ...and the reloaded list no longer shows the deleted doc.
    await waitFor(() => expect(screen.queryByTestId("doc-row-d1")).not.toBeInTheDocument());
    expect(fetchFn).toHaveBeenCalled();
  });

  it("a FAILED delete surfaces the error and leaves the source in the list", async () => {
    stub({
      onDelete: () => ({ ok: false, status: 500, json: { error: "could not delete source" } }),
    });
    render(<MaterialsRail />);
    await waitFor(() => expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("doc-remove-d1"));
    await userEvent.click(screen.getByTestId("doc-remove-d1-yes"));

    await waitFor(() => expect(screen.getByText(/could not delete source/)).toBeInTheDocument());
    // The source is still there (the delete didn't succeed).
    expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument();
  });

  it("the bundled-source delete is admin-only (hidden for a non-admin member)", async () => {
    // A demo member sees the bundled source but NO admin remove control.
    stub({
      docs: docsBody({
        documents: [],
        structuredTables: [],
        bundled: [{ doc: "b1", label: "Sample contract", kind: "document", detail: "demo", urgency: null }],
        role: "member",
      }),
    });
    const { unmount } = render(<MaterialsRail />);
    await waitFor(() => expect(screen.getByTestId("bundled-row-b1")).toBeInTheDocument());
    expect(screen.queryByTestId("bundled-remove-b1")).not.toBeInTheDocument();
    unmount();

    // An admin DOES get the remove control on the same bundled source.
    stub({
      docs: docsBody({
        documents: [],
        structuredTables: [],
        bundled: [{ doc: "b1", label: "Sample contract", kind: "document", detail: "demo", urgency: null }],
        role: "admin",
      }),
    });
    render(<MaterialsRail />);
    await waitFor(() => expect(screen.getByTestId("bundled-row-b1")).toBeInTheDocument());
    expect(screen.getByTestId("bundled-remove-b1")).toBeInTheDocument();
  });

  it("a load failure shows the 'Couldn't load materials' error", async () => {
    mockFetch({
      "/api/documents/file": { ok: true, json: {} },
      "/api/documents": { ok: false, status: 500, json: { error: "documents table missing" } },
      "/api/ingest": INGEST_LIMITS,
    });
    render(<MaterialsRail />);
    await waitFor(() => expect(screen.getByText(/Couldn’t load materials/)).toBeInTheDocument());
    expect(screen.getByText(/documents table missing/)).toBeInTheDocument();
  });

  it("renders the language + pages + urgency metadata chips for a doc", async () => {
    stub();
    render(<MaterialsRail />);
    await waitFor(() => expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument());
    const row = screen.getByTestId("doc-row-d1");
    expect(within(row).getByTestId("doc-lang-en")).toHaveTextContent("EN");
    expect(within(row).getByTestId("doc-pages-d1")).toHaveTextContent("4 pages");
    expect(within(row).getByTestId("doc-urgency-d1")).toBeInTheDocument();
  });
});
