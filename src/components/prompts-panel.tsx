"use client";

import { useEffect, useState } from "react";
import { Wand2, RotateCcw, Check, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The Prompt-config surface — REAL. It loads the engine's current prompts on
// mount and Save PUTs them back to the engine, which then uses them for live
// generation (system prompt) + urgency classification (urgency prompt). Editing
// here actually changes how Nucleus answers and prioritizes documents.
//
// It saves ONLY the prompt keys (system_prompt + urgency_prompt) — never the model
// section's keys — so saving prompts can never clobber a freshly-edited Model
// setting (and vice-versa). The model choice lives in ModelsPanel; the PUT route
// updates just the keys present in the body (see api/settings/route.ts).
export function PromptsPanel() {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [urgencyPrompt, setUrgencyPrompt] = useState("");
  const [loaded, setLoaded] = useState<{ system: string; urgency: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Apply a settings payload (from GET or the PUT echo) to local state. Only the
  // prompt fields are read here; the model fields live in ModelsPanel.
  function applyServer(d: Record<string, unknown>) {
    setSystemPrompt((d.system_prompt as string) ?? "");
    setUrgencyPrompt((d.urgency_prompt as string) ?? "");
    setLoaded({
      system: (d.system_prompt as string) ?? "",
      urgency: (d.urgency_prompt as string) ?? "",
    });
  }

  // Load the live prompts from the engine on mount.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        applyServer(d);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load prompts"));
    // applyServer is stable for our purposes (only setters); run once on mount.
  }, []);

  // Prompt fields changed → enables Save and "Reset to defaults".
  const dirty =
    !!loaded && (systemPrompt !== loaded.system || urgencyPrompt !== loaded.urgency);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // ONLY the prompt keys — never the model section. The PUT route updates just
      // the keys present in the body, so this can't clobber a freshly-changed model
      // mode / endpoint / provider key.
      const body: Record<string, string> = {
        system_prompt: systemPrompt,
        urgency_prompt: urgencyPrompt,
      };
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "save failed");
      // The engine echoes the effective settings (a blank field falls back to its
      // built-in default), so reflect exactly what is now live.
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
  // saved via the same prompts-only PUT. It sends only the two prompt keys, so the
  // model section is left exactly as configured.
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
      applyServer(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "reset failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
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
              disabled={!dirty}
              className={cn(
                "inline-flex items-center gap-1.5 text-sm font-medium transition-colors",
                dirty ? "text-subtle hover:text-ink" : "text-faint/50 cursor-default"
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
