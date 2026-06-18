import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";

export function MarketingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Wordmark />
        <nav className="hidden items-center gap-8 md:flex">
          <Link
            href="/#features"
            className="text-sm font-medium text-subtle transition-colors hover:text-ink"
          >
            Product
          </Link>
          <Link
            href="/pricing"
            className="text-sm font-medium text-subtle transition-colors hover:text-ink"
          >
            Pricing
          </Link>
          <Link
            href="/#sources"
            className="text-sm font-medium text-subtle transition-colors hover:text-ink"
          >
            Sources
          </Link>
        </nav>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="lg">
            <Link href="/sign-in">Sign in</Link>
          </Button>
          <Button asChild size="lg" className="bg-accent text-accent-fg hover:bg-accent/90 shadow-soft">
            <Link href="/sign-up">Get started</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  const cols: { title: string; links: string[] }[] = [
    { title: "Product", links: ["Overview", "Pricing", "Connectors", "Security"] },
    { title: "Company", links: ["About", "Customers", "Careers", "Blog"] },
    { title: "Resources", links: ["Docs", "Changelog", "Status", "Contact"] },
  ];
  return (
    <footer className="border-t border-line bg-canvas">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Wordmark />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-faint">
              One brain for your entire business. Ask anything across your
              documents, spreadsheets, and live tools.
            </p>
          </div>
          {cols.map((col) => (
            <div key={col.title}>
              <h4 className="text-sm font-semibold text-ink">{col.title}</h4>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((link) => (
                  <li key={link}>
                    <Link
                      href="#"
                      className="text-sm text-faint transition-colors hover:text-ink"
                    >
                      {link}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-line pt-6 text-sm text-faint sm:flex-row sm:items-center">
          <p>© 2026 Nucleus, Inc. All rights reserved.</p>
          <div className="flex gap-6">
            <Link href="#" className="transition-colors hover:text-ink">
              Privacy
            </Link>
            <Link href="#" className="transition-colors hover:text-ink">
              Terms
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
