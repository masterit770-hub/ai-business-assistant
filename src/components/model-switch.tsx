"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Cloud, Server, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// THE BIG SWITCH — a prominent, segmented Cloud ⇄ Local control. The ACTIVE side is
// filled in the accent color so the current backend is unmistakable at a glance;
// the inactive side is a quiet ghost button. Admin-only: it self-resolves the
// viewer's role (/api/me) and the live mode (/api/settings, admin-only), renders
// NOTHING for a non-admin, and PUTs model_mode on click so the change takes effect
// on the very next question (chat() reads the mode at request time).
//
// `variant="panel"` is the compact form for the top of the Ask panel;
// `variant="header"` is a slightly larger form for a page header.
type Mode = "cloud" | "local";

export function ModelSwitch({
  variant = "panel",
  onModeChange,
}: {
  variant?: "panel" | "header";
  onModeChange?: (mode: Mode) => void;
}) {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [endpointSet, setEndpointSet] = useState<boolean>(true);
  const [saving, setSaving] = useState<Mode | null>(null);

  // Resolve role first; only an admin loads + can flip the switch.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me = await fetch("/api/me").then((r) => r.json());
        const admin = me?.user?.role === "admin";
        if (!alive) return;
        setIsAdmin(admin);
        if (!admin) return;
        const s = await fetch("/api/settings").then((r) => r.json());
        if (!alive || s?.error) return;
        const m: Mode = s.model_mode === "local" ? "local" : "cloud";
        setMode(m);
        setEndpointSet(Boolean((s.local_endpoint ?? "").trim()));
        onModeChange?.(m);
      } catch {
        if (alive) setIsAdmin(false);
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
      const confirmed: Mode = d.model_mode === "local" ? "local" : "cloud";
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

  // Hidden entirely until we know the viewer is an admin (and mode loaded).
  if (isAdmin !== true || mode === null) return null;

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

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="model-switch" data-mode={mode}>
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
        aria-label="Switch the AI model between Cloud and Local"
        className="inline-flex items-center gap-1 rounded-xl border border-line bg-canvas p-1 shadow-soft"
      >
        {seg("cloud", "Cloud", Cloud)}
        {seg("local", "Local", Server)}
      </div>
      {/* Inline hint when Local is the active mode but no endpoint is configured. */}
      {mode === "local" && !endpointSet && (
        <Link
          href="/settings?tab=prompts"
          data-testid="model-switch-hint"
          className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-100"
        >
          Set up Local in Settings → Model
        </Link>
      )}
    </div>
  );
}
