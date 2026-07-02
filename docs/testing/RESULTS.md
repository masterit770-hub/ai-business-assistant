# Test-evidence log — 2026-06-24

**What this is:** a run-and-capture of every test layer with a per-suite PASS/FAIL verdict, so
"every test checked" is provable. Raw per-suite output lives under `docs/testing/evidence/2026-06-24/`
(git-ignored — the eval logs contain real client names from her sheets; kept local, not committed).

- **Repo HEAD at capture:** `699ac41` (branch `ui-redesign`) — deterministic gate re-confirmed green at this commit
- **Deployed (live) app:** `nucleus-woad.vercel.app` @ `b7d9e29` (deployed 2026-06-24) — the count fix + all
  client-reported-bug fixes **plus the DV5/EG4/AD4 edge cases**, the whole count surface live-verified post-deploy

---

## Top-line

| Layer | Verdict | Count | Evidence file |
|---|---|---|---|
| Build gate (`tsc --noEmit`) | ✅ PASS | 0 errors | `01-tsc.log` |
| Unit | ✅ PASS | **331 / 331** | `02-unit.log` |
| API contract (route handlers) | ✅ PASS | **119 / 119** | `03-api.log` |
| Component (Vitest + RTL) | ✅ PASS | **149 / 149** (16 files) | `04-components.log` |
| E2E / journeys (live, real browser) | ✅ PASS | **9 / 9 journeys** (chat/citations now golden-value) | `05-journeys.log`, `05b-journeys-rerun.log`, `07-journeys-goldenvalue.log` |
| Integration evals (real engine + Supabase + LLM) | ✅ PASS | **12 / 12 evals; answer-reliability 13/13 @ 5/5** | `06-evals-run.log`, `eval-*.log` |

**Deterministic total: 599 / 599 passing.** Live journey suite: **green 9/9** (after correcting 2 stale tests — see below).

---

## 1. Deterministic suites (`npm test`)
Ran via `npm run test:unit` / `test:api` / `test:components`. All exit 0.
- **Unit (331):** validators, parsers, the cell-tally engine (tally-correctness, tie/least direction,
  activity-vs-person classifier, filter-by-count, sparse-grid, non-existent-name → 0), sql-guard,
  structured-store, answer-helpers, validate-answer/validate-claim-support.
- **API contract (119):** every route handler driven directly (real handler runs; only I/O seams mocked) —
  auth/role gating, input validation + status codes, **per-user owner-scoping**, the **write-only-key**
  protection, self-lockout guards, demo-gating, friendly error mapping, never-500 contracts.
- **Component (149):** every stateful component — the prompt-save **"Saved"-lie** class (Save only on real
  2xx), the **two-step confirm** destructive actions, owner/role UI boundaries, model-key never-clobber.

## 2. Live E2E journeys (Playwright vs nucleus-woad, real Chromium, real sign-in)
Final: **9/9 PASS.** Per-journey:

| Journey | Checks | Evidence highlights |
|---|---|---|
| auth | 6/6 | unauth routes → /sign-in; admin sign-in reaches /dashboard; console renders |
| chat | **7/7** | cited; **golden VALUES — parties = Joni + Michel Carter, child support = $1,285**; follow-up uses prior turn; new-chat clears; resume |
| chat-input | 4/4 | Shift+Enter newline (no send); Enter sends; input clears; arrow-button sends |
| citations | **5/5** | **golden — asserts the real parties (a wrong-but-cited answer now FAILS)**; clickable real `<button>` chip; reveals the cited passage; toggles |
| answer-actions | 3/3 | **real cost line** (`$0.003`); copy-to-clipboard; regenerate re-runs |
| documents | 7/7 | real PDF download (119,905 bytes, `%PDF-`); **two-step delete → row removed → excluded from corpus → restored** |
| account | 4/4 | display-name save (real auth update); theme toggle; password-mismatch rejected |
| admin | 3/3 | Users panel renders; role-change controls; **create user surfaces temp password → deactivated** |
| model-modes | 6/6 | Cloud/HIPAA/Local switch + keyless → clear error |

### ⚠️ Two journeys were STALE tests (false-REDs) — diagnosed, fixed, re-run green
The first live run flagged `documents` and `admin` FAIL. I did **not** hand-wave them as "flaky" — I probed
each to ground truth on the live app:
- **documents:** the journey drove the **old `window.confirm()` delete** (registered a dialog handler + one
  click). The shipped UI is a **two-step inline confirm** (`DeleteControl`: Delete → Delete?/Delete/Cancel) —
  which **is the fix for the client's "delete is unreachable" bug** (native `confirm()` is browser-suppressible).
  Direct probing proved the product is correct: `DELETE 200`, `deleted_sources` written, bundled list excludes
  it. Updated the journey to drive the real two-step flow → **7/7**, with the delete now live-verified end-to-end.
- **admin:** after the Settings **sub-tab redesign** (Prompts/Models/Appearance/Users; panels kept mounted but
  `hidden`), the journey landed on the default tab, so the Users panel was hidden→not "visible". Deep-linked to
  `?tab=users` → **3/3** (creates + deactivates a real test user).

Product was correct in both cases; the tests were stale. Fixes committed in `e2a084b`.

## 3. Live verification of the client-reported bugs (on nucleus-woad)
| Client report | Status | How verified |
|---|---|---|
| "who is more active" → made-up names | ✅ fixed | system-wide most-scheduled person = **29** (correct name, 3/3 stable, no contracts/company leak); per-month tie groups correct; specific-person count = **15** |
| alimony question → short dead-end | ✅ fixed | grounds $130k/$95k incomes + $1,285/mo child support, cited; substantive recommendation |
| changing the prompt didn't save | ✅ fixed | round-trip persists; failed save shows error, no false "Saved" |
| couldn't delete sources | ✅ fixed | two-step inline confirm verified live end-to-end (no suppressible native dialog) |
| uploaded files "disappeared" | ✅ fixed | durable owner-scoped uploads (doc_chunks/uploaded_rows); cold-start eval |

## 4. Integration evals (real engine + Supabase + DeepSeek, serial, STRICT 5/5)
Ran `scripts/run-evidence-evals.sh` (serial; `CI_STRICT=1`, so a creds-skip fails rather than passes).
**All 12 evals exit 0** (`06-evals-run.log` + `eval-*.log`).

**`answer-reliability` — 13/13 gates, every one 5/5 strict** (the bug-targeted shard, no pass@K):
- *Count (her "who's more active" bug):* `sched-most-no-month`, `sched-system-wide` (= 29, correct name),
  `EN/sched-most-active`, `EN/sched-most-active-crosscorpus` (regression guard — no bundled-company leak),
  `sched-least`, `sched-count-rina-system` (= 15), `sched-adv-phone` (no fabrication),
  `sched-count-nonexistent` (honest 0) — **5/5 each**.
- *Legal Q&A (her alimony bug):* `EN/child-support` ($1,285), `EN/alimony-advice`, `EN/income-compare`
  ($130k/$95k) — must-ground **5/5 each**.

**Standalone evals — all exit 0:** case-file-grounding, prompt-save-roundtrip, cold-start-durability,
settings-durability, per-user-settings, recommendation-substance, router-decisions, keyless-model-error,
scanned-pdf-ocr, upload-formats, edge-journeys.

**Plus a creds-gated answer-quality gate** (`npm run test:gate`, `scripts/answer-quality-gate.mjs`): the
companion to `npm test` — `npm test` proves zero answer-quality (no live LLM), this fails loud on a real
miss OR a creds-skip under `CI_STRICT`.

## 5. Honest open items
- **Urgency flagging** — only partially covered (no scenario gate yet).
- **Local/Ollama mode** (`#6`) — in scope, must be tested (box-local + remote); not yet exercised. Not top priority.

_Closed this session:_ journey value-blindness (**#42** — chat/citations now assert the golden **$1,285** +
the real parties, with a negative-lookahead matcher so `12850` ≠ `1285`); the creds-gated answer-quality gate
(**#41** — `npm run test:gate`); the two stale journeys (documents two-step-confirm, admin sub-tab nav); and
the **DV5/EG4/AD4 deploy** (`b7d9e29` → nucleus-woad) — the whole count surface now live-verified, incl. the
edge cases (exactly-N set cited; sparse → honest no-rank; non-existent name → honest "not in your file").
Also confirmed the count engine is **general, not hardcoded** — ran the real tally/filter functions on a
freshly-invented grid (names in no test) and they computed every case correctly; cheat-grep clean.
