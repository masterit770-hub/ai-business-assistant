// Screenshot harness for the Cloud ⇄ Local model switch. Signs in as the demo
// admin, then captures the BIG toggle in both states + the Settings → Model section.
// Uses the CRR-cached Playwright + chromium-1223.
//   node scripts/shoot-model-switch.mjs <baseUrl> <email> <password> <outDir>
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/codex/Projects/Contract-Retriever-RAG/node_modules/playwright/index.js");

const BASE = process.argv[2] || "http://localhost:3217";
const EMAIL = process.argv[3];
const PASSWORD = process.argv[4];
const OUT = process.argv[5] || "/home/codex/Projects/nucleus/screenshots/model-switch";
const EXE = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

if (!EMAIL || !PASSWORD) {
  console.error("usage: shoot-model-switch.mjs <baseUrl> <email> <password> [outDir]");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 1560, height: 1100 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const log = (m) => console.log(m);

async function ensureMode(mode) {
  // Drive the REAL admin API so we start each shot from a known state.
  const r = await page.evaluate(async (m) => {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // empty endpoint on purpose: Local should read as "not configured" (the hint).
      body: JSON.stringify({ model_mode: m, local_endpoint: "" }),
    });
    return { status: res.status, body: await res.json() };
  }, mode);
  log(`  set mode=${mode} → ${r.status} (now: ${r.body.model_mode}, endpoint="${r.body.local_endpoint}")`);
}

try {
  // ── sign in as admin ──
  await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('[data-testid="auth-submit"]');
  await page.waitForURL("**/dashboard", { timeout: 30000 });
  log("  signed in as admin");

  // The dashboard renders the Ask panel twice (a visible right-rail at xl, and an
  // xl:hidden mobile copy). Target the VISIBLE switch so we shoot the real one.
  const visibleSwitch = () => page.locator('[data-testid="model-switch"]:visible').first();
  const visiblePanel = () =>
    page.locator('[data-testid="ask-model-switch"]:visible').first()
      .locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');

  // ── CLOUD state ──
  await ensureMode("cloud");
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
  await visibleSwitch().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/01-ask-cloud.png`, fullPage: false });
  await visiblePanel().screenshot({ path: `${OUT}/01-ask-cloud-panel.png` }).catch((e) => log("  panel crop skipped: " + e.message));
  log("  shot: Cloud state");

  // ── LOCAL state (endpoint empty → inline hint shows) ──
  await ensureMode("local");
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
  await page.locator('[data-testid="model-switch"][data-mode="local"]:visible').first()
    .waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/02-ask-local.png`, fullPage: false });
  await visiblePanel().screenshot({ path: `${OUT}/02-ask-local-panel.png` }).catch((e) => log("  panel crop skipped: " + e.message));
  log("  shot: Local state");

  // ── Settings → Model section ──
  await page.goto(`${BASE}/settings?tab=prompts`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="model-section"]', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/03-settings-model-full.png`, fullPage: true });
  const section = await page.$('[data-testid="model-section"]');
  if (section) await section.screenshot({ path: `${OUT}/03-settings-model.png` });
  log("  shot: Settings → Model section");

  // restore the default (cloud) so we don't leave the shared workspace on Local.
  await ensureMode("cloud");
  log("  restored mode=cloud");

  log("\n===== DONE — shots in " + OUT + " =====");
} catch (e) {
  log("ERROR: " + (e instanceof Error ? e.message : String(e)));
  await page.screenshot({ path: `${OUT}/ERROR.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
