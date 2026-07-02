// JOURNEY — PER-CHAT SCOPING + DELETE (Z21 + optional B11 cross-chat ask).
//
// Z21 (ZERO SDK): deleting an uploaded file through the rail's two-step inline confirm
//   (doc-remove-<id> → doc-remove-<id>-yes, NOT a native window.confirm) actually removes
//   it — the row disappears from the DOM AND a re-GET /api/documents no longer lists it.
//   We upload via the real /api/ingest, open the chat's Files tab, delete through the real
//   control, and assert both the DOM and the API. No /api/ask.
//
// B11 (1 SDK ask, GATED behind NUCLEUS_RUN_SDK=1): per-chat file isolation — the agent
//   answering in chat A genuinely CANNOT see chat B's uploaded file (the real-behavior
//   class the client caught). This is proven via a REAL agentic ask scoped to chat A
//   asking about a fact that lives ONLY in chat B's file → it must NOT surface it. It runs
//   ONLY when NUCLEUS_RUN_SDK=1, and it is the ONLY paid call in this module (logged).
//   When the flag is off, it self-skips honestly (recorded as skipped, never green).
import {
  launch,
  signIn,
  makeRecorder,
  uploadFileBytes,
  fileBytes,
  askAndWait,
  hasGoldenNumber,
  BASE,
} from "./lib.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const RUN_SDK = process.env.NUCLEUS_RUN_SDK === "1";
const DATA = "/home/codex/Projects/nucleus/data";
const CSV_MAINTENANCE = join(DATA, "school data 3.csv");

async function listDocs(page, sessionId = null) {
  return page.evaluate(
    async ([base, sid]) => {
      const url = sid ? `${base}/api/documents?session_id=${encodeURIComponent(sid)}` : `${base}/api/documents`;
      const r = await fetch(url);
      const d = await r.json().catch(() => ({}));
      const docs = [...(d.documents || []), ...(d.structuredTables || [])];
      return docs.map((x) => x.doc);
    },
    [BASE, sessionId]
  );
}

export async function run() {
  const rec = makeRecorder("PER-CHAT-SCOPING");
  const browser = await launch();
  let ctx, page;
  const uploadedIds = [];
  try {
    const signedIn = await signIn(browser, "admin", "/dashboard");
    ctx = signedIn.ctx;
    page = signedIn.page;
    await page.locator('[data-testid="assistant-console"]').waitFor({ state: "visible", timeout: 30000 });

    // ── Z21: delete an uploaded doc through the rail's inline confirm ────────────────
    if (!existsSync(CSV_MAINTENANCE)) {
      rec.check(false, "Z21: CSV fixture present", `missing ${CSV_MAINTENANCE}`);
    } else {
      const sessionId = randomUUID();
      const up = await uploadFileBytes(page, {
        name: "journey-delete-target.csv",
        type: "text/csv",
        bytes: fileBytes(CSV_MAINTENANCE),
        sessionId,
      });
      const docId = up?.ingested?.table ?? up?.ingested?.doc ?? null;
      if (docId) uploadedIds.push(docId);
      rec.check(up.status === 200 && !!docId, "Z21: uploaded a doc scoped to a chat (setup)", `status=${up.status} docId=${docId ?? "none"}`);

      if (docId) {
        // Open the chat + its Files tab so the chat-mode rail lists this doc. Wait for the
        // suspense fallback to settle (networkidle) then click the FIRST tab-files (the
        // dashboard mounts the console twice during hydration).
        await page.goto(`${BASE}/dashboard?session=${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
        await page.locator('[data-testid="tab-files"]').first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
        await page.locator('[data-testid="tab-files"]').first().click();
        // Give the chat-mode materials rail its mount fetch.
        await page.waitForTimeout(1500);
        // The uploaded CSV is a structured table → its row testid is table-row-<id> with a
        // table-remove-<id> delete control; a PDF/Word would be doc-row/doc-remove. Accept
        // whichever the rail rendered for this upload (wait for either to attach).
        await page
          .locator(`[data-testid="table-row-${docId}"], [data-testid="doc-row-${docId}"]`)
          .first()
          .waitFor({ state: "attached", timeout: 20000 })
          .catch(() => {});
        const isTable = (await page.locator(`[data-testid="table-row-${docId}"]`).count()) > 0;
        const removeBase = isTable ? `table-remove-${docId}` : `doc-remove-${docId}`;
        const rowSel = isTable ? `table-row-${docId}` : `doc-row-${docId}`;
        const rowVisible = await page.locator(`[data-testid="${rowSel}"]`).first().waitFor({ state: "visible", timeout: 20000 }).then(() => true).catch(() => false);
        rec.check(rowVisible, "Z21: the uploaded doc appears in the chat's Files rail", `row=${rowSel} visible=${rowVisible}`);

        if (rowVisible) {
          // Two-step inline confirm — NOT a native dialog (the "delete unreachable" bug).
          await page.locator(`[data-testid="${removeBase}"]`).first().click();
          const armed = await page
            .locator(`[data-testid="${removeBase}-yes"]`)
            .first()
            .waitFor({ state: "visible", timeout: 5000 })
            .then(() => true)
            .catch(() => false);
          rec.check(armed, "Z21: delete arms a two-step inline confirm (no native window.confirm)", `armed=${armed}`);
          await page.locator(`[data-testid="${removeBase}-yes"]`).first().click();
          await page
            .waitForFunction((sel) => !document.querySelector(`[data-testid="${sel}"]`), rowSel, { timeout: 20000 })
            .catch(() => {});
          const rowGone = (await page.locator(`[data-testid="${rowSel}"]`).count()) === 0;
          rec.check(rowGone, "Z21: after confirm, the doc row disappears from the rail", `rowGone=${rowGone}`);

          // GROUND TRUTH: a re-GET /api/documents no longer lists it.
          const docsAfter = await listDocs(page);
          const stillListed = docsAfter.includes(docId);
          rec.check(!stillListed, "Z21: deleted doc is absent from GET /api/documents (DB-level truth)", `stillListed=${stillListed}`);
          if (!stillListed) {
            // already removed — drop from cleanup list
            const idx = uploadedIds.indexOf(docId);
            if (idx >= 0) uploadedIds.splice(idx, 1);
          }
        }
      }
    }

    // ── B11: per-chat isolation via a REAL agentic ask (GATED) ───────────────────────
    if (!RUN_SDK) {
      rec.info("B11 SKIPPED (per-chat isolation cross-chat ask) — set NUCLEUS_RUN_SDK=1 to run the 1 paid call", "skipped, not green");
    } else {
      // Chat B gets a file with a UNIQUE marker fact; chat A has no such file. Asking in
      // chat A about chat B's fact must NOT surface it (strict per-chat scoping, mig 015).
      const chatB = randomUUID();
      const chatA = randomUUID();
      const marker = `ZZMARKER${Math.floor(Math.random() * 1e6)}`;
      const csvWithMarker = `id,note,value\n1,${marker},777\n2,other,888\n`;
      const upB = await uploadFileBytes(page, {
        name: "chatB-secret.csv",
        type: "text/csv",
        bytes: Array.from(new TextEncoder().encode(csvWithMarker)),
        sessionId: chatB,
      });
      const bId = upB?.ingested?.table ?? upB?.ingested?.doc ?? null;
      if (bId) uploadedIds.push(bId);

      // Ask in chat A (which has NO files) about chat B's marker. The strict-scoping
      // contract: chat A cannot see chat B's file, so the answer must NOT contain 777.
      await page.goto(`${BASE}/dashboard?session=${encodeURIComponent(chatA)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.locator('[data-testid="assistant-console"]').waitFor({ state: "visible", timeout: 20000 });
      await askAndWait(page, `In THIS chat's files, what is the value next to ${marker}? If you have no file with it, say you don't have it.`, { timeout: 120000 });
      const ans = (await page.locator('[data-testid="answer"]').last().textContent().catch(() => "")) || "";
      const leaked = hasGoldenNumber(ans, "777") || ans.includes(marker + " = 777");
      rec.check(
        !leaked,
        "B11 (1 SDK ask): chat A does NOT surface chat B's file value — strict per-chat isolation holds",
        `leaked=${leaked} answer="${ans.slice(0, 120).replace(/\n/g, " ")}"`
      );
    }

    // RESIDUE: delete anything still uploaded.
    for (const id of uploadedIds) {
      await page
        .evaluate(async ([i, base]) => {
          await fetch(`${base}/api/documents?doc=${encodeURIComponent(i)}&scope=upload`, { method: "DELETE" }).catch(() => {});
        }, [id, BASE])
        .catch(() => {});
    }
  } catch (e) {
    rec.check(false, "PER-CHAT-SCOPING completed without an unhandled error", (e.message || String(e)).slice(0, 200));
  } finally {
    await ctx?.close().catch(() => {});
    await browser.close();
  }
  return rec.summary();
}
