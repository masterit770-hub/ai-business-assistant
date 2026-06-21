// Live golden-case verification for the SOURCE-flag change on https://nucleus-woad.vercel.app.
// Signs in as admin via the cached chromium-1223, confirms model_mode=cloud (DeepSeek),
// runs ALL 6 golden cases via in-page fetch('/api/ask'), and reports for each:
//   mode, the key text it must contain, and that NO raw "SOURCE:" prefix leaks into
//   the answer shown to the user. NEVER prints the password.
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

const sec = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/demo-accounts.txt", "utf8");
function field(label) {
  const adminBlock = sec.slice(sec.indexOf("ADMIN"));
  const m = adminBlock.match(new RegExp(`${label}:\\s*(\\S+)`, "i"));
  return m ? m[1] : null;
}
const EMAIL = field("email");
const PASSWORD = field("password");
if (!EMAIL || !PASSWORD) { console.error("FATAL: could not parse admin creds"); process.exit(1); }

const log = (...a) => console.log(...a);
const J = (o) => JSON.stringify(o);

async function askInPage(page, question) {
  return page.evaluate(async (q) => {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    });
    let data = null;
    try { data = await res.json(); } catch { data = { error: "non-json" }; }
    return { status: res.status, data };
  }, question);
}

// Leak detector: a raw flag prefix would appear at the very START of the answer, or as
// a standalone "SOURCE: documents|general" line anywhere. (A normal answer never
// contains that token.)
function sourceLeak(answer) {
  if (!answer) return false;
  if (/^\s*[*`_>\s-]*source\s*:\s*(documents|general)\b/i.test(answer)) return true;
  if (/(^|\n)\s*[*`_>\s-]*source\s*:\s*(documents|general)\b/i.test(answer)) return true;
  return false;
}

const CASES = [
  {
    id: "1-contracts-90day",
    q: "How many contracts expire in the next 90 days?",
    expectMode: "grounded",
    checks: (a) => ({
      "has 38": a.includes("38"),
      "has $18,924,883.79": a.includes("18,924,883.79"),
      "has [S:contracts": /\[S:contracts/.test(a),
    }),
  },
  {
    id: "2-child-support",
    q: "What is the monthly child support amount in the case file?",
    expectMode: "grounded",
    checks: (a) => ({
      "has $1,285": a.includes("1,285"),
      "has [P:family-court": /\[P:family-court/.test(a),
    }),
  },
  {
    id: "3-carter-parties",
    q: "Who are the parties in the Carter family court case, and what was decided?",
    expectMode: "grounded",
    checks: (a) => ({
      "names Carter": /carter/i.test(a),
      "cites a doc token": /\[P:/.test(a),
    }),
  },
  {
    id: "4-maintenance-overdue",
    q: "which customers have overdue payments?",
    expectMode: "grounded",
    checks: (a) => ({
      "has $40,597.00": a.includes("40,597.00"),
      "cites maintenance": /\[S:maintenance/.test(a),
    }),
  },
  {
    id: "5-capital-australia",
    q: "What is the capital of Australia?",
    expectMode: "general",
    checks: (a) => ({
      "says Canberra": /canberra/i.test(a),
    }),
  },
  {
    id: "6-az-alimony-strategy",
    q: "whats the best deal i can ask for michael in order for him to pay less alimony according to the arizona divorce law",
    expectMode: "general",
    checks: (a) => ({
      "non-empty answer": a.trim().length > 40,
      "no leading hedge": !/^\s*(i (cannot|can't|am not able|'m not able)|i'm sorry)/i.test(a),
    }),
  },
];

(async () => {
  const browser = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  const results = [];
  try {
    log("→ sign in");
    await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('[data-testid="auth-submit"]');
    await page.waitForURL("**/dashboard", { timeout: 60000 });
    await page.waitForSelector('[data-testid="assistant-console"]', { timeout: 60000 });
    log("✓ signed in");

    // Confirm model_mode=cloud (DeepSeek). If not, set it to cloud via PUT.
    let settings = await page.evaluate(async () => {
      const r = await fetch("/api/settings");
      return r.ok ? r.json() : { error: r.status };
    });
    log("model_mode (before): " + settings.model_mode + " · cloud_provider: " + (settings.cloud_provider || "(env default)"));
    if (settings.model_mode !== "cloud") {
      await page.evaluate(async () => {
        await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model_mode: "cloud" }),
        });
      });
      settings = await page.evaluate(async () => (await fetch("/api/settings")).json());
      log("model_mode (after set): " + settings.model_mode);
    }

    for (const c of CASES) {
      log(`\n→ [${c.id}] ${c.q}`);
      const r = await askInPage(page, c.q);
      const a = r.data?.answer ?? "";
      const mode = r.data?.mode;
      const leak = sourceLeak(a);
      const checks = c.checks(a);
      const modeOk = mode === c.expectMode;
      const allChecks = Object.values(checks).every(Boolean);
      const pass = modeOk && allChecks && !leak;
      results.push({ id: c.id, status: r.status, mode, expectMode: c.expectMode, modeOk, checks, leak, pass });
      log(`  status=${r.status} mode=${mode} (expect ${c.expectMode}) modeOk=${modeOk} SOURCE_leak=${leak} PASS=${pass}`);
      log(`  checks: ${J(checks)}`);
      log(`  answer-head(420): ${a.slice(0, 420).replace(/\n/g, " ⏎ ")}`);
    }

    // Confirm we END on cloud.
    const final = await page.evaluate(async () => (await fetch("/api/settings")).json());
    log("\nmodel_mode (final): " + final.model_mode);

    log("\n===== SUMMARY =====");
    for (const r of results) log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  mode=${r.mode}  leak=${r.leak}  checks=${J(r.checks)}`);
    const allPass = results.every((r) => r.pass);
    log(`\nALL_PASS=${allPass}  final_model_mode=${final.model_mode}`);
    process.exitCode = allPass ? 0 : 2;
  } catch (e) {
    log("FATAL: " + e.message);
    process.exitCode = 3;
  } finally {
    await browser.close();
  }
})();
