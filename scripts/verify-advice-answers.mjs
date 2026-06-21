// Verify the demo ANSWERS advice/recommendation questions about a document (Jenny's
// exact concern: "will it answer my advice question or act like no rag identified?").
// Must NOT refuse. Never prints creds.
import { chromium } from "playwright-core";
import fs from "node:fs";
const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const sec = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/demo-accounts.txt", "utf8");
const ab = sec.slice(sec.indexOf("ADMIN"));
const EMAIL = ab.match(/email:\s*(\S+)/i)?.[1], PASSWORD = ab.match(/password:\s*(\S+)/i)?.[1];
const ask = (p, q) => p.evaluate(async (q) => { const r = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) }); return await r.json(); }, q);
const Qs = [
  "Based on the Carter case file, what's the best strategy for Michael to reduce the child support or alimony he pays? Advise me.",
  "Reading the case file, how should I act to my own benefit regarding the support terms?",
];
const REFUSAL = /no (relevant )?(documents?|evidence|information).*(found|available|support)|cannot (answer|find)|no rag|not able to answer|i don'?t have/i;
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const p = await (await b.newContext()).newPage(); p.setDefaultTimeout(90000);
  try {
    await p.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await p.fill('input[type="email"]', EMAIL); await p.fill('input[type="password"]', PASSWORD);
    await p.click('[data-testid="auth-submit"]'); await p.waitForURL("**/dashboard", { timeout: 90000 });
    for (const q of Qs) {
      const r = await ask(p, q);
      const a = r.answer ?? "";
      console.log("\nQ:", q.slice(0, 70) + "...");
      console.log("mode=" + r.mode + " | ANSWERED (not refused):", !REFUSAL.test(a) && a.length > 60);
      console.log("answer head:", a.slice(0, 260).replace(/\n/g, " "));
      console.log("cites:", [...a.matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]).join(" ") || "(general/uncited — honest)");
    }
  } finally { await b.close(); }
})();
