// Actually exercise the GEMINI upload-RAG lane: upload a unique PDF, then ask about
// its content. Proves Gemini File Search works (or shows the quota 429). Cleans up.
import { chromium } from "playwright-core";
import fs from "node:fs";
const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const sec = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/demo-accounts.txt", "utf8");
const ab = sec.slice(sec.indexOf("ADMIN"));
const EMAIL = ab.match(/email:\s*(\S+)/i)?.[1], PASSWORD = ab.match(/password:\s*(\S+)/i)?.[1];
const get = (p, u) => p.evaluate(async (u) => { const r = await fetch(u); return { status: r.status, data: await r.json().catch(() => null) }; }, u);
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const p = await (await b.newContext()).newPage(); p.setDefaultTimeout(120000);
  let docId = null;
  try {
    await p.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await p.fill('input[type="email"]', EMAIL); await p.fill('input[type="password"]', PASSWORD);
    await p.click('[data-testid="auth-submit"]'); await p.waitForURL("**/dashboard", { timeout: 90000 });

    // baseline docs
    const before = (await get(p, "/api/documents")).data;
    const beforeIds = new Set((before?.docs ?? before?.uploaded ?? before?.items ?? []).map?.((d) => d.doc ?? d.id) ?? []);

    // upload the PDF via the hidden file input
    await p.setInputFiles('input[type="file"]', "/tmp/bluefalcon.pdf");
    console.log("→ uploaded bluefalcon.pdf; waiting for Gemini ingest…");

    // poll /api/documents until a NEW doc shows up (Gemini ingest can take a while)
    let newDoc = null;
    for (let i = 0; i < 30; i++) {
      await p.waitForTimeout(4000);
      const now = (await get(p, "/api/documents")).data;
      const list = now?.docs ?? now?.uploaded ?? now?.items ?? [];
      newDoc = list.find?.((d) => !beforeIds.has(d.doc ?? d.id) && /bluefalcon/i.test(JSON.stringify(d)));
      if (newDoc) break;
    }
    docId = newDoc ? (newDoc.doc ?? newDoc.id) : null;
    console.log("ingested doc:", JSON.stringify(newDoc)?.slice(0, 160) || "(NOT FOUND — ingest may have failed/quota)");

    // ask about the UNIQUE content (only answerable from the uploaded doc via Gemini)
    const r = await p.evaluate(async () => await (await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "According to the uploaded internal memo, what is the classified project codename, the approved budget, and the project lead?" }) })).json());
    const a = r.answer ?? "";
    console.log("\nANSWER:", a.slice(0, 300).replace(/\n/g, " "));
    console.log("retrieval:", r.inspector?.retrievalMethod ?? r.mode);
    console.log("cites:", [...a.matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]).join(" ") || "(none)");
    console.log("GEMINI RAG WORKS:", /bluefalcon/i.test(a) && /42,?000/.test(a), "| names Dana:", /dana|whitfield/i.test(a));
  } catch (e) { console.error("ERROR:", e instanceof Error ? e.message : e); process.exitCode = 1; }
  finally {
    if (docId) { try { await p.evaluate(async (id) => fetch(`/api/documents?doc=${id}`, { method: "DELETE" }), docId); console.log("\n↩ cleaned up uploaded test doc"); } catch {} }
    await b.close();
  }
})();
