#!/usr/bin/env node
// ANSWER-QUALITY GATE  (npm run test:gate)
//
// WHY THIS EXISTS (the gate-honesty fix): the deterministic `npm test` (unit + api +
// components) is fast and runs everywhere, but it proves ZERO about whether a real user
// gets a CORRECT, GROUNDED, CITED answer — that lives in the integration evals, which need
// live creds (LLM + Supabase) and so are not in `npm test`. The result: a green CI told you
// nothing about answer quality. THIS script is the creds-gated companion gate: when creds
// are present it runs a REPRESENTATIVE answer-quality shard and FAILS LOUD (non-zero) on a
// real miss; under CI_STRICT it ALSO fails on a creds-skip (a skip is never a silent pass).
//
// WHAT IT RUNS (representative, not the whole 50-scenario sweep — that's run-evidence-evals.sh):
//   • answer-reliability.mjs, sharded to the HIGH-VALUE rows (RELIABILITY_ONLY) — the Carter
//     golden-value child-support answer, the maintenance aggregate, AND the SCHED count rows
//     (the cell-tally lane: system-wide max, per-month, specific-person count, adversarial
//     no-fabrication). Each still at the SAME strict 5/5 gate; sharding only selects WHICH
//     questions, never lowers the bar.
//   • cold-start-durability.mjs — the full durability + isolation regression (uploaded
//     spreadsheet survives a serverless cold start, owner-scoped, cited).
// These three families together are the "a real user gets a correct grounded answer" proof.
//
// EXIT CODE (honest):
//   • all selected shards pass            → 0
//   • any shard FAILS a real assertion    → 1  (a genuine answer-quality miss)
//   • a shard SKIPS for missing creds:
//       - default (no CI flag)            → that shard is SKIPPED-but-not-failed; the gate
//                                            prints a loud notice and exits 0 ONLY IF nothing
//                                            actually failed (a human without creds is not
//                                            blocked, but is told the gate did not prove quality)
//       - CI_STRICT=1 / REQUIRE_CREDS=1   → the shard exits NON-ZERO (see _skip.mjs) → the gate
//                                            FAILS. In CI a creds-skip is a failure, never a pass.
//
// CONCURRENCY: shards run SERIALLY. Concurrent runs against the shared provider key cause
// transient `fetch failed` false-REDs (documented in answer-reliability.mjs); one at a time.
//
// USAGE:
//   npm run test:gate                 # human: runs if creds present, loud skip-notice if not
//   CI_STRICT=1 npm run test:gate     # CI: a creds-skip is a hard FAILURE
//   GATE_RELIABILITY_ONLY=...         # override the sharded id list (advanced)

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRICT =
  !!process.env.CI_STRICT && process.env.CI_STRICT !== "0" && process.env.CI_STRICT.toLowerCase() !== "false" ||
  !!process.env.REQUIRE_CREDS && process.env.REQUIRE_CREDS !== "0" && process.env.REQUIRE_CREDS.toLowerCase() !== "false";

// The high-value answer-quality rows: the Carter golden-value answer + the maintenance
// aggregate + the SCHED cell-tally count space (system-wide max, per-month, specific-person
// count, and the adversarial no-fabrication guards). Every row still runs at the strict 5/5
// gate inside answer-reliability.mjs.
const RELIABILITY_ONLY =
  process.env.GATE_RELIABILITY_ONLY ||
  [
    // Carter golden VALUE (the $1,285 the journey tests also pin) + aggregate
    "EN/child-support",
    "EN/child-support-terse",
    "EN/maintenance-all-time",
    // SCHED count space — the cell-tally lane the client actually exercised
    "HE/sched-most-no-month",
    "HE/sched-system-wide",
    "HE/sched-december-most",
    "EN/sched-most-active",
    "HE/sched-count-rina-system",
    // adversarial: must NOT fabricate over her own data
    "HE/sched-adv-phone",
  ].join(",");

const shards = [
  {
    name: "answer-reliability (sharded: Carter golden + SCHED count rows)",
    file: "tests/evals/answer-reliability.mjs",
    env: { RELIABILITY_ONLY },
  },
  {
    name: "cold-start-durability (uploaded sheet survives cold start, owner-scoped, cited)",
    file: "tests/evals/cold-start-durability.mjs",
    env: {},
  },
];

console.log("═".repeat(72));
console.log(`ANSWER-QUALITY GATE — ${STRICT ? "CI_STRICT (a creds-skip FAILS)" : "default (creds-skip is a loud no-op)"}`);
console.log("Running representative answer-quality shards SERIALLY (no pass@K; strict 5/5 inside).");
console.log("═".repeat(72));

let failed = 0;
let skipped = 0;
for (const s of shards) {
  console.log(`\n▶ ${s.name}`);
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", s.file],
    { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...s.env } }
  );
  const code = res.status;
  // A shard that SKIPPED for missing creds exits 0 in default mode (benign) and 1 in strict
  // (a failure). We can't see the banner text from here, so we treat exit code as the truth:
  // strict already turns a skip into a non-zero, so any non-zero here is a real gate failure.
  if (code !== 0) {
    failed++;
    console.log(`  ✗ shard FAILED (exit ${code})`);
  } else {
    console.log(`  ✓ shard exit 0`);
  }
}

console.log("\n" + "═".repeat(72));
if (failed > 0) {
  console.log(`ANSWER-QUALITY GATE: FAILED — ${failed}/${shards.length} shard(s) did not pass.`);
  console.log("A real user would NOT reliably get a correct grounded answer. Fix before merge.");
  process.exit(1);
}
// Nothing failed. In default mode a shard MAY have skipped for missing creds (exit 0). We
// surface that honestly so a human isn't misled into thinking quality was proven.
if (!STRICT) {
  console.log("ANSWER-QUALITY GATE: no failures.");
  console.log("NOTE: in default mode a shard with missing creds SKIPS (exit 0) and proves nothing.");
  console.log("      Run with creds present (CI_STRICT=1 in CI) to make this a real quality gate.");
} else {
  console.log("ANSWER-QUALITY GATE: PASSED — every shard ran with creds and met its bar.");
}
process.exit(0);
