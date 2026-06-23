"use client";

import { useEffect, useState } from "react";
import { Sliders, Pencil, Check, Loader2, AlertCircle } from "lucide-react";
import { ModelSwitch } from "@/components/model-switch";
import { cn } from "@/lib/utils";
import { interpretSaveResponse, interpretSaveThrow } from "@/lib/settings/save-feedback";

// ANSWER SETUP — the inline strip above the chat input. It lets you tune HOW the
// assistant answers without leaving the chat: pick a style preset, edit the system
// prompt inline (admin only — same value as Settings → Prompts, via /api/settings), and
// switch the model. Non-admins see the model indicator + the active style, read-only.
type PresetKey = "general" | "analysis" | "custom";

const PRESETS: Record<Exclude<PresetKey, "custom">, { label: string; prompt: string }> = {
  general: {
    label: "General",
    prompt:
      "You are the AI Business Assistant, a sharp, helpful business assistant. Answer clearly, concretely, and concisely. When the user's documents or data are provided as evidence, ground your answer strictly in them and cite every fact; otherwise answer from your general knowledge.",
  },
  analysis: {
    label: "Analysis",
    prompt:
      "You are the AI Business Assistant in ANALYSIS mode. Give thorough, well-structured answers: break down the reasoning, surface caveats and data-quality notes, and use a table when comparing items. When the user's documents or data are provided, ground every claim in them and cite it; never invent figures.",
  },
};

function presetOf(prompt: string): PresetKey {
  const p = prompt.trim();
  if (p === PRESETS.general.prompt) return "general";
  if (p === PRESETS.analysis.prompt) return "analysis";
  return "custom";
}

export function AnswerSetup() {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // A real save error, surfaced to the user. The bug this fixes: persist() used to
  // swallow every failure in an empty catch{} and show "Saved" UNCONDITIONALLY — a
  // failed PUT (a 4xx/5xx, or a network error) looked successful, so a prompt the
  // server never stored appeared saved. Now we check res.ok, show a real error on
  // failure, and only show "Saved" when the server actually persisted the value.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Settings are PER-USER: every signed-in user has their OWN system prompt and can edit
    // it here (it applies to their own chats). /api/me returns the caller's current prompt
    // so the active style shows correctly from the start.
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (typeof d?.system_prompt === "string") setPrompt(d.system_prompt);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const active = presetOf(prompt);

  async function persist(value: string) {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: value }),
      });
      // Read the body (the route returns { error } on failure) so the interpreter can
      // surface the real reason. Tolerate a non-JSON body.
      const body = await res.json().catch(() => undefined);
      // Honest outcome via the shared, unit-tested interpreter: success ONLY on a 2xx.
      // A non-ok response is NEVER reported as saved (the silent-failure bug).
      const outcome = interpretSaveResponse({ ok: res.ok, status: res.status, body });
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      // Only adopt the value + show success once the PUT genuinely succeeded.
      setPrompt(value);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      // The fetch itself REJECTED (network failure / offline) → a REAL error, never "Saved".
      setError(interpretSaveThrow(e).error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-b border-line px-5 py-2.5" data-testid="answer-setup">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
          <Sliders className="size-3.5" strokeWidth={2.2} />
          Answer setup
        </span>

        {/* style presets */}
        <div className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-2 p-0.5">
          {(["general", "analysis"] as const).map((k) => (
            <button
              key={k}
              type="button"
              disabled={saving}
              onClick={() => persist(PRESETS[k].prompt)}
              data-testid={`preset-${k}`}
              aria-pressed={active === k}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors disabled:cursor-default",
                active === k ? "bg-accent text-accent-fg" : "text-subtle hover:text-ink"
              )}
              title={`Set the ${PRESETS[k].label} answering style`}
            >
              {PRESETS[k].label}
            </button>
          ))}
          {active === "custom" && (
            <span className="px-2 py-1 text-[12px] font-semibold text-accent">Custom</span>
          )}
        </div>

        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          data-testid="edit-prompt-toggle"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[12px] font-semibold text-subtle transition-colors hover:border-accent-ring hover:text-ink"
        >
          <Pencil className="size-3.5" />
          {editing ? "Close" : "Edit prompt"}
        </button>

        {/* A save error from a preset button (no editor open) — surfaced inline so a failed
            save is NEVER mistaken for success. The editor below shows its own error too. */}
        {error && !editing && (
          <span
            data-testid="answer-setup-error"
            className="inline-flex items-center gap-1 text-[12px] font-medium text-red-600"
          >
            <AlertCircle className="size-3.5" />
            {error}
          </span>
        )}

        {/* model switch — each user picks their own model — lives here so it's all in one place */}
        <div className="ml-auto">
          <ModelSwitch variant="panel" />
        </div>
      </div>

      {editing && (
        <div className="mt-3" data-testid="inline-prompt-editor">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            data-testid="inline-prompt"
            className="w-full resize-y rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/15"
            placeholder="How should the assistant answer? (the system prompt)"
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => persist(prompt)}
              disabled={saving}
              data-testid="save-prompt"
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg transition-colors hover:bg-accent-strong disabled:opacity-50"
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              Save prompt
            </button>
            {saved && !error && (
              <span
                data-testid="answer-setup-saved"
                className="inline-flex items-center gap-1 text-[12px] font-medium text-accent"
              >
                <Check className="size-3.5" strokeWidth={2.5} />
                Saved
              </span>
            )}
            {error && (
              <span
                data-testid="answer-setup-error"
                className="inline-flex items-center gap-1 text-[12px] font-medium text-red-600"
              >
                <AlertCircle className="size-3.5" />
                {error}
              </span>
            )}
            <span className="text-[11px] text-faint">
              This is the same system prompt as Settings → Prompts.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
