// NEGATIVE-CITATION EVAL — F3's LIVE proof (the false-grounding-floor regression gate).
//
// THE BUG (F3, answer-messages.ts): a grounding "floor" overrode an explicit SOURCES_USED:
// NONE. So a PURE general-knowledge question, asked inside a chat that HAPPENS to have a
// document, came back falsely marked grounded=true with a citation to a file the model never
// used — a fabricated citation. This is the negative case that a positive grounding test can
// never catch (grounding tests only prove it grounds when it SHOULD).
//
// WHAT THIS PROVES, end-to-end on a LIVE deployment (NUCLEUS_BASE): a chat WITH a PDF + a
// general-knowledge question ("capital of France") →
//   • the answer is still produced (general knowledge is fine), AND
//   • grounded === false, AND
//   • evidence.chunks is EMPTY (no citation manufactured for the unused file), AND
//   • the answer does NOT name the fixture file (no fabricated file reference).
// RED-first: with the F3 floor reverted the same ask returns grounded=true / ≥1 evidence chunk
// / the fixture filename echoed as a "source".
//
// OPT-IN + BILLED: this makes EXACTLY ONE real Claude call (Haiku, low). It is gated behind
// NUCLEUS_RUN_NEG_CITATION=1 and SKIPS LOUDLY (exit 0, "not a pass") otherwise, so it never
// fires in CI or a plain `npm test`. Run it deliberately, LOCAL first (subscription):
//   NUCLEUS_RUN_NEG_CITATION=1 NUCLEUS_BASE=http://localhost:3000 node tests/evals/negative-citation.mjs
//
// PURITY NOTE: the journey-purity rule (UI-only state mutations) does NOT apply to evals —
// an eval drives the API directly by design. The fixture PDF is uploaded via /api/ingest and
// the question asked via /api/ask (exactly one ask). We reuse the journey lib's launch/signIn
// so the ask runs under a real authenticated session (the same path the browser uses).

import { launch, signIn, BASE } from "../journeys/lib.mjs";
import { existsSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const GATE = process.env.NUCLEUS_RUN_NEG_CITATION === "1";
const DATA_DIR = "/home/codex/Projects/nucleus/data";
const QUESTION = "What is the capital of France? Answer in one word.";
const MODEL = "claude-haiku-4-5"; // answer-correctness of a NEGATIVE case; Haiku is sufficient

function loudSkip(reason) {
  const bar = "═".repeat(72);
  console.log("\n" + bar);
  console.log("⏭  SKIPPED — negative-citation eval did NOT run (this is NOT a pass).");
  console.log("   " + reason);
  console.log(bar);
  process.exit(0);
}

if (!GATE) {
  loudSkip("Set NUCLEUS_RUN_NEG_CITATION=1 to run (this eval makes ONE billed Haiku call — opt-in).");
}

// First PDF under data/ — any works; we upload it under our OWN distinctive filename so the
// "does the answer name the file?" assertion is unambiguous.
function findPdf() {
  if (!existsSync(DATA_DIR)) return null;
  for (const name of readdirSync(DATA_DIR)) {
    if (name.toLowerCase().endsWith(".pdf")) return join(DATA_DIR, name);
  }
  return null;
}

// Mirror lifecycle's SDK call-log row (docs/claude-call-log.md). Best-effort — a logging
// failure must never change the eval's verdict.
function logSdkCall({ env, model, question, justification }) {
  try {
    const envLabel = BASE.includes("nucleus-770.vercel.app") ? "prod (billed)" : "local (subscription)";
    const row =
      `| NEG-CIT | ${new Date().toISOString().slice(0, 10)} | ${env || envLabel} | messages-api | ${model} | low | ` +
      `${question.replace(/\|/g, "/").slice(0, 90)} | (negative-citation eval — F3 live proof) | ` +
      `${justification.replace(/\|/g, "/")} | sub. ~$0.01 |\n`;
    appendFileSync("/home/codex/Projects/nucleus/docs/claude-call-log.md", row);
  } catch {
    /* best-effort */
  }
}

async function main() {
  const pdf = findPdf();
  if (!pdf) loudSkip(`No PDF fixture found under ${DATA_DIR} — cannot create a chat that HAS a document.`);

  const results = [];
  const check = (ok, label, detail = "") => {
    results.push({ ok: !!ok, label });
    console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${label}]${detail ? ` — ${detail}` : ""}`);
  };

  const browser = await launch();
  let ctx = null;
  let docId = null;
  const fixtureName = `neg-citation-fixture-${randomUUID().slice(0, 8)}.pdf`;
  const sessionId = randomUUID();

  try {
    const signedIn = await signIn(browser, "admin", "/dashboard");
    ctx = signedIn.ctx;
    const page = signedIn.page;
    await page
      .locator('[data-testid="assistant-console"]')
      .first()
      .waitFor({ state: "visible", timeout: 30000 })
      .catch(() => {});

    // ── SETUP: a chat that HAS a PDF. Upload via /api/ingest with a fresh session_id so the
    //    ONE ask below runs inside a chat that genuinely contains a document. (Evals may drive
    //    the API directly — the purity rule is a JOURNEY rule.)
    const pdfBytes = Array.from(readFileSync(pdf));
    const ingest = await page.evaluate(
      async ([base, name, bytes, sid]) => {
        const fd = new FormData();
        fd.append("file", new File([new Uint8Array(bytes)], name, { type: "application/pdf" }), name);
        fd.append("session_id", sid);
        const r = await fetch(`${base}/api/ingest`, { method: "POST", body: fd });
        return { status: r.status, ...(await r.json().catch(() => ({}))) };
      },
      [BASE, fixtureName, pdfBytes, sessionId]
    );
    docId = ingest?.ingested?.doc ?? null;
    check(
      ingest.status === 200 || ingest.status === 201,
      "setup: fixture PDF ingested into the chat (chat now HAS a document)",
      `status=${ingest.status} file=${fixtureName} docId=${docId ?? "(none)"}`
    );

    // ── THE ONE ASK: a pure general-knowledge question, in a chat that HAS a document.
    logSdkCall({
      model: MODEL,
      question: QUESTION,
      justification:
        "F3 live proof — a general-knowledge question in a chat that HAS a PDF must answer from " +
        "general knowledge WITHOUT fabricating a citation: grounded=false, 0 evidence chunks, " +
        "fixture filename absent. Haiku/low. Exactly 1 ask.",
    });
    const ask = await page.evaluate(
      async ([base, q, sid, model]) => {
        const r = await fetch(`${base}/api/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q, session_id: sid, model }),
        });
        return { status: r.status, ...(await r.json().catch(() => ({}))) };
      },
      [BASE, QUESTION, sessionId, MODEL]
    );

    const answer = (ask.answer ?? "").toString();
    const grounded = ask.grounded;
    const chunks = ask.evidence?.chunks?.length ?? 0;

    check(
      answer.trim().length > 0,
      "answer is non-empty (the general question is still answered)",
      `len=${answer.length} preview="${answer.slice(0, 60).replace(/\n/g, " ")}"`
    );
    check(
      grounded === false,
      "grounded === false (no false grounding floor — the core F3 assertion)",
      `grounded=${JSON.stringify(grounded)} model=${ask.model ?? "(none)"}`
    );
    check(
      chunks === 0,
      "evidence.chunks is EMPTY (no citation manufactured for the unused file)",
      `chunks=${chunks}`
    );
    check(
      !answer.includes(fixtureName),
      "answer does NOT name the fixture file (no fabricated file reference)",
      `fixture=${fixtureName}`
    );
  } finally {
    // Best-effort teardown: remove the uploaded fixture so the account keeps no residue.
    if (ctx && docId) {
      try {
        const page = (await ctx.pages())[0];
        if (page) {
          await page.evaluate(
            async ([base, id]) => {
              await fetch(`${base}/api/documents?doc=${encodeURIComponent(id)}&scope=upload`, {
                method: "DELETE",
              }).catch(() => {});
            },
            [BASE, docId]
          );
        }
      } catch {
        /* best-effort cleanup */
      }
    }
    await ctx?.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n${"═".repeat(72)}`);
  console.log(
    `NEGATIVE-CITATION (F3): ${results.length - fails.length}/${results.length} passed` +
      (fails.length ? ` · FAILED: ${fails.map((f) => f.label).join("; ")}` : " · ALL GREEN")
  );
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error("\nNEG-CITATION RUNNER ERROR:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
