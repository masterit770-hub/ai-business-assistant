"use client";

import { useEffect, useState } from "react";
import { Wand2, RotateCcw, Check, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The Prompt-config surface — REAL. It loads the engine's current prompts on
// mount and Save PUTs them back to the engine, which then uses them for live
// generation (system prompt) + urgency classification (urgency prompt). Editing
// here actually changes how Nucleus answers and prioritizes documents.
export function PromptsPanel() {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [urgencyPrompt, setUrgencyPrompt] = useState("");
  const [loaded, setLoaded] = useState<{ system: string; urgency: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the live prompts from the engine on mount.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setSystemPrompt(d.system_prompt ?? "");
        setUrgencyPrompt(d.urgency_prompt ?? "");
        setLoaded({ system: d.system_prompt ?? "", urgency: d.urgency_prompt ?? "" });
      })
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load prompts"));
  }, []);

  const dirty =
    !!loaded && (systemPrompt !== loaded.system || urgencyPrompt !== loaded.urgency);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: systemPrompt, urgency_prompt: urgencyPrompt }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "save failed");
      // The engine echoes the effective prompts (a blank field falls back to its
      // built-in default), so reflect exactly what is now live.
      setSystemPrompt(d.system_prompt ?? "");
      setUrgencyPrompt(d.urgency_prompt ?? "");
      setLoaded({ system: d.system_prompt ?? "", urgency: d.urgency_prompt ?? "" });
      setSaved(true);
      setTimeout(() => setSaved(false), 2600);
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  // Reset clears the overrides (empty → the engine's built-in defaults), saved
  // via the same PUT so the live engine returns to default behavior.
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
      setSystemPrompt(d.system_prompt ?? "");
      setUrgencyPrompt(d.urgency_prompt ?? "");
      setLoaded({ system: d.system_prompt ?? "", urgency: d.urgency_prompt ?? "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "reset failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
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
                System prompt
              </label>
              <span className="text-xs text-faint">
                Governs grounded generation &amp; citations
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
              disabled={!dirty}
              className={cn(
                "inline-flex items-center gap-1.5 text-sm font-medium transition-colors",
                dirty ? "text-subtle hover:text-ink" : "text-faint/50 cursor-default"
              )}
            >
              <RotateCcw className="size-3.5" />
              Reset to defaults
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
        Live · these prompts are read from and saved to the engine. The system prompt sets
        answering style (the grounding &amp; citation rules always apply); the urgency prompt
        drives the document badges. Leave a field blank to use the engine default.
      </p>
    </div>
  );
}
