# NUCLEUS — Integrated Journey Spec — v2 (2026-07-03) — supersedes v1; call count unchanged

**This file is the SINGLE SOURCE OF TRUTH for the journey. Do NOT re-derive or re-debate the
composition from conversation. If it must change, EDIT THIS FILE.** (This doc exists because a long
session caused context rot — the agreed spec was lost and re-litigated repeatedly.)

**v2 (2026-07-03) — supersedes v1 (LOCKED 2026-07-01). The 6-call budget is UNCHANGED (5 Haiku +
1 Sonnet).** v2 folds in three additions that fire **zero new Claude calls**: (1) a gated,
zero-Claude **STEP-LOCAL** Ollama round-trip; (2) **F3** negative-citation assertions on STEP 6's
existing response; (3) **F4** same-filename collision probes on STEP 7's existing upload. It also
documents the per-step **model assertion** (added earlier the same night). See "v2 additions" below.

## The one integrated journey — 6 calls per run (5 Haiku + 1 Sonnet). Local + Prod = **12 total**.

Every run operates **INSIDE Knowledge Spaces** — this is the FOLDED journey, replacing the old
per-chat lifecycle. It is NOT a separate KS journey plus an old journey; it is ONE journey.

| # | Step | What it tests | Model |
|---|------|---------------|-------|
| 1 | STEP 3 | **in-space grounded read** — files uploaded into **Space A**, then a **NEW chat in Space A** reads them (cross-chat, in-space). Asserts grounded=true + references the files. | Haiku |
| 2 | STEP 6 | **cross-space isolation** — a chat in **Space B** CANNOT see Space A's files. | Haiku |
| 3 | STEP 9 | **delete + memory** — delete a doc, re-ask → deleted doc gone from retrieval AND the follow-up uses prior conversation (no "no context"). | Haiku |
| 4 | STEP 11 | **custom prompt takes effect** — edit the prompt to inject a MARKER token; assert the marker appears in the answer. **MARKER-based (deterministic), NOT brevity-collapse** (brevity is model-flaky on Haiku — that caused a prod failure). | Haiku |
| 5 | Global | **Entire-Workspace search** — toggle global ON, ask a cross-space question → surfaces BOTH spaces' files and attributes each to its space. | Haiku |
| 6 | Sonnet | **real answer quality** — re-ask a rich grounded question on **Sonnet** (Jenny's actual prod model) → verify a correct, grounded answer. | **Sonnet** |

### Rules
- The 3 KS behaviors (in-space, isolation, global): **in-space + isolation FOLD into STEP 3 & STEP 6**
  (no extra calls); **global is the 1 new call**. Sonnet answer-quality is the final call.
- All calls **Haiku** except call #6 which is **Sonnet** (Rule #0: Haiku for flow, Sonnet only for the
  answer-correctness check).
- **RUN=A** (new account) is the primary cert. RUN=B (existing seeded account) optional.
- **Budget: local 6 + prod 6 = 12.** Within the client's OK range (10–12).

## v2 additions (2026-07-03) — all fire ZERO new Claude calls

The 6-call table above is unchanged. These three fold-ins ADD assertions/steps without a 7th call:

1. **STEP-LOCAL — Local (Ollama) mode round-trip [0 Claude calls].** Runs AFTER all six SDK steps
   and the budget invariant, before teardown, using the CURRENT signed-in account (admin, post
   STEP 11). **GATED on `NUCLEUS_RUN_LOCAL_MODE=1`** — unset (e.g. a prod-target run, which cannot
   reach a box-local Ollama) → a **loud SKIP** (`rec.info`, "SKIP — not a false green"), never a
   bogus pass. When set: switch to Local through the REAL Settings→Model UI (endpoint
   `http://localhost:11434/v1`, model `llama3.2:3b`; the `[data-hydrated="1"]` wait mirrors
   `tests/journeys/local-mode.mjs`), send ONE chat "Reply with exactly: LIFECYCLE-LOCAL-OK" through
   the real console, and assert the rendered answer contains the token **AND** `resp.model` starts
   with `"local:"` (proves the ask hit Ollama, not Claude — hence 0 Claude cost). Then **RESTORE
   `model_mode=cloud` through the UI**. The restore is residue-safe: STEP-LOCAL's own `finally`
   restores cloud, and if that fails the journey's **main teardown** restores it (a mid-step failure
   can never leave the account stuck in Local mode).
2. **STEP 6+ — F3 negative-citation assertions (SAME response, no new call).** STEP 6 already asks in
   empty Space B and asserts it says it has no files + no leak. v2 adds, on the SAME response JSON:
   `grounded === false` **and** `(evidence?.chunks?.length ?? 0) === 0` — the engine must not
   fabricate grounding/citations for an answer that read no files (the F3 class: the grounding floor
   once overrode an explicit `SOURCES_USED: NONE`).
3. **STEP 7+ — F4 same-filename collision probes (0 SDK, read-only GET).** STEP 7's uploaded fixture
   is renamed to the SAME basename as one of STEP 2's Space-A uploads (the PDF; contents unchanged),
   so the same filename lands in a different scope (chat-2 / Space B). v2 adds read-only
   `GET /api/documents` probes: scoped to chat-2 the NEW doc is present, and Space A STILL has its
   own same-named doc with a **DISTINCT doc id** — the second upload did not steal/overwrite the
   first (the scoped id is `docIdFromFilename(name, session_id ?? space_id)`). Probed at STEP 7,
   before STEP 9 deletes Space A's PDF, while both docs coexist.

## Per-step model assertion (added 2026-07-02 night)

Every SDK step asserts `resp.model` — the RESOLVED model that answered — matches the model it
budgeted for: the five Haiku steps assert `model.startsWith("claude-haiku")`; the Sonnet step asserts
`model === "claude-sonnet-4-6"` (proving the `body.model` override took effect). STEP 3 (the first
Haiku step) additionally **FAILS FAST** — it throws — if the resolved model is not Haiku, because a
pinned `AGENT_MODEL` on the server (prod pins Sonnet) would silently run every "Haiku" step on Sonnet
at ~5× cost. To run a budgeted journey against a server, ensure `AGENT_MODEL` is unset (or override to
Haiku); to revert prod to Haiku: `flyctl secrets unset AGENT_MODEL -a nucleus-agent`.

## Engine + config context
- Answer engine: **Messages API + code-execution** (`ANSWER_ENGINE=messages`, `src/lib/engine/answer-messages.ts`).
- Model default: **Haiku** in code; prod pins Sonnet via the `AGENT_MODEL` Fly secret. For the journey's
  Haiku steps run with `AGENT_MODEL` unset (or model override to Haiku); the Sonnet step forces Sonnet.
- Space scoping seam: `listOwnerFiles(ownerId, chatId, {spaceId, globalMode})`. `/api/ask` + `/api/agent`
  pass `space_id` / `global_mode`. `/api/ingest` accepts `session_id` OR `space_id`.

## Known issues to fix while building (found on prod 2026-07-01)
1. **STEP 3 grounded read**: the engine grounds correctly (Fly logs: `[messages] grounding … evidence=1`)
   but the journey read `grounded=false` off the **prod UI**. Make the assertion read the REAL grounded
   signal robustly (from the answer/inspector that actually renders on the prod build), and confirm the
   Vercel deploy carried the new UI before asserting.
2. **STEP 11 prompt**: replace brevity-collapse with a **marker** assertion (prompt injects e.g.
   `NUCLEUS770-MARK:` and the answer must contain it) — deterministic across Haiku/Sonnet.

## How to run (local)
- Dev server: `ANSWER_ENGINE=messages ANTHROPIC_API_KEY=<billed> node_modules/.bin/next dev` (Haiku default;
  the subscription 429s on code-exec, so local uses the billed key — Haiku keeps it cheap).
- Journey: `JOURNEY_SDK=1 RUN=A NUCLEUS_BASE=http://localhost:3000 node scripts/run-journeys.mjs lifecycle`.
- Space UI testids: `spaces-sidebar`, `create-space-button/-form/-input`, `space-open-<id>`,
  `global-mode-toggle`, `spaces-list`. Reuse `apiCreateSpace` + space drivers from `knowledge-spaces.mjs`.

## Definition of done
- The integrated journey passes **all checks, RUN=A, LOCAL** (6 calls: 5 Haiku + 1 Sonnet), RED-first
  proven for isolation + delete. Then the lead deploys + runs it **on prod** (another 6) → 12 total green.
- v2: STEP 6+ (F3) and STEP 7+ (F4) are green on that SAME local RUN=A (0 extra calls). STEP-LOCAL is
  additionally green on a LOCAL dev server with `NUCLEUS_RUN_LOCAL_MODE=1` + a running box Ollama (0
  Claude calls); on a prod-target run it SKIPS loudly. The 12-call budget is unchanged.
