// Proves the FULL vercel→box path on the DEPLOYED app: flips nucleus-woad to Local
// pointed at this box's Ollama (qwen2.5:1.5b) via the cloudflared tunnel, asks a
// STRUCTURED question (text-to-SQL through the local model) AND a DOCUMENT question
// (RAG retrieval + local generation) to prove retrieval still runs in Local mode,
// reads the answers + inspector, then FLIPS BACK TO CLOUD (Jenny-safe). Never prints creds.
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const TUNNEL = fs.readFileSync("/tmp/tunnel-url.txt", "utf8").trim();
const LOCAL_ENDPOINT = `${TUNNEL}/v1`;
const LOCAL_MODEL = process.argv[2] || "qwen2.5:1.5b";
const sec = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/demo-accounts.txt", "utf8");
const adminBlock = sec.slice(sec.indexOf("ADMIN"));
const EMAIL = adminBlock.match(/email:\s*(\S+)/i)?.[1];
const PASSWORD = adminBlock.match(/password:\s*(\S+)/i)?.[1];
if (!EMAIL || !PASSWORD) { console.error("FATAL: no admin creds"); process.exit(1); }

const putSettings = (page, body) => page.evaluate(async (b) => {
  const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, data: await r.json().catch(() => null) };
}, body);
const ask = (page, q) => page.evaluate(async (q) => {
  const r = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
  return { status: r.status, data: await r.json().catch(() => ({ error: "non-json" })) };
}, q);

function show(label, q, r) {
  const a = r.data?.answer ?? "";
  const cites = [...a.matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]);
  const insp = r.data?.inspector;
  console.log("\n———— " + label + " ————");
  console.log("Q:", q);
  console.log("status=" + r.status + " mode=" + (r.data?.mode ?? "?") + " backend=" + (insp?.model ?? insp?.backend ?? "?"));
  console.log("ANSWER:", a.slice(0, 380).replace(/\n/g, " "));
  console.log("CITATIONS:", cites.length ? [...new Set(cites)].join(" ") : "(none — uncited, retrieved docs still shown)");
  if (insp) console.log("retrieval=" + insp.retrievalMethod + " evidenceCount=" + insp.evidenceCount + " passages=" + insp.passages);
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.setDefaultTimeout(90000);
  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('[data-testid="auth-submit"]');
    await page.waitForURL("**/dashboard", { timeout: 90000 });
    console.log("✓ signed in");

    console.log("→ flipping deployed app to LOCAL:", LOCAL_ENDPOINT, LOCAL_MODEL);
    const set = await putSettings(page, { model_mode: "local", local_endpoint: LOCAL_ENDPOINT, local_model: LOCAL_MODEL });
    console.log("  settings PUT status=" + set.status);

    // STRUCTURED (text-to-SQL via the local model) + DOCUMENT (RAG retrieval + local gen)
    show("LOCAL · structured (text-to-SQL through the box)", "How many contracts are expiring in the next 90 days?", await ask(page, "How many contracts are expiring in the next 90 days?"));
    show("LOCAL · document (RAG retrieval + local gen)", "What does the case file say about child support for the Carter case?", await ask(page, "What does the case file say about child support for the Carter case?"));
  } catch (e) {
    console.error("VERIFY ERROR:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    // ALWAYS flip back to Cloud (Jenny-safe), even on error.
    try {
      const back = await putSettings(page, { model_mode: "cloud" });
      const check = await page.evaluate(async () => (await (await fetch("/api/settings")).json()).model_mode);
      console.log("\n↩ flipped back: PUT status=" + back.status + " | GET model_mode=" + check);
    } catch (e2) { console.error("WARN: could not confirm flip-back:", e2?.message); }
    await browser.close();
  }
})();
