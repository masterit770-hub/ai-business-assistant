// JOURNEY 9 — MODEL MODES + JOURNEY 10 — ERRORS (combined: both exercise the model switch).
// Cloud answers; HIPAA (no key) returns FRIENDLY guidance, not a raw error; a cloud
// provider with no key fails closed with a friendly message (not a silent DeepSeek answer);
// and NO raw provider blob / "Unexpected token <" ever reaches the user.
//
// STATE SAFETY: this journey changes server-side admin settings (model_mode, cloud_provider,
// cloud_api_key). It ALWAYS restores model_mode=cloud, cloud_provider="", and clears the
// cloud key (sentinel "__clear__") in a finally block via the authenticated /api/settings PUT.
import { launch, signIn, makeRecorder, askAndWait } from "./lib.mjs";

// A raw provider/HTML blob that must NEVER be shown to the user.
// A RAW provider/HTML blob leaking to the user. Deliberately precise so a FRIENDLY
// message that legitimately mentions "API key" (the keyless-provider guidance) is NOT
// flagged. Real leaks: the "<provider> (<model>) <status>: <body>" throw format, an HTML
// gateway page, a bearer token, or a raw sk- secret.
const RAW_BLOB_RE = /unexpected token\s*<|<!doctype|<html|\b(deepseek|gemini|openai|azure-hipaa|azure)\s*\([^)]*\)\s*\d{3}\s*:|bearer\s+[a-z0-9._-]{12,}|\bsk-[a-z0-9]{16,}/i;

async function setSettings(page, body) {
  return page.evaluate(async (b) => {
    const r = await fetch("/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, body);
}

export async function run() {
  const rec = makeRecorder("MODEL MODES + ERRORS");
  const browser = await launch();
  const { ctx, page } = await signIn(browser, "admin", "/dashboard");
  try {
    // Baseline: ensure we start from a known-good Cloud/default state.
    await setSettings(page, { model_mode: "cloud", cloud_provider: "", cloud_api_key: "__clear__" });
    await page.reload({ waitUntil: "domcontentloaded" });

    // 9a. Cloud answers (sanity for the default backend).
    await askAndWait(page, "How many vendor contracts are there, and what is their combined annual value?");
    const cloudErr = await page.locator('[data-testid="ask-error"]').textContent().catch(() => null);
    const cloudAns = await page.locator('[data-testid="answer"]').last().textContent().catch(() => "");
    rec.check(!cloudErr && cloudAns.trim().length > 20, "Cloud mode answers", cloudErr ? `error: ${cloudErr}` : `len=${cloudAns.trim().length}`);

    // 9b. Flip to HIPAA (no Azure key configured) → FRIENDLY guidance, not a raw error.
    // The model switch is admin-only and present at the top of the console.
    const hipaaBtn = page.locator('[data-testid="model-switch-hipaa"]');
    const hasSwitch = await hipaaBtn.count();
    if (hasSwitch > 0) {
      await hipaaBtn.click();
      await page.waitForTimeout(1500); // let the PUT settle
      await page.click('[data-testid="new-chat"]');
      await askAndWait(page, "Summarize the maintenance invoices.", { timeout: 60000 });
      // Outcome is EITHER a localGuidance-style note in the answer OR a friendly error card.
      const guidance = await page.locator('[data-testid="local-guidance-note"], [data-testid="general-note"]').count();
      const ans = (await page.locator('[data-testid="answer"]').last().textContent().catch(() => "")) || "";
      const errCard = (await page.locator('[data-testid="ask-error"]').textContent().catch(() => "")) || "";
      const shown = (ans + " " + errCard).trim();
      const friendly = /hipaa|configure|set up|not.*configured|backend|settings/i.test(shown);
      const leaks = RAW_BLOB_RE.test(shown);
      rec.check(friendly && !leaks,
        "HIPAA (no key) returns FRIENDLY guidance, not a raw error",
        `guidanceNotes=${guidance} leaks=${leaks} shown="${shown.slice(0, 140)}"`);
      rec.check(!leaks, "HIPAA failure shows NO raw provider blob / 'Unexpected token <'", `shown="${shown.slice(0,140)}"`);
    } else {
      rec.check(false, "model switch present (admin)", "no model-switch-hipaa control");
    }

    // 9c. Select a cloud provider with NO key → fails closed with a friendly message
    // (NOT a silent DeepSeek answer). Drive this via the settings API (the UI key form
    // lives in the Prompts panel; the engine behavior is the contract under test).
    await setSettings(page, { model_mode: "cloud", cloud_provider: "openai", cloud_api_key: "__clear__" });
    // backendConfigured() now returns false for an explicit provider with no key → /api/ask 503.
    const probe = await page.evaluate(async () => {
      const r = await fetch("/api/ask", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "What is the maintenance total?" }),
      });
      let body; try { body = await r.json(); } catch { body = { error: await r.text() }; }
      return {
        status: r.status,
        error: typeof body?.error === "string" ? body.error : "",
        answer: typeof body?.answer === "string" ? body.answer : "",
        grounded: body?.grounded,
        rationale: body?.route?.rationale,
      };
    });
    // The product fails CLOSED via friendly guidance: either a 503 with an error, OR a
    // 200 whose ANSWER is the keyless-provider guidance (grounded:false). What it must
    // NEVER do is return a real grounded/general answer as if "openai" worked (a silent
    // fallback to the env DeepSeek key). We assert the guidance text and the absence of a
    // genuine answer, and that the guidance explicitly refuses a silent substitution.
    const shownText = (probe.error || probe.answer || "");
    const friendlyGuidance =
      /no api key is saved|not silently|selected but|add your .* key|switch the provider|configure|settings → model/i.test(shownText);
    // A "silent answer" would be a grounded answer with no guidance — guard against it.
    const isGuidanceNotRealAnswer =
      probe.status !== 200 ? true : (probe.grounded === false && friendlyGuidance);
    const leaks2 = RAW_BLOB_RE.test(shownText);
    rec.check(friendlyGuidance && isGuidanceNotRealAnswer && !leaks2,
      "keyless cloud provider fails CLOSED with a friendly message (not a silent DeepSeek answer)",
      `status=${probe.status} grounded=${probe.grounded} msg="${shownText.slice(0,140)}"`);

    // 10. Error path: a malformed ask (empty question) → a friendly 400, never a raw blob.
    const bad = await page.evaluate(async () => {
      const r = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "" }) });
      const b = await r.json().catch(async () => ({ error: await r.text() }));
      return { status: r.status, error: b?.error || "" };
    });
    rec.check(bad.status === 400 && !RAW_BLOB_RE.test(bad.error),
      "error path returns a clean message, no raw provider/HTML blob",
      `status=${bad.status} error="${bad.error}"`);

  } catch (e) {
    rec.check(false, "model-modes journey completed without an unhandled error", (e.message || String(e)).slice(0, 200));
  } finally {
    // RESTORE shared state to the working Cloud default — always.
    const restored = await setSettings(page, { model_mode: "cloud", cloud_provider: "", cloud_api_key: "__clear__" }).catch((e) => ({ status: -1, body: { error: String(e) } }));
    const okMode = restored?.body?.model_mode === "cloud" && (restored?.body?.cloud_provider ?? "") === "";
    rec.check(okMode, "RESTORE: model_mode=cloud, provider cleared, dummy key cleared", `status=${restored.status} mode=${restored?.body?.model_mode} provider="${restored?.body?.cloud_provider}"`);
    await ctx.close().catch(() => {});
    await browser.close();
  }
  return rec.summary();
}
