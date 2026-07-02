import { test } from "node:test";
import assert from "node:assert/strict";
import { backendOnlyRedirect } from "../../src/lib/backend-redirect.ts";

// Tests for the BACKEND_ONLY redirect logic (Change 3: Fly serves NO UI).
// The pure helper is extracted from the middleware so these drive the REAL decision
// tree without importing Next.js. The full middleware is exercised by the curl checks
// against the live Fly deployment.

const FE = "https://nucleus-770.vercel.app";

test("BACKEND_ONLY=false → no redirect regardless of path", () => {
  assert.equal(backendOnlyRedirect("/", false, FE), null);
  assert.equal(backendOnlyRedirect("/dashboard", false, FE), null);
  assert.equal(backendOnlyRedirect("/api/agent", false, FE), null);
});

test("BACKEND_ONLY=true, / → redirects to Vercel frontend root", () => {
  assert.equal(backendOnlyRedirect("/", true, FE), `${FE}/`);
});

test("BACKEND_ONLY=true, /dashboard → redirects to Vercel /dashboard", () => {
  assert.equal(backendOnlyRedirect("/dashboard", true, FE), `${FE}/dashboard`);
});

test("BACKEND_ONLY=true, /api/agent → passes through (null = no redirect)", () => {
  assert.equal(backendOnlyRedirect("/api/agent", true, FE), null);
});

test("BACKEND_ONLY=true, /api/ask → passes through (null = no redirect)", () => {
  assert.equal(backendOnlyRedirect("/api/ask", true, FE), null);
});

test("BACKEND_ONLY=true, /sign-in → redirects to Vercel /sign-in", () => {
  assert.equal(backendOnlyRedirect("/sign-in", true, FE), `${FE}/sign-in`);
});

test("custom FRONTEND_URL is respected", () => {
  assert.equal(backendOnlyRedirect("/", true, "https://custom.example.com"), "https://custom.example.com/");
});
