"use client";

import { useEffect, useState } from "react";
import { Sliders, Pencil, Check, Loader2 } from "lucide-react";
import { ModelSwitch } from "@/components/model-switch";
import { cn } from "@/lib/utils";

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
  const [isAdmin, setIsAdmin] = useState(false);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => alive && setIsAdmin(d?.user?.role === "admin"))
      .catch(() => {});
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setPrompt(typeof d.system_prompt === "string" ? d.system_prompt : ""))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const active = presetOf(prompt);

  async function persist(value: string) {
    setSaving(true);
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: value }),
      });
      setPrompt(value);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      /* surfaced by the next load; non-fatal to the chat */
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
              disabled={!isAdmin || saving}
              onClick={() => persist(PRESETS[k].prompt)}
              data-testid={`preset-${k}`}
              aria-pressed={active === k}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors disabled:cursor-default",
                active === k ? "bg-accent text-accent-fg" : "text-subtle hover:text-ink",
                !isAdmin && "opacity-70"
              )}
              title={isAdmin ? `Set the ${PRESETS[k].label} answering style` : "The active answering style"}
            >
              {PRESETS[k].label}
            </button>
          ))}
          {active === "custom" && (
            <span className="px-2 py-1 text-[12px] font-semibold text-accent">Custom</span>
          )}
        </div>

        {isAdmin && (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            data-testid="edit-prompt-toggle"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[12px] font-semibold text-subtle transition-colors hover:border-accent-ring hover:text-ink"
          >
            <Pencil className="size-3.5" />
            {editing ? "Close" : "Edit prompt"}
          </button>
        )}

        {/* model switch (admin-gated internally) lives here so it's all in one place */}
        <div className="ml-auto">
          <ModelSwitch variant="panel" />
        </div>
      </div>

      {isAdmin && editing && (
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
            {saved && (
              <span className="inline-flex items-center gap-1 text-[12px] font-medium text-accent">
                <Check className="size-3.5" strokeWidth={2.5} />
                Saved
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
