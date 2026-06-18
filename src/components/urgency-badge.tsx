import type { Urgency } from "@/lib/mock";
import { cn } from "@/lib/utils";

const styles: Record<Urgency, { dot: string; text: string; bg: string; label: string }> = {
  high: {
    dot: "bg-high",
    text: "text-high",
    bg: "bg-high-soft border-high/20",
    label: "High",
  },
  medium: {
    dot: "bg-medium",
    text: "text-medium",
    bg: "bg-medium-soft border-medium/20",
    label: "Medium",
  },
  low: {
    dot: "bg-low",
    text: "text-low",
    bg: "bg-low-soft border-low/20",
    label: "Low",
  },
};

export function UrgencyBadge({ urgency }: { urgency: Urgency }) {
  const s = styles[urgency];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        s.bg,
        s.text
      )}
    >
      <span className={cn("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}
