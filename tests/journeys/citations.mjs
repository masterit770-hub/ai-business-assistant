// JOURNEY 4 — CITATIONS. A citation chip is CLICKABLE and reveals the cited source text
// (not an inert span). Fails if no clickable citation chip is present at all.
import { launch, signIn, makeRecorder, askAndWait, hasAllFacts } from "./lib.mjs";

export async function run() {
  const rec = makeRecorder("CITATIONS");
  // ⛔ PAID GATE (Rule #0): every askAndWait below fires a REAL /api/ask — a billed
  // Claude call on whatever key the target server holds. Self-skip (loudly, never a
  // silent pass) unless the SDK flag is set, exactly like lifecycle/per-chat-scoping.
  // NOTE: the golden expectations here (Carter demo corpus) predate the Messages
  // engine — a fresh chat has no files in its manifest, so these checks need a
  // redesign against the current engine before the flag is worth spending.
  if (process.env.JOURNEY_SDK !== "1" && process.env.NUCLEUS_RUN_SDK !== "1") {
    rec.info("SKIP — paid asks gated (set JOURNEY_SDK=1); skipping is NOT a false green");
    return rec.summary();
  }
  const browser = await launch();
  try {
    const { ctx, page } = await signIn(browser, "admin", "/dashboard");
    // Ask a question that draws on the bundled corpus so citations are produced.
    await askAndWait(page, "Who are the parties in the Carter family court case, and what was decided?");

    // GOLDEN VALUE (not value-blind): a CITED answer is worthless if its prose is WRONG. The
    // real parties are Joni Carter + Michael — assert them so a fluent-but-wrong-yet-cited
    // answer FAILS here, not just "a chip exists". (Same golden facts the chat journey + the
    // answer-reliability eval pin.)
    const answer = await page.locator('[data-testid="answer"]').last().textContent().catch(() => "");
    rec.check(hasAllFacts(answer, [/joni/i, /mich/i]),
      "cited answer states the REAL parties (Joni Carter + Michael) — a wrong-but-cited answer fails",
      `answer snippet: ${answer.trim().slice(0, 140).replace(/\n/g, " ")}`);

    const chip = page.locator('[data-testid="citation-chip"]').first();
    const chipCount = await page.locator('[data-testid="citation-chip"]').count();
    rec.check(chipCount > 0, "at least one CLICKABLE citation chip is rendered", `chips=${chipCount}`);

    if (chipCount > 0) {
      const tagName = await chip.evaluate((el) => el.tagName.toLowerCase());
      rec.check(tagName === "button", "citation chip is a real <button> (not an inert span)", `tag=<${tagName}>`);
      const tokenText = (await chip.textContent() || "").trim();

      // Click → a source popover with the cited passage/row text appears.
      await chip.click();
      const src = page.locator('[data-testid="citation-source"]').first();
      const appeared = await src.isVisible({ timeout: 5000 }).catch(() => false);
      const srcText = appeared ? (await src.textContent() || "").trim() : "";
      rec.check(appeared && srcText.length > 0,
        "clicking the chip reveals the cited source passage/row text",
        `token=${tokenText} sourceTextLen=${srcText.length} sample="${srcText.slice(0, 80)}"`);

      // Toggling again hides it (proves it's interactive, not a static reveal).
      await chip.click();
      const stillVisible = await src.isVisible().catch(() => false);
      rec.check(!stillVisible, "clicking again collapses the source popover (interactive toggle)", `visible=${stillVisible}`);
    } else {
      rec.check(false, "citation chip is clickable and reveals source", "no citation chip present to test");
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
  return rec.summary();
}
