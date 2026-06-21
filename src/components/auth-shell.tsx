import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";

// Centered auth card on a dotgrid backdrop, with a tasteful quote rail on wide
// screens. Used by both /sign-in and /sign-up.
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-full flex-col">
      <div className="absolute inset-0 bg-dotgrid opacity-50 [mask-image:radial-gradient(ellipse_at_center,black,transparent_80%)]" />
      <header className="relative mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <Wordmark subtitle={false} />
        <ThemeToggle />
      </header>
      <div className="relative flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">{children}</div>
      </div>
      <footer className="relative mx-auto w-full max-w-6xl px-6 py-6 text-center text-sm text-faint">
        <Link href="#" className="transition-colors hover:text-ink">
          Privacy
        </Link>
        <span className="mx-3">·</span>
        <Link href="#" className="transition-colors hover:text-ink">
          Terms
        </Link>
        <span className="mx-3">·</span>
        <span>© 2026 AI Business Assistant</span>
      </footer>
    </div>
  );
}

// Inline Google "G" glyph for the social placeholder button.
export function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.24 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"
      />
    </svg>
  );
}
