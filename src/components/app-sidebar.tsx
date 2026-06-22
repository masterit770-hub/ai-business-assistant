"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquare, FileText, Clock, User, Settings } from "lucide-react";
import { AssistantMark } from "@/components/brand";
import { UserMenu } from "@/components/user-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

// Real, reachable destinations only. "Ask" was removed (it rendered the same
// dashboard; the Ask panel lives on /dashboard). "Sources" was removed (the
// connectors feature is out of scope — no real connected sources exist).
// `adminOnly` items are hidden from non-admins (server access is also gated; this
// just avoids dead-end links into a forbidden page).
const nav = [
  { label: "Chat", href: "/dashboard", icon: MessageSquare, match: "chat" },
  { label: "Sources", href: "/sources", icon: FileText, match: "sources" },
  { label: "History", href: "/history", icon: Clock, match: "history" },
  { label: "Settings", href: "/settings", icon: Settings, match: "settings", adminOnly: true },
  { label: "Account", href: "/account", icon: User, match: "account" },
];

export function AppSidebar({ active }: { active: string }) {
  const pathname = usePathname();
  void pathname; // pathname kept for future client-side active detection

  // Resolve the real role to gate admin-only nav (the dashboard is reachable by
  // everyone; Settings/Users is admin-only). Defaults to hiding admin items until
  // the role is known, so a member never briefly sees a dead-end link.
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => alive && setIsAdmin(d?.user?.role === "admin"))
      .catch(() => alive && setIsAdmin(false));
    return () => {
      alive = false;
    };
  }, []);
  const visibleNav = nav.filter((item) => !item.adminOnly || isAdmin === true);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-surface">
      {/* brand */}
      <div className="flex h-16 items-center justify-between gap-2 border-b border-line px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <AssistantMark className="size-8 shrink-0" />
          <span className="flex min-w-0 flex-col leading-none">
            <span className="truncate font-display text-[0.95rem] font-bold tracking-tight text-ink">
              AI Business Assistant
            </span>
            <span className="mt-0.5 truncate text-[10px] font-medium text-faint">
              Multi-source retrieval
            </span>
          </span>
        </div>
        <ThemeToggle className="size-8 shrink-0" />
      </div>

      {/* nav */}
      <nav className="flex-1 space-y-1 px-3 pt-4">
        {visibleNav.map((item) => {
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

      {/* user — real session + sign out */}
      <div className="border-t border-line p-3">
        <UserMenu />
      </div>
    </aside>
  );
}
