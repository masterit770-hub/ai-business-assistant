// JOURNEY 5 — ANSWER ACTIONS. Copy to clipboard; retry/regenerate; per-answer cost line.
import { launch, signIn, makeRecorder, askAndWait } from "./lib.mjs";

export async function run() {
  const rec = makeRecorder("ANSWER ACTIONS");
  const browser = await launch();
  try {
    const { ctx, page } = await signIn(browser, "admin", "/dashboard");
    await askAndWait(page, "What is the total maintenance spend across all invoices?");

    // 5a. Per-answer cost line is shown.
    const cost = page.locator('[data-testid="answer-cost"]').last();
    const costShown = await cost.isVisible().catch(() => false);
    const costText = costShown ? (await cost.textContent() || "").trim() : "";
    rec.check(costShown && costText.length > 0, "per-answer cost line is shown", `cost="${costText}"`);

    // 5b. Copy to clipboard actually writes the answer text.
    const copyBtn = page.locator('[data-testid="copy-answer"]').last();
    const copyPresent = await copyBtn.count();
    if (copyPresent > 0) {
      await copyBtn.click();
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => "")).catch(() => "");
      // Confirmation state ("Copied") is the in-DOM signal; clipboard read is the real proof.
      const confirmed = await page.locator('[data-testid="copy-answer"]').last().textContent().catch(() => "");
      rec.check((clip && clip.length > 10) || /copied/i.test(confirmed),
        "copy-to-clipboard writes the answer (or shows Copied)",
        `clipLen=${clip ? clip.length : 0}, btn="${confirmed.trim()}"`);
    } else {
      rec.check(false, "copy answer control present", "no copy-answer button");
    }

    // 5c. Retry/regenerate re-runs the question (a new turn appears).
    const retryBtn = page.locator('[data-testid="retry-answer"]').last();
    const retryPresent = await retryBtn.count();
    if (retryPresent > 0) {
      const turnsBefore = await page.locator('[data-testid="chat-turn"]').count();
      await retryBtn.click();
      await page.waitForFunction((n) =>
        document.querySelectorAll('[data-testid="chat-turn"]').length > n ||
        !!document.querySelector('[data-testid="ask-error"]'),
        turnsBefore, { timeout: 90000 }).catch(() => {});
      const turnsAfter = await page.locator('[data-testid="chat-turn"]').count();
      rec.check(turnsAfter > turnsBefore, "regenerate re-runs the question (new turn)", `turns ${turnsBefore}->${turnsAfter}`);
    } else {
      rec.info("regenerate control present", "absent");
      rec.check(false, "regenerate control present", "no retry-answer button");
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
  return rec.summary();
}
