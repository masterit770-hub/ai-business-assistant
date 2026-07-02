// JOURNEY 3 — CHAT INPUT (component). Enter sends; Shift+Enter is a newline; arrow button sends.
// SHAPE-ONLY BY DESIGN: this journey proves the INPUT plumbing (key handling + send wiring);
// it deliberately does NOT assert answer content — the golden-value guard lives in chat.mjs +
// citations.mjs (the $1,285 / Joni+Michael facts).
import { launch, signIn, makeRecorder } from "./lib.mjs";

export async function run() {
  const rec = makeRecorder("CHAT INPUT");
  const browser = await launch();
  try {
    const { ctx, page } = await signIn(browser, "admin", "/dashboard");
    const ta = page.locator('[data-testid="assistant-console"] textarea');
    await ta.waitFor({ state: "visible", timeout: 30000 });

    // 3a. Shift+Enter inserts a newline and does NOT send (no new turn, input keeps text).
    const turns0 = await page.locator('[data-testid="chat-turn"]').count();
    await ta.click();
    await ta.fill("line one");
    await page.keyboard.down("Shift");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Shift");
    await page.keyboard.type("line two");
    const val = await ta.inputValue();
    const turnsAfterShift = await page.locator('[data-testid="chat-turn"]').count();
    rec.check(val.includes("\n") && turnsAfterShift === turns0,
      "Shift+Enter inserts a newline and does NOT send",
      `value has newline=${val.includes("\n")}, turns ${turns0}->${turnsAfterShift}`);

    // 3b. Enter sends: input clears and a new turn appears with an answer.
    await ta.fill("How many vendor contracts are there, and what is their combined annual value?");
    await page.keyboard.press("Enter");
    // After send, the input clears immediately (setQuestion("") happens on resolve, but
    // the turn is what proves a send); wait for a new turn.
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="chat-turn"]').length > n ||
             !!document.querySelector('[data-testid="ask-error"]'),
      turns0, { timeout: 90000 });
    const turnsAfterEnter = await page.locator('[data-testid="chat-turn"]').count();
    const errA = await page.locator('[data-testid="ask-error"]').count();
    const inputCleared = (await ta.inputValue()).trim() === "";
    rec.check(turnsAfterEnter > turns0 && errA === 0,
      "Enter sends the message (a new turn appears)",
      `turns ${turns0}->${turnsAfterEnter}, errorCards=${errA}`);
    rec.check(inputCleared, "input clears after a successful Enter send", `value="${(await ta.inputValue()).slice(0,30)}"`);

    // 3c. The arrow (send) button sends a message.
    const turnsB = await page.locator('[data-testid="chat-turn"]').count();
    await ta.fill("What is the total maintenance spend across all invoices?");
    await page.click('[data-testid="send-ask"]');
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="chat-turn"]').length > n ||
             !!document.querySelector('[data-testid="ask-error"]'),
      turnsB, { timeout: 90000 });
    const turnsAfterBtn = await page.locator('[data-testid="chat-turn"]').count();
    rec.check(turnsAfterBtn > turnsB, "arrow button sends the message", `turns ${turnsB}->${turnsAfterBtn}`);

    await ctx.close();
  } finally {
    await browser.close();
  }
  return rec.summary();
}
