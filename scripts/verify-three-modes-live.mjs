// Live verification of the 3-mode build on the DEPLOYED app. Proves, end-to-end:
//  1. CLOUD still answers (regression — the DeepSeek env default, honest real-date number) + cites
//  2. The picker renders 3 options (Cloud / HIPAA / Local) with honest HIPAA labeling
//  3. HIPAA fails CLOSED with no key (clear message, NOT a DeepSeek answer, no crash)
//  4. Per-mode keys are independent (saving a dummy HIPAA key does NOT set the cloud key)
//  5. LOCAL answers via the box through the self-healing tunnel + cites
// ALWAYS restores model_mode=cloud and clears the dummy HIPAA key. Never prints creds.
import { chromium } from "playwright-core";
import fs from "node:fs";
const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const sec = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/demo-accounts.txt", "utf8");
const ab = sec.slice(sec.indexOf("ADMIN"));
const EMAIL = ab.match(/email:\s*(\S+)/i)?.[1], PASSWORD = ab.match(/password:\s*(\S+)/i)?.[1];

const put = (page, body) => page.evaluate(async (b) => {
  const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, data: await r.json().catch(() => null) };
}, body);
const get = (page) => page.evaluate(async () => await (await fetch("/api/settings")).json());
const ask = (page, q) => page.evaluate(async (q) => {
  const r = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
  return { status: r.status, data: await r.json().catch(() => ({ error: "non-json" })) };
}, q);
const Q = "How many contracts are expiring in the next 90 days, and what is their total annual cost?";
const cites = (a) => [...(a ?? "").matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]).join(" ") || "(none)";

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.setDefaultTimeout(90000);
  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', EMAIL); await page.fill('input[type="password"]', PASSWORD);
    await page.click('[data-testid="auth-submit"]'); await page.waitForURL("**/dashboard", { timeout: 90000 });
    await page.waitForSelector('[data-testid="assistant-console"]', { timeout: 90000 });
    console.log("✓ signed in");

    // 2. PICKER renders 3 options (wait for the admin-only switch to finish loading)
    await page.waitForSelector('[data-testid="model-switch-cloud"]', { timeout: 30000 }).catch(() => {});
    const segs = await page.evaluate(() => ["cloud", "hipaa", "local"].map((m) => Boolean(document.querySelector(`[data-testid="model-switch-${m}"]`))));
    const segLabels = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="model-switch-"]')).map((e) => e.textContent?.trim()).filter(Boolean));
    console.log("\n[2] 3-way picker present (cloud,hipaa,local):", JSON.stringify(segs), "labels:", JSON.stringify(segLabels));

    // 1. CLOUD regression
    await put(page, { model_mode: "cloud" });
    const c = await ask(page, Q);
    console.log("\n[1] CLOUD: status=" + c.status + " mode=" + c.data?.mode);
    console.log("    answer:", (c.data?.answer ?? "").slice(0, 200).replace(/\n/g, " "));
    console.log("    cites:", cites(c.data?.answer));

    // 4. PER-MODE KEY INDEPENDENCE: save a dummy HIPAA key, confirm cloud key NOT set
    await put(page, { hipaa_api_key: "dummy-azure-test-key", hipaa_endpoint: "https://example.openai.azure.com", hipaa_model: "gpt-4o" });
    const s1 = await get(page);
    console.log("\n[4] after saving HIPAA key → hipaa_api_key_set=" + s1.hipaa_api_key_set + " cloud_api_key_set=" + s1.cloud_api_key_set + " (independent ✓ if cloud=false)");

    // 3. HIPAA fail-closed: but we set a dummy key+endpoint, so it will try Azure and fail to REACH it →
    //    clear the key first to test the true 'not configured' path, then test with bad creds = clean error.
    await put(page, { hipaa_api_key: "__clear__" });
    await put(page, { model_mode: "hipaa" });
    const h = await ask(page, Q);
    const hmsg = (h.data?.answer ?? h.data?.error ?? "").slice(0, 220).replace(/\n/g, " ");
    console.log("\n[3] HIPAA no-key: status=" + h.status + " mode=" + (h.data?.mode ?? "n/a"));
    console.log("    message:", hmsg);
    console.log("    fails-closed (no $18M/DeepSeek answer):", !/18,924|19,895|41 contracts|494,513/.test(h.data?.answer ?? ""));

    // 5. LOCAL via the box (endpoint synced by the supervisor)
    await put(page, { model_mode: "local" });
    const l = await ask(page, "What does the case file say about child support for the Carter case?");
    console.log("\n[5] LOCAL (via box): status=" + l.status + " mode=" + l.data?.mode);
    console.log("    answer:", (l.data?.answer ?? "").slice(0, 220).replace(/\n/g, " "));
    console.log("    cites:", cites(l.data?.answer), "| retrieval=" + (l.data?.inspector?.retrievalMethod ?? "?"));
  } catch (e) {
    console.error("VERIFY ERROR:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    try {
      await put(page, { model_mode: "cloud", hipaa_api_key: "__clear__", hipaa_endpoint: "", hipaa_model: "" });
      const fin = await get(page);
      console.log("\n↩ restored: model_mode=" + fin.model_mode + " hipaa_api_key_set=" + fin.hipaa_api_key_set);
    } catch (e2) { console.error("WARN restore:", e2?.message); }
    await b.close();
  }
})();
