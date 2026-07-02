// JOURNEY 2 — CHAT. Grounded cited answer; context follow-up; New chat clears; resume from history.
import { launch, signIn, makeRecorder, askAndWait, BASE, hasAllFacts, hasGoldenNumber } from "./lib.mjs";

const CITE_RE = /\[(?:S|P):[^\]#]+#\d+\]/;

export async function run() {
  const rec = makeRecorder("CHAT");
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

    // 2a. Ask a golden question → a grounded, CITED answer.
    await askAndWait(page, "Who are the parties in the Carter family court case, and what was decided?");
    const errText = await page.locator('[data-testid="ask-error"]').textContent().catch(() => null);
    const answer = await page.locator('[data-testid="answer"]').last().textContent().catch(() => "");
    rec.check(!errText && answer && answer.trim().length > 40,
      "first question returns a non-empty answer (no error card)",
      errText ? `error: ${errText}` : `answer len ${answer.trim().length}`);

    // CITED: at least one inline citation chip resolving a [P:/S:...#n] token.
    const chipCount = await page.locator('[data-testid="citation-chip"]').count();
    const hasToken = CITE_RE.test(answer);
    rec.check(chipCount > 0 || hasToken,
      "answer is CITED (citation chip / token present)",
      `chips=${chipCount}, tokenInText=${hasToken}`);

    // GOLDEN VALUE (not value-blind): the Carter parties are Joni Carter + Michael — the
    // REAL fact from the bundled case file. A fluent-but-WRONG cited answer (wrong names)
    // must FAIL here, not pass on "len>40 + a chip exists". (Golden source: the family-court
    // case file; the answer-reliability eval pins the same /joni/ + /mich/ facts.)
    rec.check(hasAllFacts(answer, [/joni/i, /mich/i]),
      "answer states the REAL parties (Joni Carter + Michael) — not just any fluent text",
      `answer snippet: ${answer.trim().slice(0, 140).replace(/\n/g, " ")}`);

    // 2b. A second golden question whose CORRECT answer is a specific FIGURE — the child
    // support amount is $1,285. This is the exact value-blindness guard the directive names:
    // a fluent-but-WRONG amount ("$2,000/month") must FAIL, not pass on length + a chip.
    await askAndWait(page, "What was the final child support amount in the Carter case?");
    const csAnswer = await page.locator('[data-testid="answer"]').last().textContent().catch(() => "");
    rec.check(hasGoldenNumber(csAnswer, "1285"),
      "child-support answer states the REAL figure $1,285 (value-aware, not just cited)",
      `answer snippet: ${csAnswer.trim().slice(0, 140).replace(/\n/g, " ")}`);

    // 2c. Context follow-up: "what did I just ask?" should reference the prior turn (the
    // child-support question). A correct context-carry recaps child support / the amount.
    await askAndWait(page, "What did I just ask you in my previous question?");
    const followup = (await page.locator('[data-testid="answer"]').last().textContent().catch(() => "") || "").toLowerCase();
    const refsPrior = /child support|1,?285|amount|carter|previous|earlier|you asked/.test(followup);
    rec.check(refsPrior,
      "context follow-up references the prior turn",
      `followup snippet: ${followup.slice(0, 120)}`);

    // Grab a session id from the URL or history before clearing, for the resume test.
    // 2c. New chat clears the thread.
    const turnsBefore = await page.locator('[data-testid="chat-turn"]').count();
    await page.click('[data-testid="new-chat"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-turn"]').length === 0, null, { timeout: 10000 }).catch(() => {});
    const turnsAfter = await page.locator('[data-testid="chat-turn"]').count();
    rec.check(turnsBefore >= 2 && turnsAfter === 0,
      "New chat clears the thread",
      `before=${turnsBefore}, after=${turnsAfter}`);

    // 2d. Resume a session from /history → /dashboard?session=<id> shows the prior thread.
    await page.goto(`${BASE}/history`, { waitUntil: "domcontentloaded", timeout: 45000 });
    // The history panel fetches its sessions on mount — wait for the async load to
    // populate rows (or the empty-state) before reading, so we don't race the fetch.
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-testid="history-row"]').length > 0 ||
      /No conversations yet/i.test(document.body.textContent || ""),
      null, { timeout: 30000 }).catch(() => {});
    const resume = page.locator('[data-testid="resume-session"]').first();
    const haveHistory = await resume.count();
    if (haveHistory > 0) {
      const href = await resume.getAttribute("href");
      await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      // Wait for the resumed thread to load its turns.
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-turn"]').length > 0, null, { timeout: 30000 }).catch(() => {});
      const resumedTurns = await page.locator('[data-testid="chat-turn"]').count();
      const firstQ = await page.locator('[data-testid="turn-question"]').first().textContent().catch(() => "");
      rec.check(resumedTurns > 0 && firstQ.trim().length > 0,
        "resume session shows the prior thread",
        `href=${href} resumedTurns=${resumedTurns} firstQ="${firstQ.slice(0,60)}"`);
    } else {
      rec.check(false, "resume session shows the prior thread", "no history rows found to resume");
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
  return rec.summary();
}
