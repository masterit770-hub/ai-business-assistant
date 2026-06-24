#!/usr/bin/env bash
# Evidence capture for the integration-eval layer (tests/evals/*.mjs).
# Runs each eval SERIALLY (concurrency is the sole cause of false-REDs against the
# shared DeepSeek key) in STRICT mode (CI_STRICT=1 → a creds-skip exits NON-ZERO, so a
# skip can never masquerade as a pass). Captures each eval's full stdout/stderr to its
# own log and records the exit code, so "every test checked" is provable.
set -u
cd "$(dirname "$0")/.."
EV=docs/testing/evidence/2026-06-24
mkdir -p "$EV"
export CI_STRICT=1

# answer-reliability is the expensive 5x-per-scenario gate; target HER bugs (the count
# SCHED rows + the alimony/income/child-support rows) rather than the whole 50-scenario
# sweep that today's live verification already covered.
RELI_IDS="HE/sched-most-no-month,HE/sched-system-wide,EN/sched-most-active,EN/sched-most-active-crosscorpus,HE/sched-least,HE/sched-count-rina-system,HE/sched-adv-phone,HE/sched-count-nonexistent,EN/alimony-advice,EN/income-compare,EN/child-support"

run() {  # run <logname> <node-args...>
  local name="$1"; shift
  local log="$EV/eval-$name.log"
  echo "### RUN $name"
  node "$@" > "$log" 2>&1
  local code=$?
  echo "eval_${name}_exit=$code" | tee -a "$EV/00-context.txt"
  tail -3 "$log" | sed 's/^/    /'
}

echo "==== INTEGRATION EVAL EVIDENCE  ($(git rev-parse --short HEAD)) ===="
RELIABILITY_ONLY="$RELI_IDS" run answer-reliability tests/evals/answer-reliability.mjs
run case-file-grounding   tests/evals/case-file-grounding.mjs
run prompt-save-roundtrip tests/evals/prompt-save-roundtrip.mjs
run cold-start-durability tests/evals/cold-start-durability.mjs
run settings-durability   tests/evals/settings-durability.mjs
run per-user-settings     tests/evals/per-user-settings.mjs
run recommendation        tests/evals/recommendation-substance.mjs
run router-decisions      tests/evals/router-decisions.mjs
run keyless-model-error   tests/evals/keyless-model-error.mjs
run scanned-pdf-ocr       tests/evals/scanned-pdf-ocr.mjs
run upload-formats        tests/evals/upload-formats.mjs
run edge-journeys         tests/evals/edge-journeys.mjs
echo "==== EVAL EVIDENCE DONE ===="
