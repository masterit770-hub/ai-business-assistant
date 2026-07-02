// ModelsPanel — Settings → Model (src/components/models-panel.tsx).
//
// THE BAR: pass ⇒ no findable UI-state bug. This panel carries the literal client bug
// ("entering an Azure key wiped the cloud key") and the secret-handling contract, so the
// cases pin: write-only api keys (never prefilled, "key saved" reflects the boolean,
// only SENT when newly typed), Save persisting ONLY the model keys, dirty tracking, the
// mode-gated setup hints, the local-model detect picker (reachable/empty/unreachable),
// and "Save & test connection" which SAVES FIRST then tests (the "it still says DeepSeek
// on Azure" bug). These are the branches a real owner walks.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelsPanel } from "@/components/models-panel";
import { mockFetch } from "./helpers";

// A GET /api/settings model payload. The api keys are returned only as *_set booleans.
function model(over: Record<string, unknown> = {}) {
  return {
    model_mode: "cloud",
    local_endpoint: "",
    local_model: "",
    cloud_provider: "",
    cloud_api_key_set: false,
    cloud_model: "",
    cloud_base_url: "",
    azure_endpoint: "",
    azure_api_version: "",
    hipaa_api_key_set: false,
    hipaa_endpoint: "",
    hipaa_api_version: "",
    hipaa_model: "",
    ...over,
  };
}

describe("ModelsPanel", () => {
  beforeEach(() => vi.useRealTimers());

  it("loads the live config and reflects the active mode; Save starts DISABLED (not dirty)", async () => {
    mockFetch({ "/api/settings": { json: model({ model_mode: "local", local_endpoint: "http://x:11434/v1" }) } });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("model-section-local")).toHaveAttribute("data-active", "true"));
    expect(screen.getByTestId("local-endpoint-input")).toHaveValue("http://x:11434/v1");
    expect(screen.getByTestId("model-save")).toBeDisabled(); // nothing changed yet
  });

  it("the api key field is NEVER prefilled, but 'key saved' shows when the server reports one", async () => {
    mockFetch({ "/api/settings": { json: model({ cloud_provider: "openai", cloud_api_key_set: true }) } });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("cloud-api-key-input")).toBeInTheDocument());
    // The secret is write-only — the input stays empty even though a key is stored.
    expect(screen.getByTestId("cloud-api-key-input")).toHaveValue("");
    // ...and the "key saved" indicator confirms one exists.
    expect(screen.getByTestId("cloud-key-set")).toBeInTheDocument();
  });

  it("changing the mode makes the panel dirty and enables Save", async () => {
    mockFetch({ "/api/settings": { json: model({ model_mode: "cloud" }) } });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("model-save")).toBeDisabled());

    await userEvent.click(screen.getByTestId("model-section-hipaa"));
    expect(screen.getByTestId("model-section-hipaa")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("model-save")).toBeEnabled();
  });

  it("Save sends ONLY the model keys, omits a blank api key, and includes a freshly-typed one", async () => {
    let putBody: Record<string, unknown> | null = null;
    mockFetch({
      "/api/settings": (_url, init) => {
        if (init?.method === "PUT") {
          putBody = JSON.parse(init.body as string);
          return { json: model({ model_mode: "cloud", cloud_provider: "openai", cloud_api_key_set: true }) };
        }
        return { json: model({ cloud_provider: "openai" }) };
      },
    });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("cloud-api-key-input")).toBeInTheDocument());

    // Type a new key + save.
    await userEvent.type(screen.getByTestId("cloud-api-key-input"), "sk-newkey");
    await userEvent.click(screen.getByTestId("model-save"));

    await waitFor(() => expect(putBody).not.toBeNull());
    // It carries the model keys + the typed cloud key...
    expect(putBody!.cloud_api_key).toBe("sk-newkey");
    expect(putBody!.model_mode).toBe("cloud");
    // ...and NEVER a prompt key (the no-clobber contract).
    expect(putBody).not.toHaveProperty("system_prompt");
    expect(putBody).not.toHaveProperty("urgency_prompt");
    // The blank HIPAA key is NOT sent (so a stored HIPAA key is left untouched).
    expect(putBody).not.toHaveProperty("hipaa_api_key");
    await waitFor(() => expect(screen.getByTestId("model-saved")).toBeInTheDocument());
  });

  it("the HIPAA key has its OWN independent slot (typing it never sends the cloud key)", async () => {
    // This is the literal client bug: an Azure/HIPAA key must not touch cloud_api_key.
    let putBody: Record<string, unknown> | null = null;
    mockFetch({
      "/api/settings": (_url, init) => {
        if (init?.method === "PUT") {
          putBody = JSON.parse(init.body as string);
          return { json: model({ model_mode: "hipaa", hipaa_api_key_set: true }) };
        }
        return { json: model({ model_mode: "hipaa" }) };
      },
    });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("hipaa-api-key-input")).toBeInTheDocument());

    await userEvent.type(screen.getByTestId("hipaa-api-key-input"), "azure-key-123");
    await userEvent.click(screen.getByTestId("model-save"));

    await waitFor(() => expect(putBody).not.toBeNull());
    expect(putBody!.hipaa_api_key).toBe("azure-key-123");
    expect(putBody).not.toHaveProperty("cloud_api_key"); // the cloud key is left untouched
  });

  it("a failed Save surfaces the error and shows NO 'Saved'", async () => {
    mockFetch({
      "/api/settings": (_url, init) =>
        init?.method === "PUT"
          ? { ok: false, status: 403, json: { error: "only admins can change the model" } }
          : { json: model() },
    });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("model-save")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("model-section-local"));
    await userEvent.click(screen.getByTestId("model-save"));

    await waitFor(() => expect(screen.getByText("only admins can change the model")).toBeInTheDocument());
    expect(screen.queryByTestId("model-saved")).not.toBeInTheDocument();
  });

  it("shows the Local setup hint only when Local is active and the endpoint is blank", async () => {
    mockFetch({ "/api/settings": { json: model({ model_mode: "local", local_endpoint: "" }) } });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("model-section-hint")).toBeInTheDocument());

    // Typing an endpoint dismisses the hint.
    await userEvent.type(screen.getByTestId("local-endpoint-input"), "http://localhost:11434/v1");
    expect(screen.queryByTestId("model-section-hint")).not.toBeInTheDocument();
  });

  it("shows the HIPAA setup hint only when HIPAA is active and no key is saved/typed", async () => {
    mockFetch({ "/api/settings": { json: model({ model_mode: "hipaa", hipaa_api_key_set: false }) } });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("hipaa-section-hint")).toBeInTheDocument());

    // Typing a key dismisses the hint.
    await userEvent.type(screen.getByTestId("hipaa-api-key-input"), "k");
    expect(screen.queryByTestId("hipaa-section-hint")).not.toBeInTheDocument();
  });

  it("the Cloud section is Claude-only: a write-only key field + optional model, NO provider matrix", async () => {
    mockFetch({ "/api/settings": { json: model() } });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("cloud-api-key-input")).toBeInTheDocument());

    // The Claude API key field is always visible (no provider gate) and write-only.
    expect(screen.getByTestId("cloud-api-key-input")).toHaveValue("");
    // The optional model field is enabled (NOT gated behind a provider choice).
    expect(screen.getByTestId("cloud-model-input")).toBeInTheDocument();
    expect(screen.getByTestId("cloud-model-input")).toBeEnabled();
    // The old provider matrix + azure/base-url fields are GONE.
    expect(screen.queryByTestId("cloud-provider-select")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cloud-base-url-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("azure-fields")).not.toBeInTheDocument();

    // ── REGRESSION GUARD — HIPAA + Local were NOT deleted (the prior attempt's mistake).
    expect(screen.getByTestId("model-section-hipaa")).toBeInTheDocument();
    expect(screen.getByTestId("model-section-local")).toBeInTheDocument();
    expect(screen.getByTestId("hipaa-model-section")).toBeInTheDocument();
  });

  // ── Detect-models picker ────────────────────────────────────────────────────
  it("Detect lists pulled models as clickable chips; clicking one sets the local model", async () => {
    mockFetch({
      "/api/settings": { json: model({ model_mode: "local", local_endpoint: "http://x:11434/v1" }) },
      "/api/local-models": { json: { models: ["qwen2.5", "llama3.1"], reachable: true } },
    });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("detect-models-button")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("detect-models-button"));
    await waitFor(() => expect(screen.getByTestId("detected-models")).toBeInTheDocument());
    const chips = screen.getAllByTestId("detected-model-chip");
    expect(chips).toHaveLength(2);

    await userEvent.click(chips[0]); // "qwen2.5"
    expect(screen.getByTestId("local-model-input")).toHaveValue("qwen2.5");
    expect(chips[0]).toHaveAttribute("data-active", "true");
  });

  it("Detect against an UNREACHABLE endpoint shows the friendly setup hint (no crash)", async () => {
    mockFetch({
      "/api/settings": { json: model({ model_mode: "local", local_endpoint: "http://x:11434/v1" }) },
      "/api/local-models": { json: { models: [], reachable: false } },
    });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("detect-models-button")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("detect-models-button"));
    await waitFor(() => expect(screen.getByTestId("detect-hint")).toHaveTextContent(/Couldn't reach your endpoint/i));
  });

  it("Detect against a REACHABLE-but-empty endpoint hints to pull a model", async () => {
    mockFetch({
      "/api/settings": { json: model({ model_mode: "local", local_endpoint: "http://x:11434/v1" }) },
      "/api/local-models": { json: { models: [], reachable: true } },
    });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("detect-models-button")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("detect-models-button"));
    await waitFor(() => expect(screen.getByTestId("detect-hint")).toHaveTextContent(/no models are pulled yet/i));
  });

  // ── Test connection (save-first) ────────────────────────────────────────────
  it("'Save & test connection' SAVES first, then tests, and shows the ok result", async () => {
    const calls: string[] = [];
    mockFetch({
      "/api/settings": (_url, init) => {
        calls.push(init?.method === "PUT" ? "PUT settings" : "GET settings");
        return { json: model({ cloud_provider: "openai", cloud_api_key_set: true }) };
      },
      "/api/test-connection": () => {
        calls.push("POST test");
        return { json: { ok: true, message: "Connected to openai." } };
      },
    });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("cloud-test-button")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("cloud-test-button"));

    await waitFor(() => expect(screen.getByTestId("cloud-test-result")).toHaveTextContent("Connected to openai."));
    // The PUT (save) happened BEFORE the test POST — the whole point of the fix.
    const putIdx = calls.indexOf("PUT settings");
    const testIdx = calls.indexOf("POST test");
    expect(putIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThan(putIdx);
  });

  it("a failing connection test shows the failure message without throwing", async () => {
    mockFetch({
      "/api/settings": { json: model({ cloud_provider: "openai", cloud_api_key_set: true }) },
      // The route returns { ok:false, message } (it never 500s for a bad key).
      "/api/test-connection": { json: { ok: false, message: "Invalid API key." } },
    });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("cloud-test-button")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("cloud-test-button"));
    await waitFor(() => expect(screen.getByTestId("cloud-test-result")).toHaveTextContent("Invalid API key."));
  });

  it("if the save-first step fails, the test is NOT attempted and a save error is shown", async () => {
    let testCalled = false;
    mockFetch({
      "/api/settings": (_url, init) =>
        init?.method === "PUT"
          ? { ok: false, status: 400, json: { error: "bad endpoint" } }
          : { json: model({ cloud_provider: "openai" }) },
      "/api/test-connection": () => {
        testCalled = true;
        return { json: { ok: true, message: "should not run" } };
      },
    });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId("cloud-test-button")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("cloud-test-button"));

    await waitFor(() =>
      expect(screen.getByTestId("cloud-test-result")).toHaveTextContent(/Couldn't save the settings to test/i),
    );
    expect(testCalled).toBe(false); // never tested a config we couldn't save
  });

  it("a load failure surfaces the error message", async () => {
    mockFetch({ "/api/settings": { json: { error: "settings unavailable" } } });
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByText("settings unavailable")).toBeInTheDocument());
  });
});
