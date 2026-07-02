import Link from "next/link";
import { cn } from "@/lib/utils";

// The NUCLEUS 770 mark: a rounded violet square (neon gradient) with a
// stacked "layers" glyph — the inspector/orchestration motif from the reference UI.
// Pure SVG + CSS, no libraries. `size` controls the square; the glyph scales with it.
export function AssistantMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-xl text-white neon-glow",
        "size-9 bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))]",
        className
      )}
      role="img"
      aria-label="NUCLEUS 770"
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
        {/* a stacked-layers / orchestration glyph */}
        <path
          d="M12 3.5 20 7l-8 3.5L4 7l8-3.5Z"
          fill="currentColor"
          opacity="0.95"
        />
        <path
          d="M4 11.5 12 15l8-3.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.75"
        />
        <path
          d="M4 15.5 12 19l8-3.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.5"
        />
      </svg>
    </span>
  );
}

// Backwards-compatible alias — older imports referenced NucleusMark.
export const NucleusMark = AssistantMark;

export function Wordmark({
  className,
  href = "/",
  subtitle = true,
  // The product name to display. Defaults to the in-app name; the public landing
  // passes "Nucleus".
  name = "NUCLEUS 770",
}: {
  className?: string;
  href?: string;
  subtitle?: boolean;
  name?: string;
}) {
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2.5", className)}>
      <AssistantMark />
      <span className="flex flex-col leading-none">
        <span className="font-display text-[1.15rem] font-bold tracking-tight text-ink">
          {name}
        </span>
        {subtitle && (
          <span className="mt-0.5 text-[11px] font-medium text-faint">
            Multi-source retrieval &amp; orchestration
          </span>
        )}
      </span>
    </Link>
  );
}
