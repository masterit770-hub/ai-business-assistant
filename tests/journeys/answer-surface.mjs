// JOURNEY — ANSWER SURFACE (the BOUNDED answer-quality set). PAID SDK calls.
//
// This is the ONLY module that asks the agent real questions. It is GATED behind
// NUCLEUS_RUN_SDK=1 and makes a PROVABLY BOUNDED number of agentic /api/ask calls:
// exactly the questions in QUESTIONS sliced to MAX_ASKS (default 3). The count is asserted
// at the end so it can NEVER silently exceed the cap. With the flag off it self-skips
// honestly (recorded as skipped, never green) so CI / plumbing runs spend $0.
//
// ⛔ COST DISCIPLINE (CLAUDE.md): run LOCALLY first (subscription = free) — prove all
// asks GREEN — then at most a single confirming pass on prod. NEVER a sweep. Each call is
// logged in docs/claude-call-log.md with its justification (why it's needed for the suite).
//
// The asks are answer-QUALITY (correctness), so they use the full Sonnet + Agent SDK config
// (the deployed default). They run in ONE persisted chat that already holds the corpus, so
// the rich questions reuse one set of uploaded files. Each asserts the REAL golden fact on
// the rendered answer (hasGoldenNumber / hasAllFacts) — a fluent-but-wrong answer FAILS.
//
// GOLDEN VALUES are ground-truthed from the client's real files (see docs/golden-bar.md /
// her-data-coverage.md). They are facts about the data, not numbers the test invented.
import {
  launch,
  signIn,
  makeRecorder,
  askAndWait,
  uploadFileBytes,
  fileBytes,
  hasGoldenNumber,
  hasAllFacts,
  BASE,
} from "./lib.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const RUN_SDK = process.env.NUCLEUS_RUN_SDK === "1";
// HARD CAP on paid asks — the suite can never exceed this no matter how QUESTIONS grows.
const MAX_ASKS = Math.min(Number(process.env.NUCLEUS_MAX_ASKS || 3), 3);

const DATA = "/home/codex/Projects/nucleus/data";
const FILES = {
  pdf: join(DATA, "📄 FAMILY COURT CASE FILE (MOCK) – FINAL VERSION.pdf"),
  xlsxJune: join(DATA, "שיבוצים יוני 2024 - סיון תשפד (1).xlsx"),
  csv: join(DATA, "school data 3.csv"),
};

// The rich, cross-document questions + their golden assertions. We select the first
// MAX_ASKS of these (default: Q1 leaderboard, Q2 Excel↔PDF cross, probe child-support).
// Each `assert(answer)` returns true iff the REAL golden fact is present.
const QUESTIONS = [
  {
    id: "Q1",
    covers: "A1,A3,A4,A7,A8 — cross-Excel participation leaderboard (Hebrew RTL)",
    text:
      "In the June scheduling grid, which PERSON is assigned the most times, and how many " +
      "times in total? Give the single most-scheduled person and their exact count. Do not " +
      "count activity cells (like flower-arranging) as people.",
    // Ground truth on the June grid: רינה אנטוב (Rina Antov) = 5 assignments (the top
    // person in the single June sheet). We assert the count AND the Hebrew name renders.
    assert: (a) => hasGoldenNumber(a, "5") && /רינה|אנטוב|Rina|Antov/i.test(a),
    evidence: "expect top person count=5 + a Hebrew/transliterated name",
  },
  {
    id: "Q2",
    covers: "A2,A5,A6 — Excel + PDF cross-reasoning (distinct people vs named children)",
    text:
      "How many children are NAMED in the family-court case file? List their first names. " +
      "Do not count the adults (the parents).",
    // Ground truth: 3 children — Emma, Noah, Olivia (Carter). Adults (Joni/Michel) excluded.
    assert: (a) => hasAllFacts(a, [/\b3\b|three/i, "Emma", "Noah", "Olivia"]),
    evidence: "expect 3 children: Emma, Noah, Olivia",
  },
  {
    id: "probe",
    covers: "A6,A11 — scanned/text-PDF readability end-to-end (Bug-1 proof)",
    text:
      "According to the family-court case file, what MONTHLY child-support amount was " +
      "ordered in the final judgment? Give the dollar figure.",
    // Ground truth: $1,285/month — lives deep in the PDF body (Final Judgment), in no
    // filename/metadata. A correct grounded answer can only come from text the doc lane
    // actually extracted + the agent read → independently confirms a READABLE PDF.
    assert: (a) => hasGoldenNumber(a, "1285"),
    evidence: "expect $1,285/month from the PDF Final Judgment",
  },
  {
    id: "Q3",
    covers: "A2,A9 — cross-CSV reasoning + full-column aggregate (truncated-window guard)",
    text:
      "How many total entries (rows) are in the maintenance tickets dataset I uploaded? " +
      "Give the exact row count.",
    // Ground truth: school data 3.csv (maintenance) has 750 data rows.
    assert: (a) => hasGoldenNumber(a, "750"),
    evidence: "expect 750 maintenance rows",
  },
];

export async function run() {
  const rec = makeRecorder("ANSWER-SURFACE");

  if (!RUN_SDK) {
    rec.info(
      "ANSWER-SURFACE SKIPPED — set NUCLEUS_RUN_SDK=1 to run the bounded paid answer-quality asks",
      `would run ${Math.min(QUESTIONS.length, MAX_ASKS)} of ${QUESTIONS.length} (cap=${MAX_ASKS}); skipped, not green`
    );
    // Honest skip: a summary with zero checks is neither pass nor fail noise.
    return rec.summary();
  }

  const selected = QUESTIONS.slice(0, MAX_ASKS);
  rec.info(`ANSWER-SURFACE will make EXACTLY ${selected.length} paid SDK ask(s) (cap=${MAX_ASKS})`, selected.map((q) => q.id).join(", "));

  const browser = await launch();
  let ctx, page;
  const uploadedIds = [];
  let askCount = 0; // provable counter — every askAndWait increments this exactly once.
  const sessionId = randomUUID();
  try {
    const signedIn = await signIn(browser, "admin", `/dashboard?session=${sessionId}`);
    ctx = signedIn.ctx;
    page = signedIn.page;
    await page.locator('[data-testid="assistant-console"]').waitFor({ state: "visible", timeout: 30000 });

    // ── ONE-TIME file prep: upload the corpus the rich asks share (scoped to this chat) ─
    const toUpload = [
      ["pdf", FILES.pdf, "application/pdf"],
      ["xlsx", FILES.xlsxJune, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["csv", FILES.csv, "text/csv"],
    ];
    for (const [, path, type] of toUpload) {
      if (!existsSync(path)) {
        rec.check(false, `setup: fixture present (${path})`, "missing");
        continue;
      }
      const r = await uploadFileBytes(page, {
        name: path.split("/").pop(),
        type,
        bytes: fileBytes(path),
        sessionId,
      });
      const id = r?.ingested?.doc ?? r?.ingested?.table ?? null;
      if (id) uploadedIds.push(id);
    }
    // Reload the chat so the freshly-uploaded files are in scope for the asks.
    await page.goto(`${BASE}/dashboard?session=${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.locator('[data-testid="assistant-console"]').waitFor({ state: "visible", timeout: 20000 });

    // ── The bounded paid asks ────────────────────────────────────────────────────────
    for (const q of selected) {
      askCount += 1; // count BEFORE the call so an exception still counts the attempt.
      await askAndWait(page, q.text, { timeout: 150000 });
      const answer = (await page.locator('[data-testid="answer"]').last().textContent().catch(() => "")) || "";
      const errCard = (await page.locator('[data-testid="ask-error"]').last().textContent().catch(() => "")) || "";
      const ok = !errCard && q.assert(answer);
      rec.check(
        ok,
        `${q.id}: ${q.covers}`,
        `golden=[${q.evidence}] ${errCard ? `error="${errCard.slice(0, 80)}"` : `answer="${answer.slice(0, 140).replace(/\n/g, " ")}"`}`
      );
    }

    // PROVABLE BOUND: the number of paid asks made must not exceed the cap.
    rec.check(
      askCount <= MAX_ASKS && askCount === selected.length,
      `BOUND: made exactly ${askCount} paid SDK ask(s), within the cap of ${MAX_ASKS}`,
      `askCount=${askCount} cap=${MAX_ASKS} selected=${selected.length}`
    );

    // RESIDUE: remove the uploaded corpus.
    for (const id of uploadedIds) {
      await page
        .evaluate(async ([i, base]) => {
          await fetch(`${base}/api/documents?doc=${encodeURIComponent(i)}&scope=upload`, { method: "DELETE" }).catch(() => {});
        }, [id, BASE])
        .catch(() => {});
    }
  } catch (e) {
    rec.check(false, "ANSWER-SURFACE completed without an unhandled error", (e.message || String(e)).slice(0, 200));
  } finally {
    await ctx?.close().catch(() => {});
    await browser.close();
  }
  return rec.summary();
}

// EXPORTED for the runner/CI to assert the provable upper bound WITHOUT making any call.
// The answer-journey makes at most this many agentic asks. (A7 Hebrew-RTL is covered inside
// Q1; A10 grounded-AND-recommend is covered by the committed recommendation-substance.mjs
// eval and is intentionally NOT re-run here to keep the paid count at MAX_ASKS.)
export const MAX_SDK_ASKS = MAX_ASKS;
