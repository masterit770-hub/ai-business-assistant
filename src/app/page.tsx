import Link from "next/link";
import { ArrowRight, FileText, ShieldCheck, Sparkles, Layers } from "lucide-react";
import { MarketingNav, MarketingFooter } from "@/components/marketing";
import { SourcesOrbit } from "@/components/sources-orbit";
import { PricingCard } from "@/components/pricing-card";
import { Button } from "@/components/ui/button";
import { pricingTiers } from "@/lib/mock";

const features = [
  {
    icon: Sparkles,
    title: "Ask anything",
    body: "One question box for your whole company. Nucleus reads across every contract, sheet, and thread to answer in plain language — with the receipts.",
  },
  {
    icon: ShieldCheck,
    title: "Trustworthy numbers",
    body: "Financial answers come straight from your ledgers and models, every figure traced to its exact source cell. No hallucinated totals.",
  },
  {
    icon: Layers,
    title: "Every source, one place",
    body: "PDFs, spreadsheets, QuickBooks, Slack, and your CRM — connected once, searched together. The whole business, one brain.",
  },
];

export default function LandingPage() {
  return (
    <div className="flex min-h-full flex-col">
      <MarketingNav />

      <main className="flex-1">
        {/* ── Hero ── */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 bg-dotgrid opacity-60 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-[1.05fr_1fr] lg:py-28">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-subtle shadow-soft">
                <span className="size-1.5 rounded-full bg-accent" />
                NotebookLM for your whole business
              </span>
              <h1 className="mt-5 font-display text-5xl font-bold leading-[1.05] tracking-tight text-ink sm:text-6xl">
                One brain for your
                <br />
                entire business.
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-subtle">
                Nucleus is a single AI that searches and answers across all your
                documents, spreadsheets, and live tools — and gives you numbers
                you can actually trust, cited to the source.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button
                  asChild
                  size="lg"
                  className="h-12 bg-accent px-6 text-base text-accent-fg hover:bg-accent/90 shadow-soft"
                >
                  <Link href="/sign-up">
                    Get started
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  size="lg"
                  className="h-12 border-line px-6 text-base text-ink hover:bg-muted"
                >
                  <Link href="/dashboard">See a live demo</Link>
                </Button>
              </div>
              <p className="mt-5 flex items-center gap-2 text-sm text-faint">
                <FileText className="size-4" />
                No credit card · Connect your first source in minutes
              </p>
            </div>

            <div id="sources" className="lg:pl-6">
              <SourcesOrbit />
            </div>
          </div>
        </section>

        {/* ── Features ── */}
        <section id="features" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <div className="max-w-2xl">
              <h2 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
                Stop hunting through ten tabs for one answer.
              </h2>
              <p className="mt-4 text-lg text-subtle">
                Your knowledge is scattered across files and apps. Nucleus pulls
                it into one place and makes it answerable.
              </p>
            </div>
            <div className="mt-12 grid gap-6 md:grid-cols-3">
              {features.map((f) => (
                <div
                  key={f.title}
                  className="rounded-2xl border border-line bg-canvas p-7 shadow-soft transition-shadow hover:shadow-card"
                >
                  <span className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <f.icon className="size-5" strokeWidth={2} />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold text-ink">
                    {f.title}
                  </h3>
                  <p className="mt-2.5 text-sm leading-relaxed text-subtle">
                    {f.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Trust strip ── */}
        <section className="border-t border-line bg-canvas">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-6 py-12 text-center">
            <p className="text-sm font-medium uppercase tracking-wider text-faint">
              Connects to the tools you already run on
            </p>
            <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
              {["Google Drive", "QuickBooks", "Slack", "HubSpot", "Notion", "Gmail"].map(
                (name) => (
                  <span
                    key={name}
                    className="font-display text-lg font-semibold text-line-strong"
                  >
                    {name}
                  </span>
                )
              )}
            </div>
          </div>
        </section>

        {/* ── Pricing strip ── */}
        <section id="pricing" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
                Simple pricing that scales with you
              </h2>
              <p className="mt-4 text-lg text-subtle">
                Start free. Upgrade when your whole team wants in.
              </p>
            </div>
            <div className="mt-14 grid gap-6 lg:grid-cols-3">
              {pricingTiers.map((tier) => (
                <PricingCard key={tier.name} tier={tier} />
              ))}
            </div>
            <p className="mt-8 text-center text-sm text-faint">
              Want the full breakdown?{" "}
              <Link href="/pricing" className="font-medium text-accent hover:underline">
                Compare all plans →
              </Link>
            </p>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="border-t border-line bg-canvas">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <div className="relative overflow-hidden rounded-3xl border border-line bg-ink px-8 py-16 text-center shadow-lift">
              <div className="absolute inset-0 bg-dotgrid opacity-10" />
              <div className="relative">
                <h2 className="font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
                  Give your business one brain.
                </h2>
                <p className="mx-auto mt-4 max-w-xl text-lg text-white/70">
                  Connect your first source and ask your first question in the
                  next five minutes.
                </p>
                <Button
                  asChild
                  size="lg"
                  className="mt-8 h-12 bg-accent px-6 text-base text-accent-fg hover:bg-accent/90"
                >
                  <Link href="/sign-up">
                    Get started free
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
