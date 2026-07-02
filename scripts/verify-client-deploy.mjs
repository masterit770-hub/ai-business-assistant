// Live post-deploy verification of the `client` branch on the owner's Vercel prod
// (https://nucleus-woad.vercel.app). Signs in as admin via cached chromium-1223 and
// drives the engine through real /api/ask + /api/settings calls IN-PAGE (so the
// session cookie is sent). Covers: (1) default DeepSeek path no-regression, (2) the
// new Cloud-model settings section + write-only key, (3) provider-swap to Gemini +
// reset to DeepSeek default, (4) per-doc EN/HE chips, (5) clean Local-mode guidance.
// NEVER prints the admin password or any provider key.
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const OUT = "/home/codex/Projects/nucleus/screenshots/client";
fs.mkdirSync(OUT, { recursive: true });

// ── Secrets (never logged) ──────────────────────────────────────────────────
const sec = fs.readFileSync(
  "/home/codex/Projects/nucleus/.secrets/demo-accounts.txt",
  "utf8"
);
function adminField(label) {
  const block = sec.slice(sec.indexOf("ADMIN"));
  const m = block.match(new RegExp(`${label}:\\s*(\\S+)`, "i"));
  return m ? m[1] : null;
}
const EMAIL = adminField("email");
const PASSWORD = adminField("password");

const gem = fs.readFileSync("/home/codex/Projects/nucleus/.secrets/gemini.env", "utf8");
const GEMINI_KEY = (gem.match(/GEMINI_API_KEY=(\S+)/) || gem.match(/GOOGLE_API_KEY=(\S+)/) || [])[1];

if (!EMAIL || !PASSWORD) { console.error("FATAL: missing admin creds"); process.exit(1); }
if (!GEMINI_KEY) { console.error("FATAL: missing gemini key"); process.exit(1); }

const log = (...a) => console.log(...a);
const J = (o) => JSON.stringify(o, null, 2);

async function ask(page, question) {
  return page.evaluate(async (q) => {
    const r = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    });
    let data = null;
    try { data = await r.json(); } catch { data = { error: "non-json" }; }
    return { status: r.status, data };
  }, question);
}
async function getSettings(page) {
  return page.evaluate(async () => {
    const r = await fetch("/api/settings");
    let data = null;
    try { data = await r.json(); } catch { data = { error: "non-json" }; }
    return { status: r.status, data, raw: await (await fetch("/api/settings")).text() };
  });
}
async function putSettings(page, body) {
  return page.evaluate(async (b) => {
    const r = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b),
    });
    let data = null;
    try { data = await r.json(); } catch { data = { error: "non-json" }; }
    return { status: r.status, data };
  }, body);
}

const RESULT = {};

(async () => {
  const browser = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);

  try {
    // ── SIGN IN ────────────────────────────────────────────────────────────
    log("→ sign-in");
    await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('[data-testid="auth-submit"]');
    await page.waitForURL("**/dashboard", { timeout: 60000 });
    await page.waitForSelector('[data-testid="assistant-console"]', { timeout: 60000 });
    log("✓ signed in");

    // ── PRE-CHECK: starting settings state (should be cloud + no override) ───
    const s0 = await getSettings(page);
    RESULT.settingsStart = {
      status: s0.status,
      model_mode: s0.data?.model_mode,
      cloud_provider: s0.data?.cloud_provider,
      cloud_api_key_set: s0.data?.cloud_api_key_set,
      local_endpoint: s0.data?.local_endpoint,
      cloud_model: s0.data?.cloud_model,
      hasRawKeyField: Object.prototype.hasOwnProperty.call(s0.data ?? {}, "cloud_api_key"),
    };
    log("SETTINGS(start): " + J(RESULT.settingsStart));

    // ── 1) DEFAULT PATH — alimony (general, must answer, no hedge) ───────────
    log("→ [1a] alimony (default/env path)");
    const q1 = await ask(page,
      "whats the best deal i can ask for michael in order for him to pay less alimony according to the arizona divorce law");
    const a1 = q1.data?.answer ?? "";
    RESULT.alimony = {
      status: q1.status,
      mode: q1.data?.mode,
      provider: q1.data?.inspector?.cost?.provider,
      len: a1.length,
      head: a1.slice(0, 320).replace(/\n/g, " "),
      // hedge = a refusal/can't-answer phrasing; a real general answer should NOT hedge.
      hedged: /i (can't|cannot|am unable|do not have)|no information|unable to (answer|help)/i.test(a1.slice(0, 240)),
    };
    log("[1a] " + J(RESULT.alimony));

    // ── 1b) DEFAULT PATH — contracts (grounded, cited 38 + $18,924,883.79) ───
    log("→ [1b] contracts 90-day (grounded)");
    const q2 = await ask(page, "How many contracts expire in the next 90 days?");
    const a2 = q2.data?.answer ?? "";
    RESULT.contracts = {
      status: q2.status,
      mode: q2.data?.mode,
      provider: q2.data?.inspector?.cost?.provider,
      has38: a2.includes("38"),
      hasTotal: a2.includes("18,924,883.79"),
      hasCite: /\[S:contracts/.test(a2),
      head: a2.slice(0, 320).replace(/\n/g, " "),
    };
    log("[1b] " + J(RESULT.contracts));

    // ── 2) CLOUD-MODEL SETTINGS SECTION (screenshot + write-only key) ────────
    log("→ [2] settings → Model & Prompts → Cloud model section");
    await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
    // Open the "Model & Prompts" tab (SimpleTabs renders plain <button> with the
    // label as text — the default tab is "Users", so we must click to mount PromptsPanel).
    const modelTab = page.getByRole("button", { name: /Model & Prompts/i }).first();
    await modelTab.waitFor({ timeout: 30000 });
    await modelTab.click();
    await page.waitForTimeout(500);
    await page.waitForSelector('[data-testid="cloud-model-section"]', { timeout: 30000 });
    // The panel runs an async settings fetch that sets cloud_provider — wait for it to
    // settle, else our selectOption gets overwritten by the late load.
    await page.waitForTimeout(2500);
    // Reveal the Azure conditional fields by selecting Azure in the dropdown (so the
    // screenshot shows provider dropdown + write-only key + Azure conditional fields).
    await page.selectOption('[data-testid="cloud-provider-select"]', "azure");
    await page.waitForTimeout(600);
    const azureVisible = await page.locator('[data-testid="azure-fields"]').count();
    const keyInputType = await page.getAttribute('[data-testid="cloud-api-key-input"]', "type");
    // Scroll the section into view and screenshot just that card.
    const sectionEl = page.locator('[data-testid="cloud-model-section"]');
    await sectionEl.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await sectionEl.screenshot({ path: `${OUT}/LIVE-cloud-provider-settings.png` });
    log(`✓ screenshot ${OUT}/LIVE-cloud-provider-settings.png`);
    // Reset the dropdown back to "" so we don't leave a half-filled azure provider.
    await page.selectOption('[data-testid="cloud-provider-select"]', "");
    await page.waitForTimeout(200);
    // Confirm GET /api/settings exposes cloud_api_key_set (boolean) and NOT the raw key.
    const s2 = await getSettings(page);
    RESULT.cloudSection = {
      sectionRendered: true,
      azureFieldsRevealedWhenAzure: azureVisible > 0,
      keyInputType, // expect "password"
      cloud_api_key_set_isBoolean: typeof s2.data?.cloud_api_key_set === "boolean",
      cloud_api_key_set_value: s2.data?.cloud_api_key_set,
      rawKeyLeaked: Object.prototype.hasOwnProperty.call(s2.data ?? {}, "cloud_api_key")
        || /"cloud_api_key"\s*:/.test(s2.raw ?? ""),
    };
    log("[2] " + J(RESULT.cloudSection));

    // ── 3) PROVIDER-SWAP → GEMINI (end-to-end), then RESET → deepseek ────────
    log("→ [3] PUT provider=gemini + key + gemini-2.5-flash");
    const put = await putSettings(page, {
      cloud_provider: "gemini",
      cloud_api_key: GEMINI_KEY,
      cloud_model: "gemini-2.5-flash",
    });
    RESULT.swapPut = {
      status: put.status,
      cloud_provider: put.data?.cloud_provider,
      cloud_model: put.data?.cloud_model,
      cloud_api_key_set: put.data?.cloud_api_key_set,
    };
    log("[3] PUT result: " + J(RESULT.swapPut));

    log("→ [3] ask a simple question on the gemini override");
    const qg = await ask(page, "What is 2 plus 2?");
    const ag = qg.data?.answer ?? "";
    const gProvider = qg.data?.inspector?.cost?.provider;
    RESULT.swapAsk = {
      status: qg.status,
      mode: qg.data?.mode,
      provider: gProvider,
      routedToGemini: (gProvider ?? "").toLowerCase().includes("gemini"),
      errored: qg.status !== 200 || !!qg.data?.error,
      // A 429 means the swap REACHED gemini (free-tier throttle) — still proves routing.
      errorHead: (qg.data?.error ?? "").slice(0, 200),
      answerHead: ag.slice(0, 160).replace(/\n/g, " "),
    };
    log("[3] ASK(gemini): " + J(RESULT.swapAsk));

    // RESET — clear provider override so demo returns to env DeepSeek default.
    log("→ [3] RESET: clear cloud_provider + cloud_api_key (__clear__)");
    const reset = await putSettings(page, {
      cloud_provider: "",
      cloud_api_key: "__clear__",
    });
    RESULT.reset = {
      status: reset.status,
      cloud_provider: reset.data?.cloud_provider,
      cloud_api_key_set: reset.data?.cloud_api_key_set,
    };
    log("[3] RESET result: " + J(RESULT.reset));

    log("→ [3] follow-up ask should be back on deepseek default");
    const qd = await ask(page, "What is 3 plus 4?");
    RESULT.backOnDefault = {
      status: qd.status,
      mode: qd.data?.mode,
      provider: qd.data?.inspector?.cost?.provider,
      isDeepseek: (qd.data?.inspector?.cost?.provider ?? "").toLowerCase().includes("deepseek"),
    };
    log("[3] ASK(after reset): " + J(RESULT.backOnDefault));

    // ── 4) PER-DOC EN/HE CHIPS on dashboard materials ───────────────────────
    log("→ [4] dashboard materials lang chips");
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="materials-rail"]', { timeout: 30000 });
    await page.waitForTimeout(1200); // let bundled docs load
    const enCount = await page.locator('[data-testid="doc-lang-en"]').count();
    const heCount = await page.locator('[data-testid="doc-lang-he"]').count();
    RESULT.langChips = { enCount, heCount, hasEN: enCount > 0, hasHE: heCount > 0 };
    log("[4] " + J(RESULT.langChips));
    const rail = page.locator('[data-testid="materials-rail"]');
    await rail.scrollIntoViewIfNeeded();
    await rail.screenshot({ path: `${OUT}/LIVE-materials-lang.png` });
    log(`✓ screenshot ${OUT}/LIVE-materials-lang.png`);

    // ── 5) LOCAL MODE = CLEAN GUIDANCE (not a timeout) ──────────────────────
    log("→ [5] flip to Local, ask, expect friendly guidance");
    const toLocal = await putSettings(page, { model_mode: "local" });
    RESULT.localFlip = { status: toLocal.status, model_mode: toLocal.data?.model_mode, local_endpoint: toLocal.data?.local_endpoint };
    log("[5] flipped: " + J(RESULT.localFlip));
    const ql = await ask(page, "Give me a quick hello.");
    const al = ql.data?.answer ?? "";
    RESULT.localGuidance = {
      status: ql.status,
      localGuidance: ql.data?.localGuidance,
      mode: ql.data?.mode,
      // clean guidance = a 200 with a localGuidance marker / setup copy, NOT a 500/timeout
      isCleanGuidance: ql.status === 200 && (!!ql.data?.localGuidance || /set up|local model|set your|configure/i.test(al)),
      answerHead: al.slice(0, 200).replace(/\n/g, " "),
      error: (ql.data?.error ?? "").slice(0, 160),
    };
    log("[5] " + J(RESULT.localGuidance));

    // Reset back to cloud (demo must end on cloud/deepseek default).
    const toCloud = await putSettings(page, { model_mode: "cloud" });
    RESULT.localReset = { status: toCloud.status, model_mode: toCloud.data?.model_mode };
    log("[5] reset to cloud: " + J(RESULT.localReset));

    // ── FINAL STATE SNAPSHOT ─────────────────────────────────────────────────
    const sf = await getSettings(page);
    RESULT.settingsFinal = {
      model_mode: sf.data?.model_mode,
      cloud_provider: sf.data?.cloud_provider,
      cloud_api_key_set: sf.data?.cloud_api_key_set,
      local_endpoint: sf.data?.local_endpoint,
    };
    log("SETTINGS(final): " + J(RESULT.settingsFinal));

    log("\n===== RESULT JSON =====");
    log(J(RESULT));
    await browser.close();
  } catch (e) {
    log("FATAL during verification: " + (e?.message || e));
    log("\n===== PARTIAL RESULT =====");
    log(J(RESULT));
    try { await page.screenshot({ path: `${OUT}/LIVE-verify-error.png` }); } catch {}
    await browser.close();
    process.exit(2);
  }
})();
