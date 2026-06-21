// After a tunnel self-heal (new URL), confirm the DEPLOYED app's Local mode picks up
// the re-synced endpoint and answers via the box. Restores Cloud. Never prints creds.
import { chromium } from "playwright-core";
import fs from "node:fs";
const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const sec = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/demo-accounts.txt", "utf8");
const ab = sec.slice(sec.indexOf("ADMIN"));
const EMAIL = ab.match(/email:\s*(\S+)/i)?.[1], PASSWORD = ab.match(/password:\s*(\S+)/i)?.[1];
const put = (p, b) => p.evaluate(async (b) => (await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).status, b);
const ask = (p, q) => p.evaluate(async (q) => { const r = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) }); return await r.json(); }, q);
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const p = await (await b.newContext()).newPage(); p.setDefaultTimeout(90000);
  try {
    await p.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await p.fill('input[type="email"]', EMAIL); await p.fill('input[type="password"]', PASSWORD);
    await p.click('[data-testid="auth-submit"]'); await p.waitForURL("**/dashboard", { timeout: 90000 });
    await put(p, { model_mode: "local" });
    const r = await ask(p, "What does the case file say about child support for the Carter case?");
    const a = r.answer ?? "";
    console.log("POST-HEAL LOCAL: mode=" + r.mode);
    console.log("answer:", a.slice(0, 240).replace(/\n/g, " "));
    console.log("cites:", [...a.matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]).join(" ") || "(none)");
    console.log("reached-the-box (not the 'couldn't reach' message):", !/couldn't reach|isn't set up/i.test(a));
  } finally { await put(p, { model_mode: "cloud" }); await b.close(); }
})();
