"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

export interface SimpleTab {
  value: string;
  label: string;
  content: React.ReactNode;
}

// A small, dependency-free tab bar — horizontal pills over the active panel.
// Used on Settings; reliable across Tailwind v4 without generated custom variants.
export function SimpleTabs({
  tabs,
  defaultValue,
}: {
  tabs: SimpleTab[];
  defaultValue?: string;
}) {
  const [active, setActive] = useState(defaultValue ?? tabs[0]?.value);
  const current = tabs.find((t) => t.value === active) ?? tabs[0];

  return (
    <div>
      <div className="inline-flex items-center gap-1 rounded-xl border border-line bg-muted p-1">
        {tabs.map((t) => (
          <button
            key={t.value}
            onClick={() => setActive(t.value)}
            className={cn(
              "rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
              t.value === active
                ? "bg-surface text-ink shadow-soft"
                : "text-faint hover:text-ink"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-6">{current?.content}</div>
    </div>
  );
}
