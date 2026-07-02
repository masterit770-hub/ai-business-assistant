// Component-layer test setup. Runs before every component spec (vitest setupFiles).
//
// This file establishes the jsdom contract the components-under-test need but that
// the real browser/Next runtime would supply: jest-dom matchers, a default-failing
// fetch (so a test that forgets to stub a call fails LOUDLY instead of hitting the
// real network), and light stubs for the Next.js navigation/Link/router primitives a
// "use client" component imports. We mock ONLY these framework seams + the network —
// never the component's own state machine, which is the thing under test.

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount React trees + reset the DOM between tests so state never leaks across cases.
afterEach(() => {
  cleanup();
});

// ── fetch: fail-closed by default ────────────────────────────────────────────
// Every component here talks to the backend only through fetch. The default
// implementation REJECTS so any unstubbed call is an obvious test bug, not a silent
// pass against a phantom 200. Each test installs the exact responses it expects.
beforeEach(() => {
  global.fetch = vi.fn(() =>
    Promise.reject(new Error("fetch not stubbed in this test")),
  ) as unknown as typeof fetch;
});

// ── next/navigation ──────────────────────────────────────────────────────────
// Components read the URL via useSearchParams() and (sometimes) useRouter(). Provide
// controllable stubs. A test can override the search params per-case by re-mocking,
// but the default is an empty query string.
const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/dashboard",
}));

// ── next/link ────────────────────────────────────────────────────────────────
// Render <Link> as a plain <a> so href + children assertions work without the Next
// runtime. (We only ever assert the href / active class, never navigation itself.)
vi.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => {
    const React = require("react");
    return React.createElement(
      "a",
      { href: typeof href === "string" ? href : String(href), ...rest },
      children,
    );
  },
}));

// jsdom lacks scrollIntoView (the console auto-scrolls the thread on each turn).
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
// jsdom doesn't implement window.open (the rail opens originals / CSV exports).
if (typeof window !== "undefined" && !window.open) {
  window.open = vi.fn() as unknown as typeof window.open;
}
// jsdom logs "Not implemented: window.confirm" on every call. Components that gate a
// destructive action behind confirm() (remove doc, change role) re-stub it per-test
// (vi.spyOn) to control the answer; provide a default so the bare call is quiet. A
// test that cares OVERRIDES this with its own spy.
if (typeof window !== "undefined") {
  window.confirm = vi.fn(() => true) as unknown as typeof window.confirm;
}
