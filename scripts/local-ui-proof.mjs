// One-shot live UI proof for Local mode. Drives the REAL deployed UI at
// nucleus-woad.vercel.app: sign in as admin -> Settings -> set Local + endpoint
// + model -> save -> confirm GET /api/settings persisted -> flip the big switch
// to Local in the Ask UI -> ask the question -> wait up to 50s -> screenshot the
// rendered answer. Then a direct in-page /api/ask fetch as a second confirmation.
import { chromium } from "playwright-core";

const BASE = "https://nucleus-woad.vercel.app";
const EXE = process.env.CHROME_EXE;
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD; // never logged
const TUNNEL = process.env.TUNNEL_URL; // e.g. https://xxx.trycloudflare.com
const ENDPOINT = `${TUNNEL}/v1`;
const MODEL = "qwen2.5:7b";
const QUESTION =
  "In one sentence, what does Arizona community property law say about dividing marital assets?";
const SHOT = "/home/codex/Projects/nucleus/screenshots/client/LIVE-local-UI-answer.png";

const log = (...a) => console.log(`[proof ${new Date().toISOString().slice(11, 19)}]`, ...a);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
page.setDefaultTimeout(120000);

try {
  // ── sign in ────────────────────────────────────────────────────────────────
  log("navigating to /sign-in");
  await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('[data-testid="auth-submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/sign-in"), { timeout: 30000 });
  log("signed in, now at", new URL(page.url()).pathname);

  // confirm admin via /api/me
  const me = await page.evaluate(async () => (await fetch("/api/me")).json());
  log("role:", me?.user?.role);
  if (me?.user?.role !== "admin") throw new Error("not signed in as admin");

  // ── Settings -> Model: set Local + endpoint + model, save ───────────────────
  log("navigating to /settings?tab=prompts");
  await page.goto(`${BASE}/settings?tab=prompts`, { waitUntil: "networkidle" });
  await page.locator('[data-testid="model-section"]').waitFor({ state: "visible" });
  await page.locator('[data-testid="model-section-local"]').click();
  await page.locator('[data-testid="local-endpoint-input"]').fill(ENDPOINT);
  await page.locator('[data-testid="local-model-input"]').fill(MODEL);
  const saveBtn = page.locator('[data-testid="prompts-save"]');
  // The form only enables Save when something CHANGED. If Local + this exact
  // endpoint/model is already persisted, Save stays disabled — which is itself a
  // confirmation that the settings held. So: click if enabled, else verify the
  // already-persisted state directly.
  const enabled = await saveBtn.isEnabled();
  if (enabled) {
    log("settings changed; clicking Save");
    await saveBtn.click();
    await page.locator('[data-testid="prompts-saved"]').waitFor({ state: "visible", timeout: 30000 });
    log("Save confirmed (Saved — live now)");
  } else {
    log("Save disabled (no diff) — Local + endpoint/model already persisted; not re-saving");
  }

  // ── confirm a FRESH GET /api/settings shows mode=local persisted ────────────
  const s1 = await page.evaluate(async () => (await fetch("/api/settings")).json());
  log("GET /api/settings after save:", JSON.stringify({
    model_mode: s1.model_mode,
    local_endpoint: s1.local_endpoint,
    local_model: s1.local_model,
  }));
  if (s1.model_mode !== "local") throw new Error("model_mode did not persist as local");

  // ── Ask UI: flip the big switch to Local, ask the question through the UI ────
  log("navigating to /dashboard for the Ask panel");
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
  // the big switch in the ask panel
  const askSwitch = page.locator('[data-testid="ask-model-switch"] [data-testid="model-switch-local"]');
  await askSwitch.waitFor({ state: "visible", timeout: 30000 });
  await askSwitch.click();
  // wait until the switch group reports mode=local
  await page.locator('[data-testid="ask-model-switch"] [data-testid="model-switch"][data-mode="local"]')
    .waitFor({ state: "visible", timeout: 15000 });
  log("big switch flipped to Local in the Ask UI");

  // type the question into the REAL Ask box (a textarea) and submit via the
  // send button (plain Enter inserts a newline; submit is the button / Ctrl+Enter)
  const input = page.locator('textarea[aria-label="Ask a question"]');
  await input.waitFor({ state: "visible", timeout: 30000 });
  await input.fill(QUESTION);
  const t0 = Date.now();
  log("submitting the question through the real UI (send button)");
  await page.locator('button[type="submit"]:near(textarea[aria-label="Ask a question"])').first().click();

  // wait for the rendered answer (or the guidance note). A general-knowledge
  // question in Local mode makes TWO sequential local calls (router classify +
  // answer generation) on a contended CPU box reached over a tunnel, so allow up
  // to ~110s — still under the /api/ask function's 120s maxDuration.
  const answer = page.locator('[data-testid="answer"]');
  await answer.waitFor({ state: "visible", timeout: 110000 });
  // let any streaming/settle finish a beat
  await page.waitForTimeout(800);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const answerText = (await answer.innerText()).trim();
  const hasGuidanceNote = await page.locator('[data-testid="local-guidance-note"]').count();
  const hasGeneralNote = await page.locator('[data-testid="general-note"]').count();
  const errBox = await page.locator('[data-testid="ask-result"] .text-red-700').count();

  log(`UI answer rendered in ${elapsed}s`);
  log("local-guidance-note present:", hasGuidanceNote > 0);
  log("general-note present:", hasGeneralNote > 0);
  log("error box present:", errBox > 0);
  log("--- RENDERED ANSWER (UI) START ---");
  console.log(answerText);
  log("--- RENDERED ANSWER (UI) END ---");

  await page.screenshot({ path: SHOT, fullPage: false });
  log("screenshot saved:", SHOT);

  // ── second confirmation: direct in-page /api/ask fetch ──────────────────────
  log("direct in-page /api/ask fetch (second confirmation)");
  const apiT0 = Date.now();
  const apiRes = await page.evaluate(async (q) => {
    const r = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    });
    return { status: r.status, body: await r.json() };
  }, QUESTION);
  const apiElapsed = ((Date.now() - apiT0) / 1000).toFixed(1);
  log(`/api/ask status ${apiRes.status} in ${apiElapsed}s`);
  log("/api/ask mode:", apiRes.body?.mode, "grounded:", apiRes.body?.grounded,
    "localGuidance:", apiRes.body?.localGuidance ?? "(none)");
  log("--- /api/ask ANSWER START ---");
  console.log((apiRes.body?.answer ?? "(no answer field)").trim());
  log("--- /api/ask ANSWER END ---");

  // ── machine-readable summary line ───────────────────────────────────────────
  const summary = {
    ui_answer_chars: answerText.length,
    ui_elapsed_s: elapsed,
    ui_is_guidance: hasGuidanceNote > 0,
    ui_is_general: hasGeneralNote > 0,
    ui_has_citation: /\[(S|P):/.test(answerText),
    api_status: apiRes.status,
    api_mode: apiRes.body?.mode,
    api_localGuidance: apiRes.body?.localGuidance ?? null,
    api_has_citation: /\[(S|P):/.test(apiRes.body?.answer ?? ""),
    api_elapsed_s: apiElapsed,
  };
  console.log("SUMMARY_JSON=" + JSON.stringify(summary));
} catch (e) {
  log("ERROR:", e?.message ?? e);
  try { await page.screenshot({ path: SHOT.replace(".png", "-ERROR.png"), fullPage: false }); } catch {}
  process.exitCode = 1;
} finally {
  await browser.close();
}
