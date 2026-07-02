// Verify the multi-turn chat + resume END-TO-END on the deployed app:
//  1. ask Q1 (mints a session) 2. ask a CONTEXT-DEPENDENT follow-up (must use prior turn)
//  3. session shows all turns in /api/history  4. load the session's ordered turns
//  5. reopen /dashboard?session=<id> and confirm the thread renders the prior turns.
import { chromium } from "playwright-core";
import fs from "node:fs";
const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const sec = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/demo-accounts.txt", "utf8");
const ab = sec.slice(sec.indexOf("ADMIN"));
const EMAIL = ab.match(/email:\s*(\S+)/i)?.[1], PASSWORD = ab.match(/password:\s*(\S+)/i)?.[1];
const askRaw = (p, body) => p.evaluate(async (b) => await (await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json(), body);
const get = (p, u) => p.evaluate(async (u) => await (await fetch(u)).json(), u);
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const p = await (await b.newContext()).newPage(); p.setDefaultTimeout(90000);
  try {
    await p.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await p.fill('input[type="email"]', EMAIL); await p.fill('input[type="password"]', PASSWORD);
    await p.click('[data-testid="auth-submit"]'); await p.waitForURL("**/dashboard", { timeout: 90000 });

    const Q1 = "How many contracts are expiring in the next 90 days?";
    const r1 = await askRaw(p, { question: Q1 });
    const sid = r1.session_id;
    console.log("[1] Q1 asked → session_id minted:", !!sid, "| answer:", (r1.answer || "").slice(0, 90).replace(/\n/g, " "));

    // CONTEXT-DEPENDENT follow-up — meaningless without the prior turn.
    const Q2 = "What did I just ask you about?";
    const r2 = await askRaw(p, { question: Q2, session_id: sid, history: [{ question: Q1, answer: r1.answer }] });
    const a2 = (r2.answer || "").toLowerCase();
    const usedContext = /contract|expir|90 day|next 90/.test(a2);
    console.log("\n[2] CONTEXT follow-up '" + Q2 + "'");
    console.log("    answer:", (r2.answer || "").slice(0, 200).replace(/\n/g, " "));
    console.log("    USED PRIOR CONTEXT (mentions contracts/expiring):", usedContext, "| same session:", r2.session_id === sid);

    // a natural third turn
    await askRaw(p, { question: "Which vendor has the most contracts?", session_id: sid, history: [{ question: Q1, answer: r1.answer }, { question: Q2, answer: r2.answer }] });

    // [3] session appears in history with all turns
    const hist = await get(p, "/api/history");
    const sess = (hist.sessions || []).find((s) => s.session_id === sid);
    console.log("\n[3] /api/history → session present:", !!sess, "| title:", JSON.stringify(sess?.title), "| turn_count:", sess?.turn_count);

    // [4] ordered turns load
    const turns = await get(p, `/api/history/${sid}`);
    console.log("[4] /api/history/<sid> → turns:", (turns.turns || []).length, "| first q:", JSON.stringify((turns.turns || [])[0]?.question));

    // [5] RESUME — reopen the session in the dashboard, confirm the thread renders
    await p.goto(`${BASE}/dashboard?session=${sid}`, { waitUntil: "networkidle" });
    await p.waitForTimeout(2500);
    const bodyText = await p.evaluate(() => document.body.innerText);
    console.log("\n[5] RESUME /dashboard?session=<id> → thread shows Q1:", bodyText.includes("expiring in the next 90 days"), "| shows the follow-up:", /what did i just ask/i.test(bodyText));
  } catch (e) {
    console.error("VERIFY ERROR:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally { await b.close(); }
})();
