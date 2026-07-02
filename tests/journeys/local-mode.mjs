// JOURNEY — LOCAL (Ollama) MODE v0.5 (chat-only).
//
// Proves the REAL user-observable behavior of Local mode end-to-end through a live
// browser + the box Ollama (ZERO Claude/Anthropic cost — every ask here hits the
// user's own local model):
//   1. In Settings → Model the user selects Local, enters their endpoint + model, and
//      Saves through the REAL UI.
//   2. Test connection succeeds against the live Ollama endpoint.
//   3. A chat message genuinely round-trips through Ollama and the reply renders
//      (assert the rendered answer + that the response JSON `model` starts with "local:").
//   4. HONESTY: asking about "my uploaded documents" does NOT fabricate document
//      content — grounded===false, no citation chips render, and the reply says it
//      can't read documents in Local mode.
// Then it RESTORES model_mode=cloud through the UI so no residue is left.
//
// GATED: this journey drives the box Ollama, so it only runs when NUCLEUS_RUN_LOCAL_MODE=1
// AND against a LOCAL dev server (NUCLEUS_BASE=http://localhost:3000) — a hosted deploy
// can't reach localhost:11434. Otherwise it SKIPS loudly (skip-not-pass), like the other
// gated journeys. PURITY: every state MUTATION goes through the real UI; fetch() is used
// only for read-only response/JSON assertions.
import { launch, signIn, makeRecorder, BASE } from "./lib.mjs";

const RUN = process.env.NUCLEUS_RUN_LOCAL_MODE === "1";
const LOCAL_ENDPOINT = process.env.NUCLEUS_LOCAL_ENDPOINT || "http://localhost:11434/v1";
const LOCAL_MODEL = process.env.NUCLEUS_LOCAL_MODEL || "llama3.2:3b";
const IS_LOCAL_BASE = /localhost|127\.0\.0\.1/.test(BASE);

export async function run() {
  const rec = makeRecorder("LOCAL MODE v0.5 (chat-only)");

  if (!RUN) {
    rec.info("LOCAL MODE: SKIPPED — set NUCLEUS_RUN_LOCAL_MODE=1 to run (drives the box Ollama; skip-not-pass, not a false green)");
    return rec.summary();
  }
  if (!IS_LOCAL_BASE) {
    rec.info(`LOCAL MODE: SKIPPED — needs a LOCAL dev server (NUCLEUS_BASE=http://localhost:3000); a hosted deploy can't reach ${LOCAL_ENDPOINT}. skip-not-pass.`);
    return rec.summary();
  }

  const browser = await launch();
  const { ctx, page } = await signIn(browser, "admin", "/settings?tab=models");
  try {
    // 1) Configure Local through the REAL Settings → Model UI.
    //    Wait for HYDRATION, not just visibility: the panel's async settings GET resets
    //    every field when it lands, so pre-hydration fills are clobbered and Save stays
    //    disabled (dirty=false) — the exact race that failed this journey's first run.
    await page.locator('[data-testid="model-section"][data-hydrated="1"]').waitFor({ state: "visible", timeout: 20000 });
    await page.click('[data-testid="model-section-local"]');
    await page.fill('[data-testid="local-endpoint-input"]', LOCAL_ENDPOINT);
    await page.fill('[data-testid="local-model-input"]', LOCAL_MODEL);
    await page.click('[data-testid="model-save"]');
    await page.locator('[data-testid="model-saved"]').waitFor({ state: "visible", timeout: 15000 });
    // Confirm the mode actually persisted as local (read-only probe).
    const saved = await page.evaluate(async () => {
      const r = await fetch("/api/settings");
      return r.json();
    });
    rec.check(saved.model_mode === "local" && (saved.local_endpoint || "").includes("11434"),
      "Local mode saved through the UI (model_mode=local, endpoint persisted)",
      `mode=${saved.model_mode} endpoint=${saved.local_endpoint} model=${saved.local_model}`);

    // 2) Test connection against the live Ollama endpoint (a tiny real local call — free).
    // There is no Local-specific test button in the panel; the /api/test-connection route
    // tests the backend AS SAVED (now Local), so we probe it read-only.
    const conn = await page.evaluate(async () => {
      // purity-exempt: read-only connectivity probe — persists NO product state (the route
      // only reads the saved config + makes one tiny local model call). The mode was already
      // SAVED through the real UI above; the panel has no Local-specific Test button to click.
      const r = await fetch("/api/test-connection", { method: "POST" });
      return r.json();
    });
    rec.check(conn.ok === true && conn.mode === "local",
      "Test connection succeeds against the live local endpoint",
      `ok=${conn.ok} mode=${conn.mode} provider=${conn.provider} model=${conn.model}`);

    // 3) A chat message round-trips through Ollama and renders. Capture the /api/ask JSON
    // via a response listener so we can assert model starts with "local:" + grounded state.
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="assistant-console"]').waitFor({ state: "visible", timeout: 20000 });
    await page.click('[data-testid="new-chat"]');

    const askPromise = page.waitForResponse(
      (res) => res.url().includes("/api/ask") && res.request().method() === "POST",
      { timeout: 120000 }
    );
    const before = await page.locator('[data-testid="chat-turn"]').count();
    await page.fill('[data-testid="assistant-console"] textarea', "Reply with exactly: LOCAL-JOURNEY-OK");
    await page.click('[data-testid="send-ask"]');
    const askRes = await askPromise;
    const askJson = await askRes.json().catch(() => ({}));
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="chat-turn"]').length > n, before, { timeout: 120000 });

    const answerText = (await page.locator('[data-testid="answer"]').last().textContent().catch(() => "")) || "";
    rec.check(/LOCAL-JOURNEY-OK/.test(answerText),
      "chat message genuinely round-trips through Ollama and renders the reply",
      `answer="${answerText.trim().slice(0, 120)}"`);
    rec.check(typeof askJson.model === "string" && askJson.model.startsWith("local:"),
      "the answer was produced by the LOCAL model (response JSON model starts with 'local:')",
      `model=${askJson.model} lane=${askJson?._engine?.lane}`);

    // 4) HONESTY guardrail: ask about documents → NO fabricated document content.
    const docAskPromise = page.waitForResponse(
      (res) => res.url().includes("/api/ask") && res.request().method() === "POST",
      { timeout: 120000 }
    );
    const before2 = await page.locator('[data-testid="chat-turn"]').count();
    await page.fill('[data-testid="assistant-console"] textarea', "What do my uploaded documents say?");
    await page.click('[data-testid="send-ask"]');
    const docRes = await docAskPromise;
    const docJson = await docRes.json().catch(() => ({}));
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="chat-turn"]').length > n, before2, { timeout: 120000 });

    rec.check(docJson.grounded === false,
      "documents question is NOT grounded in Local mode (grounded===false)",
      `grounded=${docJson.grounded} model=${docJson.model}`);
    const chipCount = await page.locator('[data-testid="citation-chip"]').count();
    rec.check(chipCount === 0,
      "no citation chips render for a Local-mode documents question (no fabricated sources)",
      `chips=${chipCount}`);
    const docAnswer = (await page.locator('[data-testid="answer"]').last().textContent().catch(() => "")) || "";
    // The reply should acknowledge it cannot read documents in Local mode — a general,
    // content-level assertion (not a fabricated summary of file contents).
    rec.check(/can'?t|cannot|not able|unable|no access|local mode/i.test(docAnswer) && /document|file|upload/i.test(docAnswer),
      "the reply says it cannot read documents in Local mode (no fabricated content)",
      `answer="${docAnswer.trim().slice(0, 160)}"`);

  } catch (e) {
    rec.check(false, "local-mode journey completed without an unhandled error", (e.message || String(e)).slice(0, 200));
  } finally {
    // RESTORE model_mode=cloud through the REAL UI (leave no residue).
    try {
      await page.goto(`${BASE}/settings?tab=models`, { waitUntil: "domcontentloaded" });
      // Same hydration wait as the setup step: pre-hydration clicks are clobbered.
      await page.locator('[data-testid="model-section"][data-hydrated="1"]').waitFor({ state: "visible", timeout: 15000 });
      await page.click('[data-testid="model-section-cloud"]');
      await page.click('[data-testid="model-save"]');
      await page.locator('[data-testid="model-saved"]').waitFor({ state: "visible", timeout: 15000 });
      const restored = await page.evaluate(async () => (await fetch("/api/settings")).json());
      rec.check(restored.model_mode === "cloud",
        "RESTORE: model_mode returned to cloud through the UI (no residue)",
        `mode=${restored.model_mode}`);
    } catch (e) {
      rec.check(false, "RESTORE: model_mode returned to cloud", (e.message || String(e)).slice(0, 160));
    }
    await ctx.close().catch(() => {});
    await browser.close();
  }
  return rec.summary();
}
