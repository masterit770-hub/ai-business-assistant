import Link from "next/link";
import { ArrowRight, FileText, ShieldCheck, Languages, Lock, Quote } from "lucide-react";
import { MarketingNav, MarketingFooter } from "@/components/marketing";
import { Button } from "@/components/ui/button";

// Honest capabilities — only what the app actually does today: routed, grounded,
// cited Q&A over the loaded documents + structured data, in English and Hebrew,
// behind admin-controlled access. No fabricated connectors, plans, or "live tools".
const features = [
  {
    icon: Quote,
    title: "A citation on every fact",
    body: "Every answer is grounded in the source — each claim links to the exact PDF page or data row it came from. If the answer isn't in your data, Nucleus says so instead of guessing.",
  },
  {
    icon: ShieldCheck,
    title: "Trustworthy numbers",
    body: "Totals and counts are computed from your structured data and verified before they're shown. A grounding check rejects any answer whose citations don't resolve — no hallucinated figures.",
  },
  {
    icon: FileText,
    title: "Documents + data, one question box",
    body: "Ask across uploaded PDFs and spreadsheet/SQL data together. A router decides which sources are relevant and shows you its choice, so you can see how the answer was reached.",
  },
  {
    icon: Languages,
    title: "English and Hebrew",
    body: "Ask in English or Hebrew, including a Hebrew question over an English document — the answer comes back in your language with the citation preserved.",
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
          <div className="relative mx-auto max-w-3xl px-6 py-24 text-center lg:py-32">
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-subtle shadow-soft">
              <span className="size-1.5 rounded-full bg-accent" />
              Grounded answers over your business knowledge
            </span>
            <h1 className="mt-6 font-display text-5xl font-bold leading-[1.05] tracking-tight text-ink sm:text-6xl">
              Ask your documents.
              <br />
              Get answers you can trust.
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-subtle">
              Nucleus answers questions across your documents and data, in plain
              language — and puts a citation on every fact so you can trace it to
              the exact page or row. Grounded, or it tells you it doesn&rsquo;t know.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Button
                asChild
                size="lg"
                className="h-12 bg-accent px-6 text-base text-accent-fg hover:bg-accent/90 shadow-soft"
              >
                <Link href="/sign-in">
                  Sign in
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            </div>
            <p className="mt-5 flex items-center justify-center gap-2 text-sm text-faint">
              <Lock className="size-4" />
              Access is managed by your workspace admin.
            </p>
          </div>
        </section>

        {/* ── Features ── */}
        <section id="features" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <div className="max-w-2xl">
              <h2 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
                Not a PDF chatbot. A grounded knowledge engine.
              </h2>
              <p className="mt-4 text-lg text-subtle">
                A free-form question is routed to the right source, answered with
                hybrid retrieval over documents and structured data, and returned
                with a citation on every claim.
              </p>
            </div>
            <div className="mt-12 grid gap-6 md:grid-cols-2">
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

        {/* ── CTA ── */}
        <section className="border-t border-line bg-canvas">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <div className="relative overflow-hidden rounded-3xl border border-line bg-ink px-8 py-16 text-center shadow-lift">
              <div className="absolute inset-0 bg-dotgrid opacity-10" />
              <div className="relative">
                <h2 className="font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
                  Sign in to ask your first question.
                </h2>
                <p className="mx-auto mt-4 max-w-xl text-lg text-white/70">
                  Your workspace admin sets up accounts and access. Once you&rsquo;re
                  in, the answer — with its sources — is one question away.
                </p>
                <Button
                  asChild
                  size="lg"
                  className="mt-8 h-12 bg-accent px-6 text-base text-accent-fg hover:bg-accent/90"
                >
                  <Link href="/sign-in">
                    Sign in
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
