import Link from "next/link";
import { Check, Minus } from "lucide-react";
import { MarketingNav, MarketingFooter } from "@/components/marketing";
import { PricingCard } from "@/components/pricing-card";
import { pricingTiers } from "@/lib/mock";

const comparison: { label: string; values: (boolean | string)[] }[] = [
  { label: "Documents", values: ["200", "Unlimited", "Unlimited"] },
  { label: "Connected sources", values: ["2", "All connectors", "All connectors"] },
  { label: "Ask Nucleus questions", values: ["100 / mo", "Unlimited", "Unlimited"] },
  { label: "Cited, trustworthy numbers", values: [false, true, true] },
  { label: "SSO & SCIM", values: [false, false, true] },
  { label: "Audit log & data residency", values: [false, false, true] },
  { label: "Role-based permissions", values: [false, false, true] },
  { label: "Support", values: ["Community", "Priority", "Dedicated CSM"] },
];

function Cell({ value }: { value: boolean | string }) {
  if (typeof value === "boolean") {
    return value ? (
      <Check className="mx-auto size-4 text-accent" strokeWidth={2.5} />
    ) : (
      <Minus className="mx-auto size-4 text-line-strong" strokeWidth={2.5} />
    );
  }
  return <span className="text-sm text-subtle">{value}</span>;
}

export default function PricingPage() {
  return (
    <div className="flex min-h-full flex-col">
      <MarketingNav />

      <main className="flex-1">
        <section className="relative overflow-hidden border-b border-line">
          <div className="absolute inset-0 bg-dotgrid opacity-50 [mask-image:radial-gradient(ellipse_at_top,black,transparent_75%)]" />
          <div className="relative mx-auto max-w-3xl px-6 pt-20 pb-10 text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-subtle shadow-soft">
              <span className="size-1.5 rounded-full bg-accent" />
              Pricing
            </span>
            <h1 className="mt-5 font-display text-4xl font-bold tracking-tight text-ink sm:text-5xl">
              Pricing that grows with your team
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-lg text-subtle">
              Start free, then unlock every source and unlimited answers when
              your whole company comes aboard.
            </p>
          </div>
        </section>

        <section className="bg-canvas">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <div className="grid gap-6 lg:grid-cols-3">
              {pricingTiers.map((tier) => (
                <PricingCard key={tier.name} tier={tier} />
              ))}
            </div>
          </div>
        </section>

        {/* ── Comparison table ── */}
        <section className="border-t border-line bg-surface">
          <div className="mx-auto max-w-5xl px-6 py-16">
            <h2 className="text-center font-display text-2xl font-bold tracking-tight text-ink">
              Compare every plan
            </h2>
            <div className="mt-10 overflow-hidden rounded-2xl border border-line">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-canvas">
                    <th className="px-5 py-4 text-left text-sm font-semibold text-faint">
                      Features
                    </th>
                    {pricingTiers.map((t) => (
                      <th
                        key={t.name}
                        className="px-5 py-4 text-center text-sm font-semibold text-ink"
                      >
                        {t.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((row, i) => (
                    <tr
                      key={row.label}
                      className={i % 2 === 1 ? "bg-canvas/60" : "bg-surface"}
                    >
                      <td className="px-5 py-3.5 text-sm font-medium text-ink">
                        {row.label}
                      </td>
                      {row.values.map((v, j) => (
                        <td key={j} className="px-5 py-3.5 text-center">
                          <Cell value={v} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-8 text-center text-sm text-faint">
              All plans include a 14-day Pro trial.{" "}
              <Link href="/sign-up" className="font-medium text-accent hover:underline">
                Start yours →
              </Link>
            </p>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
