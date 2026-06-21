// Per-user isolation READ cross-check + Gemini answer-path, on the consolidated
// preview. Deliberate, minimal Gemini queries (the doc lane for uploads = Gemini File
// Search). Flow:
//   1. Sign in as ADMIN (user A), upload a PDF with a UNIQUE fact (ZEPHYR-7741).
//   2. Ask as A about ZEPHYR → A must get the cited answer (proves upload→Gemini→ask).
//   3. Sign in as MEMBER (user B), ask the same → B must get NOTHING of A's content
//      (proves per-user isolation: B never sees A's upload).
import { chromium } from "@playwright/test";

const BASE = process.env.PREVIEW_URL;
const BYPASS = process.env.VERCEL_BYPASS;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL, ADMIN_PW = process.env.ADMIN_PW;
const USER_EMAIL = process.env.USER_EMAIL, USER_PW = process.env.USER_PW;
const PDF = process.env.PDF_PATH;
const CHROME = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const log = (m) => console.log(m);
let ok = true;

async function session(email, pw) {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    extraHTTPHeaders: { "x-vercel-protection-bypass": BYPASS, "x-vercel-set-bypass-cookie": "true" },
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('[data-testid="auth-submit"]');
  await page.waitForURL("**/dashboard", { timeout: 30000 });
  return { ctx, page };
}
async function ask(page, q) {
  return page.evaluate(async (question) => {
    const res = await fetch("/api/ask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, answer: j.answer || j.error || "" };
  }, q);
}

try {
  // 1. ADMIN uploads the unique-fact PDF
  const A = await session(ADMIN_EMAIL, ADMIN_PW);
  log("✓ signed in as ADMIN (user A)");
  const up = await A.page.evaluate(async (dataUrl) => {
    const blob = await (await fetch(dataUrl)).blob();
    const fd = new FormData();
    fd.append("file", new File([blob], "zephyr-secret.pdf", { type: "application/pdf" }));
    const res = await fetch("/api/ingest", { method: "POST", body: fd });
    return { status: res.status, body: (await res.text()).slice(0, 200) };
  }, "data:application/pdf;base64," + (await import("node:fs")).readFileSync(PDF).toString("base64"));
  log(`  upload: [${up.status}] ${up.body.replace(/\n/g, " ")}`);
  if (up.status !== 200) { ok = false; log("  ✗ upload failed"); }

  // give Gemini File Search a moment to index
  await A.page.waitForTimeout(8000);

  // 2. ADMIN asks about the unique fact → must get the cited answer
  const aAns = await ask(A.page, "What is the secret project codename and its budget?");
  const aHas = /ZEPHYR-7741/i.test(aAns.answer) || /88,?888/.test(aAns.answer);
  log(`  A asks ZEPHYR: [${aAns.status}] hasFact=${aHas} | ${aAns.answer.slice(0, 120).replace(/\n/g, " ")}`);
  if (!aHas) { ok = false; log("  ✗ A did NOT get its own uploaded fact (upload→Gemini→ask broken)"); }
  await A.ctx.close();

  // 3. MEMBER asks the same → must get NOTHING of A's content
  const B = await session(USER_EMAIL, USER_PW);
  log("✓ signed in as MEMBER (user B)");
  const bAns = await ask(B.page, "What is the secret project codename and its budget?");
  const bLeak = /ZEPHYR-7741/i.test(bAns.answer) || /88,?888/.test(bAns.answer);
  log(`  B asks ZEPHYR: [${bAns.status}] LEAK=${bLeak} | ${bAns.answer.slice(0, 120).replace(/\n/g, " ")}`);
  if (bLeak) { ok = false; log("  ✗✗ ISOLATION BREACH — B saw A's uploaded content!"); }
  else log("  ✓ isolation holds — B got none of A's content");
  await B.ctx.close();
} catch (e) {
  ok = false;
  log("ERROR: " + (e instanceof Error ? e.message : String(e)));
} finally {
  await browser.close();
}
log("\n===== ISOLATION + GEMINI ANSWER-PATH: " + (ok ? "PASS" : "FAIL") + " =====");
process.exit(ok ? 0 : 1);
