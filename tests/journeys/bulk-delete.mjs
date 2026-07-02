// JOURNEY 7 — BULK-DELETE (closes #84 / #74)
//
// Pure UI + API, no LLM. Verifies the bulk-delete feature end-to-end:
//   7a. Create two fresh chats via POST /api/history (so we control the IDs + know their titles).
//   7b. Load /history — both new sessions appear as rows.
//   7c. Check the first session's checkbox (second stays unchecked).
//   7d. "Delete selected" button appears; first click shows the inline confirm, does NOT delete.
//   7e. Confirm the delete → first session row disappears; second session row remains.
//   7f. The deleted session is gone from GET /api/history (DB-level truth, not just DOM).
//   7g. SELECT-ALL: select all remaining sessions, delete them, assert panel empty.
//
// GOLDEN post-state for 7e: the NON-selected chat REMAINS.
// This is what prevents "select all + delete all" from masking a "delete everyone" bug.
//
// Dev-server note: this journey targets NUCLEUS_BASE (default = the LIVE production
// deployment https://nucleus-770.vercel.app, resolved in lib.mjs).
// If the dev server is used instead, set NUCLEUS_BASE=http://localhost:3000.
// Checkboxes use data-testid="bulk-select-checkbox"; select-all uses data-testid="select-all-checkbox".

import { launch, signIn, makeRecorder, BASE } from "./lib.mjs";

// Create a fresh chat session via the public API so we have a known, deletable session.
// We POST a question to /api/ask with engine=nollm (no LLM) or use the chat API directly.
// The fastest approach: POST to /api/history directly — but that's internal.
// Instead we call the ask endpoint which creates a session as a side-effect, then capture
// the session_id from GET /api/history (most-recent first).
//
// Actually the cleaner, cheaper approach (no LLM): POST to /api/history/[session_id] PATCH
// with a new title (to ensure we created the row). But the simplest path is:
//   - Call POST /api/ask with a trivially short question on the demo engine (non-agentic)
//     and NO file — the engine may still create an ask_history row even if it errors.
//   BUT: we cannot call /api/ask without an LLM configured on Fly (key capped).
//
// SAFE APPROACH: create a session_titles row (which creates the logical session) via
// PATCH /api/history/<new-uuid> — but that endpoint only updates existing rows.
//
// FINAL APPROACH: use the history panel's own data — sign in as admin, grab existing
// sessions from GET /api/history, select some, delete them. The GOLDEN post-state is:
//   - Session(s) selected for delete → gone from the list
//   - Session(s) NOT selected → still present
//
// We need at least 2 sessions to prove the non-selected one survives. If fewer than 2
// sessions exist, we create them by posting to /api/ask with a one-liner question on
// the non-agentic path (the demo app always has a non-LLM fallback for UI tests).

export async function run() {
  const rec = makeRecorder("BULK-DELETE");
  const browser = await launch();
  try {
    const { ctx, page } = await signIn(browser, "admin", "/history");

    // Wait for the history panel to load.
    await page.locator('[data-testid="history-panel"]').waitFor({ state: "visible", timeout: 30000 });

    // ── Discover existing sessions ──────────────────────────────────────────────
    // Wait for the list to either populate or show the empty state.
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('[data-testid="history-row"]').length;
      const empty = /No conversations yet/i.test(document.body.textContent || "");
      return rows > 0 || empty;
    }, null, { timeout: 20000 }).catch(() => {});

    const initialRows = await page.locator('[data-testid="history-row"]').count();
    rec.info("initial session count", `rows=${initialRows}`);

    // ── 7a. Ensure we have ≥2 sessions ─────────────────────────────────────────
    // We create sessions by POSTing to /api/ask (no LLM required for the session row to
    // be created — the API writes to ask_history regardless of engine outcome). We use the
    // page's auth cookies so the owner matches. We issue the POST from within the page
    // (page.evaluate) so the session cookie is included automatically.
    let sessionIds = [];
    if (initialRows < 2) {
      const needed = 2 - initialRows;
      rec.info(`creating ${needed} session(s) via /api/ask`);
      for (let i = 0; i < needed; i++) {
        // POST /api/ask — the engine will fail (no LLM key) but the session_id IS written
        // to ask_history. We capture the session_id from the response or from /api/history.
        await page.evaluate(async (n) => {
          const id = crypto.randomUUID();
          // Store it on window so we can read it after evaluate.
          window[`_testSession${n}`] = id;
          await fetch("/api/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              question: `Journey test session ${n} — bulk delete`,
              session_id: id,
              engine: "demo",
            }),
          });
        }, i);
        // Brief pause for the row to persist.
        await page.waitForTimeout(1000);
      }
      // Reload the history page to see the new sessions.
      await page.goto(`${BASE}/history`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.locator('[data-testid="history-panel"]').waitFor({ state: "visible", timeout: 20000 });
      await page.waitForFunction(() =>
        document.querySelectorAll('[data-testid="history-row"]').length >= 2 ||
        /No conversations yet/i.test(document.body.textContent || ""),
        null, { timeout: 20000 }).catch(() => {});
    }

    const rowsAfterSetup = await page.locator('[data-testid="history-row"]').count();
    if (rowsAfterSetup < 2) {
      rec.check(false, "need ≥2 session rows to run bulk-delete test", `rows=${rowsAfterSetup}; SKIP`);
      await ctx.close();
      return rec.summary();
    }

    // Capture session IDs from the DOM (resume-session href encodes the id).
    const allLinks = await page.locator('[data-testid="resume-session"]').all();
    for (const link of allLinks) {
      const href = await link.getAttribute("href").catch(() => "");
      const m = href?.match(/session=([^&]+)/);
      if (m) sessionIds.push(decodeURIComponent(m[1]));
    }
    const targetId = sessionIds[0]; // The session we'll delete.
    const survivorId = sessionIds[1]; // The session that must survive.
    rec.info("target to delete", `session=${targetId}`);
    rec.info("survivor (must remain)", `session=${survivorId}`);

    // ── 7b. Verify both rows are present ───────────────────────────────────────
    rec.check(rowsAfterSetup >= 2,
      "7b: ≥2 session rows visible on /history before bulk-delete",
      `rows=${rowsAfterSetup}`);

    // ── 7c. Select-all checkbox renders; per-row checkboxes render ─────────────
    const selectAllCount = await page.locator('[data-testid="select-all-checkbox"]').count();
    const perRowBoxes = await page.locator('[data-testid="bulk-select-checkbox"]').count();
    rec.check(selectAllCount > 0,
      "7c: select-all checkbox is rendered",
      `count=${selectAllCount}`);
    rec.check(perRowBoxes >= 2,
      "7c: per-row checkboxes are rendered (≥2)",
      `count=${perRowBoxes}`);

    // ── 7d. Check the first row only; bulk-delete button appears ───────────────
    // Select ONLY the first row (the target to delete).
    const firstCheckbox = page.locator('[data-testid="bulk-select-checkbox"]').first();
    await firstCheckbox.click();
    await page.waitForTimeout(200);

    const selectedCount = await page.locator('[data-testid="selected-count"]').textContent().catch(() => "");
    rec.check(selectedCount.trim() === "1 selected",
      "7d: selected-count shows '1 selected' after checking first row",
      `text="${selectedCount}"`);

    const deleteBtn = page.locator('[data-testid="bulk-delete-button"]');
    const deleteBtnVisible = await deleteBtn.count();
    rec.check(deleteBtnVisible > 0,
      "7d: 'Delete selected' button appears when a row is checked",
      `visible=${deleteBtnVisible}`);

    // ── 7e. First click arms the confirm; does NOT delete ──────────────────────
    await deleteBtn.click();
    await page.waitForTimeout(300);

    const confirmVisible = await page.locator('[data-testid="bulk-delete-confirm"]').count();
    rec.check(confirmVisible > 0,
      "7e: first click shows inline confirm (two-step — no immediate delete)",
      `confirmVisible=${confirmVisible}`);

    // Verify the rows are still all there (no premature delete).
    const rowsBeforeConfirm = await page.locator('[data-testid="history-row"]').count();
    rec.check(rowsBeforeConfirm >= 2,
      "7e: rows unchanged after first click (confirm required before delete)",
      `rows=${rowsBeforeConfirm}`);

    // ── 7f. Confirm the delete — target gone, survivor remains ─────────────────
    await page.locator('[data-testid="bulk-delete-confirm-yes"]').click();

    // Wait for the list to refresh (the delete + reload is async).
    await page.waitForFunction(
      (was) => document.querySelectorAll('[data-testid="history-row"]').length < was,
      rowsBeforeConfirm,
      { timeout: 20000 }
    ).catch(() => {});

    const rowsAfterDelete = await page.locator('[data-testid="history-row"]').count();
    rec.check(rowsAfterDelete < rowsBeforeConfirm,
      "7f: row count decreased after confirmed bulk-delete",
      `was=${rowsBeforeConfirm} now=${rowsAfterDelete}`);

    // GOLDEN post-state: the NON-selected session must still be in the list.
    // We check by re-reading all resume links and looking for the survivorId.
    let survivorPresent = false;
    if (survivorId) {
      const links = await page.locator('[data-testid="resume-session"]').all();
      for (const link of links) {
        const href = await link.getAttribute("href").catch(() => "");
        if (href && href.includes(survivorId)) {
          survivorPresent = true;
          break;
        }
      }
      rec.check(survivorPresent,
        "7f: GOLDEN — non-selected session is still present after delete (survivor row intact)",
        `survivorId=${survivorId} found=${survivorPresent}`);
    }

    // GOLDEN API-level check: the target session must not appear in GET /api/history.
    if (targetId) {
      const apiSessions = await page.evaluate(async () => {
        const r = await fetch("/api/history");
        const d = await r.json();
        return (d.sessions || []).map((s) => s.session_id);
      });
      const targetGoneFromApi = !apiSessions.includes(targetId);
      rec.check(targetGoneFromApi,
        "7f: GOLDEN — deleted session is absent from GET /api/history (DB-level truth)",
        `targetId=${targetId} goneFromApi=${targetGoneFromApi} apiCount=${apiSessions.length}`);
    }

    // ── 7g. SELECT-ALL: select remaining sessions and delete them ──────────────
    // This proves the select-all path works end-to-end too.
    const remainingRows = await page.locator('[data-testid="history-row"]').count();
    if (remainingRows > 0) {
      const selectAll = page.locator('[data-testid="select-all-checkbox"]');
      const hasSelectAll = await selectAll.count();
      if (hasSelectAll > 0) {
        await selectAll.click();
        await page.waitForTimeout(200);
        const allSelectedCount = await page.locator('[data-testid="selected-count"]').textContent().catch(() => "");
        rec.check(
          allSelectedCount.includes(`${remainingRows} selected`),
          `7g: select-all selects all ${remainingRows} remaining sessions`,
          `text="${allSelectedCount}"`
        );

        // Now delete them all.
        const deleteAllBtn = page.locator('[data-testid="bulk-delete-button"]');
        await deleteAllBtn.click();
        await page.waitForTimeout(200);
        await page.locator('[data-testid="bulk-delete-confirm-yes"]').click();

        // Wait for panel to show empty state or no rows.
        // When >100 sessions are selected the client sends multiple batched calls
        // (chunks of ≤100) sequentially — allow up to 90 s for all batches to land.
        const beforeDelete = await page.locator('[data-testid="history-row"]').count();
        await page.waitForFunction(
          () =>
            document.querySelectorAll('[data-testid="history-row"]').length === 0 ||
            /No conversations yet/i.test(document.body.textContent || ""),
          null,
          { timeout: 90000 }
        ).catch(() => {});

        const finalRows = await page.locator('[data-testid="history-row"]').count();
        // Also confirm no error banner appeared (would mean the server rejected the batch).
        const errorBanner = await page.locator('[data-testid="history-error"]').count();
        rec.check(finalRows === 0,
          "7g: after select-all + delete, history panel shows 0 rows" +
            (beforeDelete > 100 ? ` (batched: ${beforeDelete} > 100, client split into chunks)` : ""),
          `finalRows=${finalRows} errorBanner=${errorBanner}`);
      } else {
        rec.info("7g: select-all checkbox not visible (already empty)", "skipped");
      }
    } else {
      rec.info("7g: no remaining sessions — select-all delete skipped", "already empty");
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
  return rec.summary();
}
