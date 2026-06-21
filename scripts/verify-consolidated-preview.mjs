// End-to-end verification of the CONSOLIDATED single app on its preview deploy.
// Signs in as the demo admin and exercises the in-process engine (no ENGINE_URL):
// structured cited answers, bundled-doc + Hebrew, de-faked pages, role nav, doc
// list. Gemini is conserved — at most ONE File Search query (skippable via env).
//
// The preview is Vercel-SSO-protected; we pass the automation protection-bypass
// token as a header AND set the bypass cookie so every navigation gets through.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.PREVIEW_URL;
const BYPASS = process.env.VERCEL_BYPASS;
const EMAIL = process.env.NUCLEUS_EMAIL;
const PASSWORD = process.env.NUCLEUS_PASSWORD;
const ONE_GEMINI = process.env.RUN_GEMINI === "1";
const OUT = "/home/codex/Projects/nucleus/screenshots/real-engine";
const CHROME =
  process.env.PW_CHROMIUM_PATH ??
  "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

if (!BASE || !BYPASS || !EMAIL || !PASSWORD) {
  console.error("need PREVIEW_URL, VERCEL_BYPASS, NUCLEUS_EMAIL, NUCLEUS_PASSWORD");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext({
  viewport: { width: 1560, height: 1200 },
  // Bypass Vercel SSO on every request in this context.
  extraHTTPHeaders: { "x-vercel-protection-bypass": BYPASS, "x-vercel-set-bypass-cookie": "true" },
});
const page = await ctx.newPage();
let ok = true;
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const log = (m) => console.log(m);

async function ask(q) {
  const input = page.locator('input[aria-label="Ask a question"]:visible').first();
  await input.fill(q);
  await input.press("Enter");
  await page.waitForSelector('[data-testid="answer"]', { timeout: 90000 });
  await page.waitForTimeout(1200);
  return (await page.textContent('[data-testid="answer"]')) ?? "";
}

try {
  // 1) sign in
  await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('[data-testid="auth-submit"]');
  await page.waitForURL("**/dashboard", { timeout: 30000 });
  log("✓ signed in → dashboard (in-process app)");

  // 2) bundled corpus renders + Documents stat
  await page.waitForSelector("text=Built-in business data", { timeout: 30000 });
  const docStat = (await page.textContent('[data-testid="stat-Documents"]'))?.trim() ?? "";
  log(`  Documents stat = ${docStat}`);
  if (Number(docStat.replace(/[^0-9]/g, "")) < 9) { ok = false; log("  ✗ bundled corpus count < 9"); }

  // 3) STRUCTURED cited answer (DeepSeek/SQL — no Gemini)
  const a1 = await ask("How many vendor contracts expire in the next 90 days?");
  const has38 = /\b38\b/.test(a1) && /\[S:contracts#/.test(a1);
  log(`  contracts: ${has38 ? "✓" : "✗"} ${a1.slice(0, 90).replace(/\n/g, " ")}`);
  if (!has38) ok = false;

  const a2 = await ask("What is the total maintenance spend across all invoices?");
  const hasMaint = /40,?597/.test(a2) && /\[S:maintenance#/.test(a2);
  log(`  maintenance: ${hasMaint ? "✓" : "✗"} ${a2.slice(0, 90).replace(/\n/g, " ")}`);
  if (!hasMaint) ok = false;

  // 4) BUNDLED-DOC + Hebrew (local vector path — no Gemini)
  const a3 = await ask("מה היה סכום המזונות הסופי ומי קיבל את המשמורת?");
  const hasHe = /1,?285/.test(a3) && /\[P:family-court#/.test(a3);
  log(`  hebrew case-file: ${hasHe ? "✓" : "✗"} ${a3.slice(0, 110).replace(/\n/g, " ")}`);
  if (!hasHe) ok = false;

  // 5) ONE conservative Gemini File Search query (only if RUN_GEMINI=1)
  if (ONE_GEMINI) {
    const a4 = await ask("Summarize the Carter family court case file.");
    const cited = /\[P:/.test(a4);
    log(`  (gemini path) carter: ${cited ? "✓ cited" : "✗"} ${a4.slice(0, 80).replace(/\n/g, " ")}`);
    if (!cited) ok = false;
  } else {
    log("  (skipping the Gemini File Search query — RUN_GEMINI not set)");
  }

  await page.screenshot({ path: `${OUT}/C0-consolidated-preview.png`, fullPage: true });
  log(`  saved → ${OUT}/C0-consolidated-preview.png`);

  // 6) console errors
  if (errors.length) { ok = false; log(`  ✗ ${errors.length} console error(s): ${errors.slice(0,3).join(" | ")}`); }
  else log("  ✓ zero console errors");
} catch (e) {
  ok = false;
  log("ERROR: " + (e instanceof Error ? e.message : String(e)));
  await page.screenshot({ path: `${OUT}/C0-consolidated-ERROR.png` }).catch(() => {});
} finally {
  await browser.close();
}
log("\n===== " + (ok ? "PASS" : "FAIL") + " =====");
process.exit(ok ? 0 : 1);
