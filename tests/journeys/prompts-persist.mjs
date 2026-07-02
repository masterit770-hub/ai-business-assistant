// JOURNEY — PROMPTS PERSIST (Z22). ZERO SDK calls.
//
// Real behavior under test: editing the system + urgency prompts in Settings → Prompts and
// saving them ROUND-TRIPS — after a full page reload the edited text is still there, and a
// raw GET /api/settings returns the saved values (owner-scoped engine_settings). This is
// the "my prompt edits don't stick" concern; it is proven by an actual save → reload →
// re-read, not by a click that returns 200.
//
// Driven entirely through the real Settings UI + /api/settings GET — no /api/ask. The
// original prompts are captured up front and RESTORED in a finally block so the account is
// left exactly as found (prompts change every answer, so leaving residue would be unsafe).
import { launch, signIn, makeRecorder, BASE } from "./lib.mjs";

async function getSettings(page) {
  return page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/settings`);
    const d = await r.json().catch(() => ({}));
    return { status: r.status, system_prompt: d.system_prompt ?? "", urgency_prompt: d.urgency_prompt ?? "" };
  }, BASE);
}

async function putSettings(page, body) {
  return page.evaluate(
    async ([base, b]) => {
      const r = await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    [BASE, body]
  );
}

export async function run() {
  const rec = makeRecorder("PROMPTS-PERSIST");
  const browser = await launch();
  let ctx, page, original;
  try {
    const signedIn = await signIn(browser, "admin", "/settings");
    ctx = signedIn.ctx;
    page = signedIn.page;

    // Capture the ORIGINAL prompts so we can restore them at the end.
    original = await getSettings(page);
    rec.info("captured original prompts", `systemLen=${original.system_prompt.length} urgencyLen=${original.urgency_prompt.length}`);

    // Wait for the prompts panel to mount (it loads the live prompts on mount).
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.locator('[data-testid="prompts-save"]').waitFor({ state: "visible", timeout: 30000 });

    // Find the two textareas (system prompt + urgency prompt) inside the Prompts panel.
    const textareas = page.locator("textarea");
    const taCount = await textareas.count();
    rec.check(taCount >= 2, "Z22: Prompts panel renders the system + urgency prompt fields", `textareas=${taCount}`);

    // The Save button is disabled until the form is DIRTY, and the dirty check compares
    // against the values loaded on mount — so wait until the panel has actually loaded its
    // current prompts (textarea non-empty OR the captured original was empty) before editing,
    // otherwise `loaded` is still null and our edit can't flip `dirty`.
    await page
      .waitForFunction(
        (orig) => {
          const ta = document.querySelectorAll("textarea");
          if (ta.length < 2) return false;
          // Loaded once the field reflects the server value (matches what GET returned).
          return (ta[0].value || "") === orig.system || (orig.system === "" && true);
        },
        { system: original.system_prompt },
        { timeout: 20000 }
      )
      .catch(() => {});

    // Type unique, recognizable edits into both fields (a marker so we can prove THESE
    // values round-tripped, not some default). Clear then type so React's onChange fires
    // and the dirty flag (and thus the enabled Save button) updates.
    const stamp = Date.now();
    const newSystem = `JOURNEY SYSTEM PROMPT ${stamp} — answer as a careful analyst, cite every fact.`;
    const newUrgency = `JOURNEY URGENCY PROMPT ${stamp} — flag anything legal or financial as high.`;

    await textareas.nth(0).fill(newSystem);
    await textareas.nth(1).fill(newUrgency);
    // Confirm the Save button became enabled (form is dirty) before clicking.
    await page.locator('[data-testid="prompts-save"]:not([disabled])').waitFor({ state: "visible", timeout: 10000 }).catch(() => {});

    // Save via the real button → wait for the "Saved — live now" confirmation.
    await page.click('[data-testid="prompts-save"]');
    const saved = await page
      .locator('[data-testid="prompts-saved"]')
      .waitFor({ state: "visible", timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    rec.check(saved, "Z22: Save shows the 'Saved — live now' confirmation", `savedConfirmation=${saved}`);

    // RELOAD the page — the panel re-fetches /api/settings on mount. The edited text must
    // still be present (durable round-trip, not just in-memory state).
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.locator('[data-testid="prompts-save"]').waitFor({ state: "visible", timeout: 30000 });
    // Wait for the panel's mount GET to populate the textarea with the saved value (the
    // fetch is async — reading too early sees the empty initial state, a false RED).
    await page
      .waitForFunction(
        (marker) => {
          const ta = document.querySelectorAll("textarea");
          return ta.length >= 1 && (ta[0].value || "").includes(marker);
        },
        `JOURNEY SYSTEM PROMPT ${stamp}`,
        { timeout: 20000 }
      )
      .catch(() => {});
    const reloadedTextareas = page.locator("textarea");
    const reloadedSystem = (await reloadedTextareas.nth(0).inputValue().catch(() => "")) || "";
    const reloadedUrgency = (await reloadedTextareas.nth(1).inputValue().catch(() => "")) || "";
    rec.check(
      reloadedSystem.includes(`JOURNEY SYSTEM PROMPT ${stamp}`),
      "Z22: after reload, the edited SYSTEM prompt is still in the textarea (round-trip)",
      `value="${reloadedSystem.slice(0, 60)}"`
    );
    rec.check(
      reloadedUrgency.includes(`JOURNEY URGENCY PROMPT ${stamp}`),
      "Z22: after reload, the edited URGENCY prompt is still in the textarea (round-trip)",
      `value="${reloadedUrgency.slice(0, 60)}"`
    );

    // GROUND TRUTH: a raw GET /api/settings returns the saved values (durable in
    // engine_settings, owner-scoped) — not just a UI cache.
    const fromApi = await getSettings(page);
    rec.check(
      fromApi.status === 200 &&
        fromApi.system_prompt.includes(`JOURNEY SYSTEM PROMPT ${stamp}`) &&
        fromApi.urgency_prompt.includes(`JOURNEY URGENCY PROMPT ${stamp}`),
      "Z22: GET /api/settings returns the saved prompts (durable, owner-scoped engine_settings)",
      `status=${fromApi.status} systemMatch=${fromApi.system_prompt.includes(String(stamp))} urgencyMatch=${fromApi.urgency_prompt.includes(String(stamp))}`
    );
  } catch (e) {
    rec.check(false, "PROMPTS-PERSIST completed without an unhandled error", (e.message || String(e)).slice(0, 200));
  } finally {
    // RESTORE the original prompts — always, so the account is left exactly as found.
    if (page && original) {
      const restored = await putSettings(page, {
        system_prompt: original.system_prompt,
        urgency_prompt: original.urgency_prompt,
      }).catch((e) => ({ status: -1, body: { error: String(e) } }));
      const ok =
        restored.status === 200 &&
        (restored.body?.system_prompt ?? "") === original.system_prompt &&
        (restored.body?.urgency_prompt ?? "") === original.urgency_prompt;
      rec.check(ok, "Z22 RESTORE: original system + urgency prompts restored", `status=${restored.status} ok=${ok}`);
    }
    await ctx?.close().catch(() => {});
    await browser.close();
  }
  return rec.summary();
}
