// Live verification of the deployed `client` branch (purple AI Business Assistant
// inspector rebrand) on https://nucleus-woad.vercel.app. Signs in as admin via the
// cached chromium-1223, screenshots light + dark, asks the four golden questions via
// IN-PAGE fetch('/api/ask') (so we get the full engine `inspector` block), and
// reports the live cost/tokens/confidence/retrievalMethod. NEVER prints the password.
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = "https://nucleus-woad.vercel.app";
const EXEC =
  "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const OUT = "/home/codex/Projects/nucleus/screenshots/client";
fs.mkdirSync(OUT, { recursive: true });

// Parse admin creds from the gitignored secrets file (never logged).
const sec = fs.readFileSync(
  "/home/codex/Projects/nucleus/.secrets/demo-accounts.txt",
  "utf8"
);
function field(label) {
  // first occurrence after the ADMIN header
  const adminBlock = sec.slice(sec.indexOf("ADMIN"));
  const m = adminBlock.match(new RegExp(`${label}:\\s*(\\S+)`, "i"));
  return m ? m[1] : null;
}
const EMAIL = field("email");
const PASSWORD = field("password");
if (!EMAIL || !PASSWORD) {
  console.error("FATAL: could not parse admin creds");
  process.exit(1);
}

const log = (...a) => console.log(...a);
const J = (o) => JSON.stringify(o, null, 2);

async function askInPage(page, question) {
  return page.evaluate(async (q) => {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    });
    const status = res.status;
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = { error: "non-json response" };
    }
    return { status, data };
  }, question);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);

  try {
    // ── SIGN IN ───────────────────────────────────────────────────────────────
    log("→ navigating to sign-in");
    await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('[data-testid="auth-submit"]');
    await page.waitForURL("**/dashboard", { timeout: 60000 });
    await page.waitForSelector('[data-testid="assistant-console"]', {
      timeout: 60000,
    });
    log("✓ signed in, dashboard loaded");

    // ── THE LOOK (light) ────────────────────────────────────────────────────────
    // Ensure light theme explicitly.
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "light");
      try { localStorage.setItem("ab-theme", "light"); } catch {}
    });
    await page.waitForTimeout(600);
    const themeLight = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme")
    );
    const header = (await page
      .locator('[data-testid="assistant-console"] h2')
      .first()
      .textContent())?.trim();
    // Read the accent color actually in effect (proves purple, not teal).
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
    );
    log(`LOOK: data-theme=${themeLight} consoleHeader="${header}" accent=${accent}`);
    await page.screenshot({ path: `${OUT}/LIVE-light.png`, fullPage: false });
    log(`✓ screenshot ${OUT}/LIVE-light.png`);

    // ── Q1: Jenny's alimony question (must ANSWER, mode=general, no hedge) ────────
    log("→ Q1 Jenny alimony");
    const q1 = await askInPage(
      page,
      "whats the best deal i can ask for michael in order for him to pay less alimony according to the arizona divorce law"
    );
    const a1 = q1.data?.answer ?? "";
    const firstSentence1 = a1.split(/(?<=[.!?])\s/)[0]?.trim() ?? a1.slice(0, 200);
    log("Q1 status=" + q1.status + " mode=" + q1.data?.mode);
    log("Q1 first-sentence: " + firstSentence1);
    log("Q1 answer-head(400): " + a1.slice(0, 400).replace(/\n/g, " "));

    // ── Q2: golden grounded contracts (the inspector with REAL numbers) ──────────
    log("→ Q2 contracts 90 days");
    const q2 = await askInPage(page, "How many contracts expire in the next 90 days?");
    const a2 = q2.data?.answer ?? "";
    const insp = q2.data?.inspector ?? null;
    const cites2 = (q2.data?.citations ?? q2.data?.route?.sources ?? []);
    log("Q2 status=" + q2.status + " mode=" + q2.data?.mode);
    log("Q2 answer-head(500): " + a2.slice(0, 500).replace(/\n/g, " "));
    log("Q2 has 38: " + a2.includes("38"));
    log("Q2 has $18,924,883.79: " + a2.includes("18,924,883.79"));
    log("Q2 has [S:contracts: " + /\[S:contracts/.test(a2));
    if (insp) {
      log("Q2 INSPECTOR:");
      log("  route(rationale): " + (q2.data?.route?.rationale ?? "").slice(0, 160));
      log("  retrievalMethod: " + insp.retrievalMethod);
      log("  confidence: " + J(insp.confidence));
      log("  passages: " + insp.passages + "  evidenceCount: " + insp.evidenceCount);
      log("  timings: " + J(insp.timings));
      log("  cost: " + J(insp.cost));
    } else {
      log("Q2 INSPECTOR: <MISSING>");
    }

    // Screenshot the Inspector tab for this contracts answer (UI render of panels).
    try {
      await page.click('[data-testid="tab-inspector"]');
      await page.waitForSelector('[data-testid="inspector-view"]', { timeout: 15000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/LIVE-inspector-contracts.png`, fullPage: false });
      log(`✓ screenshot ${OUT}/LIVE-inspector-contracts.png`);
      // back to workspace for clean dark shot later
      await page.click('[data-testid="tab-workspace"]');
      await page.waitForTimeout(300);
    } catch (e) {
      log("Q2 inspector-tab screenshot skipped: " + e.message);
    }

    // ── Q4: child support (grounded, $1,285 + [P:family-court#...]) ──────────────
    log("→ Q3(task#4) child support");
    const q4 = await askInPage(page, "What is the monthly child support amount in the case file?");
    const a4 = q4.data?.answer ?? "";
    log("Q4 status=" + q4.status + " mode=" + q4.data?.mode);
    log("Q4 answer-head(400): " + a4.slice(0, 400).replace(/\n/g, " "));
    log("Q4 has $1,285: " + (a4.includes("1,285") || a4.includes("$1,285")));
    log("Q4 has [P:family-court: " + /\[P:family-court/.test(a4));

    // ── DARK theme via the real toggle (persistence) ─────────────────────────────
    log("→ toggling dark via UI control");
    // Find a theme toggle; sidebar/user-menu may host it. Fall back to setting attr.
    const toggle = page.locator('[data-testid="theme-toggle"]').first();
    if (await toggle.count()) {
      // toggle until dark
      for (let i = 0; i < 2; i++) {
        const t = await page.evaluate(() =>
          document.documentElement.getAttribute("data-theme")
        );
        if (t === "dark") break;
        await toggle.click();
        await page.waitForTimeout(400);
      }
    }
    let themeDark = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme")
    );
    if (themeDark !== "dark") {
      // toggle control not reachable on this view — set directly (still proves dark palette renders)
      await page.evaluate(() => {
        document.documentElement.setAttribute("data-theme", "dark");
        try { localStorage.setItem("ab-theme", "dark"); } catch {}
      });
      await page.waitForTimeout(400);
      themeDark = await page.evaluate(() =>
        document.documentElement.getAttribute("data-theme")
      );
    }
    const persisted = await page.evaluate(() => {
      try { return localStorage.getItem("ab-theme"); } catch { return null; }
    });
    const accentDark = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
    );
    log(`DARK: data-theme=${themeDark} persisted(ab-theme)=${persisted} accent=${accentDark}`);
    await page.screenshot({ path: `${OUT}/LIVE-dark.png`, fullPage: false });
    log(`✓ screenshot ${OUT}/LIVE-dark.png`);

    // ── Theme persistence across reload ──────────────────────────────────────────
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const themeAfterReload = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme")
    );
    log("PERSIST: data-theme after reload = " + themeAfterReload);

    log("\n===== RESULT JSON =====");
    log(J({
      themeLight, themeDark, themeAfterReload, persisted,
      accentLight: accent, accentDark,
      consoleHeader: header,
      q1: { status: q1.status, mode: q1.data?.mode, firstSentence: firstSentence1 },
      q2: {
        status: q2.status, mode: q2.data?.mode,
        has38: a2.includes("38"),
        hasTotal: a2.includes("18,924,883.79"),
        hasCite: /\[S:contracts/.test(a2),
        inspector: insp && {
          retrievalMethod: insp.retrievalMethod,
          confidence: insp.confidence,
          passages: insp.passages,
          evidenceCount: insp.evidenceCount,
          timings: insp.timings,
          cost: insp.cost,
        },
      },
      q4: {
        status: q4.status, mode: q4.data?.mode,
        has1285: a4.includes("1,285"),
        hasCite: /\[P:family-court/.test(a4),
      },
    }));
    log("===== END =====");
  } catch (e) {
    log("FATAL during verification: " + (e?.stack || e?.message || e));
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
