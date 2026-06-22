"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, AlertCircle, Cloud, Server, ShieldCheck, KeyRound, Search, Plug } from "lucide-react";
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

// The Model surface — REAL. It owns the Cloud ⇄ HIPAA ⇄ Local choice plus the
// per-mode backend config (the owner's own local endpoint + model id; the cloud
// provider "paste-a-key" swap; the HIPAA Azure key), persisted through the
// /api/settings PUT. The engine reads model_mode + the matching config at request
// time, so the choice here actually decides which backend answers.
//
// This panel saves ONLY the MODEL keys — it never sends system_prompt/urgency_prompt
// — so saving Models can never clobber a freshly-edited prompt (and vice-versa). The
// PUT route updates only keys present in the body (see api/settings/route.ts).
export function ModelsPanel() {
  const [modelMode, setModelMode] = useState<ModelMode>("cloud");
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [localModel, setLocalModel] = useState("");
  // "Detect models on your box" — the picker that lists the models actually pulled
  // on the owner's machine (via Ollama's /api/tags, proxied through /api/local-models).
  // Clicking a chip just sets `localModel`, so it's equivalent to typing the name.
  const [detecting, setDetecting] = useState(false);
  const [detectedModels, setDetectedModels] = useState<string[] | null>(null);
  const [detectHint, setDetectHint] = useState<string | null>(null);
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
  // "Test connection" — a tiny REAL chat call against the currently-SAVED provider/key,
  // so the owner learns a bad key immediately. `testing` marks which section is in
  // flight ("cloud" | "hipaa"); `testResult` holds the friendly ok/failure outcome.
  const [testing, setTesting] = useState<"cloud" | "hipaa" | null>(null);
  const [testResult, setTestResult] = useState<{
    section: "cloud" | "hipaa";
    ok: boolean;
    message: string;
  } | null>(null);

  // POST /api/test-connection (admin-only). It tests the model backend as SAVED, so a
  // just-typed-but-unsaved key needs a Save first; we surface that hint when relevant.
  // The route never throws for a bad key — it returns { ok, message } — so we just
  // reflect that. `section` only labels which button the result belongs to.
  async function testConnection(section: "cloud" | "hipaa") {
    setTesting(section);
    setTestResult(null);
    try {
      const res = await fetch("/api/test-connection", { method: "POST" });
      const d = await res.json();
      if (!res.ok) {
        // Auth/role failures (401/403) come back with `error`, not `ok`.
        throw new Error(d?.error ?? "test failed");
      }
      setTestResult({ section, ok: Boolean(d.ok), message: d.message ?? (d.ok ? "Connected." : "Connection failed.") });
    } catch (e) {
      setTestResult({ section, ok: false, message: e instanceof Error ? e.message : "test failed" });
    } finally {
      setTesting(null);
    }
  }

  // Apply a settings payload (from GET or the PUT echo) to local state. The api key
  // is WRITE-ONLY — the server returns only `cloud_api_key_set` (a boolean), never the
  // secret — so we reflect "key stored" without ever holding the value in the client.
  // Only the MODEL fields are applied here; the prompt fields live in PromptsPanel.
  function applyServer(d: Record<string, unknown>) {
    const mode: ModelMode = normMode(d.model_mode);
    const provider = ((d.cloud_provider as string) ?? "") as CloudProvider;
    const keySet = Boolean(d.cloud_api_key_set);
    const hKeySet = Boolean(d.hipaa_api_key_set);
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

  // Load the live model config from the engine on mount.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        applyServer(d);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load model settings"));
    // applyServer is stable for our purposes (only setters); run once on mount.
  }, []);

  // Any model field changed → enables Save (which persists ONLY the model section).
  const dirty =
    !!loaded &&
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
      hipaaModel !== loaded.hipaaModel);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // ONLY the MODEL keys — never the prompts. The PUT route updates just the keys
      // present in the body, so this can't clobber a freshly-edited system/urgency
      // prompt. The api keys are WRITE-ONLY: only sent when the admin typed a new value
      // (a blank field leaves any stored key untouched on the server).
      const body: Record<string, string> = {
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

  // "Detect models on your box" — ask the server (admin-only /api/local-models) to
  // list the models actually pulled at the configured endpoint. It probes the
  // endpoint as currently SAVED, so a just-typed-but-unsaved endpoint may need a
  // Save first; we hint that on an unreachable result. The route never 500s — it
  // returns { models, reachable, reason } — so we just reflect that calmly.
  async function detectModels() {
    setDetecting(true);
    setDetectHint(null);
    try {
      const res = await fetch("/api/local-models");
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "detect failed");
      const models: string[] = Array.isArray(d.models) ? d.models : [];
      setDetectedModels(models);
      if (!d.reachable) {
        setDetectHint(
          "Couldn't reach your endpoint — make sure Ollama is running (and the endpoint above is saved), or just type the model name below."
        );
      } else if (models.length === 0) {
        setDetectHint(
          "Reached your endpoint, but no models are pulled yet. Run e.g. `ollama pull qwen2.5`, or type a model name below."
        );
      }
    } catch (e) {
      setDetectedModels([]);
      setDetectHint(e instanceof Error ? e.message : "detect failed");
    } finally {
      setDetecting(false);
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

          {/* Plain-language legend — what each of the three modes means, near the
              control, so a non-technical owner can choose without a docs trip. */}
          <ul className="space-y-1.5 text-sm text-faint" data-testid="model-mode-legend">
            <li className="flex items-start gap-2">
              <Cloud className="mt-0.5 size-4 shrink-0 text-subtle" />
              <span>
                <span className="font-medium text-subtle">Cloud</span> — a hosted AI; works
                with any provider key (OpenAI, Gemini, DeepSeek, Azure).
              </span>
            </li>
            <li className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-subtle" />
              <span>
                <span className="font-medium text-subtle">HIPAA</span> — your own Azure key,
                for patient data under a Microsoft BAA.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Server className="mt-0.5 size-4 shrink-0 text-subtle" />
              <span>
                <span className="font-medium text-subtle">Local</span> — runs on your own
                machine; nothing leaves it (you self-host Nucleus by your model).
              </span>
            </li>
          </ul>

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
                Or <span className="font-medium text-subtle">detect</span> what&apos;s installed below.
              </p>
            </div>
          </div>

          {/* ── Local-model PICKER — auto-detect the models pulled on the owner's box ──
              Probes the SAVED endpoint (Ollama /api/tags via /api/local-models) and
              renders each model as a clickable chip. Clicking a chip just sets the
              Local model name field, so it's equivalent to typing it — the free-text
              input above stays the fallback when nothing is detected yet. */}
          <div className={cn("space-y-3", modelMode === "cloud" && "opacity-60")} data-testid="local-model-picker">
            <Button
              type="button"
              variant="outline"
              onClick={detectModels}
              disabled={detecting}
              data-testid="detect-models-button"
              className="gap-2"
            >
              {detecting ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              {detecting ? "Detecting…" : "Detect models on your box"}
            </Button>

            {detectedModels && detectedModels.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-faint">
                  Models found on your endpoint — click one to use it:
                </p>
                <div className="flex flex-wrap gap-2" data-testid="detected-models">
                  {detectedModels.map((name) => {
                    const active = localModel.trim() === name;
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => setLocalModel(name)}
                        aria-pressed={active}
                        data-testid="detected-model-chip"
                        data-active={active}
                        className={cn(
                          "rounded-full border px-3 py-1.5 font-mono text-[12px] transition",
                          active
                            ? "border-accent-ring bg-accent/10 text-accent"
                            : "border-line bg-canvas text-subtle hover:border-accent-ring hover:text-ink"
                        )}
                      >
                        {active && <Check className="mr-1 inline size-3" />}
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {detectHint && (
              <div
                data-testid="detect-hint"
                className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{detectHint}</span>
              </div>
            )}
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

            {/* ── TEST CONNECTION — make a tiny real call against the SAVED cloud key ── */}
            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4" data-testid="cloud-test-connection">
              <Button
                type="button"
                variant="outline"
                onClick={() => testConnection("cloud")}
                disabled={testing !== null}
                data-testid="cloud-test-button"
                className="gap-2"
              >
                {testing === "cloud" ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                {testing === "cloud" ? "Testing…" : "Test connection"}
              </Button>
              <span className="text-xs text-faint">Tests the key as currently saved — Save first if you just changed it.</span>
              {testResult?.section === "cloud" && (
                <div
                  data-testid="cloud-test-result"
                  className={cn(
                    "flex w-full items-start gap-2 rounded-xl border px-4 py-3 text-sm",
                    testResult.ok
                      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                      : "border-red-300 bg-red-50 text-red-700"
                  )}
                >
                  {testResult.ok ? (
                    <Check className="mt-0.5 size-4 shrink-0" strokeWidth={2.5} />
                  ) : (
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  )}
                  <span>{testResult.message}</span>
                </div>
              )}
            </div>
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

            {/* ── TEST CONNECTION — make a tiny real call against the SAVED Azure key ──
                Note: this tests whatever backend the SAVED model_mode resolves to, so
                to test the Azure/HIPAA key specifically, set the mode to HIPAA + Save. */}
            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4" data-testid="hipaa-test-connection">
              <Button
                type="button"
                variant="outline"
                onClick={() => testConnection("hipaa")}
                disabled={testing !== null}
                data-testid="hipaa-test-button"
                className="gap-2"
              >
                {testing === "hipaa" ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                {testing === "hipaa" ? "Testing…" : "Test connection"}
              </Button>
              <span className="text-xs text-faint">
                Set the mode to HIPAA and Save, then test — it calls the backend as saved.
              </span>
              {testResult?.section === "hipaa" && (
                <div
                  data-testid="hipaa-test-result"
                  className={cn(
                    "flex w-full items-start gap-2 rounded-xl border px-4 py-3 text-sm",
                    testResult.ok
                      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                      : "border-red-300 bg-red-50 text-red-700"
                  )}
                >
                  {testResult.ok ? (
                    <Check className="mt-0.5 size-4 shrink-0" strokeWidth={2.5} />
                  ) : (
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  )}
                  <span>{testResult.message}</span>
                </div>
              )}
            </div>
          </div>

          {/* ── SAVE — persists ONLY the model section (never the prompts) ────────── */}
          <div className="flex items-center justify-end gap-3 border-t border-line pt-5">
            {error && (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-red-600">
                <AlertCircle className="size-4" />
                {error}
              </span>
            )}
            {saved && !error && (
              <span
                data-testid="model-saved"
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
              data-testid="model-save"
              className="h-10 gap-2 bg-accent text-accent-fg hover:bg-accent/90 disabled:opacity-50"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save model
            </Button>
          </div>
        </div>
      </div>

      <p className="px-1 text-xs text-faint">
        Live · the model choice is read from and saved to the engine. <span className="font-medium text-subtle">Cloud</span>{" "}
        uses the built-in demo provider unless you paste your own key; <span className="font-medium text-subtle">HIPAA</span>{" "}
        routes to your own Azure OpenAI resource under a Microsoft BAA; <span className="font-medium text-subtle">Local</span>{" "}
        runs on your own machine when you self-host. The HIPAA key is a separate slot from the Cloud key, so saving one never
        overwrites the other.
      </p>
    </div>
  );
}
