// BundledDocs — the "Built-in business data" section (src/components/bundled-docs.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug. Promises:
//   • lists the bundled sources and publishes its count via nucleus:bundled
//   • the remove button is ADMIN-ONLY (a member never sees it — the UI privilege boundary)
//   • remove is CONFIRM-gated and DELETEs with scope=bundled + the source's kind
//   • renders nothing when there are no bundled sources (a clean client bucket)
// We mock ONLY fetch + window.confirm — never the component's own state machine.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BundledDocs } from "@/components/bundled-docs";
import { mockFetch } from "./helpers";

const BUNDLED = [
  { doc: "contracts", label: "Contracts", kind: "structured", detail: "table · 12 rows" },
  { doc: "family-court", label: "Family Court", kind: "document", detail: "PDF" },
];

describe("BundledDocs", () => {
  beforeEach(() => vi.spyOn(window, "confirm").mockReturnValue(true));
  afterEach(() => vi.restoreAllMocks());

  it("lists the bundled sources and publishes its count via nucleus:bundled", async () => {
    const onBundled = vi.fn();
    window.addEventListener("nucleus:bundled", onBundled as EventListener);
    mockFetch({ "/api/documents": { json: { bundled: BUNDLED, role: "user" } } });
    render(<BundledDocs />);
    await waitFor(() => expect(screen.getByTestId("bundled-row-contracts")).toBeInTheDocument());
    await waitFor(() =>
      expect(onBundled).toHaveBeenCalledWith(expect.objectContaining({ detail: { count: 2 } })),
    );
    window.removeEventListener("nucleus:bundled", onBundled as EventListener);
  });

  it("a MEMBER never sees the remove button (the UI privilege boundary)", async () => {
    mockFetch({ "/api/documents": { json: { bundled: BUNDLED, role: "user" } } });
    render(<BundledDocs />);
    await waitFor(() => expect(screen.getByTestId("bundled-row-contracts")).toBeInTheDocument());
    expect(screen.queryByTestId("bundled-remove-contracts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bundled-remove-family-court")).not.toBeInTheDocument();
  });

  it("an ADMIN sees the remove button on each row", async () => {
    mockFetch({ "/api/documents": { json: { bundled: BUNDLED, role: "admin" } } });
    render(<BundledDocs />);
    await waitFor(() => expect(screen.getByTestId("bundled-remove-contracts")).toBeInTheDocument());
  });

  it("an admin remove DELETEs with scope=bundled and the source's kind", async () => {
    let deleteUrl: string | null = null;
    let bundled = [...BUNDLED];
    mockFetch({
      "/api/documents": (url, init) => {
        if (init?.method === "DELETE") {
          deleteUrl = url;
          bundled = bundled.filter((b) => !url.includes(`doc=${b.doc}`) || b.doc !== "contracts");
          return { ok: true, json: { ok: true } };
        }
        return { json: { bundled, role: "admin" } };
      },
    });
    render(<BundledDocs />);
    await waitFor(() => expect(screen.getByTestId("bundled-remove-contracts")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("bundled-remove-contracts"));
    expect(deleteUrl).toContain("doc=contracts");
    expect(deleteUrl).toContain("scope=bundled");
    expect(deleteUrl).toContain("kind=structured");
  });

  it("a cancelled confirm makes NO delete request", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const fn = mockFetch({ "/api/documents": { json: { bundled: BUNDLED, role: "admin" } } });
    render(<BundledDocs />);
    await waitFor(() => expect(screen.getByTestId("bundled-remove-contracts")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("bundled-remove-contracts"));
    expect(fn.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });

  it("renders nothing when there are no bundled sources (a clean client bucket)", async () => {
    mockFetch({ "/api/documents": { json: { bundled: [], role: "user" } } });
    const { container } = render(<BundledDocs />);
    // the component returns null for an empty list — no bundled-docs panel
    await waitFor(() => expect(screen.queryByTestId("bundled-docs")).not.toBeInTheDocument());
    expect(container.querySelector('[data-testid="bundled-docs"]')).toBeNull();
  });
});
