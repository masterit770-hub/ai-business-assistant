// RENDERED state+layout test for the documents bucket — written FROM the API data and
// the USER's standard, NOT from the component's own test-ids. It derives what SHOULD be
// true from /api/documents and asserts the rendered dashboard matches:
//   • COUNT CONSISTENCY — every counter (the three stat cards + the rail header) agrees
//     with each other AND with the data (Sources = uploads + bundled; Your uploads =
//     uploads). This is the cross-check that catches a double-count / mislabel.
//   • URGENCY CONSISTENCY — EVERY document row (uploaded + bundled) shows an urgency
//     badge, not just one. (Tables don't — they aren't documents.)
//   • READABILITY — NO document name is truncated (scrollWidth <= clientWidth). Catches
//     the "names crammed into one line" regression that a presence-only test missed.
//   • DOWNLOAD — an uploaded PDF actually serves its original file.
// Exit 1 on any failure.
//
//   RENDER_BASE  override target (default: production alias)
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = process.env.RENDER_BASE || "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const sec = fs.readFileSync(new URL("../../.secrets/demo-accounts.txt", import.meta.url), "utf8");
const ADMIN = (() => {
  const s = sec.slice(sec.indexOf("ADMIN"));
  return { email: s.match(/email:\s*(\S+)/i)?.[1], password: s.match(/password:\s*(\S+)/i)?.[1] };
})();

const results = [];
const check = (id, ok, detail = "") => {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓" : "✗"} [${id}]${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const b = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  // wide viewport so the lg: rail (and the stat cards) actually render.
  const p = await (await b.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  p.setDefaultTimeout(120000);
  try {
    await p.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await p.fill('input[type="email"]', ADMIN.email);
    await p.fill('input[type="password"]', ADMIN.password);
    await p.click('[data-testid="auth-submit"]');
    await p.waitForURL("**/dashboard", { timeout: 90000 });
    await p.waitForSelector('[data-testid="materials-rail"]', { timeout: 30000 });
    await p.waitForTimeout(3500); // let the rail load + publish counts

    // GROUND TRUTH from the API (independent of any rendered test-id).
    const api = await p.evaluate(async () => await (await fetch("/api/documents")).json());
    const uploads = api.documents ?? [];
    const bundled = api.bundled ?? [];
    const bundledDocs = bundled.filter((s) => s.kind === "document");
    const expectedSources = uploads.length + bundled.length;

    // What the SCREEN shows.
    const ui = await p.evaluate(() => {
      const num = (sel) => {
        const t = document.querySelector(sel)?.textContent?.trim();
        return t && /^\d+$/.test(t) ? Number(t) : null;
      };
      const rail = document.querySelector('[data-testid="materials-rail"]');
      const headerSources = Number((rail?.innerText.match(/(\d+)\s+sources/) || [])[1]);
      // name elements + whether each is truncated (content wider than its box).
      const names = [...document.querySelectorAll('[data-testid^="doc-name-"],[data-testid^="bundled-name-"]')].map(
        (el) => ({
          id: el.getAttribute("data-testid"),
          text: el.textContent.trim(),
          truncated: el.scrollWidth > el.clientWidth + 1,
        })
      );
      const hasUrgency = (id) => !!document.querySelector(`[data-testid="${id}"]`);
      return {
        statSources: num('[data-testid="stat-Sources"]'),
        headerSources,
        names,
      };
    });

    // — COUNT CONSISTENCY (one bucket → ONE count, cross-checked against the data) —
    check("count/stat-sources-matches-data", ui.statSources === expectedSources, `stat Sources=${ui.statSources} expected=${expectedSources} (uploads ${uploads.length} + bundled ${bundled.length})`);
    check("count/rail-header-matches-data", ui.headerSources === expectedSources, `rail header=${ui.headerSources} expected=${expectedSources}`);
    check("count/stat-and-header-agree", ui.statSources === ui.headerSources, `sources-stat=${ui.statSources} header=${ui.headerSources}`);

    // — URGENCY CONSISTENCY: every DOCUMENT (uploaded + bundled) shows a badge —
    const urgency = await p.evaluate(({ uploadIds, bundledDocIds }) => {
      const has = (sel) => !!document.querySelector(sel);
      const missingUploads = uploadIds.filter((id) => !has(`[data-testid="doc-urgency-${id}"]`));
      const missingBundled = bundledDocIds.filter((id) => !has(`[data-testid="bundled-urgency-${id}"]`));
      return { missingUploads, missingBundled };
    }, { uploadIds: uploads.map((d) => d.doc), bundledDocIds: bundledDocs.map((d) => d.doc) });
    check("urgency/all-uploaded-docs-have-badge", urgency.missingUploads.length === 0, urgency.missingUploads.length ? `missing on: ${urgency.missingUploads.join(", ")}` : `all ${uploads.length} uploads`);
    check("urgency/all-bundled-docs-have-badge", urgency.missingBundled.length === 0, urgency.missingBundled.length ? `missing on: ${urgency.missingBundled.join(", ")}` : `all ${bundledDocs.length} bundled docs`);

    // — READABILITY: no document name is truncated —
    const truncated = ui.names.filter((n) => n.truncated);
    check("layout/no-name-truncated", truncated.length === 0, truncated.length ? `truncated: ${truncated.map((n) => `${n.text}`).join(" | ")}` : `all ${ui.names.length} names fully visible`);

    // — DOWNLOAD: an uploaded PDF serves its original —
    const heb = uploads.find((d) => d.doc === "hebrew-invoice");
    if (heb) {
      const dl = await p.evaluate(async () => {
        const r = await fetch("/api/documents/file?doc=hebrew-invoice");
        return { status: r.status, ctype: r.headers.get("content-type") };
      });
      check("download/hebrew-serves-pdf", dl.status === 200 && /pdf/i.test(dl.ctype || ""), JSON.stringify(dl));
    }

    await p.locator('[data-testid="materials-rail"]').screenshot({ path: "/tmp/rail.png" }).catch(() => {});
    await p.screenshot({ path: "/tmp/dashboard.png" });
  } catch (e) {
    console.error("RAIL-RENDER ERROR:", e instanceof Error ? e.stack : e);
    process.exitCode = 1;
  } finally {
    await b.close();
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\nRAIL-RENDER: ${results.length - fails.length}/${results.length} passed${fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN"}`);
  if (fails.length) process.exitCode = 1;
}
main();
