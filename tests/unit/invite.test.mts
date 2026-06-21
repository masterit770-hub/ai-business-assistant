import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAppOrigin,
  inviteRedirectUrl,
  buildInviteResult,
} from "../../src/lib/account/invite.ts";

// These drive the SAME pure helpers the admin users route uses to compute where an
// invite link points and how the credentials block is shaped. A green here means the
// API hands the admin a usable origin/redirect and a well-formed invite/fallback.

// A tiny stand-in for a Next Request: just url + a header bag.
function reqOf(url: string, headers: Record<string, string> = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { url, headers: { get: (n: string) => lower.get(n.toLowerCase()) ?? null } };
}

const SITE = process.env.NEXT_PUBLIC_SITE_URL;
afterEach(() => {
  if (SITE === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = SITE;
});

// ── resolveAppOrigin ──────────────────────────────────────────────────────────

test("origin: an explicit NEXT_PUBLIC_SITE_URL wins and is stripped of a trailing slash", () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nucleus.example.com/";
  const o = resolveAppOrigin(reqOf("https://anything/api/admin/users"));
  assert.equal(o, "https://nucleus.example.com");
});

test("origin: forwarded host (Vercel proxy) is used with https by default", () => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
  const o = resolveAppOrigin(
    reqOf("https://internal/api/admin/users", {
      "x-forwarded-host": "nucleus-woad.vercel.app",
      "x-forwarded-proto": "https",
    })
  );
  assert.equal(o, "https://nucleus-woad.vercel.app");
});

test("origin: a localhost host defaults to http (no forwarded proto)", () => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
  const o = resolveAppOrigin(reqOf("http://x/api", { host: "localhost:3000" }));
  assert.equal(o, "http://localhost:3000");
});

test("origin: falls back to the request URL's own origin when no host header", () => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
  const o = resolveAppOrigin(reqOf("https://fallback.example.com/api/admin/users"));
  assert.equal(o, "https://fallback.example.com");
});

test("origin: an unparseable URL with no host yields null", () => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
  assert.equal(resolveAppOrigin(reqOf("not a url")), null);
});

// ── inviteRedirectUrl ─────────────────────────────────────────────────────────

test("redirect: points at the sign-in page of the given origin", () => {
  assert.equal(inviteRedirectUrl("https://nucleus.example.com"), "https://nucleus.example.com/sign-in");
});

test("redirect: a trailing slash on the origin doesn't double up", () => {
  assert.equal(inviteRedirectUrl("https://x.com/"), "https://x.com/sign-in");
});

test("redirect: a null origin yields undefined (no redirectTo passed to Supabase)", () => {
  assert.equal(inviteRedirectUrl(null), undefined);
});

// ── buildInviteResult ─────────────────────────────────────────────────────────

test("invite result: a real link is kept and the email is trimmed", () => {
  const r = buildInviteResult({
    email: "  teammate@company.com  ",
    inviteLink: "https://x.com/auth/v1/verify?token=abc",
    tempPassword: "hunter2hunter2",
  });
  assert.deepEqual(r, {
    email: "teammate@company.com",
    inviteLink: "https://x.com/auth/v1/verify?token=abc",
    tempPassword: "hunter2hunter2",
  });
});

test("invite result: a null/empty link collapses to null so the UI shows the fallback", () => {
  assert.equal(
    buildInviteResult({ email: "a@b.com", inviteLink: null, tempPassword: "p" }).inviteLink,
    null
  );
  assert.equal(
    buildInviteResult({ email: "a@b.com", inviteLink: "", tempPassword: "p" }).inviteLink,
    null
  );
});

test("invite result: the temp password is always preserved as the guaranteed fallback", () => {
  const r = buildInviteResult({ email: "a@b.com", inviteLink: null, tempPassword: "fallback-pw" });
  assert.equal(r.tempPassword, "fallback-pw");
});
