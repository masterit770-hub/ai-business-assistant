"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Cloud, Server, ShieldCheck, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// THE BIG SWITCH — a prominent, segmented Cloud ⇄ Local control. The ACTIVE side is
// filled in the accent color so the current backend is unmistakable at a glance;
// the inactive side is a quiet ghost button. Admin-only: it self-resolves the
// caller's OWN live mode (/api/settings is per-user), renders once that mode has
// loaded, and PUTs model_mode on click so the change takes effect
// on the very next question (chat() reads the mode at request time).
//
// `variant="panel"` is the compact form for the top of the Ask panel;
// `variant="header"` is a slightly larger form for a page header.
type Mode = "cloud" | "hipaa" | "local";

// Normalize a stored model_mode string to one of the three modes; anything
// unknown/blank fails safe to "cloud" (the working default), mirroring the engine.
const normMode = (v: unknown): Mode =>
  v === "local" ? "local" : v === "hipaa" ? "hipaa" : "cloud";

export function ModelSwitch({
  variant = "panel",
  onModeChange,
}: {
  variant?: "panel" | "header";
  onModeChange?: (mode: Mode) => void;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [endpointSet, setEndpointSet] = useState<boolean>(true);
  const [saving, setSaving] = useState<Mode | null>(null);

  // Settings are PER-USER: every signed-in user loads + flips their OWN model. /api/settings
  // is owner-scoped (no admin gate), so this reads/writes the caller's own model_mode.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await fetch("/api/settings").then((r) => r.json());
        if (!alive || s?.error) return;
        const m: Mode = normMode(s.model_mode);
        setMode(m);
        setEndpointSet(Boolean((s.local_endpoint ?? "").trim()));
        onModeChange?.(m);
      } catch {
        /* leave mode null → render nothing */
      }
    })();
    return () => {
      alive = false;
    };
    // onModeChange is intentionally not a dep — we only want the initial sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function flip(next: Mode) {
    if (next === mode || saving) return;
    setSaving(next);
    // Optimistic: reflect the new mode immediately so it feels instant.
    const prev = mode;
    setMode(next);
    onModeChange?.(next);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_mode: next }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "failed");
      const confirmed: Mode = normMode(d.model_mode);
      setMode(confirmed);
      setEndpointSet(Boolean((d.local_endpoint ?? "").trim()));
      onModeChange?.(confirmed);
    } catch {
      // Roll back on failure so the UI never lies about the live mode.
      setMode(prev);
      onModeChange?.(prev ?? "cloud");
    } finally {
      setSaving(null);
    }
  }

  // Hidden until the caller's own mode has loaded.
  if (mode === null) return null;

  const big = variant === "header";
  const segBase =
    "relative inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
  const segSize = big ? "px-4 py-2 text-sm" : "px-3 py-1.5 text-[13px]";

  const seg = (m: Mode, label: string, Icon: typeof Cloud) => {
    const active = mode === m;
    const isSaving = saving === m;
    return (
      <button
        key={m}
        type="button"
        onClick={() => flip(m)}
        aria-pressed={active}
        data-testid={`model-switch-${m}`}
        data-active={active}
        className={cn(
          segBase,
          segSize,
          active
            ? "bg-accent text-accent-fg shadow-soft"
            : "text-subtle hover:text-ink"
        )}
      >
        {isSaving ? (
          <Loader2 className={cn(big ? "size-4" : "size-3.5", "animate-spin")} />
        ) : (
          <Icon className={big ? "size-4" : "size-3.5"} strokeWidth={2.2} />
        )}
        {label}
      </button>
    );
  };

  // Plain-language one-liner for the ACTIVE mode, shown right under the switch so a
  // non-technical owner knows what each choice means without leaving the control.
  const MODE_BLURB: Record<Mode, string> = {
    cloud: "Cloud — a hosted AI; works with any provider key.",
    hipaa: "HIPAA — your own Azure key, for patient data under a BAA.",
    local: "Local — runs on your own machine; nothing leaves it.",
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="model-switch" data-mode={mode}>
      <span
        className={cn(
          "font-medium uppercase tracking-wide text-faint",
          big ? "text-[11px]" : "text-[10px]"
        )}
      >
        AI model
      </span>
      <div
        role="group"
        aria-label="Switch the AI model between Cloud, HIPAA, and Local"
        className="inline-flex items-center gap-1 rounded-xl border border-line bg-canvas p-1 shadow-soft"
      >
        {seg("cloud", "Cloud", Cloud)}
        {seg("hipaa", "HIPAA", ShieldCheck)}
        {seg("local", "Local", Server)}
      </div>
      {/* What the active mode means, in plain language (basis-full → its own line). */}
      <p
        data-testid="model-switch-blurb"
        className={cn("basis-full text-faint", big ? "text-xs" : "text-[11px]")}
      >
        {MODE_BLURB[mode]}
      </p>
      {/* Inline hint when Local is the active mode but no endpoint is configured. */}
      {mode === "local" && !endpointSet && (
        <Link
          href="/settings?tab=prompts"
          data-testid="model-switch-hint"
          className="inline-flex items-center gap-1 rounded-lg border border-medium/40 bg-medium-soft px-2 py-1 text-[11px] font-medium text-medium transition-colors hover:opacity-90"
        >
          Set up Local in Settings → Model
        </Link>
      )}
    </div>
  );
}
