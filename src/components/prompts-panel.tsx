"use client";

import { useEffect, useState } from "react";
import { Wand2, RotateCcw, Check, Loader2, AlertCircle, Cloud, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ModelMode = "cloud" | "local";

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
  const [loaded, setLoaded] = useState<{
    system: string;
    urgency: string;
    mode: ModelMode;
    endpoint: string;
    model: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the live prompts + model config from the engine on mount.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        const mode: ModelMode = d.model_mode === "local" ? "local" : "cloud";
        setSystemPrompt(d.system_prompt ?? "");
        setUrgencyPrompt(d.urgency_prompt ?? "");
        setModelMode(mode);
        setLocalEndpoint(d.local_endpoint ?? "");
        setLocalModel(d.local_model ?? "");
        setLoaded({
          system: d.system_prompt ?? "",
          urgency: d.urgency_prompt ?? "",
          mode,
          endpoint: d.local_endpoint ?? "",
          model: d.local_model ?? "",
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load prompts"));
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
        localModel !== loaded.model));

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_prompt: systemPrompt,
          urgency_prompt: urgencyPrompt,
          model_mode: modelMode,
          local_endpoint: localEndpoint,
          local_model: localModel,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "save failed");
      // The engine echoes the effective settings (a blank field falls back to its
      // built-in default), so reflect exactly what is now live.
      const mode: ModelMode = d.model_mode === "local" ? "local" : "cloud";
      setSystemPrompt(d.system_prompt ?? "");
      setUrgencyPrompt(d.urgency_prompt ?? "");
      setModelMode(mode);
      setLocalEndpoint(d.local_endpoint ?? "");
      setLocalModel(d.local_model ?? "");
      setLoaded({
        system: d.system_prompt ?? "",
        urgency: d.urgency_prompt ?? "",
        mode,
        endpoint: d.local_endpoint ?? "",
        model: d.local_model ?? "",
      });
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
      const mode: ModelMode = d.model_mode === "local" ? "local" : "cloud";
      setSystemPrompt(d.system_prompt ?? "");
      setUrgencyPrompt(d.urgency_prompt ?? "");
      // Keep model fields in sync with the echoed truth (unchanged by this PUT).
      setModelMode(mode);
      setLocalEndpoint(d.local_endpoint ?? "");
      setLocalModel(d.local_model ?? "");
      setLoaded({
        system: d.system_prompt ?? "",
        urgency: d.urgency_prompt ?? "",
        mode,
        endpoint: d.local_endpoint ?? "",
        model: d.local_model ?? "",
      });
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
            aria-label="Choose the AI model: Cloud or Local"
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
