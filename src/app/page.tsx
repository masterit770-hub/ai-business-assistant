import Link from "next/link";
import { ArrowRight, Lock, Quote, Layers, Languages, Upload, ShieldCheck } from "lucide-react";
import { MarketingNav, MarketingFooter } from "@/components/marketing";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/landing/reveal";
import { AskDemo } from "@/components/landing/ask-demo";
import { PipelineStrip } from "@/components/landing/pipeline-strip";
import {
  CitationMock,
  HybridMock,
  HebrewMock,
  UploadMock,
  AccessMock,
} from "@/components/landing/mocks";

// Honest, polished marketing. Everything shown is a REAL capability with REAL
// verified numbers, rendered in HTML/CSS (no images, full honesty control). No
// pricing, no named connectors, no SSO/SCIM. The only CTA is Sign in.
const features = [
  {
    icon: Quote,
    title: "A citation on every fact",
    body: "Each claim links to the exact PDF page or data row it came from. A grounding check rejects any answer whose citations don't resolve — so a number is either traceable or it isn't shown.",
    mock: <CitationMock />,
  },
  {
    icon: Layers,
    title: "Documents and data, one answer",
    body: "A router decides which sources are relevant and shows its choice. Ask across uploaded PDFs and spreadsheet/SQL data together — the answer cites each source separately, never on a fabricated join.",
    mock: <HybridMock />,
  },
  {
    icon: Languages,
    title: "English and Hebrew",
    body: "Ask in English or Hebrew — including a Hebrew question over an English document. The answer comes back in your language, with the citation preserved.",
    mock: <HebrewMock />,
  },
  {
    icon: Upload,
    title: "Upload and ask in seconds",
    body: "Drop in PDFs, scanned documents, or spreadsheets. They're parsed and indexed on upload, so you can query them — with citations — moments later.",
    mock: <UploadMock />,
  },
  {
    icon: ShieldCheck,
    title: "Admin-controlled access",
    body: "An admin creates accounts and manages access. Kick-out is instant — a removed user loses access on their next request — and each member only ever retrieves their own uploaded documents.",
    mock: <AccessMock />,
  },
];

export default function LandingPage() {
  return (
    <div className="flex min-h-full flex-col">
      <MarketingNav />

      <main className="flex-1">
        {/* ── Hero ── */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 bg-dotgrid opacity-60 [mask-image:radial-gradient(ellipse_at_top,black,transparent_72%)]" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-[1.02fr_1fr] lg:py-28">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-subtle shadow-soft">
                <span className="size-1.5 rounded-full bg-accent" />
                Grounded answers over your business knowledge
              </span>
              <h1 className="mt-5 font-display text-[2.6rem] font-bold leading-[1.05] tracking-tight text-ink sm:text-5xl lg:text-6xl">
                Ask your documents.
                <br />
                Trust every answer.
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-subtle">
                The AI Business Assistant answers questions across your documents and data in plain
                language — and puts a citation on every fact, so you can trace it
                to the exact page or row. Grounded, or it tells you it doesn&rsquo;t
                know.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
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
              <p className="mt-5 flex items-center gap-2 text-sm text-faint">
                <Lock className="size-4" />
                Access is managed by your workspace admin.
              </p>
            </div>

            {/* the rendered promo film — its scenes already contain browser
                mockups, so no extra frame; just a clean rounded container */}
            <div className="lg:pl-4">
              <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-lift">
                <video
                  className="aspect-video w-full"
                  autoPlay
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  poster="/nucleus-promo-poster.jpg"
                >
                  <source src="/nucleus-promo.mp4" type="video/mp4" />
                </video>
              </div>
            </div>
          </div>
        </section>

        {/* ── Live Ask demo ── */}
        <section className="border-t border-line bg-canvas">
          <div className="mx-auto max-w-3xl px-6 py-20">
            <Reveal className="mb-10 text-center">
              <h2 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
                See it answer, live
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-lg text-subtle">
                A real golden question, the grounded answer, and the citation
                chips that back it — rendered live, looping.
              </p>
            </Reveal>
            <Reveal delay={120} className="mx-auto max-w-xl">
              <AskDemo />
            </Reveal>
          </div>
        </section>

        {/* ── Features ── */}
        <section id="features" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <Reveal className="max-w-2xl">
              <h2 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
                Not a PDF chatbot. A grounded knowledge engine.
              </h2>
              <p className="mt-4 text-lg text-subtle">
                A free-form question is routed to the right source, answered with
                hybrid retrieval over documents and structured data, and returned
                with a citation on every claim.
              </p>
            </Reveal>

            <div className="mt-14 space-y-16">
              {features.map((f, i) => (
                <div
                  key={f.title}
                  className={`grid items-center gap-8 lg:grid-cols-2 ${
                    i % 2 === 1 ? "lg:[&>*:first-child]:order-2" : ""
                  }`}
                >
                  <Reveal>
                    <span className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
                      <f.icon className="size-5" strokeWidth={2} />
                    </span>
                    <h3 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">
                      {f.title}
                    </h3>
                    <p className="mt-3 max-w-md text-base leading-relaxed text-subtle">
                      {f.body}
                    </p>
                  </Reveal>
                  <Reveal delay={120}>{f.mock}</Reveal>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── How it works ── */}
        <section className="border-t border-line bg-canvas">
          <div className="mx-auto max-w-5xl px-6 py-20">
            <Reveal className="mb-12 text-center">
              <h2 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
                How an answer is made
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-lg text-subtle">
                Five steps, every time — and the last one can say no.
              </p>
            </Reveal>
            <PipelineStrip />
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <Reveal>
              <div className="relative overflow-hidden rounded-3xl border border-accent-strong/30 bg-accent px-8 py-16 text-center shadow-lift">
                <div className="absolute inset-0 bg-dotgrid opacity-10" />
                <div className="relative">
                  <h2 className="font-display text-3xl font-bold tracking-tight text-accent-fg sm:text-4xl">
                    Sign in to ask your first question.
                  </h2>
                  <p className="mx-auto mt-4 max-w-xl text-lg text-accent-fg/80">
                    Your workspace admin sets up accounts and access. Once
                    you&rsquo;re in, the answer — with its sources — is one
                    question away.
                  </p>
                  <Button
                    asChild
                    size="lg"
                    className="mt-8 h-12 bg-surface px-6 text-base text-ink hover:bg-surface/90"
                  >
                    <Link href="/sign-in">
                      Sign in
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </div>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
