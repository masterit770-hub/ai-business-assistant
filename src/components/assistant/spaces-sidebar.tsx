"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Folder, FolderOpen, Plus, Trash2, Loader2, ChevronRight, Globe } from "lucide-react";
import { cn } from "@/lib/utils";

export type Space = {
  id: string;
  name: string;
  created_at: string;
};

type SpacesSidebarProps = {
  activeSpaceId?: string | null;
  onSpaceChange: (spaceId: string | null) => void;
  globalMode: boolean;
  onGlobalModeChange: (on: boolean) => void;
};

export function SpacesSidebar({
  activeSpaceId,
  onSpaceChange,
  globalMode,
  onGlobalModeChange,
}: SpacesSidebarProps) {
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  async function loadSpaces() {
    try {
      const res = await fetch("/api/spaces");
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "failed to load spaces");
      setSpaces(d.spaces ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load spaces");
    }
  }

  useEffect(() => {
    loadSpaces();
    const onCreated = () => loadSpaces();
    window.addEventListener("nucleus:space-created", onCreated);
    return () => window.removeEventListener("nucleus:space-created", onCreated);
  }, []);

  async function createSpace() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/spaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "failed to create space");
      setNewName("");
      await loadSpaces();
      // Auto-switch to the new space.
      if (d.space?.id) onSpaceChange(d.space.id);
      window.dispatchEvent(new CustomEvent("nucleus:space-created"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to create space");
    } finally {
      setCreating(false);
    }
  }

  async function deleteSpace(spaceId: string) {
    setDeleting(spaceId);
    setError(null);
    try {
      const res = await fetch(`/api/spaces?space=${encodeURIComponent(spaceId)}`, {
        method: "DELETE",
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "failed to delete space");
      setConfirmingDelete(null);
      await loadSpaces();
      // If we just deleted the active space, go back to "no space".
      if (activeSpaceId === spaceId) onSpaceChange(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to delete space");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="spaces-sidebar">
      {/* Section header */}
      <div className="flex items-center justify-between px-1 pb-1">
        <span
          className="text-[11px] font-semibold uppercase tracking-wide text-faint"
          data-testid="spaces-section-label"
        >
          Spaces
        </span>
      </div>

      {error && (
        <p className="px-1 text-xs text-high" data-testid="spaces-error">
          {error}
        </p>
      )}

      {/* Global (Entire Workspace) toggle */}
      <button
        type="button"
        onClick={() => {
          onGlobalModeChange(!globalMode);
          if (!globalMode) onSpaceChange(null); // entering global: clear space selection
        }}
        data-testid="global-mode-toggle"
        className={cn(
          "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          globalMode
            ? "bg-accent-soft text-accent"
            : "text-subtle hover:bg-muted hover:text-ink"
        )}
      >
        <Globe className="size-4 shrink-0" strokeWidth={2} />
        <span className="truncate">Entire Workspace</span>
        {globalMode && (
          <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide opacity-70">
            ON
          </span>
        )}
      </button>

      {/* Spaces list */}
      {spaces === null ? (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-faint">
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </div>
      ) : spaces.length === 0 ? (
        <p className="px-3 py-2 text-xs text-faint">
          No spaces yet. Create one below.
        </p>
      ) : (
        <ul className="space-y-0.5" data-testid="spaces-list">
          {spaces.map((sp) => {
            const isActive = sp.id === activeSpaceId && !globalMode;
            const isConfirming = confirmingDelete === sp.id;
            return (
              <li key={sp.id} data-testid={`space-item-${sp.id}`}>
                {isConfirming ? (
                  <div className="flex items-center gap-1.5 rounded-lg bg-high-soft px-3 py-2">
                    <span className="flex-1 text-xs font-medium text-high">
                      Delete &quot;{sp.name}&quot;?
                    </span>
                    <button
                      type="button"
                      onClick={() => deleteSpace(sp.id)}
                      disabled={deleting === sp.id}
                      data-testid={`space-delete-confirm-${sp.id}`}
                      className="rounded-md bg-high px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-high/90 disabled:opacity-50"
                    >
                      {deleting === sp.id ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        "Delete"
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(null)}
                      data-testid={`space-delete-cancel-${sp.id}`}
                      className="rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-subtle hover:bg-surface-2"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-3 py-2 transition-colors group",
                      isActive
                        ? "bg-accent-soft text-accent"
                        : "text-subtle hover:bg-muted hover:text-ink cursor-pointer"
                    )}
                    onClick={() => {
                      if (!isActive) {
                        onGlobalModeChange(false);
                        onSpaceChange(sp.id);
                      }
                    }}
                    data-testid={`space-open-${sp.id}`}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        onGlobalModeChange(false);
                        onSpaceChange(sp.id);
                      }
                    }}
                  >
                    {isActive ? (
                      <FolderOpen className="size-4 shrink-0" strokeWidth={2} />
                    ) : (
                      <Folder className="size-4 shrink-0" strokeWidth={2} />
                    )}
                    <span
                      className="min-w-0 flex-1 truncate text-sm font-medium"
                      data-testid={`space-name-${sp.id}`}
                      title={sp.name}
                    >
                      {sp.name}
                    </span>
                    {isActive && (
                      <ChevronRight className="size-3.5 shrink-0 opacity-60" />
                    )}
                    {/* Delete button — visible on hover */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmingDelete(sp.id);
                      }}
                      data-testid={`space-delete-${sp.id}`}
                      title={`Delete "${sp.name}" space`}
                      className={cn(
                        "invisible rounded-md p-0.5 text-faint hover:text-high group-hover:visible",
                        isActive && "visible"
                      )}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Create new space */}
      <div className="mt-1 px-1" data-testid="create-space-form">
        <div className="flex gap-1.5">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createSpace()}
            placeholder="New space…"
            data-testid="create-space-input"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-ink placeholder-faint outline-none focus:border-accent-ring focus:ring-1 focus:ring-accent-ring/40"
          />
          <button
            type="button"
            onClick={createSpace}
            disabled={creating || !newName.trim()}
            data-testid="create-space-button"
            title="Create space"
            className="flex items-center justify-center rounded-lg border border-line bg-surface px-2 py-1.5 text-subtle hover:border-accent-ring hover:text-ink disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
