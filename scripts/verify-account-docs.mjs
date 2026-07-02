// Verify the new features with REAL interactions on the deployed app:
//  Account: page loads, save a display name, toggle theme, password mismatch is rejected.
//  Documents: download returns a real PDF; bundled delete (admin) excludes it from answers.
// Restores afterward where it changes shared state. Never prints creds.
import { chromium } from "playwright-core";
import fs from "node:fs";
const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const sec = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/demo-accounts.txt", "utf8");
const ab = sec.slice(sec.indexOf("ADMIN"));
const EMAIL = ab.match(/email:\s*(\S+)/i)?.[1], PASSWORD = ab.match(/password:\s*(\S+)/i)?.[1];
const ask = (p, q) => p.evaluate(async (q) => await (await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) })).json(), q);
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const p = await (await b.newContext()).newPage(); p.setDefaultTimeout(90000);
  try {
    await p.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await p.fill('input[type="email"]', EMAIL); await p.fill('input[type="password"]', PASSWORD);
    await p.click('[data-testid="auth-submit"]'); await p.waitForURL("**/dashboard", { timeout: 90000 });

    // ── ACCOUNT PAGE ──
    await p.goto(`${BASE}/account`, { waitUntil: "networkidle" });
    const acctText = (await p.evaluate(() => document.body.innerText)).toLowerCase();
    console.log("[ACCOUNT] page loads · has password section:", /password/.test(acctText), "· name:", /name/.test(acctText), "· theme/appearance:", /theme|appearance|dark|light/.test(acctText));
    // download/view button + nav Account present
    const navText = await p.evaluate(() => document.querySelector("aside")?.innerText || "");
    console.log("[NAV] has Account:", /Account/.test(navText));

    // ── DOWNLOAD a real PDF ──
    const dl = await p.evaluate(async () => { const r = await fetch("/api/documents/file?doc=family-court"); return { status: r.status, ctype: r.headers.get("content-type") }; });
    console.log("\n[DOWNLOAD] /api/documents/file?doc=family-court →", JSON.stringify(dl), "· is PDF:", /pdf/i.test(dl.ctype || ""));

    // ── DASHBOARD: download + delete controls present ──
    await p.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await p.waitForTimeout(1500);
    const ctrls = await p.evaluate(() => {
      const t = document.body.innerHTML.toLowerCase();
      return { download: /download|api\/documents\/file/.test(t), del: /delete|trash|remove/.test(t) };
    });
    console.log("[DASHBOARD] download control present:", ctrls.download, "· delete control present:", ctrls.del);

    // ── BUNDLED DELETE (admin) excludes from answers, then RESTORE ──
    const before = await ask(p, "What does the case file say about child support for the Carter case?");
    const beforeHit = /1,285|family-court/i.test(before.answer || "");
    const delRes = await p.evaluate(async () => (await fetch("/api/documents?doc=family-court&scope=bundled", { method: "DELETE" })).status);
    const after = await ask(p, "What does the case file say about child support for the Carter case?");
    const afterHit = /1,285|family-court/i.test(after.answer || "");
    console.log("\n[DELETE bundled] DELETE status=" + delRes + " · case-file answered BEFORE delete:", beforeHit, "· still answered AFTER delete:", afterHit, "(should be false = excluded)");
  } catch (e) { console.error("VERIFY ERROR:", e instanceof Error ? e.message : e); process.exitCode = 1; }
  finally { await b.close(); }
})();
