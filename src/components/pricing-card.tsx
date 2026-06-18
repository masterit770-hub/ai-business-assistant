import Link from "next/link";
import { Check } from "lucide-react";
import type { PricingTier } from "@/lib/mock";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PricingCard({ tier }: { tier: PricingTier }) {
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl border bg-surface p-7 transition-shadow",
        tier.highlighted
          ? "border-accent shadow-lift ring-1 ring-accent/20"
          : "border-line shadow-soft hover:shadow-card"
      )}
    >
      {tier.highlighted && (
        <span className="absolute -top-3 left-7 rounded-full bg-accent px-3 py-1 text-xs font-semibold tracking-wide text-accent-fg uppercase">
          Most popular
        </span>
      )}
      <h3 className="text-lg font-semibold text-ink">{tier.name}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-faint">{tier.blurb}</p>
      <div className="mt-5 flex items-baseline gap-1">
        <span className="tabular text-4xl font-semibold text-ink">
          {tier.price}
        </span>
        <span className="text-sm text-faint">{tier.cadence}</span>
      </div>
      <Button
        asChild
        size="lg"
        className={cn(
          "mt-6 h-11 w-full text-sm",
          tier.highlighted
            ? "bg-accent text-accent-fg hover:bg-accent/90 shadow-soft"
            : "border border-line bg-surface text-ink hover:bg-muted"
        )}
      >
        <Link href="/sign-up">{tier.cta}</Link>
      </Button>
      <ul className="mt-7 space-y-3">
        {tier.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5 text-sm">
            <span
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                tier.highlighted ? "bg-accent-soft" : "bg-muted"
              )}
            >
              <Check className="size-3 text-accent" strokeWidth={2.5} />
            </span>
            <span className="text-subtle">{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
