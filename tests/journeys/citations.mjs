// JOURNEY 4 — CITATIONS. A citation chip is CLICKABLE and reveals the cited source text
// (not an inert span). Fails if no clickable citation chip is present at all.
import { launch, signIn, makeRecorder, askAndWait } from "./lib.mjs";

export async function run() {
  const rec = makeRecorder("CITATIONS");
  const browser = await launch();
  try {
    const { ctx, page } = await signIn(browser, "admin", "/dashboard");
    // Ask a question that draws on the bundled corpus so citations are produced.
    await askAndWait(page, "Who are the parties in the Carter family court case, and what was decided?");

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
