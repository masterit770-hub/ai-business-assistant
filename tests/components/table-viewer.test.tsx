// TableViewer — the [S]-table modal viewer (src/components/assistant/table-viewer.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug. Promises:
//   • loads a page of real columns + rows from GET /api/table and renders them
//   • paging: Prev disabled on page 1; Next disabled when !hasMore; advancing requests
//     the next offset and updates the "from–to of total" range honestly
//   • Export CSV opens the ?format=csv endpoint (the whole table, not the page)
//   • error / empty / loading states render (never a blank black box)
//   • Escape + the close button close the modal
// We mock ONLY fetch + window.open — never the viewer's own paging state machine.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TableViewer } from "@/components/assistant/table-viewer";
import { mockFetch } from "./helpers";

const COLUMNS = [{ name: "vendor", type: "TEXT" }, { name: "amount", type: "INTEGER" }];
function pageAt(offset: number, total = 120) {
  const rows = Array.from({ length: Math.min(50, total - offset) }, (_, i) => ({
    vendor: `V${offset + i}`,
    amount: (offset + i) * 10,
  }));
  return { table: "maintenance", kind: "bundled", columns: COLUMNS, rows, total, limit: 50, offset, hasMore: offset + rows.length < total };
}

describe("TableViewer", () => {
  beforeEach(() => { window.open = vi.fn() as unknown as typeof window.open; });
  afterEach(() => vi.restoreAllMocks());

  it("loads and renders the real columns + rows", async () => {
    mockFetch({ "/api/table": { json: pageAt(0) } });
    render(<TableViewer table="maintenance" label="Maintenance" onClose={() => {}} />);
    const grid = await screen.findByTestId("table-viewer-grid");
    expect(within(grid).getByText("vendor")).toBeInTheDocument();
    expect(within(grid).getByText("amount")).toBeInTheDocument();
    expect(within(grid).getByText("V0")).toBeInTheDocument();
  });

  it("Prev is disabled on the first page; Next is enabled when there's more", async () => {
    mockFetch({ "/api/table": { json: pageAt(0) } });
    render(<TableViewer table="maintenance" label="Maintenance" onClose={() => {}} />);
    await screen.findByTestId("table-viewer-grid");
    expect(screen.getByTestId("table-viewer-prev")).toBeDisabled();
    expect(screen.getByTestId("table-viewer-next")).toBeEnabled();
    expect(screen.getByTestId("table-viewer-range")).toHaveTextContent(/1–50 of 120/);
  });

  it("Next requests the next offset and updates the range", async () => {
    const seenOffsets: string[] = [];
    mockFetch({
      "/api/table": (url) => {
        const off = Number(new URL(url, "http://x").searchParams.get("offset") ?? "0");
        seenOffsets.push(String(off));
        return { json: pageAt(off) };
      },
    });
    render(<TableViewer table="maintenance" label="Maintenance" onClose={() => {}} />);
    await screen.findByTestId("table-viewer-grid");
    await userEvent.click(screen.getByTestId("table-viewer-next"));
    await waitFor(() => expect(screen.getByTestId("table-viewer-range")).toHaveTextContent(/51–100 of 120/));
    expect(seenOffsets).toContain("50");
    // now Prev is enabled
    expect(screen.getByTestId("table-viewer-prev")).toBeEnabled();
  });

  it("Next is disabled on the LAST page (no fake 'more')", async () => {
    // a single page covering the whole (small) table
    mockFetch({ "/api/table": { json: { table: "t", kind: "bundled", columns: COLUMNS, rows: [{ vendor: "A", amount: 1 }], total: 1, limit: 50, offset: 0, hasMore: false } } });
    render(<TableViewer table="t" label="T" onClose={() => {}} />);
    await screen.findByTestId("table-viewer-grid");
    expect(screen.getByTestId("table-viewer-next")).toBeDisabled();
    expect(screen.getByTestId("table-viewer-prev")).toBeDisabled();
  });

  it("Export CSV opens the ?format=csv endpoint (the whole table)", async () => {
    mockFetch({ "/api/table": { json: pageAt(0) } });
    render(<TableViewer table="maintenance" label="Maintenance" onClose={() => {}} />);
    await screen.findByTestId("table-viewer-grid");
    await userEvent.click(screen.getByTestId("table-export-csv"));
    expect(window.open).toHaveBeenCalledWith(expect.stringContaining("format=csv"), "_blank", "noopener");
    expect((window.open as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("table=maintenance");
  });

  it("an error from the endpoint renders an honest message, not a blank grid", async () => {
    mockFetch({ "/api/table": { ok: false, status: 404, json: { error: "table not found" } } });
    render(<TableViewer table="ghost" label="Ghost" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/table not found/)).toBeInTheDocument());
    expect(screen.queryByTestId("table-viewer-grid")).not.toBeInTheDocument();
  });

  it("an empty table shows 'no rows' rather than an empty grid", async () => {
    mockFetch({ "/api/table": { json: { table: "t", kind: "bundled", columns: COLUMNS, rows: [], total: 0, limit: 50, offset: 0, hasMore: false } } });
    render(<TableViewer table="t" label="T" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no rows/i)).toBeInTheDocument());
  });

  it("Escape and the close button both close the modal", async () => {
    mockFetch({ "/api/table": { json: pageAt(0) } });
    const onClose = vi.fn();
    render(<TableViewer table="maintenance" label="Maintenance" onClose={onClose} />);
    await screen.findByTestId("table-viewer-grid");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId("table-viewer-close"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
