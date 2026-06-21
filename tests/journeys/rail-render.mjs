// RENDERED component test for the "Your materials" rail — the layer that API/eval tests
// never exercise (and where a cluster of one-bucket regressions hid: a wrong count, a
// missing page detail, a grey/dead download, a vanished urgency badge). This drives the
// REAL deployed dashboard and asserts what the USER sees in the DOM, then confirms the
// download actually serves the file. Exit 1 on any failure.
//
//   RENDER_BASE   override target (default: production alias)
//   Creds from .secrets/demo-accounts.txt — parsed in-process, never printed.
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
  const p = await (await b.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  p.setDefaultTimeout(120000);
  try {
    await p.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await p.fill('input[type="email"]', ADMIN.email);
    await p.fill('input[type="password"]', ADMIN.password);
    await p.click('[data-testid="auth-submit"]');
    await p.waitForURL("**/dashboard", { timeout: 90000 });
    await p.waitForSelector('[data-testid="materials-rail"]', { timeout: 30000 });
    await p.waitForTimeout(3000);

    // What the API says is in the bucket (uploads + bundled), to derive the expected count.
    const api = await p.evaluate(async () => (await (await fetch("/api/documents")).json()));
    const uploads = api.documents ?? [];
    const bundled = api.bundled ?? [];
    const expectedCount = uploads.length + bundled.length;

    const dom = await p.evaluate(() => {
      const rail = document.querySelector('[data-testid="materials-rail"]');
      const railText = rail?.innerText ?? "";
      const headerN = (railText.match(/(\d+)\s+sources/) || [])[1];
      // every uploaded doc row that is a PDF should carry: a page detail, an ENABLED
      // download (not the "no original" greyed span), and (when classified) an urgency badge.
      const docRows = [...document.querySelectorAll('[data-testid^="doc-row-"]')].map((el) => {
        const id = el.getAttribute("data-testid").replace("doc-row-", "");
        return {
          id,
          text: el.innerText.replace(/\s+/g, " ").trim(),
          hasPages: !!el.querySelector(`[data-testid="doc-pages-${id}"]`),
          downloadEnabled: !!el.querySelector(`[data-testid="doc-download-${id}"]`),
          downloadGreyed: !!el.querySelector(`[data-testid="doc-no-original-${id}"]`),
          hasUrgency: !!el.querySelector(`[data-testid="doc-urgency-${id}"]`),
        };
      });
      return { headerN, docRows };
    });

    check("count-includes-bundled", Number(dom.headerN) === expectedCount, `header=${dom.headerN} expected=${expectedCount} (uploads ${uploads.length} + bundled ${bundled.length})`);

    // The seeded Hebrew invoice is the canonical uploaded PDF — it must render fully.
    const heb = dom.docRows.find((r) => r.id === "hebrew-invoice");
    check("hebrew-row-renders", !!heb, heb?.text || "(hebrew-invoice row missing)");
    if (heb) {
      check("hebrew-lang-HE", /\bHE\b/.test(heb.text), heb.text);
      check("hebrew-page-detail", heb.hasPages, "shows 'PDF · N pages'");
      check("hebrew-download-enabled", heb.downloadEnabled && !heb.downloadGreyed, `enabled=${heb.downloadEnabled} greyed=${heb.downloadGreyed}`);
      check("hebrew-urgency-badge", heb.hasUrgency, "urgency badge present");

      // the download must actually SERVE the original file (not a dead 404).
      const dl = await p.evaluate(async () => {
        const r = await fetch("/api/documents/file?doc=hebrew-invoice");
        return { status: r.status, ctype: r.headers.get("content-type") };
      });
      check("hebrew-download-serves-pdf", dl.status === 200 && /pdf/i.test(dl.ctype || ""), JSON.stringify(dl));
    }
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
