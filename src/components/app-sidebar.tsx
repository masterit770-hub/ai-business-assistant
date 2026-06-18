"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sparkles,
  FileText,
  Plug,
  Settings,
  ChevronsUpDown,
} from "lucide-react";
import { NucleusMark } from "@/components/brand";
import { currentUser } from "@/lib/mock";
import { cn } from "@/lib/utils";

const nav = [
  { label: "Ask", href: "/dashboard?view=ask", icon: Sparkles, match: "ask" },
  { label: "Documents", href: "/dashboard", icon: FileText, match: "documents" },
  { label: "Sources", href: "/settings?tab=sources", icon: Plug, match: "sources" },
  { label: "Settings", href: "/settings", icon: Settings, match: "settings" },
];

export function AppSidebar({ active }: { active: string }) {
  const pathname = usePathname();
  void pathname; // pathname kept for future client-side active detection

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-surface">
      {/* brand */}
      <div className="flex h-16 items-center gap-2 border-b border-line px-5">
        <NucleusMark />
        <span className="font-display text-xl font-bold tracking-tight text-ink">
          Nucleus
        </span>
      </div>

      {/* workspace switcher */}
      <div className="px-3 pt-4">
        <button className="flex w-full items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5 text-left transition-colors hover:bg-muted">
          <span className="flex size-8 items-center justify-center rounded-md bg-ink text-xs font-semibold text-white">
            MR
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-ink">
              {currentUser.company}
            </span>
            <span className="block truncate text-xs text-faint">
              Business plan
            </span>
          </span>
          <ChevronsUpDown className="size-4 text-faint" />
        </button>
      </div>

      {/* nav */}
      <nav className="flex-1 space-y-1 px-3 pt-4">
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

      {/* user */}
      <div className="border-t border-line p-3">
        <button className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted">
          <span className="flex size-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg">
            {currentUser.initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-ink">
              {currentUser.name}
            </span>
            <span className="block truncate text-xs text-faint">
              {currentUser.email}
            </span>
          </span>
          <ChevronsUpDown className="size-4 text-faint" />
        </button>
      </div>
    </aside>
  );
}
