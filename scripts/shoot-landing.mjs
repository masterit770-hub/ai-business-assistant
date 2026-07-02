// Landing-page screenshot harness. Uses the CRR-cached Playwright + chromium-1223.
// Usage: node scripts/shoot-landing.mjs <baseUrl> <outDir>
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/codex/Projects/Contract-Retriever-RAG/node_modules/playwright/index.js");

const BASE = process.argv[2] || "http://localhost:3210";
const OUT = process.argv[3] || "/tmp/landing-shots";
const EXE = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

mkdirSync(OUT, { recursive: true });

async function shoot(label, width, height) {
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  const resp = await page.goto(BASE + "/", { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  // let the hero typing animation reach the answer state + scroll reveals settle
  await page.waitForTimeout(4500);

  await page.screenshot({ path: `${OUT}/${label}-hero.png`, fullPage: false });

  // scroll through to trigger reveals, then full-page shot
  await page.evaluate(async () => {
    const h = document.body.scrollHeight;
    for (let y = 0; y < h; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${label}-full.png`, fullPage: true });

  await browser.close();
  return { status: resp ? resp.status() : "none", errors };
}

const d = await shoot("desktop", 1440, 900);
const m = await shoot("mobile", 390, 844);

console.log("DESKTOP http", d.status, "errors:", d.errors.length ? JSON.stringify(d.errors, null, 2) : "none");
console.log("MOBILE  http", m.status, "errors:", m.errors.length ? JSON.stringify(m.errors, null, 2) : "none");
console.log("OUT:", OUT);
