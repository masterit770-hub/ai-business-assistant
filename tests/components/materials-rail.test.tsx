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

// The setup.ts already mocks next/navigation globally (useRouter, useSearchParams, etc.).
// We extend it here so useRouter returns OUR trackable mockPush for the navigation tests.
// vi.hoisted() ensures mockPush is initialized before the mock factory runs (Vitest
// hoists vi.mock calls above all other module-level code).
const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard",
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

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
  beforeEach(() => {
    vi.useRealTimers();
    mockPush.mockClear();
  });

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

// ─── Global mode ─────────────────────────────────────────────────────────────
// RED-first verified: tests below were confirmed to fail before the global-mode
// code was added to MaterialsRail (the "Upload inside a chat" note, chatLabel
// badge, and click-to-navigate behavior didn't exist before this build).

describe("MaterialsRail — global mode", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockPush.mockClear();
  });

  it("shows NO upload control in global mode", async () => {
    mockFetch({
      "/api/documents/file": { ok: true, json: {} },
      "/api/documents": { json: docsBody() },
    });
    render(<MaterialsRail mode="global" />);
    await waitFor(() => expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument());
    // No upload panel in global mode.
    expect(screen.queryByText(/Upload PDF or spreadsheet/i)).not.toBeInTheDocument();
    // Informational note is present instead.
    expect(screen.getByText(/Upload inside a chat/i)).toBeInTheDocument();
  });

  it("shows chat labels on each doc row in global mode", async () => {
    mockFetch({
      "/api/documents/file": { ok: true, json: {} },
      "/api/documents": {
        json: docsBody({
          documents: [
            { doc: "d1", label: "Lease.pdf", urgency: null, lang: "en", pages: 2,
              session_id: "sess-1", chatLabel: "Contract review" },
          ],
        }),
      },
    });
    render(<MaterialsRail mode="global" />);
    await waitFor(() => expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument());
    // The chat label appears in the metadata row.
    const row = screen.getByTestId("doc-row-d1");
    expect(within(row).getByText(/Contract review/i)).toBeInTheDocument();
  });

  it('shows "Unassigned" for docs with null session_id/chatLabel in global mode', async () => {
    mockFetch({
      "/api/documents/file": { ok: true, json: {} },
      "/api/documents": {
        json: docsBody({
          documents: [
            { doc: "d1", label: "Orphan.pdf", urgency: null, lang: "en", pages: 1,
              session_id: null, chatLabel: null },
          ],
        }),
      },
    });
    render(<MaterialsRail mode="global" />);
    await waitFor(() => expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument());
    const row = screen.getByTestId("doc-row-d1");
    expect(within(row).getByText(/Unassigned/i)).toBeInTheDocument();
  });

  it("clicking a doc row name with a session_id navigates to /dashboard?session=<id> in global mode", async () => {
    mockFetch({
      "/api/documents/file": { ok: true, json: {} },
      "/api/documents": {
        json: docsBody({
          documents: [
            { doc: "d1", label: "Lease.pdf", urgency: null, lang: "en", pages: 2,
              session_id: "sess-abc", chatLabel: "My chat" },
          ],
        }),
      },
    });
    render(<MaterialsRail mode="global" />);
    await waitFor(() => expect(screen.getByTestId("doc-name-d1")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("doc-name-d1"));
    expect(mockPush).toHaveBeenCalledWith("/dashboard?session=sess-abc");
  });
});

// ─── Chat mode ────────────────────────────────────────────────────────────────

describe("MaterialsRail — chat mode", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockPush.mockClear();
  });

  it("shows upload control in chat mode", async () => {
    mockFetch({
      "/api/documents/file": { ok: true, json: {} },
      "/api/documents": { json: docsBody() },
      "/api/ingest": INGEST_LIMITS,
    });
    render(<MaterialsRail mode="chat" sessionId="sess-1" />);
    await waitFor(() => expect(screen.getByText(/Upload PDF or spreadsheet/i)).toBeInTheDocument());
    // And no "Upload inside a chat" note (that's global-mode only).
    expect(screen.queryByText(/Upload inside a chat/i)).not.toBeInTheDocument();
  });

  it("fetches with session_id param in chat mode", async () => {
    let capturedUrl: string | null = null;
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/documents") && !url.includes("/file")) {
        if (!init?.method || init?.method === "GET") capturedUrl = url;
      }
      // Minimal stubs.
      if (url.includes("/api/documents/file")) return { ok: true, status: 200, json: async () => ({}) } as Response;
      if (url.includes("/api/documents")) return { ok: true, status: 200, json: async () => docsBody() } as Response;
      if (url.includes("/api/ingest")) return { ok: true, status: 200, json: async () => INGEST_LIMITS.json } as Response;
      throw new Error(`mockFetch: no stub for ${url}`);
    });
    global.fetch = fn as unknown as typeof fetch;

    render(<MaterialsRail mode="chat" sessionId="sess-1" />);
    await waitFor(() => expect(capturedUrl).not.toBeNull());
    expect(capturedUrl).toContain("session_id=sess-1");
  });

  it("does NOT show chat labels in chat mode", async () => {
    mockFetch({
      "/api/documents/file": { ok: true, json: {} },
      "/api/documents": {
        json: docsBody({
          documents: [
            { doc: "d1", label: "Lease.pdf", urgency: null, lang: "en", pages: 2,
              session_id: "sess-1", chatLabel: "My chat" },
          ],
        }),
      },
      "/api/ingest": INGEST_LIMITS,
    });
    render(<MaterialsRail mode="chat" sessionId="sess-1" />);
    await waitFor(() => expect(screen.getByTestId("doc-row-d1")).toBeInTheDocument());
    // In chat mode, no "Chat:" label appears on the row.
    expect(screen.queryByText(/Chat:/i)).not.toBeInTheDocument();
  });
});
