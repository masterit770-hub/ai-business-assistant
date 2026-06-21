// Screenshot the client (purple inspector) rebuild — light + dark, the inspector
// and workspace views — using the cached chromium-1223 via playwright-core.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3941";
const OUT = "/home/codex/Projects/nucleus/screenshots/client";
const CHROME =
  process.env.PW_CHROMIUM_PATH ??
  "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: CHROME });

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    localStorage.setItem("ab-theme", t);
    document.documentElement.setAttribute("data-theme", t);
  }, theme);
}

async function shoot(path, name, { theme, viewport, clicks = [], waitFor, fullPage = false }) {
  const ctx = await browser.newContext({ viewport: viewport ?? { width: 1500, height: 1080 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await setTheme(page, theme);
  await page.reload({ waitUntil: "networkidle" });
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
  for (const sel of clicks) {
    await page.click(sel).catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(500);
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, fullPage });
  console.log("  saved → " + file);
  await ctx.close();
}

try {
  // Inspector preview — case-file fixture, Inspector tab (the marquee view)
  await shoot("/dev/inspector", "inspector-light", { theme: "light", waitFor: '[data-testid="status-tiles"]' });
  await shoot("/dev/inspector", "inspector-dark", { theme: "dark", waitFor: '[data-testid="status-tiles"]' });

  // Workspace tab (answer + citation chips), light + dark
  await shoot("/dev/inspector", "workspace-light", {
    theme: "light",
    waitFor: '[data-testid="status-tiles"]',
    clicks: ["text=Workspace"],
  });
  await shoot("/dev/inspector", "workspace-dark", {
    theme: "dark",
    waitFor: '[data-testid="status-tiles"]',
    clicks: ["text=Workspace"],
  });

  // Contracts (SQL) fixture, inspector — shows the structured-rows retrieval table
  await shoot("/dev/inspector", "inspector-contracts-light", {
    theme: "light",
    waitFor: '[data-testid="status-tiles"]',
    clicks: ["text=Contracts (SQL)"],
  });

  // General-knowledge fixture, inspector — NONE route + skipped citation
  await shoot("/dev/inspector", "inspector-general-dark", {
    theme: "dark",
    waitFor: '[data-testid="status-tiles"]',
    clicks: ["text=General knowledge"],
  });

  // Landing page, light + dark
  await shoot("/", "landing-light", { theme: "light", viewport: { width: 1500, height: 1000 } });
  await shoot("/", "landing-dark", { theme: "dark", viewport: { width: 1500, height: 1000 } });

  // Sign-in, light + dark
  await shoot("/sign-in", "signin-light", { theme: "light", viewport: { width: 1500, height: 900 } });
  await shoot("/sign-in", "signin-dark", { theme: "dark", viewport: { width: 1500, height: 900 } });

  console.log("DONE");
} catch (e) {
  console.error("ERROR:", e instanceof Error ? e.message : String(e));
} finally {
  await browser.close();
}
