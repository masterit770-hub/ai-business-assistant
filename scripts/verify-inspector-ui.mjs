// Focused follow-up: sign in, ask the contracts question THROUGH THE UI (so the
// console's own state holds the result), switch to the Inspector tab, and screenshot
// the rendered MetricsPanels (cost/tokens/confidence/timings) — proving the purple
// inspector UI renders the real engine trace live. Light + dark.
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const OUT = "/home/codex/Projects/nucleus/screenshots/client";

const sec = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/demo-accounts.txt", "utf8");
const adminBlock = sec.slice(sec.indexOf("ADMIN"));
const EMAIL = adminBlock.match(/email:\s*(\S+)/i)[1];
const PASSWORD = adminBlock.match(/password:\s*(\S+)/i)[1];
const log = (...a) => console.log(...a);

(async () => {
  const browser = await chromium.launch({
    executablePath: EXEC, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('[data-testid="auth-submit"]');
    await page.waitForURL("**/dashboard");
    await page.waitForSelector('[data-testid="assistant-console"]');
    await page.evaluate(() => { document.documentElement.setAttribute("data-theme","light"); try{localStorage.setItem("ab-theme","light")}catch{} });

    // Ask THROUGH the UI textarea so the console keeps the result in its state.
    await page.fill('textarea[aria-label="Ask a question"]', "How many contracts expire in the next 90 days?");
    // submit the form
    await page.click('[data-testid="ask-result"]'); // ensure focus context
    await page.locator('textarea[aria-label="Ask a question"]').focus();
    await page.keyboard.down("Control"); await page.keyboard.press("Enter"); await page.keyboard.up("Control");
    // wait for the answer to render (StatusTiles / AnswerView appear in ask-result)
    await page.waitForFunction(() => {
      const r = document.querySelector('[data-testid="ask-result"]');
      return r && /38 contracts/.test(r.textContent || "");
    }, { timeout: 90000 });
    log("✓ UI answer rendered (contracts)");

    // Switch to Inspector tab and wait for the panels.
    await page.click('[data-testid="tab-inspector"]');
    await page.waitForSelector('[data-testid="inspector-view"]', { timeout: 20000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/LIVE-inspector-contracts.png`, fullPage: false });
    log(`✓ ${OUT}/LIVE-inspector-contracts.png`);

    // Capture the visible inspector text (proves real numbers are on screen).
    const inspText = await page.locator('[data-testid="inspector-view"]').innerText();
    log("---- INSPECTOR PANEL TEXT (first 1200 chars) ----");
    log(inspText.slice(0, 1200));

    // Dark variant of the inspector.
    await page.evaluate(() => { document.documentElement.setAttribute("data-theme","dark"); try{localStorage.setItem("ab-theme","dark")}catch{} });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/LIVE-inspector-contracts-dark.png`, fullPage: false });
    log(`✓ ${OUT}/LIVE-inspector-contracts-dark.png`);
  } catch (e) {
    log("FATAL: " + (e?.stack || e?.message || e));
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
