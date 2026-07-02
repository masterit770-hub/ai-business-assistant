// JOURNEY 6 — DOCUMENTS.
//   6a–6d: Download a doc returns a real PDF; download/delete controls show;
//           admin deletes a BUNDLED doc (family-court) → excluded from answers → then RESTORE it.
//   6e–6f: Per-chat docs UX — Sources page global-catalog (no upload control, chat labels)
//           + chat docs rail appears when a session is active.
//
// RESTORE is non-negotiable: whether or not the UI delete succeeds, this test deletes
// the family-court row from public.deleted_sources at the end via psql so the demo keeps
// the case file. (Runner also runs a belt-and-suspenders restore after the whole suite.)
import { launch, signIn, makeRecorder, askAndWait, BASE } from "./lib.mjs";
import { execFileSync } from "node:child_process";

const FAMILY = "family-court";

function restoreFamilyCourt() {
  // Use the engine's supabase.env DB creds; delete the soft-delete row. Never prints creds.
  try {
    const out = execFileSync("bash", ["-c",
      `set -a; . /home/codex/Projects/nucleus/.secrets/supabase.env; set +a; ` +
      `PGPASSWORD="$SUPABASE_DB_PASSWORD" psql ` +
      `"host=db.\${SUPABASE_PROJECT_REF}.supabase.co port=5432 dbname=postgres user=postgres sslmode=require" ` +
      `-tAc "delete from public.deleted_sources where source_id='${FAMILY}'; select count(*) from public.deleted_sources where source_id='${FAMILY}';"`
    ], { encoding: "utf8", timeout: 30000 });
    const remaining = out.trim().split(/\s+/).pop();
    return { ok: remaining === "0", detail: `family-court rows remaining=${remaining}` };
  } catch (e) {
    return { ok: false, detail: (e.message || String(e)).slice(0, 200) };
  }
}

export async function run() {
  const rec = makeRecorder("DOCUMENTS");
  const browser = await launch();
  let deleted = false;
  try {
    const { ctx, page } = await signIn(browser, "admin", "/sources");
    // Wait for the materials rail + bundled list to load.
    await page.locator('[data-testid="materials-rail"]').waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await page.locator(`[data-testid="bundled-row-${FAMILY}"]`).waitFor({ state: "visible", timeout: 30000 }).catch(() => {});

    // 6a. The bundled family-court row shows a download control + (admin) a delete control.
    const dlPresent = await page.locator(`[data-testid="bundled-download-${FAMILY}"]`).count();
    const rmPresent = await page.locator(`[data-testid="bundled-remove-${FAMILY}"]`).count();
    rec.check(dlPresent > 0, "bundled family-court row shows a download control", `present=${dlPresent}`);
    rec.check(rmPresent > 0, "admin sees a delete control on the bundled row", `present=${rmPresent}`);

    // 6b. Download returns a real PDF (Content-Type application/pdf). Use the page's
    // session cookies so the authed request is honored; check status + content-type.
    const fileUrl = `${BASE}/api/documents/file?doc=${encodeURIComponent(FAMILY)}`;
    const head = await page.evaluate(async (u) => {
      const r = await fetch(u);
      const buf = await r.arrayBuffer();
      const first5 = new TextDecoder().decode(new Uint8Array(buf).slice(0, 5));
      return { status: r.status, ctype: r.headers.get("content-type"), bytes: buf.byteLength, magic: first5 };
    }, fileUrl);
    rec.check(head.status === 200 && /application\/pdf/i.test(head.ctype || "") && head.magic.startsWith("%PDF"),
      "download returns a real PDF (Content-Type application/pdf + %PDF magic)",
      `status=${head.status} ctype=${head.ctype} bytes=${head.bytes} magic=${JSON.stringify(head.magic)}`);

    // 6c. Admin deletes the BUNDLED family-court source. The shipped UI uses a TWO-STEP
    // INLINE confirm (DeleteControl), NOT window.confirm() — native confirm() can be
    // browser-suppressed, which was the client's "the delete is unreachable" bug. So the
    // real flow is: click "Delete" to ARM, then click the inline "Delete" (…-yes) to
    // confirm. (An earlier version of this journey drove the OLD window.confirm path with
    // page.on("dialog") + a single click — a stale FALSE-RED; the product was correct.)
    if (rmPresent > 0) {
      await page.click(`[data-testid="bundled-remove-${FAMILY}"]`);
      const armed = await page
        .locator(`[data-testid="bundled-remove-${FAMILY}-yes"]`)
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      rec.check(armed, "delete arms a two-step inline confirm (no native dialog to suppress)", `armed=${armed}`);
      await page.click(`[data-testid="bundled-remove-${FAMILY}-yes"]`);
      await page.waitForFunction((id) => !document.querySelector(`[data-testid="bundled-row-${id}"]`),
        FAMILY, { timeout: 20000 }).catch(() => {});
      const rowGone = (await page.locator(`[data-testid="bundled-row-${FAMILY}"]`).count()) === 0;
      deleted = rowGone;
      rec.check(rowGone, "after admin delete, family-court is removed from the materials rail", `rowGone=${rowGone}`);

      // 6d. It is excluded from answers: GET /api/documents bundled list no longer lists it.
      const stillBundled = await page.evaluate(async () => {
        const r = await fetch("/api/documents");
        const d = await r.json();
        return (d.bundled || []).some((b) => b.doc === "family-court");
      });
      rec.check(!stillBundled, "deleted bundled source is excluded from the answer corpus", `stillInBundledList=${stillBundled}`);
    } else {
      rec.check(false, "admin can delete a bundled source", "no remove control to click");
    }

    // ── 6e. Sources page global-catalog UX ──────────────────────────────────────
    // Navigate to /sources as the admin user (already signed in) and verify the
    // per-chat docs UX: no upload control, "Upload inside a chat" note is visible.
    await page.goto(`${BASE}/sources`);
    await page.locator('[data-testid="materials-rail"]').waitFor({ state: "visible", timeout: 30000 }).catch(() => {});

    const uploadBtnCount = await page.locator('[data-testid="upload-button"]').count();
    rec.check(uploadBtnCount === 0, "Sources page (global mode): no upload button present", `count=${uploadBtnCount}`);

    const noUploadNote = await page.locator("text=Upload inside a chat").count();
    rec.check(noUploadNote > 0, "Sources page (global mode): 'Upload inside a chat' note is visible", `found=${noUploadNote}`);

    // ── 6f. Chat docs rail ────────────────────────────────────────────────────
    // Navigate to the dashboard with a session param and confirm the chat-docs rail renders.
    // We use the admin account which likely has sessions from prior interactions.
    // If no sessions exist, this check is skipped gracefully with a note.
    const sessionsRes = await page.evaluate(async () => {
      const r = await fetch("/api/history");
      const d = await r.json();
      return (d.sessions || []).map((s) => s.session_id).filter(Boolean);
    });
    if (sessionsRes.length > 0) {
      const firstSession = sessionsRes[0];
      await page.goto(`${BASE}/dashboard?session=${encodeURIComponent(firstSession)}`);
      // The chat docs panel is materials-rail in CHAT mode since the sidebar redesign
      // (the old chat-docs-rail testid no longer exists anywhere — this check false-REDed
      // on correct code until re-pinned to the real affordance), and it lives behind the
      // console's Files tab — reach it the way a user does.
      await page.locator('[data-testid="tab-files"]').waitFor({ state: "visible", timeout: 15000 });
      await page.click('[data-testid="tab-files"]');
      const railPresent = await page.locator('[data-testid="materials-rail-chat"]').waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);
      rec.check(railPresent, "dashboard with session param: materials-rail (chat mode) renders", `session=${firstSession} railPresent=${railPresent}`);
    } else {
      rec.check(true, "materials-rail check skipped — no sessions found for admin account (no prior chats)", "skipped");
    }

    await ctx.close();
  } finally {
    await browser.close();
    // RESTORE — always, regardless of pass/fail, so the demo keeps the case file.
    const r = restoreFamilyCourt();
    rec.check(r.ok, "RESTORE: family-court un-deleted (deleted_sources row removed)", r.detail);
  }
  return rec.summary();
}
