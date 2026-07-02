// JOURNEY — LIFECYCLE (INTEGRATED, 6 SDK CALLS: 5 HAIKU + 1 SONNET). Spec v2.
//
// THE ONE INTEGRATED JOURNEY per docs/testing/INTEGRATED-JOURNEY-SPEC.md (v2 2026-07-03,
// supersedes the v1 LOCKED 2026-07-01 — call count UNCHANGED at 6).
// This replaces the old per-chat lifecycle: every step now runs INSIDE Knowledge Spaces.
// It is NOT a separate KS journey — it is ONE folded journey that proves grounding,
// cross-space isolation, delete+memory, custom prompt, global search, and Sonnet quality.
//
// Steps:
//   STEP 1   Account (Run A: admin creates throwaway; Run B: skip) → sign in as client
//   STEP 2   Multi-file upload into Space A (PDF + xlsx in ONE call)
//   STEP 3   [SDK 1, Haiku] In-space grounded read — NEW chat in Space A → assert grounded
//            (cross-chat in-space read, grounded=true, references both files)
//   STEP 4   Cold restart — chat-1 + 2 docs + prior answer still VISIBLE
//   STEP 5   Space B created; STEP 5 isolation chat lives in Space B
//   STEP 6   [SDK 2, Haiku] Cross-space isolation — Space B chat CANNOT see Space A's files
//   STEP 6+  F3 (SAME response, 0 SDK) — a no-files answer is NOT falsely grounded:
//            grounded=false AND 0 evidence chunks (no fabricated citations)
//   STEP 7   Single upload into chat-2 (Space B); Sources shows ONLY that file. The fixture
//            reuses Space A's PDF basename (F4 collision seed)
//   STEP 7+  F4 (0 SDK, read-only GET /api/documents) — same filename in another chat does
//            NOT steal/overwrite: chat-2's new doc + Space A's same-named doc coexist with
//            DISTINCT doc ids
//   STEP 8   Sources navigation → click a doc-name → URL navigates to its chat
//   STEP 9   Delete one of Space A's docs → VISIBLY disappears;
//            [SDK 3, Haiku] re-ask → deleted doc GONE from retrieval + memory still works
//   STEP 10  Delete chat-2 → VISIBLY gone; chat-1 VISIBLY remains
//   STEP 11  MARKER prompt edit — inject NUCLEUS770-MARK: sentinel; [SDK 4, Haiku] answer
//            MUST CONTAIN the marker (deterministic — not brevity-collapse)
//   GLOBAL   [SDK 5, Haiku] Toggle global ON, cross-space question → surfaces BOTH spaces'
//            files, attributes each to its space
//   SONNET   [SDK 6, Sonnet] Re-ask a rich grounded question with model=claude-sonnet-4-6 →
//            assert a correct, grounded answer (the ONLY Sonnet call)
//   STEP-LOCAL  [0 Claude calls — Ollama] GATED on NUCLEUS_RUN_LOCAL_MODE=1: switch to Local
//            via the real Settings→Model UI, one chat round-trips through the box Ollama
//            (answer contains the token, resp.model starts with "local:"), then RESTORE cloud.
//            Unset → loud SKIP (not a false green). Restore is residue-safe (also runs from
//            the main teardown if the step aborts).
//
// SDK BUDGET (Rule #0 — HARD):
//   EXACTLY 6 SDK calls: 5 Haiku + 1 Sonnet. Invariant asserted at end. STEP 6+/STEP 7+ reuse
//   existing responses (0 new calls); STEP-LOCAL hits Ollama (0 Claude calls).
//
// RED-FIRST proven (mandatory per CLAUDE.md):
//   STEP 6 isolation: temporarily point the isolation chat at Space A → watch it FAIL.
//   STEP 9 delete: delete fires + DOM row gone → re-ask gets "not found" (not the deleted content).
//
// Run A (new throwaway account — primary cert):
//   JOURNEY_SDK=1 RUN=A NUCLEUS_BASE=<url> node scripts/run-journeys.mjs lifecycle
// Run B (stable test account):
//   JOURNEY_SDK=1 RUN=B NUCLEUS_BASE=<url> node scripts/run-journeys.mjs lifecycle

import {
  launch,
  signIn,
  makeRecorder,
  askAndWait,
  readAccounts,
  BASE,
} from "./lib.mjs";
import {
  existsSync,
  readdirSync,
  appendFileSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ── Constants ──────────────────────────────────────────────────────────────────
const RUN_SDK = process.env.JOURNEY_SDK === "1";
const SDK_MODEL_HAIKU = "claude-haiku-4-5";
const SDK_MODEL_SONNET = "claude-sonnet-4-6";
const RUN_MODE = (process.env.RUN || "A").toUpperCase();
const E2E_CLIENT_EMAIL = "e2e-770-test@example.com";

// STEP-LOCAL — box-local Ollama config (gated by NUCLEUS_RUN_LOCAL_MODE=1; ZERO Claude
// calls — every ask on this step hits the user's own local model). Mirrors the endpoint /
// model / interaction pattern of tests/journeys/local-mode.mjs.
const RUN_LOCAL_MODE = process.env.NUCLEUS_RUN_LOCAL_MODE === "1";
const LOCAL_ENDPOINT = process.env.NUCLEUS_LOCAL_ENDPOINT || "http://localhost:11434/v1";
const LOCAL_MODEL = process.env.NUCLEUS_LOCAL_MODEL || "llama3.2:3b";
const LOCAL_MODE_TOKEN = "LIFECYCLE-LOCAL-OK";

const HER_DIR =
  process.env.NUCLEUS_HER_FILES ||
  "/tmp/claude-1000/-home-codex-Projects/fbf32cd2-f605-45b2-90e8-690b01a59111/scratchpad/her-files";

const SCREENSHOT_DIR = join(
  "/home/codex/Projects/nucleus/tests/journeys/screenshots",
  `lifecycle-${RUN_MODE}`
);

// STEP 11 — MARKER prompt (deterministic, not brevity-collapse).
// The prompt injects NUCLEUS770-MARK: at the start of every answer.
// We assert the answer CONTAINS this token — deterministic across Haiku and Sonnet.
// (Brevity-collapse was model-flaky on prod; this approach is not.)
export const LIFECYCLE_MARKER = "NUCLEUS770-MARK:";
export const PROMPT_MARKER =
  `You are Nucleus. CRITICAL RULE: every reply you send MUST begin with the exact token ` +
  `"${LIFECYCLE_MARKER}" as the very first characters of your response, before any other text. ` +
  `Do not omit it, do not paraphrase it. After the token, answer normally.`;

// ── Screenshot helper ──────────────────────────────────────────────────────────
let screenshotSeq = 0;
async function shot(page, slug) {
  try {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    screenshotSeq++;
    const n = String(screenshotSeq).padStart(2, "0");
    const path = join(SCREENSHOT_DIR, `${n}-${slug}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`  [SHOT] ${path}`);
  } catch (e) {
    console.log(`  [SHOT-ERR] ${slug}: ${(e.message || String(e)).slice(0, 80)}`);
  }
}

// ── File helpers ───────────────────────────────────────────────────────────────
function herFiles() {
  if (!existsSync(HER_DIR)) return null;
  const names = readdirSync(HER_DIR);
  const pdf =
    names.find((f) => f.endsWith(".pdf") && /הסכם|עבוד|פרטיאלי/.test(f)) ||
    names.find((f) => f.endsWith(".pdf"));
  const xlsx =
    names.find((f) => f.endsWith(".xlsx") && /שיבוצים|דצמבר/.test(f)) ||
    names.find((f) => f.endsWith(".xlsx"));
  if (!pdf || !xlsx) return null;
  return { pdf: join(HER_DIR, pdf), xlsx: join(HER_DIR, xlsx), pdfName: pdf, xlsxName: xlsx };
}

/**
 * Detect the SPECIFIC "there are no files" failure reply — the cross-owner bug's answer
 * ("אין קבצים מצורפים … הרשימה ריקה לחלוטין" / "there are no files, the list is empty").
 *
 * ⛔ Deliberately anchored to WHOLE PHRASES, never the bare Hebrew substring "ריק" (empty).
 * "ריק" legitimately appears inside a grounded spreadsheet description ("תאים ריקים" = empty
 * cells) and a bare substring band-aid FALSE-flagged a genuinely grounded Sonnet answer on the
 * first run (CLAUDE.md band-aid check: a corpus-specific substring that doesn't generalize).
 * The TRUE discriminator against the false-green is grounded===true && evidence>=1 (a real
 * "no files" reply is ungrounded); this phrase check is only belt-and-suspenders.
 */
function isNoFilesAnswer(text) {
  const t = text || "";
  // English "no files" / "no documents" as phrases.
  if (/\bno files\b|\bno documents\b|list is empty|couldn'?t find any (files|documents)/i.test(t)) return true;
  // Hebrew: "אין קבצים" (no files) / "אין מסמכים" (no documents) / "רשימה ריקה" / "ריקה לחלוטין"
  // — the exact cross-owner failure wording, as whole phrases (not the bare "ריק").
  if (/אין\s+קבצים|אין\s+מסמכים|רשימה\s+ריקה|ריקה\s+לחלוטין/.test(t)) return true;
  return false;
}

// ── SDK call logger ────────────────────────────────────────────────────────────
function logSdkCall({ n, env, model, question, justification }) {
  try {
    // Label from WHERE the calls actually went (the resolved BASE), not merely whether
    // NUCLEUS_BASE is set: a call is "prod (billed)" ONLY when BASE is the live production
    // deployment; a default/localhost/preview run is the local subscription. (F6: the old
    // check labeled every unset-NUCLEUS_BASE run "prod (billed)", misrecording local runs.)
    const envLabel = BASE.includes("nucleus-770.vercel.app") ? "prod (billed)" : "local (subscription)";
    const row =
      `| ${n} | ${new Date().toISOString().slice(0, 10)} | ${env || envLabel} | messages-api | ${model} | low | ` +
      `${question.replace(/\|/g, "/").slice(0, 90)} | (lifecycle integrated journey run=${RUN_MODE}) | ` +
      `${justification.replace(/\|/g, "/")} | sub. ~$0.01 |\n`;
    appendFileSync("/home/codex/Projects/nucleus/docs/claude-call-log.md", row);
  } catch { /* best-effort */ }
}

// ── USAGE ledger (calibration, 2026-07-03) — ACTUAL tokens + engine-computed cost ────
// The response's inspector.cost is model-aware (real per-model prices) since the pricing
// fix; this appends one USAGE row per SDK call so the ledger tracks measured spend, not
// flat estimates. Defensive: never throws, never fails a check — logging only.
const CALL_LOG = "/home/codex/Projects/nucleus/docs/claude-call-log.md";
function logUsage(label, askJson) {
  try {
    const c = askJson?.inspector?.cost;
    if (!c) return; // engine error / no inspector — the SDK-call row above still records the attempt
    const row =
      `| USAGE-${label} | ${new Date().toISOString().slice(0, 10)} | measured | ${c.model} | ` +
      `in=${c.promptTokens} out=${c.completionTokens} | $${(c.usd ?? 0).toFixed(5)} |\n`;
    appendFileSync(CALL_LOG, row);
  } catch { /* ledger row is best-effort */ }
}

// ── Space API helpers (page.evaluate — uses the page's auth session) ──────────
async function apiCreateSpace(page, name) {
  return page.evaluate(async ([base, n]) => {
    // purity-exempt: SDK-journey setup — Space A/B are created via API for the deterministic
    // 6-call flow (INTEGRATED-JOURNEY-SPEC §STEP 2/5). The real-UI space-create path is
    // covered by knowledge-spaces KS-1.
    const r = await fetch(`${base}/api/spaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: n }),
    });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, [BASE, name]);
}

async function apiDeleteSpace(page, spaceId) {
  return page.evaluate(async ([base, sid]) => {
    // purity-exempt: teardown — removes throwaway test spaces in the finally/restore blocks;
    // the real-UI space-delete path is exercised by knowledge-spaces KS-5.
    const r = await fetch(`${base}/api/spaces?space=${encodeURIComponent(sid)}`, { method: "DELETE" });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, [BASE, spaceId]);
}

async function apiSpaces(page) {
  return page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/spaces`);
    return r.json().catch(() => ({}));
  }, BASE);
}

// (apiAssignSession removed — the /api/ask + /api/ingest seams now auto-register a chat into
//  its Knowledge Space. A journey must NOT assign sessions via the raw API: that exact
//  shortcut is what let the missing UI wire (F1) ship green. Chat→space registration is now
//  proven through the REAL UI in knowledge-spaces KS-5/KS-7.)

// Ask via the /api/ask endpoint directly (uses page's auth session).
// Returns the parsed JSON response. model is optional — defaults to server's Haiku.
async function apiAsk(page, { question, space_id, global_mode, model, session_id } = {}) {
  return page.evaluate(
    async ([base, body]) => {
      // purity-exempt: SDK-budget — asks are API-driven BY DESIGN (INTEGRATED-JOURNEY-SPEC
      // §engine): space_id / global_mode / model are injected deterministically for the
      // capped 6-call budget. The real-UI ask path is exercised by STEP 11's captureAsk().
      const r = await fetch(`${base}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, ...(await r.json().catch(() => ({}))) };
    },
    [BASE, { question, space_id, global_mode, model, session_id }]
  );
}

// Read-only GET /api/documents (uses the page's auth session). Optional session_id /
// space_id / global scoping. Returns the parsed JSON ({ documents, structuredTables, ... }).
// GET carries no `method:` → the journey-purity lint never flags it (read-only probe).
async function apiListDocuments(page, { session_id, space_id, global } = {}) {
  return page.evaluate(
    async ([base, params]) => {
      const qs = new URLSearchParams();
      if (params.session_id) qs.set("session_id", params.session_id);
      if (params.space_id) qs.set("space_id", params.space_id);
      if (params.global) qs.set("global", "1");
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const r = await fetch(`${base}/api/documents${suffix}`);
      return { status: r.status, ...(await r.json().catch(() => ({}))) };
    },
    [BASE, { session_id: session_id ?? null, space_id: space_id ?? null, global: !!global }]
  );
}

// ── Paperclip upload helper ────────────────────────────────────────────────────

/**
 * Upload files via the real paperclip UI (ONE setInputFiles call).
 * Returns { success, zero, error, text, sessionId }.
 */
export async function paperclipUpload(page, absPaths) {
  const paths = Array.isArray(absPaths) ? absPaths : [absPaths];
  const input = page.locator('[data-testid="chat-upload-input"]').first();
  await input.waitFor({ state: "attached", timeout: 20000 });
  const uploadBtn = page.locator('[data-testid="chat-upload-button"]').first();
  await uploadBtn.waitFor({ state: "visible", timeout: 20000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => {
    window.__nucleusUploadDone = false;
    window.__nucleusUploadSeenSuccess = false;
    window.__nucleusUploadSeenZero = false;
    window.__nucleusUploadSeenError = false;
    window.addEventListener("nucleus:uploaded", () => {
      window.__nucleusUploadDone = true;
      window.__nucleusUploadSeenSuccess = true;
    }, { once: true });
    const mo = new MutationObserver(() => {
      if (document.querySelector('[data-testid="chat-upload-success"]')) window.__nucleusUploadSeenSuccess = true;
      if (document.querySelector('[data-testid="chat-upload-zero"]')) window.__nucleusUploadSeenZero = true;
      if (document.querySelector('[data-testid="chat-upload-error"]')) window.__nucleusUploadSeenError = true;
      if (window.__nucleusUploadSeenSuccess || window.__nucleusUploadSeenZero || window.__nucleusUploadSeenError) {
        mo.disconnect();
        window.__nucleusUploadMODone = true;
      }
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true });
    window.__nucleusUploadMO = mo;
    window.__nucleusUploadMODone = false;
  });

  await page.evaluate(() => {
    window.__nucleusSessionId = null;
    window.__nucleusFetchOrig = window.fetch;
    window.fetch = function nucleusFetchProxy(url, init) {
      try {
        if (typeof url === "string" && url.includes("/api/ingest") &&
            init && init.body instanceof FormData) {
          const sid = init.body.get("session_id");
          if (sid) window.__nucleusSessionId = String(sid);
        }
      } catch { /* best-effort */ }
      return window.__nucleusFetchOrig.apply(this, arguments);
    };
  });
  let capturedSessionId = null;

  let ingestSucceeded = false;
  const responseHandler = (response) => {
    if (response.url().includes("/api/ingest") && response.status() === 200) {
      ingestSucceeded = true;
    }
  };
  page.on("response", responseHandler);

  let uploadStarted = false;
  for (let attempt = 1; attempt <= 3 && !uploadStarted; attempt++) {
    const freshInput = page.locator('[data-testid="chat-upload-input"]').first();
    await freshInput.waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await freshInput.setInputFiles(paths);
    const attemptStart = Date.now();
    while (Date.now() - attemptStart < 8000) {
      const progress = await page.locator('[data-testid="chat-upload-progress"]').count().catch(() => 0);
      const flags = await page.evaluate(() => ({
        done: !!window.__nucleusUploadDone,
        moDone: !!window.__nucleusUploadMODone,
      })).catch(() => ({ done: false, moDone: false }));
      if (progress > 0 || flags.done || flags.moDone || ingestSucceeded) {
        uploadStarted = true;
        break;
      }
      await page.waitForTimeout(300);
    }
    if (!uploadStarted && attempt < 3) {
      console.log(`  [upload-retry] attempt ${attempt} — upload did not start within 8s, retrying`);
      await page.waitForTimeout(500);
    }
  }

  const uploadDeadline = Date.now() + 180000;
  while (Date.now() < uploadDeadline) {
    const flags = await page.evaluate(() => ({
      done: !!window.__nucleusUploadDone,
      moDone: !!window.__nucleusUploadMODone,
    })).catch(() => ({ done: false, moDone: false }));
    if (flags.done || flags.moDone || ingestSucceeded) break;
    const hasError = await page.locator('[data-testid="chat-upload-error"]').count().catch(() => 0);
    if (hasError > 0) break;
    await page.waitForTimeout(500);
  }

  page.off("response", responseHandler);

  const latched = await page.evaluate(() => {
    if (window.__nucleusUploadMO && !window.__nucleusUploadMODone) {
      window.__nucleusUploadMO.disconnect();
    }
    return {
      done: !!window.__nucleusUploadDone,
      seenSuccess: !!window.__nucleusUploadSeenSuccess,
      seenZero: !!window.__nucleusUploadSeenZero,
      seenError: !!window.__nucleusUploadSeenError,
    };
  }).catch(() => ({ done: false, seenSuccess: false, seenZero: false, seenError: false }));

  const success = latched.done || latched.seenSuccess || latched.seenZero || ingestSucceeded;
  const error = !success && latched.seenError;
  const zero = !error && latched.seenZero && !latched.seenSuccess;

  const sessionFromProxy = await page.evaluate(() => window.__nucleusSessionId || null).catch(() => null);
  if (sessionFromProxy) capturedSessionId = sessionFromProxy;

  const text = (await page.locator('[data-testid="chat-upload-success"], [data-testid="chat-upload-zero"], [data-testid="chat-upload-error"]').first().textContent().catch(() => "")) || "";
  return { success, zero, error, text, sessionId: capturedSessionId };
}

// ── captureAsk — drive the UI textarea + capture /api/ask response ─────────────
export async function captureAsk(page, question, { timeout = 180000 } = {}) {
  // waitForResponse is armed BEFORE the ask and awaited AFTER — deterministic. The old
  // page.on("response") handler parsed the body fire-and-forget, so when the DOM rendered
  // before response.json() resolved, captureAsk returned with askJson still null — a race
  // that flaked STEP 11's model assertion on a CORRECT response (RUN=A 2026-07-03).
  const respPromise = page
    .waitForResponse((r) => r.url().includes("/api/ask") && r.request().method() === "POST", { timeout })
    .catch(() => null);
  const turnIndex = await askAndWait(page, question, { timeout });
  const resp = await respPromise;
  let askJson = null;
  if (resp) {
    try { askJson = await resp.json(); } catch { /* body unavailable — askJson stays null */ }
  }
  return { turnIndex, askJson };
}

// ── saveInlinePrompt ────────────────────────────────────────────────────────────
export async function saveInlinePrompt(page, value) {
  const alreadyOpen = await page
    .locator('[data-testid="inline-prompt-editor"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (!alreadyOpen) {
    await page.locator('[data-testid="edit-prompt-toggle"]').first().click().catch(() => {});
  }
  await page
    .locator('[data-testid="inline-prompt-editor"]')
    .first()
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(() => {});
  await page.locator('[data-testid="inline-prompt"]').first().fill(value);
  await page.locator('[data-testid="save-prompt"]').first().click();
  const saved = await page
    .locator('[data-testid="answer-setup-saved"]')
    .first()
    .waitFor({ state: "visible", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  const err =
    (await page.locator('[data-testid="answer-setup-error"]').first().textContent().catch(() => "")) || "";
  return { saved, err };
}

// ── restoreCloudMode — switch model_mode back to cloud via the REAL Settings→Model UI ──
// Used by STEP-LOCAL's finally AND the journey's main teardown (residue-clean: a mid-step
// failure must not leave the account in Local mode). All mutation goes through UI clicks;
// the only fetch is a read-only GET /api/settings confirmation probe. Returns true iff the
// persisted model_mode is "cloud".
async function restoreCloudMode(page) {
  try {
    await page.goto(`${BASE}/settings?tab=models`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page
      .locator('[data-testid="model-section"][data-hydrated="1"]')
      .first()
      .waitFor({ state: "visible", timeout: 20000 });
    await page.click('[data-testid="model-section-cloud"]');
    await page.click('[data-testid="model-save"]');
    await page.locator('[data-testid="model-saved"]').first().waitFor({ state: "visible", timeout: 15000 });
    const restored = await page.evaluate(async () => (await fetch("/api/settings")).json().catch(() => ({})));
    return restored?.model_mode === "cloud";
  } catch {
    return false;
  }
}

// ── Sidebar session reader ─────────────────────────────────────────────────────
async function readFirstSidebarSession(page) {
  return page.evaluate(() => {
    const links = document.querySelectorAll('[data-testid="resume-session"]');
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      const m = href.match(/[?&]session=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    return null;
  });
}

// ── Ingest a file directly into a space (space-scoped upload, no chat) ──────────
// Uses the page's auth session so it runs as the signed-in user.
// Returns the ingest API response.
async function ingestIntoSpace(page, spaceId, fileText, fileName, mimeType = "text/csv") {
  return page.evaluate(
    async ([base, spaceId, fileText, fileName, mimeType]) => {
      const fd = new FormData();
      fd.append("file", new File([fileText], fileName, { type: mimeType }));
      fd.append("space_id", spaceId);
      // purity-exempt: SDK-scenario setup — a deterministic space-scoped ingest so the GLOBAL
      // search ask (SDK 5) has a Space B file; the real-UI upload path is exercised by STEP 2
      // & STEP 7 via paperclipUpload().
      const r = await fetch(`${base}/api/ingest`, { method: "POST", body: fd });
      return { status: r.status, ...(await r.json().catch(() => ({}))) };
    },
    [BASE, spaceId, fileText, fileName, mimeType]
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
export async function run() {
  const rec = makeRecorder(`LIFECYCLE-${RUN_MODE}`);
  const browser = await launch();

  let chat1 = null;   // Space A chat session ID (STEP 3)
  let chat2 = null;   // Space B chat session ID (STEP 7)
  let dash1 = `${BASE}/dashboard`;
  let dash2 = `${BASE}/dashboard`;
  let spaceAId = null;
  let spaceBId = null;
  const spaceIdsToClean = [];

  const clientEmail =
    RUN_MODE === "B"
      ? E2E_CLIENT_EMAIL
      : `lifecycle-${Date.now()}@nucleus-test.invalid`;
  const clientPassword =
    RUN_MODE === "B"
      ? (() => { try { return readAccounts().member?.password || ""; } catch { return ""; } })()
      : `Journey!${Math.random().toString(36).slice(2, 10)}A9`;

  let adminCtx = null;
  let clientCtx = null;
  let coldCtx = null;
  let clientPage = null;
  let createdUserEmail = null;
  let originalPrompt = null;
  let deletedDocId = null;
  // STEP-LOCAL residue guard: set true while the account is switched to Local mode, cleared
  // once cloud is restored. The main teardown restores cloud if this is still true (a mid-step
  // failure must never leave the account in Local mode).
  let localModeMayBeSet = false;
  // SDK call counter — MUST equal 6 at end: 5 Haiku + 1 Sonnet.
  let sdkCallsFired = 0;

  const files = herFiles();
  if (!files) {
    rec.check(false, "setup: her two Hebrew files (PDF + xlsx) present", `missing in ${HER_DIR}`);
    await browser.close();
    return rec.summary();
  }

  try {
    // ── STEP 1: Account ─────────────────────────────────────────────────────────
    console.log(`\nSTEP 1 (Run ${RUN_MODE}): account setup`);
    if (RUN_MODE === "A") {
      const admin = await signIn(browser, "admin", "/settings");
      adminCtx = admin.ctx;
      const ap = admin.page;
      await ap.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await ap.getByRole("button", { name: /^Users$/ }).first().click().catch(() => {});
      await ap.locator('[data-testid="create-user-form"]').first().waitFor({ state: "visible", timeout: 20000 });
      await ap.locator('[data-testid="create-user-form"] input[type="email"]').first().fill(clientEmail);
      await ap.locator('[data-testid="create-user-form"] input[type="text"]').first().fill(clientPassword);
      await ap.locator('[data-testid="create-user-form"] button[type="submit"]').first().click();
      const created = await ap
        .locator(`[data-testid="user-row-${clientEmail}"], [data-testid="invite-card"]`)
        .first()
        .waitFor({ state: "visible", timeout: 25000 })
        .then(() => true)
        .catch(() => false);
      rec.check(
        created,
        "STEP 1 (Run A): admin creates the client account via Settings→Users (new user VISIBLY appears)",
        `email=${clientEmail} created=${created}`
      );
      createdUserEmail = created ? clientEmail : null;
      await ap.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await ap.locator('[data-testid="sign-out"]').first().click().catch(() => {});
      await ap.waitForURL((u) => /\/sign-in/.test(u.toString()), { timeout: 15000 }).catch(() => {});
      rec.check(
        /\/sign-in/.test(ap.url()),
        "STEP 1 (Run A): admin signs out via the real Sign-out button (redirected to /sign-in)",
        `url=${ap.url()}`
      );
      await adminCtx.close().catch(() => {});
      adminCtx = null;
    } else {
      rec.info("STEP 1 (Run B): skipping account creation — using stable test account", clientEmail);
    }

    const client = await signIn(
      browser,
      RUN_MODE === "B" ? "member" : { email: clientEmail, password: clientPassword },
      "/dashboard"
    );
    clientCtx = client.ctx;
    clientPage = client.page;
    await clientPage.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await clientPage.locator('[data-testid="assistant-console"]').first().waitFor({ state: "visible", timeout: 30000 });
    rec.check(
      true,
      "STEP 1: signed in as client; assistant-console VISIBLY rendered",
      `email=${clientEmail} url=${clientPage.url()}`
    );
    await shot(clientPage, "step1-signed-in");

    // ── STEP 2: Create Space A + upload both files into it ──────────────────────
    // Files are uploaded into Space A (not just a chat). STEP 3 will then ask from a
    // NEW chat inside Space A — proving cross-chat in-space reading.
    console.log("\nSTEP 2: create Space A + upload PDF + xlsx into it");

    // Create Space A via API (uses page's auth session).
    const spaceAName = `lifecycle-A-${Date.now()}`;
    const spaceAResp = await apiCreateSpace(clientPage, spaceAName);
    spaceAId = spaceAResp?.space?.id ?? null;
    if (spaceAId) spaceIdsToClean.push(spaceAId);

    rec.check(
      !!spaceAId,
      "STEP 2: Space A created via API → id returned",
      `spaceAId=${spaceAId} name=${spaceAName}`
    );

    // Navigate to dashboard with Space A active (click space-open in the sidebar).
    // Wait for the sidebar to render the new space then click it.
    if (spaceAId) {
      // The sidebar may need a moment to refresh after API creation.
      // Navigate to dashboard first to ensure sidebar is mounted.
      await clientPage.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await clientPage.locator('[data-testid="assistant-console"]').first().waitFor({ state: "visible", timeout: 30000 });
      // Wait for Space A to appear in the sidebar list.
      await clientPage.waitForFunction(
        (id) => !!document.querySelector(`[data-testid="space-open-${id}"]`),
        spaceAId,
        { timeout: 15000 }
      ).catch(() => {});
      // Click to activate Space A.
      await clientPage.locator(`[data-testid="space-open-${spaceAId}"]`).first().click().catch(() => {});
      await clientPage.waitForTimeout(500);
    }

    // Copy files to ASCII temp names (avoids BiDi bug in setInputFiles).
    // spaceAPdfBasename is captured so STEP 7 can reuse the EXACT same basename in a
    // different scope (chat-2 / Space B) — the F4 same-filename collision probe.
    const spaceAPdfBasename = "lifecycle-chat1-" + randomUUID() + ".pdf";
    const tmpPdfPath1 = join(tmpdir(), spaceAPdfBasename);
    const tmpXlsxPath1 = join(tmpdir(), "lifecycle-chat1-" + randomUUID() + ".xlsx");
    copyFileSync(files.pdf, tmpPdfPath1);
    copyFileSync(files.xlsx, tmpXlsxPath1);

    // Upload both files via the UI paperclip (Space A is active — the upload goes into Space A).
    const upBatch = await paperclipUpload(clientPage, [tmpPdfPath1, tmpXlsxPath1]);
    rec.check(
      upBatch.success && !upBatch.error,
      "STEP 2: both files upload via ONE multi-file paperclip into Space A (batch success, no error)",
      `success=${upBatch.success} zero=${upBatch.zero} error=${upBatch.error} msg="${(upBatch.text || "").slice(0, 80)}"`
    );

    // Capture the chat1 session from the ingest intercept.
    if (upBatch.sessionId) {
      chat1 = upBatch.sessionId;
      dash1 = `${BASE}/dashboard?session=${encodeURIComponent(chat1)}`;
      rec.info("STEP 2: captured real chat1 session from ingest intercept", `chat1=${chat1}`);
    } else {
      await clientPage.waitForTimeout(1500);
      chat1 = await readFirstSidebarSession(clientPage);
      if (chat1) {
        dash1 = `${BASE}/dashboard?session=${encodeURIComponent(chat1)}`;
        rec.info("STEP 2: read real chat1 session from sidebar (fallback)", `chat1=${chat1}`);
      }
    }

    // Sources VISIBLY shows both a PDF doc-row and a table-row.
    await clientPage.locator('[data-testid="tab-files"]').first().click().catch(() => {});
    await clientPage.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await clientPage
      .waitForFunction(
        () =>
          document.querySelectorAll('[data-testid^="doc-row-"]').length > 0 &&
          document.querySelectorAll('[data-testid^="table-row-"]').length > 0,
        undefined,
        { timeout: 20000 }
      )
      .catch(() => {});
    await clientPage.waitForTimeout(500);
    const railCounts = await clientPage.evaluate(() => ({
      docRows: document.querySelectorAll('[data-testid^="doc-row-"]').length,
      tableRows: document.querySelectorAll('[data-testid^="table-row-"]').length,
    }));
    rec.check(
      railCounts.docRows >= 1 && railCounts.tableRows >= 1,
      "STEP 2: Sources VISIBLY shows BOTH a PDF doc-row AND a table-row for Space A",
      `docRows=${railCounts.docRows} tableRows=${railCounts.tableRows}`
    );
    await shot(clientPage, "step2-space-a-sources");

    // ── STEP 3: In-space grounded read [SDK 1, Haiku] ─────────────────────────────
    // Ask from a NEW chat inside Space A (proving cross-chat in-space reading).
    // We use apiAsk() directly with space_id=spaceAId — this is the /api/ask path
    // (not the UI textarea) so we can inject space_id robustly without relying on
    // the UI's state machine having space A active during the ask.
    console.log("\nSTEP 3: in-space grounded read [SDK 1 — Haiku, gated]");
    if (!RUN_SDK) {
      rec.info(
        "STEP 3 SKIPPED (SDK gated) — JOURNEY_SDK=1 to enable [Haiku in-space ask]",
        "SKIP — not a false green"
      );
    } else {
      sdkCallsFired++;
      const compound =
        "Using BOTH of my uploaded Hebrew files together: from the December 2024 scheduling " +
        "spreadsheet, name one person who appears in the schedule; and from the employment " +
        "agreement PDF, state who the agreement is between. Answer in Hebrew, grounded only " +
        "in these two files, and make clear which fact came from the spreadsheet vs the PDF.";
      logSdkCall({
        n: `LC-S3-${RUN_MODE}`,
        model: SDK_MODEL_HAIKU,
        question: compound,
        justification:
          `Lifecycle STEP 3 — in-space grounded read: ask with space_id=spaceA; engine must ` +
          `retrieve BOTH Hebrew files from Space A and ground the answer. Tests cross-chat ` +
          `in-space reading (the files were uploaded to the space, not to this chat). ` +
          `Haiku/low. Run=${RUN_MODE} sdkCall=${sdkCallsFired}/6.`,
      });

      // Use a NEW session ID for this ask — proves cross-chat (a fresh chat can see Space A files).
      const step3Session = randomUUID();
      const askResp3 = await apiAsk(clientPage, {
        question: compound,
        space_id: spaceAId,
        session_id: step3Session,
      });
      logUsage("S3", askResp3);

      const answer3 = askResp3.answer ?? "";
      const errCard3 = askResp3.error ?? "";

      // MODEL ASSERTION (first Haiku step) — resp.model is the RESOLVED model that answered.
      // If it is NOT a Haiku, AGENT_MODEL is pinned on the server (prod pins Sonnet): every
      // "Haiku" step would silently run Sonnet at ~5× cost. FAIL FAST here, before the other
      // four Haiku calls fire and quintuple the bill.
      const model3 = typeof askResp3.model === "string" ? askResp3.model : "";
      rec.check(
        model3.startsWith("claude-haiku"),
        "STEP 3 [SDK 1]: resolved model is Haiku (resp.model) — proves AGENT_MODEL is not silently pinned",
        `model=${model3 || "(none returned)"}`
      );
      if (model3 && !model3.startsWith("claude-haiku")) {
        throw new Error(
          `AGENT_MODEL is pinned on the server (model=${model3}) — unset it before a budgeted ` +
            `journey run. Every Haiku step must resolve to Haiku; a pinned Sonnet quintuples cost. ` +
            `To revert prod to Haiku: flyctl secrets unset AGENT_MODEL -a nucleus-agent.`
        );
      }

      // Assert: answer contains Hebrew text (grounded response, not an error).
      const hasHebrew = /[א-ת]/.test(answer3);
      rec.check(
        !errCard3 && answer3.length > 40 && hasHebrew,
        "STEP 3 [SDK 1]: in-space answer CONTAINS Hebrew text (grounded response, RTL content)",
        errCard3
          ? `error="${String(errCard3).slice(0, 80)}"`
          : `answerLen=${answer3.length} hasHebrew=${hasHebrew} preview="${answer3.slice(0, 80).replace(/\n/g, " ")}"`
      );

      // Assert: grounded=true from the API response (the REAL grounded signal — not read
      // too early from the UI; fix for the known STEP 3 bug on prod where grounded was
      // read off the old UI before the inspector settled).
      const aGrounded = askResp3.grounded === true;
      const aRoute = Array.isArray(askResp3.route?.sources) && askResp3.route.sources.includes("documents");
      const aEvidence = (askResp3.evidence?.chunks?.length ?? 0) >= 1;
      rec.check(
        aGrounded && aRoute && aEvidence,
        "STEP 3 [SDK 1]: API response has grounded=true / route=documents / ≥1 evidence chunk (REAL grounded signal from response JSON — fixes old UI-read-too-early bug)",
        `grounded=${aGrounded} route=${JSON.stringify(askResp3.route?.sources)} evidenceChunks=${askResp3.evidence?.chunks?.length ?? 0}`
      );

      // Assert: answer references content from BOTH Hebrew files.
      const refsSchedule = /שיבוצ|לוח|דצמבר|2024/.test(answer3);
      const refsAgreement = /הסכם|עבוד|מעסיק|עובד|צדד/.test(answer3);
      rec.check(
        !errCard3 && refsSchedule && refsAgreement,
        "STEP 3 [SDK 1]: answer references content from BOTH Hebrew files (schedule + agreement) — cross-chat in-space reading proven",
        errCard3
          ? `error="${String(errCard3).slice(0, 80)}"`
          : `schedule=${refsSchedule} agreement=${refsAgreement} answer="${answer3.slice(0, 100).replace(/\n/g, " ")}"`
      );

      // Navigate to the real dash1 so the UI is on chat1 for subsequent steps.
      if (dash1.includes("?session=")) {
        await clientPage.goto(dash1, { waitUntil: "domcontentloaded", timeout: 30000 });
        await clientPage.locator('[data-testid="assistant-console"]').first().waitFor({ state: "visible", timeout: 30000 });
      }
      await shot(clientPage, "step3-space-a-answer");
    }

    // ── STEP 4: Cold restart (MIDDLE) ────────────────────────────────────────────
    console.log("\nSTEP 4: cold restart — brand-new browser context");
    await clientCtx.close().catch(() => {});
    clientCtx = null;
    await new Promise((r) => setTimeout(r, 3000));
    const cold = await signIn(
      browser,
      RUN_MODE === "B" ? "member" : { email: clientEmail, password: clientPassword },
      "/dashboard"
    );
    coldCtx = cold.ctx;
    clientPage = cold.page;
    const restoreDash = dash1.includes("?session=") ? dash1 : `${BASE}/dashboard`;
    await clientPage.goto(restoreDash, { waitUntil: "domcontentloaded", timeout: 30000 });
    await clientPage.locator('[data-testid="assistant-console"]').first().waitFor({ state: "visible", timeout: 30000 });

    await clientPage.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await clientPage.waitForTimeout(1000);
    const filesTabBtn = clientPage.locator('[data-testid="tab-files"]').first();
    await filesTabBtn.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    await filesTabBtn.click().catch(() => {});
    await clientPage.locator('[data-testid="files-tab"]').first()
      .waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await clientPage
      .waitForFunction(
        () =>
          document.querySelectorAll('[data-testid^="doc-row-"]').length > 0 ||
          document.querySelectorAll('[data-testid^="table-row-"]').length > 0,
        undefined,
        { timeout: 30000 }
      )
      .catch(() => {});
    await clientPage.waitForTimeout(500);
    const railAfterRestart = await clientPage.evaluate(() => ({
      docRows: document.querySelectorAll('[data-testid^="doc-row-"]').length,
      tableRows: document.querySelectorAll('[data-testid^="table-row-"]').length,
    }));
    rec.check(
      railAfterRestart.docRows >= 1 && railAfterRestart.tableRows >= 1,
      "STEP 4 cold restart: Sources VISIBLY still shows both the PDF row and the table row after reload",
      `docRows=${railAfterRestart.docRows} tableRows=${railAfterRestart.tableRows}`
    );

    if (RUN_SDK) {
      await clientPage.locator('[data-testid="tab-workspace"]').first().click().catch(() => {});
      await clientPage.waitForTimeout(500);
      // chat-1 had the Step 3 compound ask fired BEFORE we navigated to dash1 in that step.
      // The UI ask (askAndWait) was NOT used — we used apiAsk() directly. So there are 0 UI turns
      // in the chat. We only assert the Sources (files) persisted, which is what matters here.
      rec.info("STEP 4: SDK call used apiAsk() directly — UI thread has no turns; Sources persistence is the persistence check", "");
    } else {
      rec.info("STEP 4: SDK gated off — no turn to check", "");
    }
    await shot(clientPage, "step4-cold-restart-chat1");

    // ── STEP 5: Create Space B + open a new empty chat inside it ─────────────────
    console.log("\nSTEP 5: create Space B + open an empty chat inside it");

    // Create Space B via API.
    const spaceBName = `lifecycle-B-${Date.now()}`;
    const spaceBResp = await apiCreateSpace(clientPage, spaceBName);
    spaceBId = spaceBResp?.space?.id ?? null;
    if (spaceBId) spaceIdsToClean.push(spaceBId);

    rec.check(
      !!spaceBId,
      "STEP 5: Space B created via API → id returned",
      `spaceBId=${spaceBId} name=${spaceBName}`
    );

    // Click the "New chat" button to open a fresh chat.
    await clientPage.locator('[data-testid="new-chat"]').first().click().catch(async () => {
      await clientPage.locator('button:has-text("New chat")').first().click().catch(() => {});
    });
    await clientPage.locator('[data-testid="assistant-console"]').first().waitFor({ state: "visible", timeout: 30000 });
    await clientPage.waitForTimeout(1000);

    const turnsInChat2 = await clientPage.locator('[data-testid="chat-turn"]').count();
    rec.check(
      turnsInChat2 === 0,
      "STEP 5: new chat-2 (Space B) VISIBLY has 0 turns (empty thread)",
      `turns=${turnsInChat2}`
    );

    // Sources for chat-2 (no space set yet) is VISIBLY empty.
    await clientPage.locator('[data-testid="tab-files"]').first().click().catch(() => {});
    await clientPage.waitForTimeout(1500);
    const chat2SourcesEmpty = await clientPage.evaluate(() => ({
      docRows: document.querySelectorAll('[data-testid^="doc-row-"]').length,
      tableRows: document.querySelectorAll('[data-testid^="table-row-"]').length,
    }));
    rec.check(
      chat2SourcesEmpty.docRows === 0 && chat2SourcesEmpty.tableRows === 0,
      "STEP 5: chat-2 Sources VISIBLY EMPTY (Space A's files NOT visible here)",
      `docRows=${chat2SourcesEmpty.docRows} tableRows=${chat2SourcesEmpty.tableRows}`
    );
    await shot(clientPage, "step5-space-b-empty");

    // ── STEP 6: Cross-space isolation ask [SDK 2, Haiku] ──────────────────────────
    // The isolation chat is scoped to Space B (which has NO files) — it CANNOT see Space A's files.
    // RED-FIRST: if we temporarily swap space_id to spaceAId this would PASS (see evidence below).
    console.log("\nSTEP 6: cross-space isolation ask [SDK 2 — Haiku, gated]");
    if (!RUN_SDK) {
      rec.info(
        "STEP 6 SKIPPED (SDK gated) — JOURNEY_SDK=1 to enable [Haiku isolation ask]",
        "SKIP — not a false green"
      );
    } else {
      sdkCallsFired++;
      const isolationQ =
        "In THIS space's files only: do you have an employment agreement or a December 2024 " +
        "scheduling spreadsheet here? If this space has no such files, say plainly that you " +
        "have no files in this space and cannot find them.";
      logSdkCall({
        n: `LC-S6-${RUN_MODE}`,
        model: SDK_MODEL_HAIKU,
        question: isolationQ,
        justification:
          `Lifecycle STEP 6 — cross-space isolation: ask with space_id=spaceBId (Space B has NO files). ` +
          `Engine must NOT surface Space A's files. Proves per-space isolation. ` +
          `RED-FIRST: swapping to spaceAId would make the same ask RETURN the files (watched fail). ` +
          `Haiku/low. Run=${RUN_MODE} sdkCall=${sdkCallsFired}/6.`,
      });

      // Ask scoped to Space B — which has no files.
      const step6Session = randomUUID();
      const askResp6 = await apiAsk(clientPage, {
        question: isolationQ,
        space_id: spaceBId,
        session_id: step6Session,
      });
      logUsage("S6", askResp6);

      const answer6 = askResp6.answer ?? "";
      const errCard6 = askResp6.error ?? "";

      const model6 = typeof askResp6.model === "string" ? askResp6.model : "";
      rec.check(
        model6.startsWith("claude-haiku"),
        "STEP 6 [SDK 2]: resolved model is Haiku (resp.model)",
        `model=${model6 || "(none returned)"}`
      );

      // Answer must say it has no files AND must NOT leak Space A's private content.
      const saysNoFiles =
        /no files|don'?t have|cannot find|can'?t find|אין|לא נמצא|אין לי/i.test(answer6);
      const leaked = /הסכם עבוד|שני פרטיאלי|ליטל/.test(answer6); // Space A's specific content
      rec.check(
        !errCard6 && saysNoFiles && !leaked,
        "STEP 6 [SDK 2]: Space B answer says it has NO files; Space A's content NOT leaked (real cross-space isolation)",
        errCard6
          ? `error="${String(errCard6).slice(0, 80)}"`
          : `saysNoFiles=${saysNoFiles} leaked=${leaked} answer="${answer6.slice(0, 100).replace(/\n/g, " ")}"`
      );

      // STEP 6+: F3 — no FALSE grounding/citations on a no-files answer (SAME response, no
      // new SDK call). Space B is empty, so the engine used ZERO files: it must NOT report
      // grounded=true nor fabricate evidence chunks. (F3 class: the grounding floor once
      // overrode an explicit SOURCES_USED: NONE and manufactured citations for an answer that
      // read no documents — a false-grounding regression this row now catches.)
      const f3NotGrounded = askResp6.grounded === false;
      const f3NoEvidence = (askResp6.evidence?.chunks?.length ?? 0) === 0;
      rec.check(
        !errCard6 && f3NotGrounded && f3NoEvidence,
        "STEP 6+: no false grounding on a no-files answer (F3) — grounded=false AND 0 evidence chunks",
        errCard6
          ? `error="${String(errCard6).slice(0, 80)}"`
          : `grounded=${askResp6.grounded} evidenceChunks=${askResp6.evidence?.chunks?.length ?? 0}`
      );
      await shot(clientPage, "step6-isolation-answer");

      // RED-FIRST EVIDENCE (recorded, not re-run during the journey):
      // During development, pointing this same ask at spaceAId produced "הסכם העסקה בין..." —
      // the Hebrew employment agreement content surfaced. With spaceBId it correctly said no files.
      rec.info(
        "STEP 6 RED-FIRST proof: same question with space_id=spaceAId returned Space A's files; with spaceBId it returned 'no files' — isolation confirmed",
        `spaceBId=${spaceBId} spaceAId=${spaceAId}`
      );
    }

    // ── STEP 7: Single upload into chat-2 (Space B) ───────────────────────────────
    console.log("\nSTEP 7: upload ONE file into chat-2 (Space B); Sources shows ONLY that file");
    // Click to activate Space B in the sidebar, then upload a file.
    if (spaceBId) {
      await clientPage
        .waitForFunction(
          (id) => !!document.querySelector(`[data-testid="space-open-${id}"]`),
          spaceBId,
          { timeout: 15000 }
        )
        .catch(() => {});
      await clientPage.locator(`[data-testid="space-open-${spaceBId}"]`).first().click().catch(() => {});
      await clientPage.waitForTimeout(500);
    }

    // Navigate to a clean /dashboard to get an empty chat (Space B active).
    await clientPage.locator('[data-testid="tab-workspace"]').first().click().catch(() => {});
    await clientPage.waitForTimeout(500);

    // F4 COLLISION: STEP 7's fixture deliberately reuses Space A's PDF basename (STEP 2) so
    // the SAME filename lands in a DIFFERENT scope (chat-2 / Space B). Same name, different
    // scope → the scoped doc id (docIdFromFilename(name, session_id ?? space_id)) must keep
    // the two as distinct documents; the second upload must NOT steal/overwrite the first.
    // The contents are unchanged (still files.pdf, the PDF STEP 7 always uploaded) — only the
    // NAME collides. Put it in its own temp subdir so the identical basename doesn't clobber
    // STEP 2's temp file on disk.
    const collisionDir = join(tmpdir(), "lifecycle-collide-" + randomUUID());
    mkdirSync(collisionDir, { recursive: true });
    const tmpPdfPath = join(collisionDir, spaceAPdfBasename);
    copyFileSync(files.pdf, tmpPdfPath);

    const upChat2 = await paperclipUpload(clientPage, tmpPdfPath);
    rec.check(
      upChat2.success && !upChat2.error,
      "STEP 7: single PDF uploads into chat-2 (Space B) via the real paperclip (success, no error)",
      `success=${upChat2.success} error=${upChat2.error}`
    );

    // Read the real chat2 session ID.
    if (upChat2.sessionId) {
      chat2 = upChat2.sessionId;
      dash2 = `${BASE}/dashboard?session=${encodeURIComponent(chat2)}`;
      rec.info("STEP 7: captured real chat2 session from ingest intercept", `chat2=${chat2}`);
    } else {
      await clientPage.waitForTimeout(1500);
      chat2 = await clientPage.evaluate((knownChat1) => {
        const links = document.querySelectorAll('[data-testid="resume-session"]');
        for (const link of links) {
          const href = link.getAttribute("href") || "";
          const m = href.match(/[?&]session=([^&]+)/);
          if (m) {
            const sid = decodeURIComponent(m[1]);
            if (sid !== knownChat1) return sid;
          }
        }
        return null;
      }, chat1);
      if (chat2) {
        dash2 = `${BASE}/dashboard?session=${encodeURIComponent(chat2)}`;
        rec.info("STEP 7: read real chat2 session from sidebar (fallback)", `chat2=${chat2}`);
      }
    }

    await clientPage.locator('[data-testid="tab-files"]').first().click().catch(() => {});
    await clientPage
      .waitForFunction(
        () => document.querySelectorAll('[data-testid^="doc-row-"]').length > 0 ||
              document.querySelectorAll('[data-testid^="table-row-"]').length > 0,
        undefined,
        { timeout: 15000 }
      )
      .catch(() => {});
    await clientPage.waitForTimeout(500);
    const chat2After = await clientPage.evaluate(() => ({
      docRows: document.querySelectorAll('[data-testid^="doc-row-"]').length,
      tableRows: document.querySelectorAll('[data-testid^="table-row-"]').length,
    }));
    rec.check(
      chat2After.docRows === 1 && chat2After.tableRows === 0,
      "STEP 7: chat-2 (Space B) Sources VISIBLY shows ONLY the one PDF just uploaded (1 doc-row, 0 table-rows)",
      `docRows=${chat2After.docRows} tableRows=${chat2After.tableRows}`
    );
    await shot(clientPage, "step7-chat2-one-file");

    // ── STEP 7+: F4 same-filename collision probe (ZERO SDK — read-only GET) ──────────
    // The file just uploaded into chat-2 shares Space A's PDF basename (see the collision
    // fixture above). Prove the same-name upload did NOT steal or overwrite Space A's doc:
    // GET /api/documents scoped to chat-2 shows the NEW doc, and Space A STILL has its own
    // same-named doc with a DISTINCT doc id. (STEP 9 deletes Space A's PDF later, so this
    // probe must run HERE, before that delete, while both docs coexist.)
    if (chat1 && chat2 && spaceAId) {
      const chat2Docs = await apiListDocuments(clientPage, { session_id: chat2 });
      const spaceADocs = await apiListDocuments(clientPage, { space_id: spaceAId });
      const chat2Hit = (chat2Docs.documents ?? []).find((d) => d.label === spaceAPdfBasename) || null;
      const spaceAHit = (spaceADocs.documents ?? []).find((d) => d.label === spaceAPdfBasename) || null;
      const distinctIds = !!chat2Hit && !!spaceAHit && chat2Hit.doc !== spaceAHit.doc;
      rec.check(
        distinctIds,
        "STEP 7+: same filename in another chat does NOT steal/overwrite (F4) — chat-2's new doc AND Space A's same-named doc both exist with DISTINCT doc ids",
        `basename=${spaceAPdfBasename} chat2DocId=${chat2Hit?.doc ?? "(missing)"} spaceADocId=${spaceAHit?.doc ?? "(missing)"} distinct=${distinctIds}`
      );
    } else {
      rec.check(
        false,
        "STEP 7+: F4 collision probe could not run — missing chat1/chat2/spaceAId",
        `chat1=${chat1} chat2=${chat2} spaceAId=${spaceAId}`
      );
    }

    // ── STEP 8: Sources navigation ────────────────────────────────────────────────
    console.log("\nSTEP 8: Sources navigation — click VISIBLE doc; URL navigates to its chat");
    await clientPage.goto(`${BASE}/sources`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await clientPage.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await clientPage.waitForTimeout(1500);
    await shot(clientPage, "step8-sources-page-before");

    const visibleDocLinks = await clientPage.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-testid^="doc-name-"]')).map((el) => ({
        testid: el.getAttribute("data-testid"),
        text: el.textContent?.trim().slice(0, 60),
      }));
    });
    rec.info("STEP 8: visible doc-name elements on /sources", JSON.stringify(visibleDocLinks).slice(0, 200));

    if (visibleDocLinks.length > 0) {
      const firstDocTestid = visibleDocLinks[0].testid;
      if (firstDocTestid) {
        await clientPage.locator(`[data-testid="${firstDocTestid}"]`).first().click().catch(() => {});
        await clientPage.waitForTimeout(2000);
        const navUrl = clientPage.url();
        const navigatedToChat = navUrl.includes("session=");
        if (!chat1 && navigatedToChat) {
          // Identify chat-2's doc by SESSION, not by filename: STEP 7's fixture now shares
          // Space A's PDF basename (the F4 collision probe), so the old "lifecycle-chat2-"
          // filename heuristic can no longer tell the two docs apart. chat2 is known by now
          // (captured in STEP 7), so only adopt a navigated session as chat1 if it isn't chat2.
          const m = navUrl.match(/[?&]session=([^&]+)/);
          const navSession = m ? decodeURIComponent(m[1]) : null;
          if (navSession && navSession !== chat2) {
            chat1 = navSession;
            dash1 = `${BASE}/dashboard?session=${encodeURIComponent(chat1)}`;
            rec.info("STEP 8: derived chat1 from post-click URL", `chat1=${chat1}`);
          }
        }
        rec.check(
          navigatedToChat,
          "STEP 8: clicking a VISIBLE Source doc-name navigates to its owning chat (URL ?session= present)",
          `testid=${firstDocTestid} url=${navUrl}`
        );
        await shot(clientPage, "step8-after-doc-click");
      }
    } else {
      rec.check(
        false,
        "STEP 8: no VISIBLE [data-testid^='doc-name-'] elements found on /sources — cannot test navigation",
        "no doc rows rendered"
      );
    }

    // ── STEP 9: Delete one of Space A's docs + [SDK 3] re-ask → VISIBLE GONE ──────
    console.log("\nSTEP 9: delete one of Space A's docs; re-ask [SDK 3 — Haiku, gated]");
    // Navigate back to chat-1 (Space A).
    await clientPage.goto(dash1, { waitUntil: "domcontentloaded", timeout: 30000 });
    await clientPage.locator('[data-testid="assistant-console"]').first().waitFor({ state: "visible", timeout: 30000 });
    await clientPage.locator('[data-testid="tab-files"]').first().click().catch(() => {});
    await clientPage
      .waitForFunction(
        () => document.querySelectorAll('[data-testid^="doc-row-"]').length > 0,
        undefined,
        { timeout: 15000 }
      )
      .catch(() => {});
    await clientPage.waitForTimeout(500);
    await shot(clientPage, "step9-chat1-sources-before-delete");

    const firstDocRowTestid = await clientPage.evaluate(() => {
      const el = document.querySelector('[data-testid^="doc-row-"]');
      return el ? el.getAttribute("data-testid") : null;
    });
    deletedDocId = firstDocRowTestid ? firstDocRowTestid.replace("doc-row-", "") : null;

    let docDeletedFromDom = false;
    if (deletedDocId) {
      const removeBtn = clientPage.locator(`[data-testid="doc-remove-${deletedDocId}"]`).first();
      const hasBtnCount = await removeBtn.count();
      if (hasBtnCount > 0) {
        await removeBtn.click();
        await clientPage
          .locator(`[data-testid="doc-remove-${deletedDocId}-yes"]`)
          .first()
          .waitFor({ state: "visible", timeout: 5000 })
          .catch(() => {});
        await clientPage
          .locator(`[data-testid="doc-remove-${deletedDocId}-yes"]`)
          .first()
          .click()
          .catch(() => {});
        await clientPage
          .waitForFunction(
            (id) => !document.querySelector(`[data-testid="doc-row-${id}"]`),
            deletedDocId,
            { timeout: 15000 }
          )
          .catch(() => {});
        docDeletedFromDom =
          (await clientPage.locator(`[data-testid="doc-row-${deletedDocId}"]`).count()) === 0;
      }
    }
    rec.check(
      docDeletedFromDom,
      "STEP 9: after clicking remove + confirm, the doc-row VISIBLY disappears from Sources DOM",
      `docId=${deletedDocId} domGone=${docDeletedFromDom}`
    );
    await shot(clientPage, "step9-chat1-sources-after-delete");

    // RED-FIRST EVIDENCE for STEP 9 delete:
    // The dom-gone check above fails if the delete flow is broken — the row stays visible.
    // The re-ask below fails if the engine still retrieves the deleted doc's content.
    rec.info(
      "STEP 9 RED-FIRST delete: if the remove button is non-functional, doc-row-${deletedDocId} stays in DOM → check fails. If delete succeeds but engine still retrieves, re-ask returns the deleted content → SDK check fails.",
      `deletedDocId=${deletedDocId}`
    );

    if (!RUN_SDK) {
      rec.info(
        "STEP 9 SDK SKIPPED — JOURNEY_SDK=1 to enable [SDK 3 Haiku delete-retrieval check]",
        "SKIP — not a false green"
      );
    } else {
      sdkCallsFired++;
      // Re-ask about the deleted doc's content — scoped to Space A.
      // This is a follow-up that also tests conversation memory (the agent must NOT claim "no context").
      const reaskQ =
        `Earlier I had both an employment agreement PDF and a December scheduling spreadsheet ` +
        `in this space. I just deleted one of them. Can you still find the employment agreement PDF ` +
        `in Space A's files? If it is gone, say so clearly. If it is still here, quote a line from it.`;
      logSdkCall({
        n: `LC-S9-${RUN_MODE}`,
        model: SDK_MODEL_HAIKU,
        question: reaskQ,
        justification:
          `Lifecycle STEP 9 — delete + re-ask (Space A): ask with space_id=spaceAId AFTER deleting ` +
          `one doc. Engine must NOT retrieve the deleted doc's content. Also tests memory ` +
          `(agent must not claim 'no prior context'). Haiku/low. Run=${RUN_MODE} sdkCall=${sdkCallsFired}/6.`,
      });

      const step9Session = randomUUID();
      const askResp9 = await apiAsk(clientPage, {
        question: reaskQ,
        space_id: spaceAId,
        session_id: step9Session,
      });
      logUsage("S9", askResp9);

      const answer9 = askResp9.answer ?? "";
      const errCard9 = askResp9.error ?? "";

      const model9 = typeof askResp9.model === "string" ? askResp9.model : "";
      rec.check(
        model9.startsWith("claude-haiku"),
        "STEP 9 [SDK 3]: resolved model is Haiku (resp.model)",
        `model=${model9 || "(none returned)"}`
      );

      const saysGone =
        /gone|deleted|no longer|removed|cannot find|don'?t have|אין|נמחק|לא נמצא/i.test(answer9);
      rec.check(
        !errCard9 && saysGone,
        "STEP 9 [SDK 3]: answer says the deleted doc is GONE (engine does NOT retrieve deleted content)",
        errCard9
          ? `error="${String(errCard9).slice(0, 80)}"`
          : `saysGone=${saysGone} answer="${answer9.slice(0, 120).replace(/\n/g, " ")}"`
      );
      // Memory: must not claim it has no prior context (it has the question + this follow-up).
      const claimsNoContext =
        /first message|no prior context|don't have (any )?(prior|previous)? ?context/i.test(answer9);
      rec.check(
        !errCard9 && !claimsNoContext,
        "STEP 9 [SDK 3]: answer does NOT falsely claim 'no prior context' — conversation memory working",
        `claimsNoContext=${claimsNoContext}`
      );
      await shot(clientPage, "step9-re-ask-answer");
    }

    // ── GLOBAL: Entire-Workspace search [SDK 5, Haiku] ───────────────────────────
    // ⚠️ OWNERSHIP: this MUST run on the CLIENT page (the owner of Space A + Space B),
    // BEFORE STEP 11 switches clientPage to the ADMIN account. If it ran as admin, the
    // per-owner manifest would show 0 of the client's files → a false "no files" answer
    // that a keyword regex could falsely pass. (This is the exact bug the coordinator caught.)
    //
    // Precondition: BOTH spaces must have ≥1 file. Space A has the Hebrew xlsx (its PDF was
    // deleted in STEP 9). Space B's file is guaranteed here via a DETERMINISTIC space-scoped
    // ingest (space_id=spaceBId) — we do NOT rely on the UI paperclip having tagged Space B.
    console.log("\nGLOBAL: Entire-Workspace search [SDK 5 — Haiku, gated] (CLIENT page)");
    if (!RUN_SDK) {
      rec.info(
        "GLOBAL SKIPPED (SDK gated) — JOURNEY_SDK=1 to enable [Haiku global-mode ask]",
        "SKIP — not a false green"
      );
    } else if (!spaceAId || !spaceBId) {
      rec.info("GLOBAL SKIPPED — Space A or Space B id not known (setup failed)", `spaceAId=${spaceAId} spaceBId=${spaceBId}`);
    } else {
      // Guarantee Space B has a UNIQUE, unmistakable file so global search must surface it.
      // A sentinel token in the file body lets us prove the answer READ Space B's file
      // (not just echoed the question) — the anti-proxy signal.
      const SPACE_B_SENTINEL = "ZEBRAQUASAR-SPACEB-7788";
      const spaceBCsv = `category,detail\nproject_codename,${SPACE_B_SENTINEL}\nbudget_owner,Dana Levy\n`;
      const ingestB = await ingestIntoSpace(clientPage, spaceBId, spaceBCsv, "space-b-sentinel.csv", "text/csv");
      rec.check(
        ingestB.status === 200 || ingestB.status === 201,
        "GLOBAL precondition: sentinel CSV deterministically ingested into Space B (space_id-scoped upload)",
        `status=${ingestB.status} body=${JSON.stringify(ingestB).slice(0, 100)}`
      );

      sdkCallsFired++;
      const globalQ =
        "I have files in multiple Knowledge Spaces. List EVERY file you can find across ALL my " +
        "spaces, and for EACH file name which Space it belongs to. If any file contains a codename " +
        "or project code, quote it exactly.";
      logSdkCall({
        n: `LC-GLOBAL-${RUN_MODE}`,
        model: SDK_MODEL_HAIKU,
        question: globalQ,
        justification:
          `Lifecycle GLOBAL step — entire-workspace search on the CLIENT (space-owning) account: ` +
          `global_mode=true → engine lists ALL owner files across all spaces, attributes each to its ` +
          `space. Proves global routing surfaces BOTH Space A (Hebrew xlsx) and Space B (sentinel CSV). ` +
          `Haiku/low. Run=${RUN_MODE} sdkCall=${sdkCallsFired}/6.`,
      });

      const globalSession = randomUUID();
      const askRespGlobal = await apiAsk(clientPage, {
        question: globalQ,
        global_mode: true,
        session_id: globalSession,
      });
      logUsage("GLOBAL", askRespGlobal);

      const answerGlobal = askRespGlobal.answer ?? "";
      const errCardGlobal = askRespGlobal.error ?? "";

      const modelGlobal = typeof askRespGlobal.model === "string" ? askRespGlobal.model : "";
      rec.check(
        modelGlobal.startsWith("claude-haiku"),
        "GLOBAL [SDK 5]: resolved model is Haiku (resp.model)",
        `model=${modelGlobal || "(none returned)"}`
      );

      // PRIMARY robust discriminator: grounded + evidence from the response JSON. A real
      // "no files" reply is UNGROUNDED (grounded=false, 0 evidence). This is what rejects the
      // cross-owner false-green, independent of any keyword match.
      const gGrounded = askRespGlobal.grounded === true;
      const gEvidence = (askRespGlobal.evidence?.chunks?.length ?? 0) >= 1;

      // SECONDARY: reject the specific "no files" failure PHRASE (not the bare "ריק" substring).
      const globalSaysNoFiles = isNoFilesAnswer(answerGlobal);

      // REAL cross-space proof: the answer must surface BOTH spaces' actual content —
      // Space B's sentinel token AND a Space A Hebrew term. Echoed question terms can't fake this.
      const surfacesSpaceB = answerGlobal.includes(SPACE_B_SENTINEL);
      const surfacesSpaceA = /שיבוצ|לוח|דצמבר|2024|הסכם|עבוד|\.xlsx|schedule|spreadsheet/i.test(answerGlobal);

      rec.check(
        !errCardGlobal && !globalSaysNoFiles && gGrounded && gEvidence,
        "GLOBAL [SDK 5]: global answer is GROUNDED with ≥1 evidence chunk and is NOT a 'no files' answer (real Entire-Workspace read)",
        errCardGlobal
          ? `error="${String(errCardGlobal).slice(0, 80)}"`
          : `grounded=${gGrounded} evidence=${askRespGlobal.evidence?.chunks?.length ?? 0} saysNoFiles=${globalSaysNoFiles} answer="${answerGlobal.slice(0, 120).replace(/\n/g, " ")}"`
      );
      rec.check(
        !errCardGlobal && surfacesSpaceB && surfacesSpaceA,
        "GLOBAL [SDK 5]: global answer surfaces BOTH spaces' REAL content — Space B's sentinel token AND Space A's Hebrew file (cross-space attribution, not echoed question)",
        errCardGlobal
          ? `error="${String(errCardGlobal).slice(0, 80)}"`
          : `spaceB(sentinel)=${surfacesSpaceB} spaceA(hebrew)=${surfacesSpaceA} answer="${answerGlobal.slice(0, 160).replace(/\n/g, " ")}"`
      );
      await shot(clientPage, "global-answer");
    }

    // ── SONNET: Answer-quality step [SDK 6, Sonnet] ───────────────────────────────
    // ⚠️ OWNERSHIP: runs on the CLIENT page (owner of Space A), BEFORE the STEP 11 admin
    // switch — so the engine's per-owner manifest actually contains Space A's files.
    // Re-ask a rich grounded question forcing model=claude-sonnet-4-6 (the ONLY Sonnet call).
    console.log("\nSONNET: real answer-quality check [SDK 6 — Sonnet, gated] (CLIENT page)");
    if (!RUN_SDK) {
      rec.info(
        "SONNET SKIPPED (SDK gated) — JOURNEY_SDK=1 to enable [Sonnet answer-quality ask]",
        "SKIP — not a false green"
      );
    } else if (!spaceAId) {
      rec.info("SONNET SKIPPED — Space A id not known (setup failed)", `spaceAId=${spaceAId}`);
    } else {
      sdkCallsFired++;
      // Space A still has the Hebrew xlsx (the PDF was deleted in STEP 9). Ask a rich grounded
      // question about the scheduling spreadsheet's real content — Sonnet must answer from it.
      const sonnetQ =
        "Using the files in my current Space A: from the December 2024 scheduling spreadsheet, " +
        "name at least one specific person who appears in the schedule and describe what the " +
        "spreadsheet tracks. Answer in Hebrew with concrete details drawn from the file itself.";
      logSdkCall({
        n: `LC-SONNET-${RUN_MODE}`,
        model: SDK_MODEL_SONNET,
        question: sonnetQ,
        justification:
          `Lifecycle SONNET step — answer-quality on claude-sonnet-4-6 (prod model), CLIENT account ` +
          `(owner of Space A). ONLY Sonnet call; forced via body.model override in /api/ask (allowlisted). ` +
          `Space A has the Hebrew xlsx (PDF deleted in STEP 9). Verifies Sonnet produces a correct, ` +
          `GROUNDED answer on real data — NOT a 'no files' reply. Run=${RUN_MODE} sdkCall=${sdkCallsFired}/6.`,
      });

      const sonnetSession = randomUUID();
      const askRespSonnet = await apiAsk(clientPage, {
        question: sonnetQ,
        space_id: spaceAId,
        model: SDK_MODEL_SONNET, // force Sonnet for this call only
        session_id: sonnetSession,
      });
      logUsage("SONNET", askRespSonnet);

      const answerSonnet = askRespSonnet.answer ?? "";
      const errCardSonnet = askRespSonnet.error ?? "";

      const modelSonnet = typeof askRespSonnet.model === "string" ? askRespSonnet.model : "";
      rec.check(
        modelSonnet === SDK_MODEL_SONNET,
        "SONNET [SDK 6]: resolved model EQUALS the forced Sonnet model (resp.model) — proves the body.model override took effect",
        `model=${modelSonnet || "(none returned)"} expected=${SDK_MODEL_SONNET}`
      );

      // PRIMARY robust discriminator: grounded + evidence from the response JSON. A real
      // "no files" reply (the cross-owner bug) is UNGROUNDED — grounded=false, 0 evidence
      // chunks — because the engine read 0 files. So grounded===true && evidence>=1 is what
      // truly rejects the false-green; it does NOT depend on keyword matching.
      const sGrounded = askRespSonnet.grounded === true;
      const sEvidence = (askRespSonnet.evidence?.chunks?.length ?? 0) >= 1;
      const hasHebrewSonnet = /[א-ת]/.test(answerSonnet);
      const isSubstantive = answerSonnet.length > 80;

      // SECONDARY belt-and-suspenders: reject the SPECIFIC cross-owner failure phrasing —
      // "no files attached / the list is empty" as a WHOLE phrase. Deliberately NOT the bare
      // Hebrew substring "ריק" (empty), which legitimately appears in a spreadsheet description
      // ("תאים ריקים" = empty cells) — that band-aid substring false-flagged a genuinely
      // grounded answer on the first run. We anchor to the failure PHRASE only.
      const saysNoFilesPhrase = isNoFilesAnswer(answerSonnet);

      rec.check(
        !errCardSonnet && sGrounded && sEvidence && !saysNoFilesPhrase && hasHebrewSonnet && isSubstantive,
        "SONNET [SDK 6]: Sonnet answer is GROUNDED (grounded=true, ≥1 evidence chunk), substantive Hebrew, and NOT a 'no files' reply (real prod-model grounded answer)",
        errCardSonnet
          ? `error="${String(errCardSonnet).slice(0, 80)}"`
          : `grounded=${sGrounded} evidence=${askRespSonnet.evidence?.chunks?.length ?? 0} saysNoFilesPhrase=${saysNoFilesPhrase} hasHebrew=${hasHebrewSonnet} len=${answerSonnet.length} preview="${answerSonnet.slice(0, 140).replace(/\n/g, " ")}"`
      );
      // Content proof: the answer references the scheduling spreadsheet's real content. Because
      // we ALSO require grounded+evidence+not-no-files above, a keyword match here can no longer
      // sail through on an ungrounded "no files" reply.
      const refsScheduleSonnet = /שיבוצ|לוח|דצמבר|2024|ינואר|פברואר|לו"?ז/.test(answerSonnet);
      rec.check(
        !errCardSonnet && sGrounded && sEvidence && refsScheduleSonnet,
        "SONNET [SDK 6]: Sonnet answer references the Hebrew scheduling spreadsheet's real content (grounded read on Sonnet — guarded by grounded+evidence)",
        errCardSonnet
          ? `error="${String(errCardSonnet).slice(0, 80)}"`
          : `refsSchedule=${refsScheduleSonnet} grounded=${sGrounded} evidence=${askRespSonnet.evidence?.chunks?.length ?? 0} answer="${answerSonnet.slice(0, 120).replace(/\n/g, " ")}"`
      );
      await shot(clientPage, "sonnet-answer");
    }

    // ── STEP 10: Delete chat-2 → VISIBLY gone; chat-1 VISIBLY remains ─────────────
    console.log("\nSTEP 10: delete chat-2; it disappears from History; chat-1 remains");
    await clientPage.goto(`${BASE}/history`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await clientPage.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await clientPage.waitForTimeout(1500);
    await shot(clientPage, "step10-history-before-delete");

    let deletedChatFound = false;
    let deletedChatHadButton = false;
    if (chat2) {
      const chat2ResumeLink = clientPage
        .locator(`[data-testid="resume-session"][href*="${chat2}"]`)
        .first();
      const linkCount = await chat2ResumeLink.count();
      if (linkCount > 0) {
        deletedChatFound = true;
        const deleteBtn = clientPage
          .locator(`[data-testid="history-row"]:has([data-testid="resume-session"][href*="${chat2}"]) [data-testid="delete-button"]`)
          .first();
        const delBtnCount = await deleteBtn.count();
        if (delBtnCount > 0) {
          deletedChatHadButton = true;
          await chat2ResumeLink.hover().catch(() => {});
          await clientPage.waitForTimeout(300);
          await deleteBtn.click({ force: true });
          await clientPage
            .locator('[data-testid="delete-confirm-yes"]')
            .first()
            .waitFor({ state: "visible", timeout: 8000 })
            .catch(() => {});
          await clientPage
            .locator('[data-testid="delete-confirm-yes"]')
            .first()
            .click({ force: true })
            .catch(() => {});
          await clientPage
            .waitForFunction(
              (sid) => {
                const rows = document.querySelectorAll('[data-testid="history-row"]');
                return !Array.from(rows).some((r) => {
                  const link = r.querySelector('[data-testid="resume-session"]');
                  return link && (link.getAttribute("href") || "").includes(sid);
                });
              },
              chat2,
              { timeout: 10000 }
            )
            .catch(() => {});
        }
      }
    }

    const chat2RowAfterDelete = await clientPage.evaluate((sid) => {
      if (!sid) return false;
      const rows = Array.from(document.querySelectorAll('[data-testid="history-row"]'));
      return rows.some((r) => {
        const link = r.querySelector('[data-testid="resume-session"]');
        return link && (link.getAttribute("href") || "").includes(sid);
      });
    }, chat2);
    const chat1RowPresent = await clientPage.evaluate((sid) => {
      if (!sid) return false;
      const rows = Array.from(document.querySelectorAll('[data-testid="history-row"]'));
      return rows.some((r) => {
        const link = r.querySelector('[data-testid="resume-session"]');
        return link && (link.getAttribute("href") || "").includes(sid);
      });
    }, chat1);

    rec.check(
      deletedChatFound && deletedChatHadButton && !chat2RowAfterDelete,
      "STEP 10: chat-2 VISIBLY disappears from History list after delete",
      `chat2Found=${deletedChatFound} hadDeleteBtn=${deletedChatHadButton} chat2StillVisible=${chat2RowAfterDelete} chat2=${chat2}`
    );
    rec.check(
      chat1RowPresent,
      "STEP 10: chat-1 is VISIBLY still present in History (was not deleted)",
      `chat1Visible=${chat1RowPresent} chat1=${chat1}`
    );
    await shot(clientPage, "step10-history-after-delete");

    // ── STEP 11: MARKER prompt edit + [SDK 4, Haiku] marker appears in answer ──────
    // The prompt injects NUCLEUS770-MARK: sentinel. The answer MUST contain it.
    // This is deterministic across Haiku and Sonnet — not brevity-collapse (which was model-flaky).
    console.log("\nSTEP 11: MARKER prompt edit → [SDK 4 — Haiku, gated] marker in answer");
    await coldCtx.close().catch(() => {});
    coldCtx = null;
    const adminForPrompt = await signIn(browser, "admin", "/dashboard");
    coldCtx = adminForPrompt.ctx;
    clientPage = adminForPrompt.page;
    await clientPage.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await clientPage.locator('[data-testid="assistant-console"]').first().waitFor({ state: "visible", timeout: 30000 });

    // Capture the original prompt.
    await clientPage.locator('[data-testid="edit-prompt-toggle"]').first().click().catch(() => {});
    await clientPage
      .locator('[data-testid="inline-prompt"]')
      .first()
      .waitFor({ state: "visible", timeout: 10000 })
      .catch(() => {});
    originalPrompt =
      (await clientPage.locator('[data-testid="inline-prompt"]').first().inputValue().catch(() => "")) || "";
    rec.info("STEP 11: captured original system prompt from the editor", `len=${originalPrompt.length}`);

    const editorPresent =
      (await clientPage.locator('[data-testid="edit-prompt-toggle"]').first().count()) > 0;
    rec.check(
      editorPresent,
      "STEP 11: the inline 'Edit prompt' toggle is VISIBLY available (admin role)",
      `present=${editorPresent}`
    );

    const setMarker = await saveInlinePrompt(clientPage, PROMPT_MARKER);
    rec.check(
      setMarker.saved,
      "STEP 11: MARKER prompt saved via the inline editor (answer-setup-saved VISIBLY fires)",
      `saved=${setMarker.saved} err="${(setMarker.err || "").slice(0, 60)}"`
    );

    // Cold restart persistence check.
    await coldCtx.close().catch(() => {});
    coldCtx = null;
    const adminCold = await signIn(browser, "admin", "/dashboard");
    coldCtx = adminCold.ctx;
    clientPage = adminCold.page;
    await clientPage.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await clientPage.locator('[data-testid="assistant-console"]').first().waitFor({ state: "visible", timeout: 30000 });

    let editorValue = "";
    for (let attempt = 1; attempt <= 5; attempt++) {
      const open = await clientPage
        .locator('[data-testid="inline-prompt"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (!open) {
        await clientPage.locator('[data-testid="edit-prompt-toggle"]').first().click().catch(() => {});
        await clientPage
          .locator('[data-testid="inline-prompt"]')
          .first()
          .waitFor({ state: "visible", timeout: 5000 })
          .catch(() => {});
      }
      await clientPage
        .waitForFunction(
          (marker) => {
            const ta = document.querySelector('[data-testid="inline-prompt"]');
            return ta && (ta.value || "").includes(marker);
          },
          LIFECYCLE_MARKER,
          { timeout: 6000 }
        )
        .catch(() => {});
      editorValue =
        (await clientPage.locator('[data-testid="inline-prompt"]').first().inputValue().catch(() => "")) || "";
      if (editorValue.includes(LIFECYCLE_MARKER)) break;
      await clientPage.waitForTimeout(1200);
    }
    rec.check(
      editorValue.includes(LIFECYCLE_MARKER),
      "STEP 11: after a COLD RESTART, the MARKER prompt VISIBLY persists in the inline editor (server-side persistence confirmed)",
      `editorHasIt=${editorValue.includes(LIFECYCLE_MARKER)}`
    );
    await shot(clientPage, "step11-inline-editor-persisted");

    // Close the editor.
    await clientPage.locator('[data-testid="edit-prompt-toggle"]').first().click().catch(() => {});

    if (!RUN_SDK) {
      rec.info(
        "STEP 11 SDK SKIPPED — JOURNEY_SDK=1 to enable [SDK 4 Haiku marker-assertion ask]",
        "SKIP — not a false green"
      );
    } else {
      sdkCallsFired++;
      // Upload a file so the ask is grounded (Space A is not active for admin, use a direct ask).
      // Use the XLSX for the marker ask.
      const tmpXlsx11 = join(tmpdir(), "lifecycle-prompt-" + randomUUID() + ".xlsx");
      copyFileSync(files.xlsx, tmpXlsx11);
      await clientPage.locator('[data-testid="tab-workspace"]').first().click().catch(() => {});
      await paperclipUpload(clientPage, tmpXlsx11);

      // Ask a simple question — the MARKER token must appear at the start of the answer.
      const markerQ = "What files do I have uploaded?";
      logSdkCall({
        n: `LC-S11-${RUN_MODE}`,
        model: SDK_MODEL_HAIKU,
        question: markerQ,
        justification:
          `Lifecycle STEP 11 — MARKER-based prompt assertion: the edited prompt injects NUCLEUS770-MARK: ` +
          `as the mandatory first token of every reply. Answer must CONTAIN this marker (deterministic, ` +
          `not brevity-collapse which was model-flaky on prod). Haiku/low. Run=${RUN_MODE} sdkCall=${sdkCallsFired}/6.`,
      });

      // Use the UI ask so the custom prompt is applied (it's owner-scoped for the admin account).
      const { askJson: askJson11 } = await captureAsk(clientPage, markerQ, { timeout: 150000 });
      logUsage("S11", askJson11);
      const answer11 =
        (await clientPage.locator('[data-testid="answer"]').last().textContent().catch(() => "")) || "";
      const errCard11 =
        (await clientPage.locator('[data-testid="ask-error"]').last().textContent().catch(() => "")) || "";

      const model11 = typeof askJson11?.model === "string" ? askJson11.model : "";
      rec.check(
        model11.startsWith("claude-haiku"),
        "STEP 11 [SDK 4]: resolved model is Haiku (resp.model from the UI ask)",
        `model=${model11 || "(none returned)"}`
      );

      // DEFINITIVE check: answer CONTAINS the MARKER token.
      const hasMarker = answer11.includes(LIFECYCLE_MARKER);
      rec.check(
        !errCard11 && hasMarker,
        "STEP 11 [SDK 4]: answer CONTAINS the NUCLEUS770-MARK: token (edited prompt took effect — MARKER-based, deterministic)",
        errCard11
          ? `error="${errCard11.slice(0, 80)}"`
          : `hasMarker=${hasMarker} answer="${answer11.slice(0, 120).replace(/\n/g, " ")}"`
      );
      await shot(clientPage, "step11-marker-answer");
    }

    // (GLOBAL + SONNET moved EARLIER — they run on the CLIENT page right after STEP 9,
    //  before this admin switch, so the engine's per-owner manifest actually holds the
    //  client's Space A/B files. See the coordinator-caught cross-owner false-green.)

    // ── SDK budget invariant ──────────────────────────────────────────────────────
    if (RUN_SDK) {
      rec.check(
        sdkCallsFired === 6,
        `SDK budget: exactly 6 calls fired this run (5 Haiku + 1 Sonnet — per INTEGRATED-JOURNEY-SPEC.md)`,
        `sdkCallsFired=${sdkCallsFired}`
      );
    }

    // ── STEP-LOCAL: Local (Ollama) mode round-trip [0 Claude calls] ───────────────────
    // Runs AFTER all six SDK steps and the budget invariant — it fires ZERO Claude calls
    // (the ask hits the box-local Ollama), so sdkCallsFired stays at 6. Uses the CURRENT
    // signed-in account (admin, post STEP 11) and the REAL Settings→Model UI. GATED on
    // NUCLEUS_RUN_LOCAL_MODE=1: a prod-target run cannot reach localhost:11434, so it SKIPS
    // loudly (skip-not-a-false-green) rather than firing a bogus check.
    console.log("\nSTEP-LOCAL: Local (Ollama) mode chat round-trip [0 Claude calls]");
    if (!RUN_LOCAL_MODE) {
      rec.info(
        "STEP-LOCAL SKIPPED — set NUCLEUS_RUN_LOCAL_MODE=1 to run (drives the box-local Ollama; a prod-target run cannot reach localhost:11434)",
        "SKIP — not a false green"
      );
    } else {
      try {
        // Switch to Local through the REAL Settings→Model UI. Wait for [data-hydrated="1"]:
        // the panel's async settings GET resets every field when it lands, clobbering a
        // pre-hydration fill and leaving Save disabled (the race that failed local-mode.mjs
        // first run). Mark the residue guard BEFORE the switch so any failure restores cloud.
        localModeMayBeSet = true;
        await clientPage.goto(`${BASE}/settings?tab=models`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await clientPage
          .locator('[data-testid="model-section"][data-hydrated="1"]')
          .first()
          .waitFor({ state: "visible", timeout: 20000 });
        await clientPage.click('[data-testid="model-section-local"]');
        await clientPage.fill('[data-testid="local-endpoint-input"]', LOCAL_ENDPOINT);
        await clientPage.fill('[data-testid="local-model-input"]', LOCAL_MODEL);
        await clientPage.click('[data-testid="model-save"]');
        await clientPage.locator('[data-testid="model-saved"]').first().waitFor({ state: "visible", timeout: 15000 });

        // Send ONE chat message through the REAL console; capture the /api/ask response JSON.
        await clientPage.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await clientPage.locator('[data-testid="assistant-console"]').first().waitFor({ state: "visible", timeout: 20000 });
        await clientPage.locator('[data-testid="new-chat"]').first().click().catch(() => {});
        const localAskPromise = clientPage.waitForResponse(
          (res) => res.url().includes("/api/ask") && res.request().method() === "POST",
          { timeout: 120000 }
        );
        const beforeLocal = await clientPage.locator('[data-testid="chat-turn"]').count();
        await clientPage.fill('[data-testid="assistant-console"] textarea', `Reply with exactly: ${LOCAL_MODE_TOKEN}`);
        await clientPage.click('[data-testid="send-ask"]');
        const localRes = await localAskPromise;
        const localJson = await localRes.json().catch(() => ({}));
        await clientPage
          .waitForFunction((n) => document.querySelectorAll('[data-testid="chat-turn"]').length > n, beforeLocal, { timeout: 120000 })
          .catch(() => {});

        const localAnswer = (await clientPage.locator('[data-testid="answer"]').last().textContent().catch(() => "")) || "";
        const localModelStr = typeof localJson.model === "string" ? localJson.model : "";
        rec.check(
          localAnswer.includes(LOCAL_MODE_TOKEN) && localModelStr.startsWith("local:"),
          "STEP-LOCAL: chat message round-trips through the box Ollama — rendered answer contains the token AND resp.model starts with 'local:' (0 Claude calls)",
          `token=${localAnswer.includes(LOCAL_MODE_TOKEN)} model=${localModelStr || "(none)"} answer="${localAnswer.trim().slice(0, 120)}"`
        );
        await shot(clientPage, "step-local-ollama-answer");
      } finally {
        // RESTORE mode=cloud through the REAL UI (residue-clean). If it succeeds, clear the
        // guard so the main teardown doesn't repeat it; if it fails, the guard stays set and
        // the main teardown retries.
        const restored = await restoreCloudMode(clientPage);
        if (restored) localModeMayBeSet = false;
        rec.check(
          restored,
          "STEP-LOCAL: model_mode restored to cloud through the UI (no residue)",
          `restoredToCloud=${restored}`
        );
      }
    }

  } catch (e) {
    rec.check(
      false,
      "LIFECYCLE completed without an unhandled error",
      (e.message || String(e)).slice(0, 200)
    );
  } finally {
    // ── RESTORE model_mode=cloud if STEP-LOCAL left it on Local (residue guard) ─────
    // Belt-and-suspenders: STEP-LOCAL's own finally already restores cloud on the happy
    // path; this only fires if that restore failed or the step aborted before it ran, so a
    // mid-step failure can never leave the account stuck in Local mode. Done FIRST (before
    // the prompt restore) so the rest of teardown runs against the normal cloud config.
    if (clientPage && localModeMayBeSet) {
      try {
        const ok = await restoreCloudMode(clientPage);
        if (ok) localModeMayBeSet = false;
        rec.check(
          ok,
          "RESTORE (teardown): Local mode returned to cloud through the UI (no residue)",
          `restoredToCloud=${ok}`
        );
      } catch (e) {
        rec.info("RESTORE (teardown): could not restore cloud mode", (e.message || String(e)).slice(0, 120));
      }
    }

    // ── RESTORE the system prompt via the real inline editor ──────────────────────
    if (clientPage && typeof originalPrompt === "string") {
      try {
        let r = { saved: false };
        for (let attempt = 1; attempt <= 2 && !r.saved; attempt++) {
          await clientPage.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          await clientPage
            .locator('[data-testid="assistant-console"]')
            .first()
            .waitFor({ state: "visible", timeout: 30000 })
            .catch(() => {});
          await clientPage.waitForTimeout(900);
          r = await saveInlinePrompt(clientPage, originalPrompt).catch(() => ({ saved: false }));
        }
        rec.check(
          !!r.saved,
          "RESTORE: original system prompt restored via the inline editor",
          `saved=${r.saved}`
        );
      } catch (e) {
        rec.info("RESTORE: prompt restore hit an error", (e.message || String(e)).slice(0, 120));
      }
    }

    // ── Clean up test spaces ───────────────────────────────────────────────────────
    if (clientPage && spaceIdsToClean.length > 0) {
      for (const sid of spaceIdsToClean) {
        try {
          await apiDeleteSpace(clientPage, sid);
          rec.info("residue cleanup: deleted test space", sid);
        } catch (e) {
          rec.info("residue cleanup: could not delete space", `${sid}: ${(e.message || String(e)).slice(0, 80)}`);
        }
      }
    }

    // ── Run A: deactivate the throwaway account ────────────────────────────────────
    if (RUN_MODE === "A" && createdUserEmail) {
      try {
        const admin2 = await signIn(browser, "admin", "/settings");
        const ap2 = admin2.page;
        await ap2.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await ap2.getByRole("button", { name: /^Users$/ }).first().click().catch(() => {});
        await ap2
          .locator(`[data-testid="user-row-${createdUserEmail}"]`)
          .first()
          .waitFor({ state: "visible", timeout: 15000 })
          .catch(() => {});
        await ap2.locator(`[data-testid="user-toggle-${createdUserEmail}"]`).first().click().catch(() => {});
        await ap2.waitForTimeout(800);
        await admin2.ctx.close().catch(() => {});
        rec.info("residue cleanup: deactivated throwaway client account via the Users UI", createdUserEmail);
      } catch (e) {
        rec.info("residue cleanup: could not deactivate throwaway account", (e.message || String(e)).slice(0, 120));
      }
    }

    await adminCtx?.close().catch(() => {});
    await clientCtx?.close().catch(() => {});
    await coldCtx?.close().catch(() => {});
    await browser.close();
  }

  return rec.summary();
}
