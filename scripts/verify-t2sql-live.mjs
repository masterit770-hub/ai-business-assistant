// Live verification of the DEPLOYED text-to-SQL build on nucleus-woad.
// Signs in as admin (cached chromium-1223), asks via in-page fetch('/api/ask') so we
// get the full engine response incl. the inspector trace with the GENERATED SQL.
// Proves: (1) real-date contracts answer (honest, not a frozen number) + citations,
// (2) arbitrary analytical questions the old 7 hardcoded intents never had still work
// via generated SQL. NEVER prints the password.
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const sec = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/demo-accounts.txt", "utf8");
const adminBlock = sec.slice(sec.indexOf("ADMIN"));
const EMAIL = adminBlock.match(/email:\s*(\S+)/i)?.[1];
const PASSWORD = adminBlock.match(/password:\s*(\S+)/i)?.[1];
if (!EMAIL || !PASSWORD) { console.error("FATAL: no admin creds"); process.exit(1); }

const ask = (page, q) => page.evaluate(async (q) => {
  const res = await fetch("/api/ask", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: q }),
  });
  let data = null; try { data = await res.json(); } catch { data = { error: "non-json" }; }
  return { status: res.status, data };
}, q);

function report(label, q, r) {
  const a = r.data?.answer ?? "";
  const blob = JSON.stringify(r.data ?? {});
  const sql = [...blob.matchAll(/SELECT[^"\\]*?(?=["\\])/gi)].map((m) => m[0].replace(/\s+/g, " ").trim());
  const cites = [...a.matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]);
  console.log("\n================ " + label + " ================");
  console.log("Q:", q);
  console.log("status=" + r.status + " mode=" + (r.data?.mode ?? "?"));
  console.log("ANSWER:", a.slice(0, 450).replace(/\n/g, " "));
  console.log("GENERATED SQL:", sql.length ? [...new Set(sql)].join("  |  ") : "(none found)");
  console.log("CITATIONS:", cites.length ? [...new Set(cites)].join(" ") : "(none)");
  const insp = r.data?.inspector;
  if (insp) console.log("retrieval=" + insp.retrievalMethod + " evidence=" + insp.evidenceCount + " conf=" + JSON.stringify(insp.confidence));
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.setDefaultTimeout(70000);
  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('[data-testid="auth-submit"]');
    await page.waitForURL("**/dashboard", { timeout: 70000 });
    await page.waitForSelector('[data-testid="assistant-console"]', { timeout: 70000 });
    console.log("✓ signed in");

    const Q1 = "How many contracts are expiring in the next 90 days, and what is their total annual cost?";
    const Q2 = "Which vendor has the most contracts?";                 // arbitrary — not one of the old 7 intents
    const Q3 = "What is the average annual cost across all contracts?"; // arbitrary aggregate
    report("Q1 contracts/next-90-days (REAL date)", Q1, await ask(page, Q1));
    report("Q2 vendor with most contracts (arbitrary)", Q2, await ask(page, Q2));
    report("Q3 average annual cost (arbitrary)", Q3, await ask(page, Q3));
    console.log("\n[live verification complete]");
  } catch (e) {
    console.error("VERIFY ERROR:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally { await browser.close(); }
})();
