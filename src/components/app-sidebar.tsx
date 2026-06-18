"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, Users, Settings } from "lucide-react";
import { NucleusMark } from "@/components/brand";
import { UserMenu } from "@/components/user-menu";
import { cn } from "@/lib/utils";

// Real, reachable destinations only. "Ask" was removed (it rendered the same
// dashboard; the Ask panel lives on /dashboard). "Sources" was removed (the
// connectors feature is out of scope — no real connected sources exist).
// `adminOnly` items are hidden from non-admins (server access is also gated; this
// just avoids dead-end links into a forbidden page).
const nav = [
  { label: "Documents", href: "/dashboard", icon: FileText, match: "documents" },
  { label: "Admin", href: "/settings", icon: Users, match: "admin", adminOnly: true },
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
      <div className="flex h-16 items-center gap-2 border-b border-line px-5">
        <NucleusMark />
        <span className="font-display text-xl font-bold tracking-tight text-ink">
          Nucleus
        </span>
      </div>

      {/* workspace label — neutral (no mock company/plan) */}
      <div className="px-3 pt-4">
        <div className="flex w-full items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5">
          <span className="flex size-8 items-center justify-center rounded-md bg-ink text-xs font-semibold text-white">
            N
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-ink">
              Nucleus workspace
            </span>
          </span>
        </div>
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
