// Shared harness for the Nucleus journey + component suite.
//
// Independent acceptance tests: they drive the LIVE deployed app through a real
// Chromium and assert the REAL user-visible outcome — never just an HTTP 200.
// Credentials are read from /home/codex/Projects/nucleus/.secrets/demo-accounts.txt
// at runtime (never hardcoded, never logged). Nothing here prints a secret.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

export const BASE = process.env.NUCLEUS_BASE || "https://nucleus-woad.vercel.app";
const CHROME =
  process.env.NUCLEUS_CHROME ||
  "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const ACCOUNTS_FILE =
  process.env.NUCLEUS_ACCOUNTS || "/home/codex/Projects/nucleus/.secrets/demo-accounts.txt";

// Parse the demo-accounts file into { admin: {email,password}, member: {email,password} }.
// The file groups creds under "ADMIN (...)" and "REGULAR USER (...)" headers with
// indented "email:" / "password:" lines. We never echo any value we read here.
export function readAccounts() {
  const raw = readFileSync(ACCOUNTS_FILE, "utf8");
  const lines = raw.split(/\r?\n/);
  const out = { admin: {}, member: {} };
  let bucket = null;
  for (const line of lines) {
    if (/ADMIN/i.test(line) && /:/.test(line) === false) bucket = "admin";
    else if (/ADMIN/i.test(line)) bucket = "admin";
    if (/REGULAR USER|MEMBER/i.test(line)) bucket = "member";
    const m = line.match(/^\s*(email|password)\s*:\s*(.+?)\s*$/i);
    if (m && bucket) out[bucket][m[1].toLowerCase()] = m[2];
  }
  if (!out.admin.email || !out.admin.password) {
    throw new Error("could not parse admin credentials from accounts file");
  }
  return out;
}

export async function launch() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  return browser;
}

// Sign in via the real Supabase email/password form and wait until the app route
// loads (the middleware-protected page actually renders, proving the session cookie
// is set). Returns the authenticated page.
export async function signIn(browser, who = "admin", target = "/dashboard") {
  const accounts = readAccounts();
  const cred = accounts[who];
  if (!cred?.email) throw new Error(`no ${who} credentials`);
  const ctx = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/sign-in?next=${encodeURIComponent(target)}`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.fill('input#email', cred.email);
  await page.fill('input#password', cred.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 45000 }),
    page.click('[data-testid="auth-submit"]'),
  ]).catch(async () => {
    // surface the auth error text if the redirect never happened
    const err = await page
      .locator('[data-testid="auth-error"]')
      .textContent()
      .catch(() => null);
    throw new Error(`sign-in did not navigate away from /sign-in${err ? ` (auth-error: ${err})` : ""}`);
  });
  return { ctx, page };
}

// A tiny assertion + result harness so each journey reports a clean PASS/FAIL line
// with concrete evidence, and the runner can aggregate.
export function makeRecorder(journey) {
  const checks = [];
  return {
    journey,
    checks,
    // ok(cond, label, evidence) — records a single check.
    check(cond, label, evidence = "") {
      checks.push({ pass: !!cond, label, evidence: String(evidence).slice(0, 300) });
      const tag = cond ? "PASS" : "FAIL";
      console.log(`  [${tag}] ${label}${evidence ? ` — ${String(evidence).slice(0, 200)}` : ""}`);
    },
    // info — a non-pass/fail observation (present/absent reporting).
    info(label, evidence = "") {
      console.log(`  [INFO] ${label}${evidence ? ` — ${String(evidence).slice(0, 200)}` : ""}`);
    },
    summary() {
      const failed = checks.filter((c) => !c.pass);
      return { journey, total: checks.length, failed: failed.length, checks };
    },
  };
}

// Ask one question in the assistant console and wait for a new answered turn to appear.
// Returns the index of the new turn. Throws if neither an answer nor an error card shows.
export async function askAndWait(page, question, { timeout = 90000 } = {}) {
  const before = await page.locator('[data-testid="chat-turn"]').count();
  await page.fill('[data-testid="assistant-console"] textarea', question);
  await page.click('[data-testid="send-ask"]');
  // Wait for either a new completed turn OR a visible error card.
  await page.waitForFunction(
    (n) => {
      const turns = document.querySelectorAll('[data-testid="chat-turn"]').length;
      const err = document.querySelector('[data-testid="ask-error"]');
      return turns > n || !!err;
    },
    before,
    { timeout }
  );
  return before;
}
