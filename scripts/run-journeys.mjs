#!/usr/bin/env node
// Nucleus journey + component test runner.
//
// Runs every committed journey under tests/journeys against the LIVE deployed app,
// prints a per-journey PASS/FAIL line for each check, then a final summary table and
// an overall pass/fail verdict. Read-only on product source — these tests only assert
// the real user-visible behavior. Shared state changed by a journey is restored by that
// journey; the runner adds a final belt-and-suspenders un-delete of the bundled
// family-court source so the demo always keeps the case file.
//
//   node scripts/run-journeys.mjs                # all journeys
//   node scripts/run-journeys.mjs auth chat      # a subset by name
import { execFileSync } from "node:child_process";
import { BASE } from "../tests/journeys/lib.mjs";

// ── PREFLIGHT ────────────────────────────────────────────────────────────────────
// Before ANY journey runs, make the target deployment LOUD and UNMISSABLE: which BASE
// resolved, and whether it came from NUCLEUS_BASE or the built-in default. Then a single
// plain HTTP GET to BASE/ confirms the deployment actually answers — so we never spend a
// whole journey run (or, worse, a paid SDK call) certifying a URL that is down or wrong.
// This is a $0 check: GET / is the landing/sign-in page, never an /api/ask agentic call.
async function preflight() {
  const fromEnv = !!(process.env.NUCLEUS_BASE && process.env.NUCLEUS_BASE.trim());
  const source = fromEnv ? "NUCLEUS_BASE (explicit)" : "built-in default (lib.mjs)";
  const bar = "=".repeat(64);
  console.log(`\n${bar}\n  JOURNEY TARGET: ${BASE}\n  resolved from : ${source}\n${bar}`);

  let status;
  try {
    const res = await fetch(`${BASE}/`, { method: "GET" });
    status = res.status;
  } catch (e) {
    console.error(`\n[preflight] ABORT — ${BASE}/ did not respond: ${(e?.message || e)}`);
    console.error("[preflight] Set NUCLEUS_BASE to a reachable deployment (or start the dev server) and retry.");
    process.exit(2);
  }
  if (status >= 500) {
    console.error(`\n[preflight] ABORT — ${BASE}/ returned HTTP ${status} (server error). Refusing to run journeys against a broken deployment.`);
    process.exit(2);
  }
  console.log(`[preflight] OK — ${BASE}/ responded HTTP ${status}\n`);
}

// Ordered cheap → expensive so a plumbing failure aborts BEFORE any paid SDK call. The
// ZERO-SDK modules (ingest-formats, console-ux, sidebar-accounts, prompts-persist, the
// delete half of per-chat-scoping) run first and cost $0. The two SDK-bearing modules run
// LAST and self-skip unless NUCLEUS_RUN_SDK=1:
//   • per-chat-scoping → its B11 cross-chat isolation ask is the ONLY paid call there;
//   • answer-surface   → the bounded answer-quality set (≤3 paid asks, provably capped).
const ALL = [
  ["auth", "./tests/journeys/auth.mjs"],
  ["chat", "./tests/journeys/chat.mjs"],
  ["chat-input", "./tests/journeys/chat-input.mjs"],
  ["citations", "./tests/journeys/citations.mjs"],
  ["answer-actions", "./tests/journeys/answer-actions.mjs"],
  ["documents", "./tests/journeys/documents.mjs"],
  ["bulk-delete", "./tests/journeys/bulk-delete.mjs"],
  ["account", "./tests/journeys/account.mjs"],
  ["admin", "./tests/journeys/admin.mjs"],
  ["model-modes", "./tests/journeys/model-modes.mjs"],
  // ── NEW zero-SDK coverage (ingest formats, console UX, per-account sidebar, prompts) ──
  ["ingest-formats", "./tests/journeys/ingest-formats.mjs"],
  ["console-ux", "./tests/journeys/console-ux.mjs"],
  ["sidebar-accounts", "./tests/journeys/sidebar-accounts.mjs"],
  ["prompts-persist", "./tests/journeys/prompts-persist.mjs"],
  // ── Knowledge Spaces (migration 016): zero-SDK + optional SDK checks ──────────────
  ["knowledge-spaces", "./tests/journeys/knowledge-spaces.mjs"], // KS-0..KS-6 zero-SDK; KS-SDK gated behind NUCLEUS_RUN_KS_SDK=1
  // ── Local (Ollama) mode v0.5: zero-CLAUDE (asks hit the user's Ollama) ─────────────
  ["local-mode", "./tests/journeys/local-mode.mjs"], // gated behind NUCLEUS_RUN_LOCAL_MODE=1 (needs box-local Ollama + a local dev server)
  // ── SDK-gated (self-skip unless NUCLEUS_RUN_SDK=1) — run LAST ──────────────────────
  ["lifecycle", "./tests/journeys/lifecycle.mjs"], // INTEGRATED JOURNEY: 6 SDK calls (5 Haiku + 1 Sonnet), gated behind JOURNEY_SDK=1; RUN=A|B — per docs/testing/INTEGRATED-JOURNEY-SPEC.md
  ["per-chat-scoping", "./tests/journeys/per-chat-scoping.mjs"], // 1 paid ask (B11), gated
  ["answer-surface", "./tests/journeys/answer-surface.mjs"], // ≤3 paid asks, gated + capped
];

function finalRestoreFamilyCourt() {
  try {
    const out = execFileSync("bash", ["-c",
      `set -a; . /home/codex/Projects/nucleus/.secrets/supabase.env; set +a; ` +
      `PGPASSWORD="$SUPABASE_DB_PASSWORD" psql ` +
      `"host=db.\${SUPABASE_PROJECT_REF}.supabase.co port=5432 dbname=postgres user=postgres sslmode=require" ` +
      `-tAc "delete from public.deleted_sources where source_id='family-court'; select count(*) from public.deleted_sources;"`
    ], { encoding: "utf8", timeout: 30000 });
    console.log(`\n[runner] final family-court restore — total deleted_sources rows now: ${out.trim().split(/\s+/).pop()}`);
  } catch (e) {
    console.log(`\n[runner] final family-court restore FAILED: ${(e.message || e).slice(0, 200)}`);
  }
}

// Supabase auth rate-limits sequential sign-in attempts when many journeys run
// back-to-back. Each journey that signs in (most of them) adds one auth call;
// by the 3rd+ journey the auth endpoint may return a rate-limit error. The primary
// fix is the auto-retry back-off logic in lib.mjs signIn(). This runner-level pause
// (5 s) is a secondary guard that spaces out burst auth attempts so the retry rarely
// needs to fire. 5 s is intentionally short — signIn()'s 25 s back-off handles the
// real window; the runner pause just prevents pure burst.
const BETWEEN_JOURNEY_DELAY_MS = 5000;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await preflight();
  const pick = process.argv.slice(2);
  const journeys = pick.length ? ALL.filter(([n]) => pick.includes(n)) : ALL;
  const summaries = [];
  for (let i = 0; i < journeys.length; i++) {
    const [name, path] = journeys[i];
    if (i > 0) {
      // Brief pause between journeys to avoid Supabase auth rate-limit.
      await sleep(BETWEEN_JOURNEY_DELAY_MS);
    }
    console.log(`\n=== JOURNEY: ${name} ===`);
    try {
      const mod = await import(new URL(path, `file://${process.cwd()}/`).href);
      const s = await mod.run();
      summaries.push(s);
    } catch (e) {
      console.log(`  [FAIL] journey crashed — ${(e.stack || e.message || String(e)).split("\n").slice(0, 4).join(" | ")}`);
      summaries.push({ journey: name, total: 0, failed: 1, checks: [{ pass: false, label: "journey crashed", evidence: (e.message || String(e)).slice(0, 200) }] });
    }
  }

  // belt-and-suspenders restore of the bundled case file.
  finalRestoreFamilyCourt();

  // Final table.
  console.log("\n\n================ JOURNEY SUMMARY ================");
  let totalFail = 0;
  for (const s of summaries) {
    const verdict = s.failed === 0 ? "PASS" : "FAIL";
    totalFail += s.failed;
    console.log(`${verdict.padEnd(5)} ${String(s.journey).padEnd(22)} ${s.total - s.failed}/${s.total} checks`);
  }
  console.log("================================================");
  console.log(totalFail === 0 ? "OVERALL: PASS" : `OVERALL: FAIL (${totalFail} failed check(s))`);
  process.exit(totalFail === 0 ? 0 : 1);
}

main();
