// AnswerSetup — the inline strip above the chat input (src/components/assistant/answer-setup.tsx).
//
// THE BAR: pass ⇒ a user can't find a UI-state bug here. The headline risk is the
// "Saved"-lie this component was BUILT to fix: a failed PUT must NEVER read as success.
// So the cases pin the save state machine at every branch a real user hits:
//   • the active preset is derived from the loaded prompt (General / Analysis / Custom)
//   • clicking a preset PUTs that prompt and shows "Saved" ONLY on a 2xx
//   • a 4xx/5xx save shows a real error and NO "Saved" (the silent-failure bug)
//   • a network REJECT shows an error and NO "Saved"
//   • the inline editor toggles, edits update the textarea, Save persists the edited text
//   • the Save/preset buttons are disabled while a save is in flight
//   • editing to an off-preset string flips the active label to "Custom"
//
// We render the REAL component. ModelSwitch is a child here; it makes its own
// /api/settings GET, which our fetch stub serves so the strip mounts cleanly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnswerSetup , PRESETS} from "@/components/assistant/answer-setup";
import { mockFetch } from "./helpers";

// The REAL preset strings, imported from the component — never duplicate them here
// (a duplicated copy silently diverges on rebrand: exactly what broke this file once).
const GENERAL_PROMPT = PRESETS.general.prompt;
const ANALYSIS_PROMPT = PRESETS.analysis.prompt;

// Stub /api/me (the strip's prompt load) + /api/settings (the child ModelSwitch).
function stubLoad(prompt: string, putResponse?: (init?: RequestInit) => Parameters<typeof mockFetch>[0][string]) {
  return mockFetch({
    "/api/me": { json: { system_prompt: prompt } },
    "/api/settings": (_url, init) => {
      if (init?.method === "PUT" && putResponse) return putResponse(init) as never;
      return { json: { model_mode: "cloud", local_endpoint: "" } };
    },
  });
}

describe("AnswerSetup", () => {
  beforeEach(() => vi.useRealTimers());

  it("derives the active preset from the loaded prompt", async () => {
    stubLoad(ANALYSIS_PROMPT);
    render(<AnswerSetup />);
    // Analysis is pressed; General is not.
    await waitFor(() =>
      expect(screen.getByTestId("preset-analysis")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByTestId("preset-general")).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the Custom label when the loaded prompt matches no preset", async () => {
    stubLoad("Be a pirate. Answer in shanties.");
    render(<AnswerSetup />);
    await waitFor(() => expect(screen.getByText("Custom")).toBeInTheDocument());
    expect(screen.getByTestId("preset-general")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("preset-analysis")).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking a preset PUTs that prompt and shows Saved ONLY on a 2xx", async () => {
    let putBody: Record<string, unknown> | null = null;
    stubLoad(GENERAL_PROMPT, (init) => {
      putBody = JSON.parse(init!.body as string);
      return { json: { ok: true } };
    });
    render(<AnswerSetup />);
    await waitFor(() => expect(screen.getByTestId("preset-general")).toHaveAttribute("aria-pressed", "true"));

    // The editor is open so the "Saved" badge (editor-scoped) is visible on success.
    await userEvent.click(screen.getByTestId("edit-prompt-toggle"));
    await userEvent.click(screen.getByTestId("preset-analysis"));

    expect(putBody).toEqual({ system_prompt: ANALYSIS_PROMPT });
    await waitFor(() => expect(screen.getByTestId("answer-setup-saved")).toBeInTheDocument());
    // No error surfaced.
    expect(screen.queryByTestId("answer-setup-error")).not.toBeInTheDocument();
    // The active preset moved to Analysis (the value was adopted only after the 2xx).
    expect(screen.getByTestId("preset-analysis")).toHaveAttribute("aria-pressed", "true");
  });

  it("a 4xx/5xx save shows a REAL error and never 'Saved' (the silent-failure bug)", async () => {
    // RED-first guard: this is the exact lie the component exists to prevent.
    stubLoad(GENERAL_PROMPT, () => ({ ok: false, status: 500, json: { error: "database is down" } }));
    render(<AnswerSetup />);
    await waitFor(() => expect(screen.getByTestId("preset-general")).toHaveAttribute("aria-pressed", "true"));

    await userEvent.click(screen.getByTestId("preset-analysis"));

    // The route's real reason is surfaced...
    await waitFor(() => expect(screen.getByTestId("answer-setup-error")).toHaveTextContent("database is down"));
    // ...and NO success badge appears, and the active preset did NOT move (value not adopted).
    expect(screen.queryByTestId("answer-setup-saved")).not.toBeInTheDocument();
    expect(screen.getByTestId("preset-general")).toHaveAttribute("aria-pressed", "true");
  });

  it("a network REJECT shows an error and never 'Saved'", async () => {
    stubLoad(GENERAL_PROMPT, () => ({ reject: new Error("Failed to fetch") }));
    render(<AnswerSetup />);
    await waitFor(() => expect(screen.getByTestId("preset-general")).toHaveAttribute("aria-pressed", "true"));

    await userEvent.click(screen.getByTestId("preset-analysis"));

    await waitFor(() => expect(screen.getByTestId("answer-setup-error")).toBeInTheDocument());
    expect(screen.queryByTestId("answer-setup-saved")).not.toBeInTheDocument();
  });

  it("the inline editor toggles open/closed and edits the textarea", async () => {
    stubLoad(GENERAL_PROMPT);
    render(<AnswerSetup />);
    await waitFor(() => expect(screen.getByTestId("preset-general")).toBeInTheDocument());

    expect(screen.queryByTestId("inline-prompt-editor")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("edit-prompt-toggle"));
    expect(screen.getByTestId("inline-prompt-editor")).toBeInTheDocument();

    const ta = screen.getByTestId("inline-prompt") as HTMLTextAreaElement;
    await userEvent.clear(ta);
    await userEvent.type(ta, "Custom voice here");
    expect(ta.value).toBe("Custom voice here");

    await userEvent.click(screen.getByTestId("edit-prompt-toggle"));
    expect(screen.queryByTestId("inline-prompt-editor")).not.toBeInTheDocument();
  });

  it("editing to an off-preset string flips the active label to Custom", async () => {
    stubLoad(GENERAL_PROMPT);
    render(<AnswerSetup />);
    await waitFor(() => expect(screen.getByTestId("preset-general")).toHaveAttribute("aria-pressed", "true"));

    await userEvent.click(screen.getByTestId("edit-prompt-toggle"));
    const ta = screen.getByTestId("inline-prompt") as HTMLTextAreaElement;
    await userEvent.clear(ta);
    await userEvent.type(ta, "totally different");

    // The General preset is no longer the active one; the Custom chip shows.
    expect(screen.getByTestId("preset-general")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });

  it("Save in the editor persists the EDITED text (not the preset)", async () => {
    let putBody: Record<string, unknown> | null = null;
    stubLoad(GENERAL_PROMPT, (init) => {
      putBody = JSON.parse(init!.body as string);
      return { json: { ok: true } };
    });
    render(<AnswerSetup />);
    await waitFor(() => expect(screen.getByTestId("preset-general")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("edit-prompt-toggle"));
    const ta = screen.getByTestId("inline-prompt") as HTMLTextAreaElement;
    await userEvent.clear(ta);
    await userEvent.type(ta, "My bespoke prompt");
    await userEvent.click(screen.getByTestId("save-prompt"));

    expect(putBody).toEqual({ system_prompt: "My bespoke prompt" });
    await waitFor(() => expect(screen.getByTestId("answer-setup-saved")).toBeInTheDocument());
  });

  it("disables the preset + save buttons while a save is in flight", async () => {
    // PUT never resolves → saving=true stays → controls disabled (no double-submit).
    stubLoad(GENERAL_PROMPT, () => ({ pending: true }));
    render(<AnswerSetup />);
    await waitFor(() => expect(screen.getByTestId("preset-general")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("edit-prompt-toggle"));
    await userEvent.click(screen.getByTestId("save-prompt"));

    await waitFor(() => expect(screen.getByTestId("save-prompt")).toBeDisabled());
    expect(screen.getByTestId("preset-general")).toBeDisabled();
    expect(screen.getByTestId("preset-analysis")).toBeDisabled();
  });

  it("renders without crashing when /api/me has no prompt (falls back to empty → no preset active)", async () => {
    mockFetch({
      "/api/me": { json: {} },
      "/api/settings": { json: { model_mode: "cloud", local_endpoint: "" } },
    });
    render(<AnswerSetup />);
    await waitFor(() => expect(screen.getByTestId("answer-setup")).toBeInTheDocument());
    // Empty prompt → "" matches no preset → Custom shows, neither preset pressed.
    const strip = screen.getByTestId("answer-setup");
    expect(within(strip).getByText("Custom")).toBeInTheDocument();
  });
});
