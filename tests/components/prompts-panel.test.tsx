// PromptsPanel — Settings → Prompts (src/components/prompts-panel.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug. This panel's promise is "Save is enabled
// only when there's a real change, it persists ONLY the prompt keys, and it tells the
// truth about whether the engine stored it." The cases pin the dirty/save/reset machine:
//   • loads the live prompts on mount into both textareas
//   • Save + Reset are DISABLED until a field actually changes (dirty tracking)
//   • Save PUTs ONLY system_prompt + urgency_prompt (never model keys) and shows "Saved"
//   • the panel re-syncs to the server ECHO (a blank field falls back to the engine default)
//   • after a successful Save, dirty clears → Save disables again
//   • a failed Save surfaces the error and shows NO "Saved"
//   • a load failure surfaces the error message
//   • Reset clears both fields and persists empties (→ engine defaults)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptsPanel } from "@/components/prompts-panel";
import { mockFetch } from "./helpers";

const LOADED = { system_prompt: "Be helpful.", urgency_prompt: "Flag late invoices." };

describe("PromptsPanel", () => {
  beforeEach(() => vi.useRealTimers());

  it("loads the live prompts into both textareas on mount", async () => {
    mockFetch({ "/api/settings": { json: LOADED } });
    render(<PromptsPanel />);
    await waitFor(() => expect(screen.getByDisplayValue("Be helpful.")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Flag late invoices.")).toBeInTheDocument();
  });

  it("Save and Reset are DISABLED until a field actually changes", async () => {
    mockFetch({ "/api/settings": { json: LOADED } });
    render(<PromptsPanel />);
    await waitFor(() => expect(screen.getByDisplayValue("Be helpful.")).toBeInTheDocument());

    const save = screen.getByTestId("prompts-save");
    const reset = screen.getByRole("button", { name: /reset prompts to defaults/i });
    expect(save).toBeDisabled();
    expect(reset).toBeDisabled();

    // Edit the system prompt → both enable.
    const sys = screen.getByDisplayValue("Be helpful.");
    await userEvent.type(sys, " Always cite.");
    expect(save).toBeEnabled();
    expect(reset).toBeEnabled();
  });

  it("Save PUTs ONLY the prompt keys (never model keys) and shows 'Saved'", async () => {
    let putBody: Record<string, unknown> | null = null;
    mockFetch({
      "/api/settings": (_url, init) => {
        if (init?.method === "PUT") {
          putBody = JSON.parse(init.body as string);
          return { json: { system_prompt: "Be helpful. Always cite.", urgency_prompt: "Flag late invoices." } };
        }
        return { json: LOADED };
      },
    });
    render(<PromptsPanel />);
    await waitFor(() => expect(screen.getByDisplayValue("Be helpful.")).toBeInTheDocument());

    await userEvent.type(screen.getByDisplayValue("Be helpful."), " Always cite.");
    await userEvent.click(screen.getByTestId("prompts-save"));

    // Body carries exactly the two prompt keys — no model_mode / cloud_* leakage.
    expect(Object.keys(putBody ?? {}).sort()).toEqual(["system_prompt", "urgency_prompt"]);
    expect(putBody!.system_prompt).toBe("Be helpful. Always cite.");
    await waitFor(() => expect(screen.getByTestId("prompts-saved")).toBeInTheDocument());
  });

  it("re-syncs to the server ECHO and re-disables Save after a successful save", async () => {
    // The engine echoes the EFFECTIVE settings; a blank urgency falls back to a default.
    mockFetch({
      "/api/settings": (_url, init) =>
        init?.method === "PUT"
          ? { json: { system_prompt: "Edited persona.", urgency_prompt: "ENGINE DEFAULT URGENCY" } }
          : { json: LOADED },
    });
    render(<PromptsPanel />);
    await waitFor(() => expect(screen.getByDisplayValue("Be helpful.")).toBeInTheDocument());

    const sys = screen.getByDisplayValue("Be helpful.") as HTMLTextAreaElement;
    await userEvent.clear(sys);
    await userEvent.type(sys, "Edited persona.");
    await userEvent.click(screen.getByTestId("prompts-save"));

    // The echoed values are now in the fields, and Save is disabled (no longer dirty).
    await waitFor(() => expect(screen.getByDisplayValue("ENGINE DEFAULT URGENCY")).toBeInTheDocument());
    expect(screen.getByTestId("prompts-save")).toBeDisabled();
  });

  it("a FAILED save surfaces the error and shows NO 'Saved'", async () => {
    mockFetch({
      "/api/settings": (_url, init) =>
        init?.method === "PUT"
          ? { ok: false, status: 403, json: { error: "only admins can edit prompts" } }
          : { json: LOADED },
    });
    render(<PromptsPanel />);
    await waitFor(() => expect(screen.getByDisplayValue("Be helpful.")).toBeInTheDocument());

    await userEvent.type(screen.getByDisplayValue("Be helpful."), " x");
    await userEvent.click(screen.getByTestId("prompts-save"));

    await waitFor(() => expect(screen.getByText("only admins can edit prompts")).toBeInTheDocument());
    expect(screen.queryByTestId("prompts-saved")).not.toBeInTheDocument();
    // Still dirty (the edit wasn't accepted) → Save stays enabled for a retry.
    expect(screen.getByTestId("prompts-save")).toBeEnabled();
  });

  it("a load failure surfaces the error message", async () => {
    mockFetch({ "/api/settings": { json: { error: "engine unreachable" } } });
    render(<PromptsPanel />);
    await waitFor(() => expect(screen.getByText("engine unreachable")).toBeInTheDocument());
  });

  it("Reset clears both fields and persists empties (→ engine defaults)", async () => {
    let putBody: Record<string, unknown> | null = null;
    mockFetch({
      "/api/settings": (_url, init) => {
        if (init?.method === "PUT") {
          putBody = JSON.parse(init.body as string);
          // Engine echoes its built-in defaults for the blank fields.
          return { json: { system_prompt: "DEFAULT SYS", urgency_prompt: "DEFAULT URG" } };
        }
        return { json: LOADED };
      },
    });
    render(<PromptsPanel />);
    await waitFor(() => expect(screen.getByDisplayValue("Be helpful.")).toBeInTheDocument());

    // Make it dirty so Reset is enabled, then reset.
    await userEvent.type(screen.getByDisplayValue("Be helpful."), " x");
    await userEvent.click(screen.getByRole("button", { name: /reset prompts to defaults/i }));

    // It PUT empty strings for both prompt keys...
    expect(putBody).toEqual({ system_prompt: "", urgency_prompt: "" });
    // ...and re-synced to the engine defaults from the echo.
    await waitFor(() => expect(screen.getByDisplayValue("DEFAULT SYS")).toBeInTheDocument());
    expect(screen.getByDisplayValue("DEFAULT URG")).toBeInTheDocument();
  });
});
