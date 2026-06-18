// Screenshot every Nucleus route at 1440x900, full-page, into ./screenshots.
// Uses the playwright install from jobright-agent + the shared browser cache.
import { chromium } from "/home/codex/Projects/jobright-agent/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "/home/codex/Projects/nucleus/screenshots";
mkdirSync(OUT, { recursive: true });

// Allow shooting a subset: `node shoot.mjs landing pricing`
const ALL = [
  { path: "/", file: "landing.png" },
  { path: "/pricing", file: "pricing.png" },
  { path: "/sign-in", file: "sign-in.png" },
  { path: "/sign-up", file: "sign-up.png" },
  { path: "/dashboard", file: "dashboard.png" },
  { path: "/settings", file: "settings.png" },
];
const want = process.argv.slice(2);
const routes = want.length
  ? ALL.filter((r) => want.some((w) => r.file.startsWith(w)))
  : ALL;

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

let ok = 0;
for (const r of routes) {
  const url = BASE + r.path;
  try {
    const resp = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    const status = resp ? resp.status() : "no-response";
    // Let fonts settle so headings render in Space Grotesk, not a fallback.
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(450);
    const dest = `${OUT}/${r.file}`;
    await page.screenshot({ path: dest, fullPage: true });
    console.log(`OK   ${r.path.padEnd(12)} -> ${r.file}  (HTTP ${status})`);
    ok++;
  } catch (e) {
    console.log(`FAIL ${r.path.padEnd(12)} -> ${r.file}  ${e.message.split("\n")[0]}`);
  }
}

await browser.close();
console.log(`\n${ok}/${routes.length} screenshots captured.`);
process.exit(ok === routes.length ? 0 : 1);
