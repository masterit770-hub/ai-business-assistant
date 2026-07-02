// Final cleanup + health check: clear the now-dead tunnel URL from settings, ensure
// the demo is on Cloud, and confirm it still answers correctly. Never prints creds.
import { chromium } from "playwright-core";
import fs from "node:fs";
const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const sec = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/demo-accounts.txt", "utf8");
const ab = sec.slice(sec.indexOf("ADMIN"));
const EMAIL = ab.match(/email:\s*(\S+)/i)?.[1], PASSWORD = ab.match(/password:\s*(\S+)/i)?.[1];
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await (await b.newContext()).newPage();
  page.setDefaultTimeout(90000);
  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', EMAIL); await page.fill('input[type="password"]', PASSWORD);
    await page.click('[data-testid="auth-submit"]'); await page.waitForURL("**/dashboard", { timeout: 90000 });
    const put = await page.evaluate(async () => (await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model_mode: "cloud", local_endpoint: "" }) })).status);
    const s = await page.evaluate(async () => await (await fetch("/api/settings")).json());
    const r = await page.evaluate(async () => { const x = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "How many contracts are expiring in the next 90 days, and what is their total annual cost?" }) }); return await x.json(); });
    console.log("settings PUT status=" + put);
    console.log("model_mode=" + s.model_mode + " | local_endpoint=" + JSON.stringify(s.local_endpoint));
    console.log("CLOUD answer:", (r.answer ?? "").slice(0, 300).replace(/\n/g, " "));
    console.log("citations:", [...(r.answer ?? "").matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]).join(" ") || "(none)");
  } finally { await b.close(); }
})();
