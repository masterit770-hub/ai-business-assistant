// Verify the chat input by SIMULATING REAL KEYSTROKES (not the API): Enter sends,
// Shift+Enter inserts a newline, the arrow button sends. This is the UI-level check
// that the earlier API-only tests missed. Never prints creds.
import { chromium } from "playwright-core";
import fs from "node:fs";
const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const sec = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/demo-accounts.txt", "utf8");
const ab = sec.slice(sec.indexOf("ADMIN"));
const EMAIL = ab.match(/email:\s*(\S+)/i)?.[1], PASSWORD = ab.match(/password:\s*(\S+)/i)?.[1];
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const p = await (await b.newContext()).newPage(); p.setDefaultTimeout(90000);
  try {
    await p.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await p.fill('input[type="email"]', EMAIL); await p.fill('input[type="password"]', PASSWORD);
    await p.click('[data-testid="auth-submit"]'); await p.waitForURL("**/dashboard", { timeout: 90000 });
    const ta = p.locator("textarea").first();
    await ta.waitFor({ timeout: 20000 });

    // [A] ENTER SENDS
    await ta.click();
    await ta.type("How many contracts are expiring in the next 90 days?");
    await p.keyboard.press("Enter");
    // success = the textarea clears AND an answer turn appears
    let sent = false, answered = false;
    try {
      await p.waitForFunction(() => (document.querySelector("textarea")?.value ?? "x") === "", { timeout: 15000 });
      sent = true;
    } catch {}
    try {
      await p.waitForFunction(() => /41 contracts|contracts? expiring|\[S:contracts/i.test(document.body.innerText), { timeout: 60000 });
      answered = true;
    } catch {}
    console.log("[A] ENTER → input cleared (sent):", sent, "| answer appeared:", answered);

    // [B] SHIFT+ENTER INSERTS A NEWLINE (does NOT send)
    await ta.click();
    await ta.type("line one");
    await p.keyboard.press("Shift+Enter");
    await ta.type("line two");
    const val = await ta.inputValue();
    console.log("[B] SHIFT+ENTER → textarea has a newline (not sent):", val.includes("\n"), "| value:", JSON.stringify(val));

    // [C] ARROW BUTTON SENDS (clears the shift+enter draft)
    const btn = p.locator('button[type="submit"]').first();
    await btn.click();
    let cleared2 = false;
    try { await p.waitForFunction(() => (document.querySelector("textarea")?.value ?? "x") === "", { timeout: 15000 }); cleared2 = true; } catch {}
    console.log("[C] ARROW click → input cleared (sent):", cleared2);
  } catch (e) {
    console.error("VERIFY ERROR:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally { await b.close(); }
})();
