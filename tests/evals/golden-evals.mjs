// AUTOMATED GOLDEN EVAL SUITE — the must-pass acceptance bar, run LIVE against the
// deployed app. Each case asks a real question and asserts the exact value + citation
// (or, where a value is date-relative, asserts grounded structure — never a demo-pinned
// number). Exit 1 if ANY must-pass assertion fails. No mocks; this is the real engine.
//
//   EVAL_BASE   override target (default: production alias)
//   Creds come from .secrets/demo-accounts.txt — parsed in-process, NEVER printed.
//
// Coverage:
//   CORE-UPLOAD  upload a born-digital PDF → ask → cited from the HYBRID lane (no Gemini)
//   HEBREW-UPLOAD upload a Hebrew invoice → ask in Hebrew → retrieves ₪52,800 + cites it
//   G1   case-file child support $1,285 + Joni Carter, cited [P:family-court#…]
//   G8   Hebrew cross-lingual over the English case file → answers IN Hebrew, citation kept
//   G3   maintenance all-time total $40,597 / 750 tickets, cited [S:…]
//   G4   contracts expiring soon — grounded count + combined value + [S:…] + honest caveat
//   G10b honest refusal on un-answerable overdue-payments question (no invention)
//   TRACE inspector exposes routing + retrieval + citations + validation for an answer
//   ISO  per-user isolation — a member cannot retrieve the admin's uploaded private doc
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = process.env.EVAL_BASE || "https://nucleus-woad.vercel.app";
const EXEC = "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const HE_PDF = "/tmp/hebrew-invoice.pdf";
const BF_PDF = "/tmp/bluefalcon.pdf";

const sec = fs.readFileSync(new URL("../../.secrets/demo-accounts.txt", import.meta.url), "utf8");
function cred(role) {
  const s = sec.slice(sec.indexOf(role));
  return { email: s.match(/email:\s*(\S+)/i)?.[1], password: s.match(/password:\s*(\S+)/i)?.[1] };
}
const ADMIN = cred("ADMIN");
const MEMBER = cred("MEMBER"); // may be undefined if no member account is provisioned

const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}
const cites = (ans) => [...(ans || "").matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]);
const hasHebrew = (s) => /[֐-׿]/.test(s || "");

async function signIn(page, c) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', c.email);
  await page.fill('input[type="password"]', c.password);
  await page.click('[data-testid="auth-submit"]');
  await page.waitForURL("**/dashboard", { timeout: 90000 });
}
const ask = (page, question) =>
  page.evaluate(
    async (q) =>
      await (
        await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q }),
        })
      ).json(),
    question
  );
const listDocs = (page) =>
  page.evaluate(async () => {
    const d = await (await fetch("/api/documents")).json();
    // The API returns { documents: [...uploaded], bundled: [...] } — uploaded docs are
    // under `documents`. (Earlier versions of this runner read the wrong key.)
    return d?.documents ?? [];
  });
// Upload a fixture and confirm it ingested. The doc id is STABLE (derived from the
// filename), and these fixtures persist across runs, so we DELETE any prior copy first,
// then upload, then poll until the doc is PRESENT (not "newly appeared" — that misses a
// re-upload of an id that already existed, which is exactly how an earlier version of
// this runner false-failed while ingestion actually worked).
async function upload(page, path, expectedDocId, rx) {
  await del(page, expectedDocId).catch(() => {});
  await page.setInputFiles('input[type="file"]', path);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(3000);
    const now = await listDocs(page);
    const found = now.find((d) => (d.doc ?? d.id) === expectedDocId || rx.test(JSON.stringify(d)));
    if (found) return found.doc ?? found.id;
  }
  return null;
}
const del = (page, docId) =>
  page.evaluate(async (id) => (await fetch(`/api/documents?doc=${id}`, { method: "DELETE" })).status, docId);

async function main() {
  const b = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  p.setDefaultTimeout(120000);
  let bfId = null;
  let heId = null;
  try {
    await signIn(p, ADMIN);

    // ── CORE-UPLOAD: the flow that was broken on Gemini — now self-hosted hybrid ──
    console.log("\n▶ CORE-UPLOAD (born-digital PDF → hybrid retrieval, no Gemini)");
    bfId = await upload(p, BF_PDF, "bluefalcon", /bluefalcon/i);
    check("CORE-UPLOAD/ingest", "uploaded memo is ingested + listed", !!bfId, `docId=${bfId}`);
    if (bfId) {
      const r = await ask(
        p,
        "According to the uploaded internal memo, what is the classified project codename, the approved budget, and the project lead?"
      );
      const a = r.answer ?? "";
      const c = cites(a);
      const method = r.inspector?.retrievalMethod ?? r.inspector?.retrieval?.method ?? r.mode ?? "";
      check("CORE-UPLOAD/value", "answer states BLUEFALCON · $42,000 · Dana Whitfield",
        /bluefalcon/i.test(a) && /42,?000/.test(a) && /dana|whitfield/i.test(a), a.slice(0, 200).replace(/\n/g, " "));
      check("CORE-UPLOAD/cite", "answer cites the uploaded doc [P:…]", c.some((x) => /^\[P:/.test(x)), c.join(" ") || "(none)");
      check("CORE-UPLOAD/hybrid", "retrieval method is the self-hosted hybrid (dense×BM25→RRF)",
        /hybrid|dense|bm25|rrf/i.test(JSON.stringify(method)), JSON.stringify(method).slice(0, 120));
      check("CORE-UPLOAD/no-gemini", "no Gemini/quota error in the path",
        !/gemini|file ?search|quota|429|resource_exhausted/i.test(a), "");
    }

    // ── HEBREW-UPLOAD: real Hebrew doc → Hebrew question → retrieve ₪52,800 ──
    console.log("\n▶ HEBREW-UPLOAD (Hebrew invoice → Hebrew question → hybrid retrieval)");
    heId = await upload(p, HE_PDF, "hebrew-invoice", /hebrew|invoice|חשבונית/i);
    check("HEBREW-UPLOAD/ingest", "Hebrew invoice is ingested + listed", !!heId, `docId=${heId}`);
    if (heId) {
      // Hebrew-LABEL fix: language must be detected from the doc's real CONTENT (he),
      // not guessed from the Latin filename "hebrew-invoice.pdf" (which read "English").
      const meta = (await listDocs(p)).find((d) => (d.doc ?? d.id) === heId);
      check("HEBREW-UPLOAD/lang", "tagged Hebrew (HE) from content, not English from filename", meta?.lang === "he", `lang=${meta?.lang}`);
      const r = await ask(p, "מהו הסכום הכולל לתשלום בחשבונית של חברת אבן יסמין?");
      const a = r.answer ?? "";
      const c = cites(a);
      check("HEBREW-UPLOAD/retrieve", "retrieves the Hebrew amount 52,800", /52,?800/.test(a), a.slice(0, 200).replace(/\n/g, " "));
      check("HEBREW-UPLOAD/cite", "cites the Hebrew doc [P:…]", c.some((x) => /^\[P:/.test(x)), c.join(" ") || "(none)");
      check("HEBREW-UPLOAD/in-hebrew", "answers IN Hebrew (output language matches)", hasHebrew(a), "");
    }

    // ── G1: bundled case-file PDF retrieval ──
    console.log("\n▶ G1 (case file — child support + primary residence)");
    {
      const r = await ask(p, "What was the final child support amount, and who got primary residence?");
      const a = r.answer ?? "";
      const c = cites(a);
      check("G1/value", "$1,285/month + primary residence Joni Carter", /1,?285/.test(a) && /joni|carter/i.test(a), a.slice(0, 200).replace(/\n/g, " "));
      check("G1/cite", "cites the case-file PDF [P:…]", c.some((x) => /^\[P:/.test(x)), c.join(" ") || "(none)");
    }

    // ── G8: Hebrew cross-lingual over the English case file ──
    console.log("\n▶ G8 (Hebrew question over English doc → answer in Hebrew, citation kept)");
    {
      const r = await ask(p, "מה גובה דמי המזונות שנפסקו ולמי ניתנה המשמורת העיקרית?");
      const a = r.answer ?? "";
      const c = cites(a);
      check("G8/value", "answer carries 1,285", /1,?285/.test(a), a.slice(0, 200).replace(/\n/g, " "));
      check("G8/in-hebrew", "answer is written IN Hebrew", hasHebrew(a), "");
      check("G8/cite", "citation preserved across the language boundary [P:…]", c.some((x) => /^\[P:/.test(x)), c.join(" ") || "(none)");
    }

    // ── G3: maintenance all-time total (date-INDEPENDENT, so exact) ──
    console.log("\n▶ G3 (maintenance all-time total)");
    {
      const r = await ask(p, "What was our total maintenance spend all-time, and how many tickets?");
      const a = r.answer ?? "";
      const c = cites(a);
      check("G3/value", "$40,597 across 750 tickets", /40,?597/.test(a) && /750/.test(a), a.slice(0, 200).replace(/\n/g, " "));
      check("G3/cite", "cites structured rows [S:…]", c.some((x) => /^\[S:/.test(x)), c.join(" ") || "(none)");
    }

    // ── G4: contracts expiring soon — date-RELATIVE, so assert grounded STRUCTURE, not a pinned number ──
    console.log("\n▶ G4 (contracts expiring soon — grounded structure, no demo-pinned number)");
    {
      const r = await ask(p, "What contracts expire in the next 90 days, and what's their combined annual value?");
      const a = r.answer ?? "";
      const c = cites(a);
      check("G4/grounded", "gives a count + a combined-$ value, both cited", /\b\d+\b/.test(a) && /\$\s?[\d,]+/.test(a) && c.some((x) => /^\[S:/.test(x)), a.slice(0, 200).replace(/\n/g, " "));
      // INFORMATIONAL (not must-pass): when the SQL collapses to a single aggregate row
      // the model legitimately can't surface per-row anomalies — that's honest, not a fail.
      const caveat = /job title|end .*start|data quality|anomal|caveat|note/i.test(a);
      console.log(`  ${caveat ? "✓" : "ⓘ"} [G4/caveat·info] surfaces a data-quality caveat: ${caveat}`);
    }

    // ── G10b: honest refusal (the trust property) ──
    console.log("\n▶ G10b (honest refusal — no fabricated overdue list)");
    {
      const r = await ask(p, "Which customers have overdue payments and what does the agreement say about service suspension?");
      const a = r.answer ?? "";
      check("G10b/refuse", "refuses honestly (no payment-status field / no agreement) — no invented overdue list",
        /cannot|can.?t|unable|do(?:es)? not have|don.?t have|no (payment|due|overdue|access|service.?agreement|customer)|not (present|available)|isn.?t/i.test(a) &&
          !/overdue balance of \$/i.test(a),
        a.slice(0, 220).replace(/\n/g, " "));
    }

    // ── TRACE: inspector completeness for a real answer ──
    console.log("\n▶ TRACE (inspector exposes the real retrieval trace)");
    {
      const r = await ask(p, "What was the final child support amount, and who got primary residence?");
      const insp = r.inspector ?? {};
      const blob = JSON.stringify(insp).toLowerCase();
      check("TRACE/present", "inspector has routing + retrieval + citations + validation",
        !!r.inspector && /rout|retriev/.test(blob) && /cit/.test(blob) && /valid|confiden/.test(blob),
        Object.keys(insp).join(","));
    }

    // ── COHERENCE: the trace must be INTERNALLY consistent (the class of bug a human
    //    caught by eye: "grounded · cited · validateAnswer passed" next to "Route NONE ·
    //    0 passages"). A grounded, cited answer MUST have a non-empty route, retrieved
    //    evidence, and a non-skipped retrieval step — and vice-versa. ──
    console.log("\n▶ COHERENCE (route ↔ retrieval ↔ grounding ↔ citations must agree)");
    {
      const r = await ask(p, "What was the final child support amount, and who got primary residence?");
      const a = r.answer ?? "";
      const insp = r.inspector ?? {};
      const sources = r.route?.sources ?? insp.route?.sources ?? [];
      const passages = typeof insp.passages === "number" ? insp.passages : 0;
      const evidence = typeof insp.evidenceCount === "number" ? insp.evidenceCount : 0;
      const grounded = r.mode === "grounded" || r.grounded === true;
      const hasCites = cites(a).length > 0;
      const retrievalStep = (insp.steps ?? []).find((s) => s.key === "retrieval");
      const coherent =
        grounded && hasCites
          ? sources.length > 0 && (passages > 0 || evidence > 0) && retrievalStep?.status !== "skip"
          : true;
      check("COHERENCE/grounded-implies-retrieval",
        "a grounded, cited answer has a real route + retrieved evidence (no 'NONE/0 passages' under a cited answer)",
        coherent, `grounded=${grounded} cites=${hasCites} sources=[${sources}] passages=${passages} evidence=${evidence} retrievalStep=${retrievalStep?.status}`);
    }

    // ── HISTORY-REPLAY: the persisted trace must survive a round-trip. Ask in a fresh
    //    session, then read it back from /api/history/<session_id> and assert the stored
    //    turn carries the REAL route + inspector (this is the exact path that showed a
    //    fabricated empty trace on resume — migration 008 persists it). ──
    console.log("\n▶ HISTORY-REPLAY (a resumed answer replays its REAL trace, not an empty one)");
    {
      const r = await p.evaluate(async () => {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: "What was the final child support amount, and who got primary residence?" }),
        });
        return res.json();
      });
      const sid = r.session_id;
      check("HISTORY-REPLAY/session", "the ask returns a session_id to resume", !!sid, `session_id=${sid}`);
      if (sid) {
        await p.waitForTimeout(1500); // let the best-effort history write land
        const hist = await p.evaluate(async (s) => (await fetch(`/api/history/${s}`)).json(), sid);
        const turn = (hist.turns ?? []).find((t) => /child support/i.test(t.question));
        const storedSources = turn?.route?.sources ?? [];
        const storedPassages = typeof turn?.inspector?.passages === "number" ? turn.inspector.passages : 0;
        check("HISTORY-REPLAY/route", "the stored turn replays its REAL route (documents), not NONE", storedSources.length > 0, `stored sources=[${storedSources}]`);
        check("HISTORY-REPLAY/trace", "the stored turn replays its REAL retrieval trace (passages > 0)", storedPassages > 0, `stored passages=${storedPassages}`);
      }
    }

    // ── ISO: per-user isolation (member cannot see admin's private upload) ──
    console.log("\n▶ ISO (per-user document isolation)");
    if (MEMBER?.email && bfId) {
      const mp = await (await b.newContext()).newPage();
      mp.setDefaultTimeout(120000);
      try {
        await signIn(mp, MEMBER);
        const r = await ask(mp, "What is the classified project codename and approved budget in the internal memo?");
        const a = r.answer ?? "";
        check("ISO/leak", "member CANNOT retrieve the admin's private BLUEFALCON memo",
          !/bluefalcon/i.test(a) && !/42,?000/.test(a), a.slice(0, 160).replace(/\n/g, " "));
      } finally {
        await mp.context().close();
      }
    } else {
      console.log("  ⓘ SKIP [ISO] no MEMBER account provisioned in .secrets/demo-accounts.txt");
    }
  } catch (e) {
    console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e);
    process.exitCode = 1;
  } finally {
    // cleanup uploaded test docs (never leave test state in the shared corpus)
    try { if (bfId) { await del(p, bfId); console.log(`\n↩ cleaned up ${bfId}`); } } catch {}
    try { if (heId) { await del(p, heId); console.log(`↩ cleaned up ${heId}`); } } catch {}
    await b.close();
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`GOLDEN EVALS: ${results.length - fails.length}/${results.length} passed` + (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN"));
  if (fails.length) process.exitCode = 1;
}
main();
