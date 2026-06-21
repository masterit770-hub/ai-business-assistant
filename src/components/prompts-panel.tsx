"use client";

import { useEffect, useState } from "react";
import { Wand2, RotateCcw, Check, Loader2, AlertCircle, Cloud, Server, ShieldCheck, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ModelMode = "cloud" | "hipaa" | "local";

// Normalize a stored model_mode to one of the three modes; unknown/blank → "cloud".
const normMode = (v: unknown): ModelMode =>
  v === "local" ? "local" : v === "hipaa" ? "hipaa" : "cloud";
type CloudProvider = "" | "openai" | "azure" | "gemini" | "deepseek";

// Per-provider helper copy + sensible model placeholder shown under the Cloud model
// fields. Keeps the "paste your key" experience self-explanatory for a non-technical
// admin (no docs trip needed to swap to Azure or Gemini).
const PROVIDER_HELP: Record<Exclude<CloudProvider, "">, { hint: string; modelPlaceholder: string }> = {
  openai: { hint: "OpenAI: paste your platform.openai.com API key.", modelPlaceholder: "gpt-4o" },
  azure: {
    hint: "Azure OpenAI: your resource endpoint + deployment name + key.",
    modelPlaceholder: "your-deployment-name",
  },
  gemini: { hint: "Gemini: paste your Google AI Studio key.", modelPlaceholder: "gemini-2.5-flash" },
  deepseek: { hint: "DeepSeek: paste your platform.deepseek.com key.", modelPlaceholder: "deepseek-chat" },
};

// The Prompt-config surface — REAL. It loads the engine's current prompts on
// mount and Save PUTs them back to the engine, which then uses them for live
// generation (system prompt) + urgency classification (urgency prompt). Editing
// here actually changes how Nucleus answers and prioritizes documents.
//
// It ALSO owns the "Model" section — the Cloud ⇄ Local choice plus the owner's
// own local endpoint + model id — persisted through the same /api/settings PUT.
export function PromptsPanel() {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [urgencyPrompt, setUrgencyPrompt] = useState("");
  const [modelMode, setModelMode] = useState<ModelMode>("cloud");
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [localModel, setLocalModel] = useState("");
  // Cloud provider override (the paste-a-key model swap).
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>("");
  const [cloudApiKey, setCloudApiKey] = useState(""); // entered value (never loaded from server)
  const [cloudKeySet, setCloudKeySet] = useState(false); // whether a key is already stored
  const [cloudModel, setCloudModel] = useState("");
  const [cloudBaseUrl, setCloudBaseUrl] = useState("");
  const [azureEndpoint, setAzureEndpoint] = useState("");
  const [azureApiVersion, setAzureApiVersion] = useState("");
  // HIPAA (Azure) override — its OWN independent slot, so entering an Azure key here
  // never touches cloud_api_key (the literal bug the client hit).
  const [hipaaApiKey, setHipaaApiKey] = useState(""); // entered value (never loaded from server)
  const [hipaaKeySet, setHipaaKeySet] = useState(false); // whether a hipaa key is already stored
  const [hipaaEndpoint, setHipaaEndpoint] = useState("");
  const [hipaaApiVersion, setHipaaApiVersion] = useState("");
  const [hipaaModel, setHipaaModel] = useState("");
  const [loaded, setLoaded] = useState<{
    system: string;
    urgency: string;
    mode: ModelMode;
    endpoint: string;
    model: string;
    cloudProvider: CloudProvider;
    cloudKeySet: boolean;
    cloudModel: string;
    cloudBaseUrl: string;
    azureEndpoint: string;
    azureApiVersion: string;
    hipaaKeySet: boolean;
    hipaaEndpoint: string;
    hipaaApiVersion: string;
    hipaaModel: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Apply a settings payload (from GET or the PUT echo) to local state. The api key
  // is WRITE-ONLY — the server returns only `cloud_api_key_set` (a boolean), never the
  // secret — so we reflect "key stored" without ever holding the value in the client.
  function applyServer(d: Record<string, unknown>) {
    const mode: ModelMode = normMode(d.model_mode);
    const provider = ((d.cloud_provider as string) ?? "") as CloudProvider;
    const keySet = Boolean(d.cloud_api_key_set);
    const hKeySet = Boolean(d.hipaa_api_key_set);
    setSystemPrompt((d.system_prompt as string) ?? "");
    setUrgencyPrompt((d.urgency_prompt as string) ?? "");
    setModelMode(mode);
    setLocalEndpoint((d.local_endpoint as string) ?? "");
    setLocalModel((d.local_model as string) ?? "");
    setCloudProvider(provider);
    setCloudKeySet(keySet);
    setCloudApiKey(""); // never prefill the secret field
    setCloudModel((d.cloud_model as string) ?? "");
    setCloudBaseUrl((d.cloud_base_url as string) ?? "");
    setAzureEndpoint((d.azure_endpoint as string) ?? "");
    setAzureApiVersion((d.azure_api_version as string) ?? "");
    setHipaaKeySet(hKeySet);
    setHipaaApiKey(""); // never prefill the secret field
    setHipaaEndpoint((d.hipaa_endpoint as string) ?? "");
    setHipaaApiVersion((d.hipaa_api_version as string) ?? "");
    setHipaaModel((d.hipaa_model as string) ?? "");
    setLoaded({
      system: (d.system_prompt as string) ?? "",
      urgency: (d.urgency_prompt as string) ?? "",
      mode,
      endpoint: (d.local_endpoint as string) ?? "",
      model: (d.local_model as string) ?? "",
      cloudProvider: provider,
      cloudKeySet: keySet,
      cloudModel: (d.cloud_model as string) ?? "",
      cloudBaseUrl: (d.cloud_base_url as string) ?? "",
      azureEndpoint: (d.azure_endpoint as string) ?? "",
      azureApiVersion: (d.azure_api_version as string) ?? "",
      hipaaKeySet: hKeySet,
      hipaaEndpoint: (d.hipaa_endpoint as string) ?? "",
      hipaaApiVersion: (d.hipaa_api_version as string) ?? "",
      hipaaModel: (d.hipaa_model as string) ?? "",
    });
  }

  // Load the live prompts + model config from the engine on mount.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        applyServer(d);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load prompts"));
    // applyServer is stable for our purposes (only setters); run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prompt fields changed → enables "Reset to defaults" (which only touches prompts).
  const promptsDirty =
    !!loaded && (systemPrompt !== loaded.system || urgencyPrompt !== loaded.urgency);
  // Any field changed → enables Save (which persists prompts AND the model section).
  const dirty =
    promptsDirty ||
    (!!loaded &&
      (modelMode !== loaded.mode ||
        localEndpoint !== loaded.endpoint ||
        localModel !== loaded.model ||
        cloudProvider !== loaded.cloudProvider ||
        cloudApiKey.trim() !== "" || // a newly typed key is always "dirty"
        cloudModel !== loaded.cloudModel ||
        cloudBaseUrl !== loaded.cloudBaseUrl ||
        azureEndpoint !== loaded.azureEndpoint ||
        azureApiVersion !== loaded.azureApiVersion ||
        hipaaApiKey.trim() !== "" || // a newly typed HIPAA key is always "dirty"
        hipaaEndpoint !== loaded.hipaaEndpoint ||
        hipaaApiVersion !== loaded.hipaaApiVersion ||
        hipaaModel !== loaded.hipaaModel));

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // The api key is WRITE-ONLY: only send it when the admin typed a new value
      // (a blank field leaves any stored key untouched on the server).
      const body: Record<string, string> = {
        system_prompt: systemPrompt,
        urgency_prompt: urgencyPrompt,
        model_mode: modelMode,
        local_endpoint: localEndpoint,
        local_model: localModel,
        cloud_provider: cloudProvider,
        cloud_model: cloudModel,
        cloud_base_url: cloudBaseUrl,
        azure_endpoint: azureEndpoint,
        azure_api_version: azureApiVersion,
        hipaa_endpoint: hipaaEndpoint,
        hipaa_api_version: hipaaApiVersion,
        hipaa_model: hipaaModel,
      };
      if (cloudApiKey.trim()) body.cloud_api_key = cloudApiKey.trim();
      // Write-only, INDEPENDENT slot: only send the HIPAA key when newly typed — a
      // blank field leaves the stored HIPAA key (and the cloud key) untouched.
      if (hipaaApiKey.trim()) body.hipaa_api_key = hipaaApiKey.trim();
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "save failed");
      // The engine echoes the effective settings (a blank field falls back to its
      // built-in default; the api key is returned only as a boolean), so reflect
      // exactly what is now live.
      applyServer(d);
      setSaved(true);
      setTimeout(() => setSaved(false), 2600);
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  // Reset clears the PROMPT overrides (empty → the engine's built-in defaults),
  // saved via the same PUT. It deliberately leaves the Model section alone — we
  // don't send model_mode/local_* — so resetting the prompts never silently flips
  // the owner back to Cloud or wipes her local endpoint.
  async function reset() {
    setSystemPrompt("");
    setUrgencyPrompt("");
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: "", urgency_prompt: "" }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "reset failed");
      // Reflect the echoed truth — the model + cloud sections are unchanged by this
      // prompts-only PUT, so they stay exactly as configured.
      applyServer(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "reset failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* ── MODEL — the Cloud ⇄ Local switch + the owner's local endpoint ────── */}
      <div className="rounded-2xl border border-line bg-surface shadow-soft" data-testid="model-section">
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          {modelMode === "local" ? (
            <Server className="size-4 text-accent" />
          ) : modelMode === "hipaa" ? (
            <ShieldCheck className="size-4 text-accent" />
          ) : (
            <Cloud className="size-4 text-accent" />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-base font-semibold text-ink">Model</h2>
            <p className="text-sm text-faint">
              Where the AI runs — the Cloud demo model, or your own machine.
            </p>
          </div>
          <span className="rounded-full border border-accent-ring bg-accent-soft px-2.5 py-0.5 text-[11px] font-medium text-accent">
            Live
          </span>
        </div>

        <div className="space-y-5 p-6">
          {/* the big segmented choice (also editable from the Ask panel) */}
          <div
            role="group"
            aria-label="Choose the AI model: Cloud, HIPAA, or Local"
            className="inline-flex items-center gap-1 rounded-xl border border-line bg-canvas p-1"
          >
            <button
              type="button"
              onClick={() => setModelMode("cloud")}
              aria-pressed={modelMode === "cloud"}
              data-testid="model-section-cloud"
              data-active={modelMode === "cloud"}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all",
                modelMode === "cloud"
                  ? "bg-accent text-accent-fg shadow-soft"
                  : "text-subtle hover:text-ink"
              )}
            >
              <Cloud className="size-4" strokeWidth={2.2} />
              Cloud
            </button>
            <button
              type="button"
              onClick={() => setModelMode("hipaa")}
              aria-pressed={modelMode === "hipaa"}
              data-testid="model-section-hipaa"
              data-active={modelMode === "hipaa"}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all",
                modelMode === "hipaa"
                  ? "bg-accent text-accent-fg shadow-soft"
                  : "text-subtle hover:text-ink"
              )}
            >
              <ShieldCheck className="size-4" strokeWidth={2.2} />
              HIPAA
            </button>
            <button
              type="button"
              onClick={() => setModelMode("local")}
              aria-pressed={modelMode === "local"}
              data-testid="model-section-local"
              data-active={modelMode === "local"}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all",
                modelMode === "local"
                  ? "bg-accent text-accent-fg shadow-soft"
                  : "text-subtle hover:text-ink"
              )}
            >
              <Server className="size-4" strokeWidth={2.2} />
              Local
            </button>
          </div>

          <p className="text-sm text-faint">
            <span className="font-medium text-subtle">Local</span> runs the AI on your own
            hardware — it only works when you <span className="font-medium text-subtle">self-host</span>{" "}
            Nucleus on the same machine/network as your model. Enter your model server&apos;s
            address, e.g. <code className="rounded bg-canvas px-1 py-0.5 text-[12px]">http://localhost:11434/v1</code>.
            The hosted demo can&apos;t reach a model on your computer.
          </p>

          {/* local endpoint + model — only meaningful in Local mode, but always
              editable so the owner can fill them in before flipping the switch. */}
          <div className={cn("grid gap-4 sm:grid-cols-2", modelMode === "cloud" && "opacity-60")}>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-ink" htmlFor="local-endpoint">
                Local model endpoint
              </label>
              <input
                id="local-endpoint"
                value={localEndpoint}
                onChange={(e) => setLocalEndpoint(e.target.value)}
                placeholder="http://localhost:11434/v1"
                spellCheck={false}
                data-testid="local-endpoint-input"
                className="w-full rounded-xl border border-line bg-canvas px-4 py-2.5 font-mono text-[13px] text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
              />
              <p className="text-xs text-faint">
                Your model server&apos;s OpenAI-compatible URL (Ollama uses port 11434).
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-ink" htmlFor="local-model">
                Local model name
              </label>
              <input
                id="local-model"
                value={localModel}
                onChange={(e) => setLocalModel(e.target.value)}
                placeholder="qwen2.5"
                spellCheck={false}
                data-testid="local-model-input"
                className="w-full rounded-xl border border-line bg-canvas px-4 py-2.5 font-mono text-[13px] text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
              />
              <p className="text-xs text-faint">
                The model you pulled, e.g. <code className="rounded bg-canvas px-1 py-0.5">ollama pull qwen2.5</code>.
              </p>
            </div>
          </div>

          {modelMode === "local" && !localEndpoint.trim() && (
            <div
              data-testid="model-section-hint"
              className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>
                Local is selected but no endpoint is set. Enter your model server&apos;s address
                above, then Save. Until then, asking a question in Local mode shows a friendly
                setup message (no answer is generated).
              </span>
            </div>
          )}

          {/* ── CLOUD MODEL — the paste-a-key provider swap (OpenAI / Azure / Gemini) ── */}
          <div
            data-testid="cloud-model-section"
            className={cn(
              "space-y-4 rounded-xl border border-line bg-canvas/60 p-5",
              modelMode === "local" && "opacity-60"
            )}
          >
            <div className="flex items-center gap-2">
              <KeyRound className="size-4 text-accent" />
              <h3 className="text-sm font-semibold text-ink">Cloud model</h3>
            </div>
            <p className="text-sm text-faint">
              Swap the cloud AI provider here — pick one and paste your key. The next question
              uses it (no redeploy). Leave on <span className="font-medium text-subtle">Default
              (server)</span> to keep the built-in demo model.
            </p>

            {/* provider dropdown */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-ink" htmlFor="cloud-provider">
                  Provider
                </label>
                <select
                  id="cloud-provider"
                  value={cloudProvider}
                  onChange={(e) => setCloudProvider(e.target.value as CloudProvider)}
                  data-testid="cloud-provider-select"
                  className="w-full rounded-xl border border-line bg-canvas px-4 py-2.5 text-[13px] text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
                >
                  <option value="">Default (server)</option>
                  <option value="openai">OpenAI</option>
                  <option value="azure">Azure OpenAI</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="deepseek">DeepSeek</option>
                </select>
              </div>

              {/* model id / azure deployment name */}
              <div className={cn("space-y-2", cloudProvider === "" && "opacity-50")}>
                <label className="text-sm font-semibold text-ink" htmlFor="cloud-model">
                  {cloudProvider === "azure" ? "Deployment name" : "Model"}
                </label>
                <input
                  id="cloud-model"
                  value={cloudModel}
                  onChange={(e) => setCloudModel(e.target.value)}
                  disabled={cloudProvider === ""}
                  placeholder={cloudProvider ? PROVIDER_HELP[cloudProvider].modelPlaceholder : "gpt-4o"}
                  spellCheck={false}
                  data-testid="cloud-model-input"
                  className="w-full rounded-xl border border-line bg-canvas px-4 py-2.5 font-mono text-[13px] text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10 disabled:cursor-not-allowed"
                />
              </div>
            </div>

            {/* api key (write-only) */}
            {cloudProvider !== "" && (
              <div className="space-y-2">
                <label className="flex items-center justify-between text-sm font-semibold text-ink" htmlFor="cloud-api-key">
                  API key
                  {cloudKeySet && (
                    <span
                      data-testid="cloud-key-set"
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-accent"
                    >
                      <Check className="size-3" strokeWidth={3} /> •••• key saved
                    </span>
                  )}
                </label>
                <input
                  id="cloud-api-key"
                  type="password"
                  value={cloudApiKey}
                  onChange={(e) => setCloudApiKey(e.target.value)}
                  placeholder={cloudKeySet ? "Saved — type to replace" : "Paste your provider key"}
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="cloud-api-key-input"
                  className="w-full rounded-xl border border-line bg-canvas px-4 py-2.5 font-mono text-[13px] text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
                />
                <p className="text-xs text-faint">
                  {PROVIDER_HELP[cloudProvider].hint} Stored securely server-side and{" "}
                  <span className="font-medium text-subtle">never shown again</span> (write-only).
                </p>
              </div>
            )}

            {/* Azure-only: resource endpoint + api-version */}
            {cloudProvider === "azure" && (
              <div className="grid gap-4 sm:grid-cols-2" data-testid="azure-fields">
                <div className="space-y-2">
                  <label className="text-sm font-semibold text-ink" htmlFor="azure-endpoint">
                    Azure resource endpoint
                  </label>
                  <input
                    id="azure-endpoint"
                    value={azureEndpoint}
                    onChange={(e) => setAzureEndpoint(e.target.value)}
                    placeholder="https://my-resource.openai.azure.com"
                    spellCheck={false}
                    data-testid="azure-endpoint-input"
                    className="w-full rounded-xl border border-line bg-canvas px-4 py-2.5 font-mono text-[13px] text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-semibold text-ink" htmlFor="azure-api-version">
                    API version
                  </label>
                  <input
                    id="azure-api-version"
                    value={azureApiVersion}
                    onChange={(e) => setAzureApiVersion(e.target.value)}
                    placeholder="2024-10-21"
                    spellCheck={false}
                    data-testid="azure-api-version-input"
                    className="w-full rounded-xl border border-line bg-canvas px-4 py-2.5 font-mono text-[13px] text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
                  />
                </div>
              </div>
            )}

            {/* optional custom base URL for openai-compatible gateways */}
            {(cloudProvider === "openai" || cloudProvider === "deepseek" || cloudProvider === "gemini") && (
              <div className="space-y-2">
                <label className="text-sm font-semibold text-ink" htmlFor="cloud-base-url">
                  Custom base URL <span className="font-normal text-faint">(optional)</span>
                </label>
                <input
                  id="cloud-base-url"
                  value={cloudBaseUrl}
                  onChange={(e) => setCloudBaseUrl(e.target.value)}
                  placeholder="Leave blank to use the provider default"
                  spellCheck={false}
                  data-testid="cloud-base-url-input"
                  className="w-full rounded-xl border border-line bg-canvas px-4 py-2.5 font-mono text-[13px] text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
                />
              </div>
            )}

            <p className="text-xs text-faint">
              For stricter setups, the cloud key can also be set via a server env var
              (<code className="rounded bg-canvas px-1 py-0.5">LLM_API_KEY</code>) instead of pasting
              it here — this Settings override simply takes precedence when present.
            </p>
          </div>

          {/* ── HIPAA MODEL — Azure OpenAI under a Microsoft BAA (its OWN key slot) ── */}
          <div
            data-testid="hipaa-model-section"
            className={cn(
              "space-y-4 rounded-xl border border-line bg-canvas/60 p-5",
              modelMode !== "hipaa" && "opacity-60"
            )}
          >
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-accent" />
              <h3 className="text-sm font-semibold text-ink">HIPAA model</h3>
            </div>
            <p className="text-sm text-faint">
              Use an <span className="font-medium text-subtle">Azure OpenAI</span> key —{" "}
              <span className="font-medium text-subtle">HIPAA-eligible under a Microsoft BAA</span>{" "}
              (not &ldquo;HIPAA-compliant&rdquo;: eligibility also requires you to sign a BAA with
              Microsoft and point at an Azure resource it covers). Google Vertex/Gemini under a BAA
              needs service-account auth, not a pasted key — see HANDOFF; Azure recommended. This is a
              separate key from the Cloud model above, so saving one never overwrites the other.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              {/* Azure key (write-only) */}
              <div className="space-y-2">
                <label className="flex items-center justify-between text-sm font-semibold text-ink" htmlFor="hipaa-api-key">
                  Azure API key
                  {hipaaKeySet && (
                    <span
                      data-testid="hipaa-key-set"
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-accent"
                    >
                      <Check className="size-3" strokeWidth={3} /> •••• key saved
                    </span>
                  )}
                </label>
                <input
                  id="hipaa-api-key"
                  type="password"
                  value={hipaaApiKey}
                  onChange={(e) => setHipaaApiKey(e.target.value)}
                  placeholder={hipaaKeySet ? "Saved — type to replace" : "Paste your Azure OpenAI key"}
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="hipaa-api-key-input"
                  className="w-full rounded-xl border border-line bg-canvas px-4 py-2.5 font-mono text-[13px] text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
                />
                <p className="text-xs text-faint">
                  Stored securely server-side and{" "}
                  <span className="font-medium text-subtle">never shown again</span> (write-only).
                </p>
              </div>

              {/* deployment name */}
              <div className="space-y-2">
                <label className="text-sm font-semibold text-ink" htmlFor="hipaa-model">
                  Deployment name
                </label>
                <input
                  id="hipaa-model"
                  value={hipaaModel}
                  onChange={(e) => setHipaaModel(e.target.value)}
                  placeholder="your-deployment-name"
                  spellCheck={false}
                  data-testid="hipaa-model-input"
                  className="w-full rounded-xl border border-line bg-canvas px-4 py-2.5 font-mono text-[13px] text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-ink" htmlFor="hipaa-endpoint">
                  Azure resource endpoint
                </label>
                <input
                  id="hipaa-endpoint"
                  value={hipaaEndpoint}
                  onChange={(e) => setHipaaEndpoint(e.target.value)}
                  placeholder="https://my-resource.openai.azure.com"
                  spellCheck={false}
                  data-testid="hipaa-endpoint-input"
                  className="w-full rounded-xl border border-line bg-canvas px-4 py-2.5 font-mono text-[13px] text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold text-ink" htmlFor="hipaa-api-version">
                  API version
                </label>
                <input
                  id="hipaa-api-version"
                  value={hipaaApiVersion}
                  onChange={(e) => setHipaaApiVersion(e.target.value)}
                  placeholder="2024-10-21"
                  spellCheck={false}
                  data-testid="hipaa-api-version-input"
                  className="w-full rounded-xl border border-line bg-canvas px-4 py-2.5 font-mono text-[13px] text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
                />
              </div>
            </div>

            {modelMode === "hipaa" && !(hipaaKeySet || hipaaApiKey.trim()) && (
              <div
                data-testid="hipaa-section-hint"
                className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>
                  HIPAA mode is selected but no Azure key is saved. Paste your Azure OpenAI key,
                  endpoint, and deployment name above, then Save. HIPAA mode has no demo fallback —
                  until it&apos;s configured, asking a question shows a clear setup message (no answer
                  is routed to the non-BAA demo model).
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── PROMPTS ──────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-line bg-surface shadow-soft">
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <Wand2 className="size-4 text-accent" />
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-base font-semibold text-ink">
              Prompt configuration
            </h2>
            <p className="text-sm text-faint">
              Tune how Nucleus answers and how documents are prioritized.
            </p>
          </div>
          <span className="rounded-full border border-accent-ring bg-accent-soft px-2.5 py-0.5 text-[11px] font-medium text-accent">
            Live
          </span>
        </div>

        <div className="space-y-6 p-6">
          {/* system prompt */}
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <label className="text-sm font-semibold text-ink">
                Assistant persona / system prompt
              </label>
              <span className="text-xs text-faint">
                Sets the assistant&apos;s voice on every answer
              </span>
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={8}
              spellCheck={false}
              className="w-full resize-y rounded-xl border border-line bg-canvas px-4 py-3 font-mono text-[13px] leading-relaxed text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
            />
          </div>

          {/* urgency prompt */}
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <label className="text-sm font-semibold text-ink">
                Document urgency prompt
              </label>
              <span className="flex items-center gap-1.5 text-xs text-faint">
                Drives the
                <span className="inline-flex items-center gap-1">
                  <span className="size-1.5 rounded-full bg-red-500" />
                  <span className="size-1.5 rounded-full bg-amber-500" />
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                </span>
                badges
              </span>
            </div>
            <textarea
              value={urgencyPrompt}
              onChange={(e) => setUrgencyPrompt(e.target.value)}
              rows={6}
              spellCheck={false}
              className="w-full resize-y rounded-xl border border-line bg-canvas px-4 py-3 font-mono text-[13px] leading-relaxed text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/10"
            />
          </div>

          <div className="flex items-center justify-between border-t border-line pt-5">
            <button
              onClick={reset}
              disabled={!promptsDirty}
              className={cn(
                "inline-flex items-center gap-1.5 text-sm font-medium transition-colors",
                promptsDirty ? "text-subtle hover:text-ink" : "text-faint/50 cursor-default"
              )}
            >
              <RotateCcw className="size-3.5" />
              Reset prompts to defaults
            </button>
            <div className="flex items-center gap-3">
              {error && (
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-red-600">
                  <AlertCircle className="size-4" />
                  {error}
                </span>
              )}
              {saved && !error && (
                <span
                  data-testid="prompts-saved"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-accent"
                >
                  <Check className="size-4" strokeWidth={2.5} />
                  Saved — live now
                </span>
              )}
              <Button
                size="lg"
                onClick={save}
                disabled={saving || !dirty}
                data-testid="prompts-save"
                className="h-10 gap-2 bg-accent text-accent-fg hover:bg-accent/90 disabled:opacity-50"
              >
                {saving && <Loader2 className="size-4 animate-spin" />}
                Save prompts
              </Button>
            </div>
          </div>
        </div>
      </div>

      <p className="px-1 text-xs text-faint">
        Live · these prompts are read from and saved to the engine. The assistant persona sets
        the voice on every answer — e.g. &ldquo;You are an expert lawyer, explain clearly for a
        layperson.&rdquo; When your documents or data contain the answer, Nucleus grounds and cites
        it (the citation rules always apply); otherwise it answers from general knowledge in this
        persona. The urgency prompt drives the document badges. Leave a field blank to use the
        engine default.
      </p>
    </div>
  );
}
