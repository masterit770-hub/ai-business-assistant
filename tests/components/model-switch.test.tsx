// ModelSwitch — the Cloud ⇄ HIPAA ⇄ Local segmented control (src/components/model-switch.tsx).
//
// THE BAR: if these pass, a user can't find a UI-state bug in this switch. The switch
// makes one promise to a non-technical owner — "the highlighted side is the backend that
// will actually answer your next question." So the cases below pin exactly that promise
// at every branch of its little state machine:
//   • it renders NOTHING until the caller's own mode has loaded (no flash of a wrong default)
//   • the loaded mode is the highlighted one, with the matching plain-language blurb
//   • clicking a side optimistically flips, PUTs model_mode, and CONFIRMS from the echo
//   • the server's CONFIRMED mode wins over the optimistic guess (server says hipaa → hipaa)
//   • a failed PUT ROLLS BACK so the highlight never lies about the live backend
//   • the in-flight side shows a spinner and re-clicking the active side is a no-op
//   • the "set up Local" hint shows only when Local is active AND no endpoint is configured
//   • a load error leaves the component hidden rather than rendering a wrong default

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelSwitch } from "@/components/model-switch";
import { mockFetch } from "./helpers";

// A GET /api/settings body. Defaults to cloud with no local endpoint.
function settings(over: Record<string, unknown> = {}) {
  return { model_mode: "cloud", local_endpoint: "", ...over };
}

describe("ModelSwitch", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing until the caller's own mode has loaded (no wrong-default flash)", () => {
    // GET never resolves → mode stays null → the whole control is hidden.
    mockFetch({ "/api/settings": { pending: true } });
    const { container } = render(<ModelSwitch />);
    expect(screen.queryByTestId("model-switch")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("highlights the LOADED mode and shows its plain-language blurb", async () => {
    mockFetch({ "/api/settings": { json: settings({ model_mode: "hipaa" }) } });
    render(<ModelSwitch />);

    await waitFor(() => expect(screen.getByTestId("model-switch")).toBeInTheDocument());
    // The active mode is reflected on the wrapper AND the pressed segment.
    expect(screen.getByTestId("model-switch")).toHaveAttribute("data-mode", "hipaa");
    expect(screen.getByTestId("model-switch-hipaa")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("model-switch-cloud")).toHaveAttribute("data-active", "false");
    // The blurb matches the active mode (a non-technical owner reads what it means).
    expect(screen.getByTestId("model-switch-blurb")).toHaveTextContent(/Azure key/i);
  });

  it("clicking a side optimistically flips and PUTs model_mode, then confirms from the echo", async () => {
    let putBody: Record<string, unknown> | null = null;
    const fetchFn = mockFetch({
      "/api/settings": (_url, init) => {
        if (init?.method === "PUT") {
          putBody = JSON.parse(init.body as string);
          return { json: settings({ model_mode: "local", local_endpoint: "http://x:11434/v1" }) };
        }
        return { json: settings({ model_mode: "cloud" }) };
      },
    });
    render(<ModelSwitch />);
    await waitFor(() => expect(screen.getByTestId("model-switch")).toHaveAttribute("data-mode", "cloud"));

    await userEvent.click(screen.getByTestId("model-switch-local"));

    // It PUT the new mode...
    await waitFor(() => expect(putBody).toEqual({ model_mode: "local" }));
    // ...and the confirmed mode is live on the control.
    await waitFor(() => expect(screen.getByTestId("model-switch")).toHaveAttribute("data-mode", "local"));
    expect(screen.getByTestId("model-switch-local")).toHaveAttribute("data-active", "true");
    expect(fetchFn).toHaveBeenCalledTimes(2); // initial GET + the PUT
  });

  it("the SERVER's confirmed mode wins over the optimistic click", async () => {
    // The user clicks Local, but the server normalizes/echoes hipaa (e.g. a policy
    // override). The control must end on what the server actually stored, not the click.
    mockFetch({
      "/api/settings": (_url, init) =>
        init?.method === "PUT"
          ? { json: settings({ model_mode: "hipaa" }) }
          : { json: settings({ model_mode: "cloud" }) },
    });
    render(<ModelSwitch />);
    await waitFor(() => expect(screen.getByTestId("model-switch")).toHaveAttribute("data-mode", "cloud"));

    await userEvent.click(screen.getByTestId("model-switch-local"));

    await waitFor(() => expect(screen.getByTestId("model-switch")).toHaveAttribute("data-mode", "hipaa"));
  });

  it("a FAILED PUT rolls back so the highlight never lies about the live backend", async () => {
    // RED-first guard: if the rollback in catch{} were removed, the optimistic "local"
    // would stick and the switch would claim a backend the server never accepted.
    mockFetch({
      "/api/settings": (_url, init) =>
        init?.method === "PUT"
          ? { ok: false, status: 500, json: { error: "save failed" } }
          : { json: settings({ model_mode: "cloud" }) },
    });
    render(<ModelSwitch />);
    await waitFor(() => expect(screen.getByTestId("model-switch")).toHaveAttribute("data-mode", "cloud"));

    await userEvent.click(screen.getByTestId("model-switch-local"));

    // It must end back on the real, previously-saved mode — NOT the optimistic local.
    await waitFor(() => expect(screen.getByTestId("model-switch")).toHaveAttribute("data-mode", "cloud"));
    expect(screen.getByTestId("model-switch-cloud")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("model-switch-local")).toHaveAttribute("data-active", "false");
  });

  it("re-clicking the ALREADY-active side is a no-op (no redundant PUT)", async () => {
    const fetchFn = mockFetch({ "/api/settings": { json: settings({ model_mode: "cloud" }) } });
    render(<ModelSwitch />);
    await waitFor(() => expect(screen.getByTestId("model-switch")).toHaveAttribute("data-mode", "cloud"));

    await userEvent.click(screen.getByTestId("model-switch-cloud"));
    // Only the initial GET — no PUT was issued for the same-mode click.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("shows the 'set up Local' hint ONLY when Local is active and no endpoint is set", async () => {
    // Local active, endpoint missing → hint shown.
    mockFetch({ "/api/settings": { json: settings({ model_mode: "local", local_endpoint: "" }) } });
    const { unmount } = render(<ModelSwitch />);
    await waitFor(() => expect(screen.getByTestId("model-switch-hint")).toBeInTheDocument());
    unmount();

    // Local active WITH an endpoint → no hint.
    mockFetch({ "/api/settings": { json: settings({ model_mode: "local", local_endpoint: "http://x:11434/v1" }) } });
    render(<ModelSwitch />);
    await waitFor(() => expect(screen.getByTestId("model-switch")).toHaveAttribute("data-mode", "local"));
    expect(screen.queryByTestId("model-switch-hint")).not.toBeInTheDocument();
  });

  it("does NOT show the Local hint when Cloud is the active mode", async () => {
    mockFetch({ "/api/settings": { json: settings({ model_mode: "cloud", local_endpoint: "" }) } });
    render(<ModelSwitch />);
    await waitFor(() => expect(screen.getByTestId("model-switch")).toHaveAttribute("data-mode", "cloud"));
    expect(screen.queryByTestId("model-switch-hint")).not.toBeInTheDocument();
  });

  it("an errored settings load leaves the control HIDDEN (never a wrong default)", async () => {
    // GET returns { error } → the effect bails and mode stays null → nothing renders.
    mockFetch({ "/api/settings": { json: { error: "unauthorized" } } });
    render(<ModelSwitch />);
    // Give the effect a tick; it must not reveal the switch.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("model-switch")).not.toBeInTheDocument();
  });

  it("notifies the parent of the live mode via onModeChange (load + flip)", async () => {
    const onModeChange = vi.fn();
    mockFetch({
      "/api/settings": (_url, init) =>
        init?.method === "PUT"
          ? { json: settings({ model_mode: "hipaa" }) }
          : { json: settings({ model_mode: "cloud" }) },
    });
    render(<ModelSwitch onModeChange={onModeChange} />);
    await waitFor(() => expect(onModeChange).toHaveBeenCalledWith("cloud"));

    await userEvent.click(screen.getByTestId("model-switch-hipaa"));
    await waitFor(() => expect(onModeChange).toHaveBeenLastCalledWith("hipaa"));
  });
});
