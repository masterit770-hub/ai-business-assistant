"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

// ── The dark / light theme switch ──────────────────────────────────────────────
// Persists the choice in localStorage under "ab-theme" and reflects it as the
// `data-theme` attribute on <html> (which drives every `dark:` style + the CSS
// variable flip in globals.css). The INITIAL value is set BEFORE paint by the
// inline ThemeScript (below) so there's no flash; this component only owns the
// runtime toggle + keeping its own icon in sync.
//
// Resolution order (matches the inline script):
//   1. an explicit saved choice in localStorage ("light" | "dark")
//   2. the OS preference (prefers-color-scheme)
//   3. fallback "light" (the reference screenshots are light)

export const THEME_KEY = "ab-theme";
type Theme = "light" | "dark";

function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

export function ThemeToggle({ className }: { className?: string }) {
  // Start as null so SSR + first client render agree (no hydration mismatch);
  // we read the real attribute after mount.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  function toggle() {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode / blocked storage — the in-session toggle still works */
    }
    setTheme(next);
  }

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      data-testid="theme-toggle"
      data-theme-value={theme ?? "light"}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-subtle transition-colors hover:border-accent-ring hover:text-accent",
        className
      )}
    >
      {/* Render both, show one — avoids a layout jump while theme resolves */}
      <Sun className={cn("size-4", isDark ? "hidden" : "block")} strokeWidth={2} />
      <Moon className={cn("size-4", isDark ? "block" : "hidden")} strokeWidth={2} />
    </button>
  );
}

// ── The BRAND axis (orthogonal to light/dark) ───────────────────────────────────
// "violet" (Jenny's, the default) or "teal" (Chris's portfolio). Reflected as the
// `data-brand` attribute on <html> (absent = violet); the CSS in globals.css overrides
// just the accent tokens. Persisted under "ab-brand"; applied before paint by the
// inline script below alongside data-theme.
export const BRAND_KEY = "ab-brand";
export type Brand = "violet" | "teal";

export function currentBrand(): Brand {
  if (typeof document === "undefined") return "violet";
  return document.documentElement.getAttribute("data-brand") === "teal" ? "teal" : "violet";
}

export function setBrand(b: Brand) {
  if (typeof document === "undefined") return;
  if (b === "teal") document.documentElement.setAttribute("data-brand", "teal");
  else document.documentElement.removeAttribute("data-brand");
  try {
    localStorage.setItem(BRAND_KEY, b);
  } catch {
    /* private mode — the in-session choice still applies */
  }
}

// Inline, render-blocking script that sets `data-theme` AND `data-brand` on <html>
// BEFORE the page paints — so the saved theme + brand are applied with zero flash.
// Kept tiny and dependency-free; mirrors currentTheme()/currentBrand() resolution.
export function ThemeScript() {
  const js = `(function(){try{
    var k=${JSON.stringify(THEME_KEY)};
    var s=localStorage.getItem(k);
    var t=(s==="light"||s==="dark")?s:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
    document.documentElement.setAttribute("data-theme",t);
    var b=localStorage.getItem(${JSON.stringify(BRAND_KEY)});
    if(b==="teal"){document.documentElement.setAttribute("data-brand","teal");}
  }catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;
  // eslint-disable-next-line react/no-danger
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}
