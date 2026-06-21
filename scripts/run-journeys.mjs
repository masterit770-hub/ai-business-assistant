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

const ALL = [
  ["auth", "./tests/journeys/auth.mjs"],
  ["chat", "./tests/journeys/chat.mjs"],
  ["chat-input", "./tests/journeys/chat-input.mjs"],
  ["citations", "./tests/journeys/citations.mjs"],
  ["answer-actions", "./tests/journeys/answer-actions.mjs"],
  ["documents", "./tests/journeys/documents.mjs"],
  ["account", "./tests/journeys/account.mjs"],
  ["admin", "./tests/journeys/admin.mjs"],
  ["model-modes", "./tests/journeys/model-modes.mjs"],
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

async function main() {
  const pick = process.argv.slice(2);
  const journeys = pick.length ? ALL.filter(([n]) => pick.includes(n)) : ALL;
  const summaries = [];
  for (const [name, path] of journeys) {
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
