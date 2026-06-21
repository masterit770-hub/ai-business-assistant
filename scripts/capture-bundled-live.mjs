// Live verification of the de-mock "bundled corpus" invariant on the REAL deployed
// Nucleus site: sign in as the demo admin, land on /dashboard, and prove the
// Documents view shows the engine's built-in corpus ("Built-in business data")
// AND the real stat total — i.e. what the user SEES matches what the assistant can
// ANSWER from. Screenshots the dashboard as evidence.
//
// Creds are passed in via env (NUCLEUS_EMAIL / NUCLEUS_PASSWORD) so nothing is
// hardcoded or printed. Chromium is the agent-box cached build.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.NUCLEUS_BASE ?? "https://nucleus-woad.vercel.app";
const EMAIL = process.env.NUCLEUS_EMAIL;
const PASSWORD = process.env.NUCLEUS_PASSWORD;
const OUT = "/home/codex/Projects/nucleus/screenshots/real-engine";
const CHROME =
  process.env.PW_CHROMIUM_PATH ??
  "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

if (!EMAIL || !PASSWORD) {
  console.error("NUCLEUS_EMAIL and NUCLEUS_PASSWORD must be set");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 1200 } });
const page = await ctx.newPage();

let ok = true;
const log = (m) => console.log(m);

try {
  // 1) sign in
  log("→ sign-in");
  await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('[data-testid="auth-submit"]');

  // 2) land on the dashboard
  await page.waitForURL("**/dashboard", { timeout: 30000 });
  log("→ on /dashboard");

  // 3) the bundled corpus section must render (it fetches /api/documents and lists
  //    the built-in sources). Wait for the BundledDocs heading + at least one known
  //    source label.
  await page.waitForSelector("text=Built-in business data", { timeout: 30000 });
  const bundledText = (await page.textContent("body")) ?? "";
  const expect = [
    "Built-in business data",
    "Vendor contracts",
    "Maintenance invoices",
    "Family Court Case File",
  ];
  const missingBundled = expect.filter((s) => !bundledText.includes(s));
  if (missingBundled.length) {
    ok = false;
    log("  MISSING bundled labels: " + missingBundled.join(", "));
  } else {
    log("  bundled corpus rendered: all expected labels present");
  }

  // 4) the "Documents" stat must be the REAL total (>= the 9 bundled sources), never 0.
  const docStat = (await page.textContent('[data-testid="stat-Documents"]'))?.trim() ?? "";
  log(`  stat Documents = "${docStat}"`);
  const n = Number(docStat.replace(/[^0-9]/g, ""));
  if (!(n >= 9)) {
    ok = false;
    log("  STAT FAIL: Documents total should be >= 9 (bundled), got " + docStat);
  }

  // 5) screenshot evidence
  const file = `${OUT}/5-bundled-corpus-live.png`;
  await page.screenshot({ path: file, fullPage: true });
  log(`  saved → ${file}`);
} catch (e) {
  ok = false;
  log("ERROR: " + (e instanceof Error ? e.message : String(e)));
  await page.screenshot({ path: `${OUT}/5-bundled-corpus-ERROR.png` }).catch(() => {});
} finally {
  await browser.close();
}

log("\n===== " + (ok ? "PASS" : "FAIL") + " =====");
process.exit(ok ? 0 : 1);
