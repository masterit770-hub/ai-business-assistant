import Link from "next/link";
import { cn } from "@/lib/utils";

// The Nucleus mark: a small atom-like glyph — a solid teal core ringed by an
// elliptical orbit. Pure SVG, no libraries.
export function NucleusMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("size-7", className)}
      role="img"
      aria-label="Nucleus"
    >
      <ellipse
        cx="16"
        cy="16"
        rx="13"
        ry="6"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.75"
        transform="rotate(-32 16 16)"
        opacity="0.55"
      />
      <ellipse
        cx="16"
        cy="16"
        rx="13"
        ry="6"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.75"
        transform="rotate(32 16 16)"
        opacity="0.55"
      />
      <circle cx="16" cy="16" r="4.25" fill="var(--color-accent)" />
    </svg>
  );
}

export function Wordmark({
  className,
  href = "/",
}: {
  className?: string;
  href?: string;
}) {
  return (
    <Link
      href={href}
      className={cn("inline-flex items-center gap-2", className)}
    >
      <NucleusMark />
      <span className="font-display text-[1.35rem] font-bold tracking-tight text-ink">
        Nucleus
      </span>
    </Link>
  );
}
