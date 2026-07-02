// SHARED SKIP HELPER for the integration eval shards (tests/evals/*.mjs).
//
// WHY THIS EXISTS (the gate-honesty fix): every eval SKIPS LOUDLY when the LLM key or the
// Supabase creds are absent — the right call for a human running locally without secrets.
// But the skip used `process.exit(0)`, so to ANY exit-code automation (CI, a wrapper that
// runs the shard and checks `$?`) a creds-skip was INDISTINGUISHABLE from a real PASS. A
// green CI that never actually ran the answer-quality path is exactly the false-green this
// repo's testing doctrine forbids ("a skip is NOT a pass").
//
// THE FIX: the skip's EXIT CODE is now mode-dependent, decided in ONE place so it can't
// drift across the 13 shards:
//   • DEFAULT (a human, no CI flag): exit 0 — a skip is benign, the human sees the loud
//     "SKIPPED — not a pass" banner and moves on. Behavior is byte-for-byte as before.
//   • STRICT (CI_STRICT=1 or REQUIRE_CREDS=1): exit 1 — in CI a creds-skip is a FAILURE,
//     never a silent pass. The same loud banner prints; only the exit code becomes honest.
//
// The human-facing message is UNCHANGED in either mode; we only append a one-line note in
// strict mode explaining why the exit is non-zero, so a CI log reader isn't mystified.
//
// Usage in a shard:
//   import { skip } from "./_skip.mjs";
//   if (!haveSupabase) skip("cold-start-durability", "Supabase creds not found — …");
// `skip()` prints + EXITS the process (it never returns).

// Strict mode is requested by EITHER flag, set to anything truthy-ish but not "0"/"false".
const truthyFlag = (v) => v != null && v !== "" && v !== "0" && v.toLowerCase?.() !== "false";
export const STRICT = truthyFlag(process.env.CI_STRICT) || truthyFlag(process.env.REQUIRE_CREDS);

export function skip(evalName, msg) {
  const line = "═".repeat(72);
  console.log("\n" + line);
  console.log(`⏭  SKIPPED — ${evalName} eval did NOT run (this is NOT a pass).`);
  console.log("   " + msg);
  if (STRICT) {
    // CI_STRICT/REQUIRE_CREDS is set → a missing-creds skip is a FAILURE, not a silent pass.
    console.log("   ✗ CI_STRICT/REQUIRE_CREDS is set → exiting NON-ZERO: a creds-skip is a CI failure, never a pass.");
  }
  console.log(line);
  process.exit(STRICT ? 1 : 0);
}
