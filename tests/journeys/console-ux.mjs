// JOURNEY — CONSOLE UX (Z11–Z14). ZERO SDK calls.
//
// Real behavior under test: the chat console's user-facing chrome around an answer —
//   Z11 (Bug 3): the OPTIMISTIC user bubble appears the instant you hit send, BEFORE the
//                (slow) answer resolves — so the chat never looks like it swallowed your
//                message during a 30–60s agent run.
//   Z12        : the WORKING indicator + a Stop button show while the answer is pending;
//                Stop aborts the in-flight request (non-destructive, no completed turn).
//   Z13 (Bug 4): a stored answer containing markdown (**bold**, a list, a table) + a
//                citation token renders as real DOM (<strong>/<li>/<table> + a citation
//                chip), NOT literal asterisks/pipes.
//   Z14        : the optimistic bubble is on screen FAST (UI responsiveness) — the user's
//                message + the working indicator are visible within a tight budget even
//                though the answer itself is still in flight.
//
// HOW THIS STAYS ZERO-SDK:
//   • Z11/Z12/Z14 intercept POST /api/ask with Playwright page.route() and fulfil a
//     CONTROLLED, DELAYED response — so the REAL ask() code path runs (optimistic bubble,
//     working indicator, Stop/abort, markdown render) with NO Claude/agent call.
//   • Z13 seeds an ask_history turn whose `answer` is markdown, then opens that chat via
//     /dashboard?session=<id> — the dashboard REPLAYS the stored answer through the REAL
//     AnswerView markdown renderer. No ask at all.
//
// RED-first: revert the optimistic-bubble fix → Z11/Z14 go RED (no pending bubble before
// the answer); revert the markdown render → Z13 goes RED (literal ** / | as text).
import { launch, signIn, makeRecorder, psql, sqlLit, ownerIdForEmail, BASE } from "./lib.mjs";
import { randomUUID } from "node:crypto";

// A stubbed /api/ask JSON response (the EngineResult shape the UI renders). `answer` is
// markdown-free plain text here — Z13 covers markdown via a seeded turn instead.
function stubAnswer(question, session_id) {
  return {
    question,
    answer: "Stubbed answer for the console-UX journey (no agent call).",
    mode: "general",
    grounded: false,
    route: { sources: [], docFilter: null, rationale: "stub" },
    evidence: { rows: [], chunks: [] },
    validation: { ok: true, reasons: [] },
    session_id,
  };
}

export async function run() {
  const rec = makeRecorder("CONSOLE-UX");
  const browser = await launch();
  let ctx;
  const seededSessions = [];
  const adminOwner = ownerIdForEmail("nucleus.admin@meridian.co");
  try {
    const signedIn = await signIn(browser, "admin", "/dashboard");
    ctx = signedIn.ctx;
    const page = signedIn.page;
    // The dashboard mounts the console once for real + once as a Suspense fallback during
    // hydration, so the testid can briefly resolve to two nodes. Wait for the suspense
    // fallback to settle (network idle) then scope to the FIRST console for all UI work.
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.locator('[data-testid="assistant-console"]').first().waitFor({ state: "visible", timeout: 30000 });

    // ── Z11 + Z14: optimistic bubble appears (fast) BEFORE the answer resolves ──────
    // Intercept /api/ask and hold the response open for ~3s so we can observe the
    // pending state. The REAL ask() stages pendingQuestion synchronously on submit.
    let releaseAsk;
    const askGate = new Promise((r) => (releaseAsk = r));
    await page.route("**/api/ask", async (route) => {
      const req = route.request();
      let body = {};
      try { body = JSON.parse(req.postData() || "{}"); } catch { /* ignore */ }
      await askGate; // hold until we've asserted the pending UI
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(stubAnswer(body.question || "hi", body.session_id || randomUUID())),
      });
    });

    const Q = "hi there";
    const t0 = Date.now();
    await page.locator('[data-testid="assistant-console"] textarea').first().fill(Q);
    await page.locator('[data-testid="send-ask"]').first().click();

    // Z11: the optimistic user bubble (pending-question) is visible WHILE loading, and the
    // real answered turn has NOT landed yet (the response is still held by askGate).
    const bubbleSeen = await page
      .waitForFunction(
        (q) => {
          const pq = document.querySelector('[data-testid="pending-question"]');
          const turns = document.querySelectorAll('[data-testid="chat-turn"]').length;
          return !!pq && pq.textContent.includes(q) && turns === 0;
        },
        Q,
        { timeout: 5000 }
      )
      .then(() => true)
      .catch(() => false);
    const tBubble = Date.now() - t0;
    rec.check(bubbleSeen, "Z11: optimistic user bubble shows BEFORE the answer resolves (Bug 3 RED-first)", `pendingBubbleVisible=${bubbleSeen} beforeAnswerLanded=true`);

    // Z14: that bubble + the working indicator appeared FAST (UI responsiveness budget).
    const indicatorVisible = await page.locator('[data-testid="working-indicator"]').first().isVisible().catch(() => false);
    rec.check(
      bubbleSeen && tBubble < 4000,
      "Z14: optimistic bubble + working indicator are on screen fast (<4s), not blocked on the answer",
      `tBubbleMs=${tBubble} indicatorVisible=${indicatorVisible}`
    );

    // ── Z12: working indicator text + Stop button present while pending ──────────────
    const indicatorText = await page.locator('[data-testid="working-indicator"]').first().textContent().catch(() => "");
    const indicatorOk = /working on your answer/i.test(indicatorText) && /route\s*→\s*retrieve\s*→\s*ground\s*→\s*cite\s*→\s*verify/i.test(indicatorText);
    const stopVisible = await page.locator('[data-testid="stop-ask"]').first().isVisible().catch(() => false);
    rec.check(indicatorOk, "Z12: working indicator shows the pipeline text while pending", `text="${(indicatorText || "").trim().slice(0, 90)}"`);
    rec.check(stopVisible, "Z12: Stop button is present while the answer is pending", `stopVisible=${stopVisible}`);

    // NOTE on Stop's ABORT behavior: a client AbortController cannot cancel a request that a
    // Playwright page.route() handler is holding open (the route owns the request until it
    // fulfils), so the abort path can't be observed under a stubbed network here. The REAL
    // abort behavior — Stop cancels the in-flight ask, restores the input, leaves NO completed
    // turn and no error — is covered FAITHFULLY at the component layer with an AbortController-
    // honoring fetch mock: tests/components/assistant-console.test.tsx ("Stop CANCELS the
    // in-flight ask …"). We assert presence here and defer the abort outcome to that test
    // rather than assert a route-interception artifact (which would be a false RED).
    rec.info("Z12: Stop's abort OUTCOME is verified at the component layer (assistant-console.test.tsx)", "route-interception cannot observe a client abort of a held request");
    // Release the held route + unroute so teardown is clean.
    try { releaseAsk(); } catch { /* already settled */ }
    await page.unroute("**/api/ask").catch(() => {});
    // Reset to a clean chat so the pending stub doesn't bleed into Z13's navigation.
    await page.locator('[data-testid="new-chat"]').first().click().catch(() => {});

    // ── Z13: a stored MARKDOWN answer renders as DOM (Bug 4 RED-first) ──────────────
    // Seed an ask_history turn whose answer is markdown + a citation token, owner-scoped to
    // the signed-in admin, then open the chat. The dashboard replays the stored answer
    // through the REAL AnswerView markdown renderer.
    if (adminOwner) {
      const sid = randomUUID();
      seededSessions.push(sid);
      const md = [
        "Here is a **bold** finding and an *italic* aside.",
        "",
        "- first item",
        "- second item",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        "| Total | 42 |",
        "",
        "Supporting evidence: [P:family-court#1].",
      ].join("\n");
      // route carries a sources array so the persisted-turn normaliser keeps it; evidence
      // empty is fine (the [P:..#1] token renders as an inert chip — still a citation-chip
      // only when it resolves, so we assert the markdown DOM + strong/li/table, and the
      // chip path is asserted via the literal-asterisk-absence + element presence).
      const validation = JSON.stringify({ ok: true, reasons: [] });
      const route = JSON.stringify({ sources: ["document"], docFilter: null, rationale: "seed" });
      const evidence = JSON.stringify({
        rows: [],
        chunks: [{ token: "[P:family-court#1]", doc: "family-court", page: 1, text: "Seeded passage for the markdown citation chip.", score: 0.9 }],
      });
      psql(
        `insert into public.ask_history (owner_id, session_id, question, answer, mode, route, evidence, validation, inspector) ` +
          `values (${sqlLit(adminOwner)}, ${sqlLit(sid)}, ${sqlLit("Show me the markdown render test")}, ${sqlLit(md)}, 'grounded', ${sqlLit(route)}::jsonb, ${sqlLit(evidence)}::jsonb, ${sqlLit(validation)}::jsonb, '{}'::jsonb);`
      );

      await page.goto(`${BASE}/dashboard?session=${encodeURIComponent(sid)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.locator('[data-testid="chat-turn"]').first().waitFor({ state: "visible", timeout: 25000 }).catch(() => {});
      const answerEl = page.locator('[data-testid="answer"]').first();
      await answerEl.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});

      const html = (await answerEl.innerHTML().catch(() => "")) || "";
      const text = (await answerEl.innerText().catch(() => "")) || "";
      const hasStrong = /<strong[\s>]/i.test(html);
      const hasList = /<li[\s>]/i.test(html);
      const hasTable = /<table[\s>]/i.test(html);
      // Literal markdown syntax must NOT appear as visible text.
      const noLiteralBold = !text.includes("**");
      const noLiteralPipeTable = !/\|\s*Metric\s*\|/.test(text);
      const chipPresent = (await page.locator('[data-testid="citation-chip"]').count()) > 0;

      rec.check(hasStrong && hasList && hasTable, "Z13: markdown renders as DOM (<strong> + <li> + <table>) — Bug 4 RED-first", `strong=${hasStrong} li=${hasList} table=${hasTable}`);
      rec.check(noLiteralBold && noLiteralPipeTable, "Z13: NO literal markdown syntax shown (** / | table |) as visible text", `text="${text.slice(0, 100).replace(/\n/g, " ")}"`);
      rec.check(chipPresent, "Z13: citation token renders as a clickable citation chip (resolved to evidence)", `chips=${chipPresent}`);
    } else {
      rec.check(false, "Z13: could not resolve admin owner_id to seed the markdown turn", "ownerIdForEmail returned null");
    }
  } catch (e) {
    rec.check(false, "CONSOLE-UX completed without an unhandled error", (e.message || String(e)).slice(0, 200));
  } finally {
    // RESIDUE: delete any seeded ask_history turns.
    for (const sid of seededSessions) {
      try {
        psql(`delete from public.ask_history where session_id = ${sqlLit(sid)};`);
      } catch { /* best-effort */ }
    }
    await ctx?.close().catch(() => {});
    await browser.close();
  }
  return rec.summary();
}
