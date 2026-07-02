"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  MessageSquare,
  MessageSquarePlus,
  Loader2,
  RefreshCw,
  FileText,
  Clock,
  User,
  Settings,
} from "lucide-react";
import { AssistantMark } from "@/components/brand";
import { UserMenu } from "@/components/user-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import { SpacesSidebar } from "@/components/assistant/spaces-sidebar";

// One conversation SESSION, as returned by GET /api/history.
type SessionSummary = {
  session_id: string;
  title: string;
  turn_count: number;
  last_at: string;
};

// Nav items — same as AppSidebar. Chat, Sources, History, Settings, Account.
const nav = [
  { label: "Chat", href: "/dashboard", icon: MessageSquare, match: "chat" },
  { label: "Sources", href: "/sources", icon: FileText, match: "sources" },
  { label: "History", href: "/history", icon: Clock, match: "history" },
  { label: "Settings", href: "/settings", icon: Settings, match: "settings" },
  { label: "Account", href: "/account", icon: User, match: "account" },
];

function when(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// UNIFIED SIDEBAR — merges AppSidebar (brand + nav + user) and ConversationsColumn
// (new chat button + conversations list) into a single w-64 column on the dashboard.
// Also hosts the Spaces list (Knowledge Spaces — migration 016).
export function UnifiedSidebar({
  active,
  activeSpaceId,
  onSpaceChange,
  globalMode,
  onGlobalModeChange,
}: {
  active: string;
  activeSpaceId?: string | null;
  onSpaceChange?: (spaceId: string | null) => void;
  globalMode?: boolean;
  onGlobalModeChange?: (on: boolean) => void;
}) {
  const params = useSearchParams();
  const activeSession = params.get("session");

  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load sessions: if a space is active, load ONLY that space's sessions.
  // Otherwise, load the full history (all chats).
  async function load() {
    try {
      const url = activeSpaceId
        ? `/api/spaces/sessions?space=${encodeURIComponent(activeSpaceId)}`
        : "/api/history";
      const res = await fetch(url);
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "failed to load conversations");
      setSessions(d.sessions ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load conversations");
    }
  }

  useEffect(() => {
    load();
    const onSession = () => load();
    window.addEventListener("nucleus:session", onSession);
    return () => window.removeEventListener("nucleus:session", onSession);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId]);

  return (
    <aside
      data-testid="conversations-column"
      className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-surface"
    >
      {/* brand header — same as AppSidebar */}
      <div className="flex h-16 items-center justify-between gap-2 border-b border-line px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <AssistantMark className="size-8 shrink-0" />
          <span className="flex min-w-0 flex-col leading-none">
            <span className="truncate font-display text-[0.95rem] font-bold tracking-tight text-ink">
              NUCLEUS 770
            </span>
            <span className="mt-0.5 truncate text-[10px] font-medium text-faint">
              Multi-source retrieval
            </span>
          </span>
        </div>
        <ThemeToggle className="size-8 shrink-0" />
      </div>

      {/* nav links */}
      <nav className="space-y-1 px-3 pt-4">
        {nav.map((item) => {
          const isActive = item.match === active;
          return (
            <Link
              key={item.label}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent-soft text-accent"
                  : "text-subtle hover:bg-muted hover:text-ink"
              )}
            >
              <item.icon className="size-[18px]" strokeWidth={2} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* divider */}
      <div className="mx-3 my-3 border-t border-line" />

      {/* Knowledge Spaces section */}
      <div className="px-3 pb-2">
        <SpacesSidebar
          activeSpaceId={activeSpaceId}
          onSpaceChange={onSpaceChange ?? (() => {})}
          globalMode={globalMode ?? false}
          onGlobalModeChange={onGlobalModeChange ?? (() => {})}
        />
      </div>

      {/* divider */}
      <div className="mx-3 mb-2 border-t border-line" />

      {/* New chat button */}
      <div className="px-3 pb-2">
        <Link
          href="/dashboard"
          data-testid="new-chat-link"
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-3 py-2.5 text-sm font-semibold text-accent-fg shadow-soft transition-colors hover:bg-accent-strong",
            !activeSession && "ring-2 ring-accent/20"
          )}
        >
          <MessageSquarePlus className="size-4" strokeWidth={2.2} />
          New chat
        </Link>
      </div>

      {/* Chats header + refresh */}
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
          {activeSpaceId ? "Space chats" : "Your chats"}
        </span>
        <button
          onClick={load}
          className="text-faint transition-colors hover:text-ink"
          title="Refresh"
          aria-label="Refresh conversations"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      {/* conversations list */}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {error && (
          <p data-testid="conversations-error" className="px-2 py-2 text-xs text-high">
            {error}
          </p>
        )}

        {!sessions && !error && (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-faint">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        )}

        {sessions && sessions.length === 0 && !error && (
          <p className="px-2 py-3 text-xs text-faint">
            No conversations yet. Start one with &quot;New chat&quot;.
          </p>
        )}

        {sessions && sessions.length > 0 && (
          <ul className="space-y-0.5">
            {sessions.map((s) => {
              const isActive = s.session_id === activeSession;
              return (
                <li key={s.session_id}>
                  <Link
                    href={`/dashboard?session=${s.session_id}`}
                    data-testid="conversation-item"
                    data-active={isActive ? "true" : "false"}
                    className={cn(
                      "flex items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                      isActive
                        ? "bg-accent-soft text-accent"
                        : "text-subtle hover:bg-muted hover:text-ink"
                    )}
                  >
                    <MessageSquare
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        isActive ? "text-accent" : "text-faint"
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-[13px] font-medium"
                        title={s.title}
                      >
                        {s.title}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-faint">
                        {when(s.last_at)} · {s.turn_count} turn
                        {s.turn_count === 1 ? "" : "s"}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* user menu footer */}
      <div className="border-t border-line p-3">
        <UserMenu />
      </div>
    </aside>
  );
}
