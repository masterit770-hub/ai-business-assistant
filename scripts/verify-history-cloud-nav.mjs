// Verify the deployed app: (1) history persists an ask + shows its sources;
// (2) a cloud provider with NO key fails closed (no silent DeepSeek answer);
// (3) nav reads Documents / History / Settings (not "Admin"). Restores cloud. No creds printed.
import { chromium } from "playwright-core";
import fs from "node:fs";
const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const sec = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/demo-accounts.txt", "utf8");
const ab = sec.slice(sec.indexOf("ADMIN"));
const EMAIL = ab.match(/email:\s*(\S+)/i)?.[1], PASSWORD = ab.match(/password:\s*(\S+)/i)?.[1];
const put = (p, b) => p.evaluate(async (b) => (await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).status, b);
const ask = (p, q) => p.evaluate(async (q) => await (await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) })).json(), q);
const hist = (p) => p.evaluate(async () => await (await fetch("/api/history")).json());
const MARK = "Which vendor has the most contracts?";
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const p = await (await b.newContext()).newPage(); p.setDefaultTimeout(90000);
  try {
    await p.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await p.fill('input[type="email"]', EMAIL); await p.fill('input[type="password"]', PASSWORD);
    await p.click('[data-testid="auth-submit"]'); await p.waitForURL("**/dashboard", { timeout: 90000 });

    // 3. NAV labels
    await p.waitForSelector('aside', { timeout: 20000 }).catch(() => {});
    const navText = await p.evaluate(() => document.querySelector("aside")?.innerText || "");
    console.log("[3] NAV has: Documents=" + /Documents/.test(navText) + " History=" + /History/.test(navText) + " Settings=" + /Settings/.test(navText) + " | still says 'Admin'? " + /\bAdmin\b/.test(navText));

    // 1. HISTORY — ask, then confirm it's logged with sources
    await put(p, { model_mode: "cloud", cloud_provider: "" });
    const a = await ask(p, MARK);
    const h = await hist(p);
    const top = (h.items || [])[0] || {};
    console.log("\n[1] HISTORY: just asked → '" + MARK + "'");
    console.log("    /api/history newest item question:", JSON.stringify(top.question));
    console.log("    logged correctly:", top.question === MARK, "| has sources:", JSON.stringify(top.citations)?.length > 2);
    console.log("    total history items:", (h.items || []).length);

    // 2. CLOUD FAIL-CLOSED — select openai with NO key, must NOT silently answer via DeepSeek
    await put(p, { cloud_provider: "openai" });
    const f = await ask(p, "How many contracts are expiring in the next 90 days?");
    const fa = f.answer ?? "";
    console.log("\n[2] CLOUD openai, NO key: mode=" + f.mode);
    console.log("    answer:", fa.slice(0, 180).replace(/\n/g, " "));
    console.log("    FAILS CLOSED (no DeepSeek masquerade):", /no API key is saved|haven't|switch the provider/i.test(fa) && !/41 contracts|19,895/.test(fa));
  } finally {
    await put(p, { model_mode: "cloud", cloud_provider: "" });
    console.log("\n↩ restored cloud default");
    await b.close();
  }
})();
