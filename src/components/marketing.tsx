import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

export function MarketingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Wordmark subtitle={false} />
        <nav className="hidden items-center gap-8 md:flex">
          <Link
            href="/#features"
            className="text-sm font-medium text-subtle transition-colors hover:text-ink"
          >
            Product
          </Link>
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button asChild size="lg" className="bg-accent text-accent-fg hover:bg-accent/90 shadow-soft">
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-line bg-canvas">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div className="max-w-md">
            <Wordmark subtitle={false} />
            <p className="mt-3 text-sm leading-relaxed text-faint">
              Grounded, cited answers across your documents and data — in English
              and Hebrew. Access managed by your workspace admin.
            </p>
          </div>
          <Button asChild size="lg" className="bg-accent text-accent-fg hover:bg-accent/90 shadow-soft">
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </div>
        <div className="mt-10 border-t border-line pt-6 text-sm text-faint">
          <p>© 2026 AI Business Assistant</p>
        </div>
      </div>
    </footer>
  );
}
