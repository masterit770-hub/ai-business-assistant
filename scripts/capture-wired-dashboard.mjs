// Drive the LIVE Nucleus dashboard (the polished UI) to ask a real question via
// the now-wired Ask panel, and screenshot the real grounded+cited answer coming
// from the Contract-Retriever-RAG engine. Proves the mock is gone — the polished
// UI returns real cited answers. Requires: Nucleus dev on :3000, engine on :3100.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.NUCLEUS_BASE ?? "http://localhost:3000";
const OUT = "/home/codex/Projects/nucleus/screenshots/real-engine";
const CHROME =
  process.env.PW_CHROMIUM_PATH ??
  "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  {
    name: "10-nucleus-wired-contracts",
    q: "What contracts expire in the next 90 days, and what is their combined annual value?",
    must: ["38", "18,924,883.79"],
  },
  {
    name: "11-nucleus-wired-case-file",
    q: "What was the final child support amount, and who got primary residence?",
    must: ["1,285", "Joni"],
  },
];

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
// xl breakpoint (>=1280) so the right-hand Ask panel is visible.
const ctx = await browser.newContext({ viewport: { width: 1560, height: 1200 } });
const page = await ctx.newPage();
const results = [];

for (const s of SHOTS) {
  console.log(`\n=== ${s.name} ===`);
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
  await page.fill('input[aria-label="Ask a question"]', s.q);
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="validation"]', { timeout: 90000 });
  await page.waitForTimeout(500);
  const answer = (await page.textContent('[data-testid="answer"]')) ?? "";
  const validation = (await page.textContent('[data-testid="validation"]')) ?? "";
  const missing = s.must.filter((m) => !answer.includes(m));
  // Screenshot just the dashboard viewport (the Ask panel is in view on the right).
  const file = `${OUT}/${s.name}.png`;
  await page.screenshot({ path: file });
  const ok = missing.length === 0;
  console.log(`  required strings present: ${ok ? "YES" : "NO (missing " + missing.join(", ") + ")"}`);
  console.log(`  validation: ${validation.trim().slice(0, 80)}`);
  console.log(`  saved → ${file}`);
  results.push({ name: s.name, ok, validation: validation.trim().slice(0, 90) });
}

await browser.close();
console.log("\n===== SUMMARY =====");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  | ${r.validation}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
