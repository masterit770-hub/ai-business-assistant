# Nucleus — Testing Architecture & Master Index

**This is the most important asset in the repo. Every change ships through this.** It defines the four
test layers, maps every test file, and — most importantly — the **coverage matrix** that makes every gap
visible. A capability is "done" only when every cell it touches is green AND it has a scenario gate.

---

## 1. The four layers (what each is, the boundary, what it catches)

| Layer | What it is | Catches | Must NOT rely on | Nucleus home |
|---|---|---|---|---|
| **Unit** | one pure function/module in isolation; fast, deterministic, no I/O | validator/parser/algorithm/logic bugs | the network, a DB, a browser | `tests/unit/*.test.mts` |
| **Integration** | real seams wired together — engine pipeline (route→retrieve→generate→validate), API↔DB↔engine, text-to-SQL↔SQLite, the **real Supabase** path, cold-start | wiring/contract/data-flow bugs, owner-scoping, durability, grounding behavior | mocking the thing under test; the in-memory fallback when the real path is claimed | `tests/evals/*.mjs` |
| **Component** | one **stateful UI component** rendered in isolation; props → state → interaction → render | UI-state bugs (the "Saved"-lie, greying, confirm flows, disabled states) | hitting the real backend (mock the fetch, assert the state machine) | `tests/components/*.test.tsx` (16 files / 149 tests) |
| **API contract** | one **route handler** driven directly (the real handler runs); only its I/O seams (auth resolver, the Supabase client/stores, `NextResponse`) are `mock.module`'d | HTTP-contract bugs the client hits — wrong status/validation order, auth/role gating, **per-user owner-scoping**, the write-only-key protection, self-lockout guards, demo-gating, error→status mapping, the never-500 contracts | mocking the handler itself; a live DB/network (assert the handler's decisions, not the store) | `tests/api/*.test.mts` |
| **E2E / Journey** | the real user flow through the **deployed** app in a real browser | the integration of *everything* + the deployed env (keys/config) + what the user actually sees | demo-mode shortcuts standing in for the real deployed run | `tests/journeys/*.mjs` + `evals/golden-evals.mjs` (Playwright) |

**Plus, orthogonal to the layers:** a per-capability **scenario design** — client-asked + lead-derived
variations/phrasings/scope + **adversarial** (try to make it fabricate) + self-consistency — applied at
whichever layer(s) the capability lives. Verifying *one canonical phrasing* ≠ verifying the capability.
Model: [`count-coverage.md`](./count-coverage.md). **Every capability gets one.**

---

## 2. Coverage matrix — capability × layer (the gap-finder)
🟢 real guard · 🟡 partial / one-phrasing-only · 🔴 gap · — n/a

The **API** column = the route-handler HTTP-contract layer (§6, `tests/api/*`). 🟢 = its handlers' contract
is guarded (auth/role, validation, owner-scoping, error mapping).

| # | Capability | Unit | Integration | API | Component | E2E | Scenario gate |
|---|---|:--:|:--:|:--:|:--:|:--:|---|
| 1 | Upload→ingest (pdf/excel/word/csv/scanned) | 🟢 ocr-decision, pdf-pagination | 🟢 upload-formats, scanned-pdf-ocr | 🟢 ingest-route, **scanned-pdf-ingest** | 🟢 chat-upload, upload-button | 🟢 **ingest-formats** (Z1–Z5: born-digital+scanned(200 not 500)+docx+415+csv+xlsx Hebrew-name, real /api/ingest POST) | — |
| 2 | Document Q&A — grounded + cited | 🟢 answer-helpers, validate-answer | 🟢 case-file-grounding, answer-reliability | 🟢 ask-route | 🟢 assistant-console | 🟢 chat, golden-evals, **answer-surface** (Q1 cross-Excel leaderboard + Q2 Excel↔PDF cross + scanned-PDF probe — ≤3 SDK asks, gated NUCLEUS_RUN_SDK=1, capped+provable) | — |
| 3 | Structured / text-to-SQL (lookup, SUM/COUNT) | 🟢 sql-guard, structured-store, table-view | 🟢 router-decisions, edge AGG | 🟢 table-route | 🟢 table-viewer | 🔴 | — |
| 4 | **Grid count / ranking (cell-tally)** | 🟢 cell-tally + cell-tally-coverage + gate units | 🟢 answer-reliability SCHED — all variations 5/5 serial | — | — | 🟢 WHOLE surface live-verified on nucleus-woad (incl. DV5/EG4/AD4 after b7d9e29 deploy) | 🟢 count-coverage.md — all 24 rows guard-green |
| 5 | Hebrew / cross-lingual Q&A | 🟢 | 🟢 cold-start HE, edge cross-lingual | — | — | 🔴 | — |
| 6 | Grounding fidelity / no-fabricate / validateAnswer | 🟢 validate-answer, validate-claim-support, salvage, **grounding** (F3: SOURCES_USED parse + absent-only floor) | 🟢 answer-reliability, edge UNANSWERABLE, **negative-citation** (F3 LIVE: general-knowledge Q in a chat WITH a doc → grounded=false / 0 evidence / no fabricated cite; opt-in NUCLEUS_RUN_NEG_CITATION, 1 Haiku ask) | 🟢 ask-route (friendly error) | — | 🟡 | 🟡 negative case now covered; still needs the broader adversarial set |
| 7 | Recommendation — never dead-end | 🟢 grounded-general-fallback | 🟢 recommendation-substance | — | — | 🔴 | — |
| 8 | Keyless / model-mode → clear error | 🟢 cloud-provider, hipaa-mode, keyless, model-switch | 🟢 keyless-model-error | 🟢 settings, test-connection, local-models | 🟢 models-panel, model-switch | 🟡 model-modes; **lifecycle asserts resp.model** (5 Haiku steps start `claude-haiku`, Sonnet step == `claude-sonnet-4-6`; STEP 3 FAIL-FASTS if AGENT_MODEL silently pins Sonnet) | — |
| 9 | Per-user settings / **prompt-save** | 🟢 settings-save-feedback | 🟢 per-user-settings, prompt-save-roundtrip | 🟢 settings-route (write-only-key) | 🟢 answer-setup, prompts-panel, account-panel | 🟢 **prompts-persist** (Z22: edit→save→reload→re-read + GET ground truth round-trip; original restored) | — |
| 10 | Cold-start durability (docs + settings) | — | 🟢 cold-start-durability, settings-durability | — | — | — | — |
| 11 | Delete source (purged from retrieval) | 🟢 deleted-sources | 🟢 edge DELETE | 🟢 documents-route (403 boundary) | 🟢 materials-rail (global+chat modes), uploaded-docs, bundled-docs | 🟢 documents — two-step inline confirm → excluded, live-verified | — |
| 12 | Multi-chat / conversations + **bulk-delete** (#74) | 🟢 conversation, session-titles, ask-sessions | 🟢 ask-history | 🟢 history-route (owner-scope) + **bulk-delete-route** (owner-scope, cascade doc_chunks+uploaded_rows) | 🟢 conversations-column, history-panel (incl. bulk-select state machine — 8 RED-first tests) | 🟢 **bulk-delete** — create chats, select-one, confirm, GOLDEN post-state (survivor remains + API truth) | — |
| 13 | Auth / kick-out / per-user isolation | 🟢 account-validate, invite | 🟢 edge ISOLATION | 🟢 admin-users, documents-file (isolation) | 🟢 auth-form, users-panel | 🟢 auth, admin, **sidebar-accounts** (Z16 client=no Sample-data / Z17 demo-user=Sample-data / Z18 admin=all-owners+emails / Z19 open-chat replay + not-found — each under its own production-faithful context) | — |
| 14 | Urgency flagging | 🟡 | 🟡 | — | 🟡 (rail badge) | 🔴 | 🔴 **uncovered** |
| 15 | UI render (chat / sources / inspector / citations / account) | 🟢 answer-helpers | — | — | 🟢 console, rail, account, table-viewer, **answer-view (markdown)**, **assistant-console (optimistic/stop)** | 🟢 chat, rail-render, citations, account, **console-ux** (Z11 optimistic bubble + Z12 working-indicator/Stop + Z13 markdown DOM + Z14 latency — RED-first via route-stub + DB-seeded markdown) | — |
| 16 | Per-chat docs (#75) — global view-only catalog + chat-scoped view + click-to-chat; session_id-tagged uploads | 🟢 per-chat-scoping (scoping logic) | 🟢 per-chat-context-isolation (integration: chat-scoped retrieval, session-tagged store/fetch) | 🟢 documents-route (session_id+chatLabel resolution) + **ingest-route** (session_id propagation) | 🟢 materials-rail (global: no upload + chat labels + Unassigned + click-nav; chat: upload present + scoped fetch + no labels) | 🟢 documents + **per-chat-scoping** journey (Z21: upload→chat Files rail→two-step inline confirm→row gone→DB-absent; **B11** cross-chat isolation = 1 SDK ask, gated NUCLEUS_RUN_SDK=1) + bulk-delete cleans session-tagged stores | — |
| 17 | **Knowledge Spaces (016)** — per-space file scoping, cross-space isolation, chat→space membership, space delete + residue | 🔴 | 🔴 (cross-space isolation proven at E2E, not yet an eval) | 🟢 **spaces-session-bookkeeping** (F1/F2/F7 RED-first: session→space register on ask+upload; GET merges table+manifest sources; DELETE cleans ask_history/session_titles/session_spaces via the union; POST ownership gate) | 🔴 | 🟢 **knowledge-spaces** (KS-0..KS-4 sidebar/create/open/space-scoping/global; **KS-5** real-UI space delete + full residue psql postconditions — F2; **KS-7** real-UI upload→chat appears — F1 regression; KS-CS connected-sources; KS-SDK ≤3 gated Haiku asks: in-space/isolation/global) + **lifecycle** (folded in-space read / cross-space isolation / global / Sonnet) | 🟡 API+E2E strong; unit + component gap |

**What the matrix says now (honest):** unit + integration are strong; the **API contract layer** (§6) closed
the route-handler gap — 119 tests across 12 handler test files, every guarded branch RED-first; the **Component**
column went from 0 → **16 stateful components / 149 tests** (the prompt-save-lie class — Save-only-on-real-
success, confirm-gated destructive actions, owner/role UI boundaries — is now guarded). Genuinely
presentational components (answer-view, inspector-panels render-only; theme-toggle/simple-tabs/app-sidebar)
remain uncovered **by judgment**, not gap — they carry no fetch/destructive state machine. The **count**
capability is now guard-complete (all 24 count-coverage rows green; the core surface live-verified on
nucleus-woad). The **live E2E journey suite is green 10/10** (bulk-delete added to the runner 2026-06-25) — two journeys were stale FALSE-REDs (the old
`window.confirm` delete + the pre-sub-tab admin nav) and were fixed to drive the shipped UI; the delete is
now live-verified end-to-end (two-step inline confirm → row removed → excluded from the answer corpus →
restored). **#74 bulk-delete** is now covered: component tests (8 RED-first), API contract (bulk-delete-route,
130/130 after fixing the >100-id limit-check ordering + documents-route mock for admin()), and a new E2E
journey (`tests/journeys/bulk-delete.mjs`, registered in `run-journeys.mjs`) — GOLDEN post-state: selected
chat gone from DOM + API; non-selected chat remains; all 12/12 checks LOCAL-verified 2026-06-25. **#75
per-chat docs** closed: unit (per-chat-scoping), integration (per-chat-context-isolation — 13/13 GREEN
local 2026-06-25), component (materials-rail), API (ingest-route session_id propagation +
documents-route chat-label resolution), and E2E (documents journey 10/10 — verified LOCAL 2026-06-25).
Migration 014 (`session_id` nullable column on `doc_chunks` + `uploaded_rows`,
updated `hybrid_match` + `match_doc_chunks` RPCs) applied to the Supabase DB 2026-06-25.
Still open: **urgency** (barely covered); **agentic Fly answering** blocked until 2026-07-01 (API key cap).

---

## 3. The standards (non-negotiable — this is the "very high bar")
1. **Real path.** Never mock the thing under test. Integration uses the real Supabase/engine; the in-memory fallback is never the proof.
2. **RED-first.** Every guard is watched failing with the fix removed. *A test never seen to fail is not a test.*
3. **Facts, not shape.** Assert the golden VALUE from the source; "a response came back / a cite exists" is not a pass.
4. **Variations + adversarial, not the canonical case.** Each capability's scenario doc enumerates the phrasings a user would type **and** the inputs designed to make it lie.
5. **No pass@K.** Strict N/N; lenient sampling masked a 33–40% failure rate before.
6. **Every stateful component has a component test.** (The layer that was missing entirely.)
7. **One index, earned "no gaps."** This file is the single source of truth; "Open gaps: none" is earned by an adversarial "what would the user do that isn't a row?" pass — never asserted.
8. **Coverage is DATA-DRIVEN, and the `verifier` owns the design.** The scenario bar must enumerate **every real artifact the client actually uploaded** (query the store — `select doc_label / table_name … group by` over their owner — never guess from the UI), and derive questions over *each*. Orbiting one capability (e.g. counting) while a whole second data-set goes untested is the failure. The **independent `verifier` designs + re-walks** this bar (gap-finding is its muscle; an author repeats its own blind spot — e.g. falsely marking the richest doc "blocked" off a rendering artifact). A *missing or falsely-blocked* row is a META-MISS invisible to a green-by-row check. → `her-data-coverage.md` + the sealed gotcha `coverage-must-be-data-driven-and-verifier-owned`.
9. **Never call a suite "comprehensive"/"perfect"/"done" before it is PROVEN.** "Comprehensive" is a derived conclusion with preconditions — data-driven + built + RED-first + independently re-walked + **live-verified** — not a feeling from a green matrix, and not a generalisation of "capability X is covered" into "the suite is covered." Until all hold, state the honest partial: "covered for X; NOT yet for Y — here's the gap." (Sealed: `never-call-tests-comprehensive-before-proven`.)
10. **Lead-owned orchestration.** The lead convenes the agents (verifier designs the bar, engineer builds, verifier grades), maintains this matrix, holds the gates, and never lets the user be the QA brain — but does NOT stamp coverage claims the agents haven't earned.

## 4. The ship gate
A change ships only when **every matrix cell it touches is 🟢**, its **scenario doc is all ✅ (incl. live)**,
and `tsc` + the full unit suite are green. The verifier gates against **this doc**, not whatever the eval included.

## 5. Run
```
npx tsc --noEmit
npm test                                                       # unit + api + component — the FAST DETERMINISTIC gate (no creds, no answer-quality)
npm run test:unit                                              # unit only
npm run test:api                                               # API route-handler contracts (tests/api/*) — see §6
npm run test:components                                        # component (vitest) only
CI_STRICT=1 npm run test:gate                                  # CREDS-GATED ANSWER-QUALITY gate — see below
for f in tests/evals/*.mjs; do node --experimental-strip-types "$f"; done   # full integration (serial; creds)
# E2E: Playwright via chromium-1223 vs nucleus-woad (or a preview)
```
Checklists: [README.md](./README.md) (45 journeys) · [count-coverage.md](./count-coverage.md) (24 count rows).

**Two gates, two jobs (why `npm test` is not enough):** `npm test` is fast, deterministic, and runs
everywhere — but it touches **zero answer-quality** (no live LLM/Supabase), so a green `npm test` does NOT
prove a real user gets a correct grounded answer. `npm run test:gate`
([`scripts/answer-quality-gate.mjs`](../../scripts/answer-quality-gate.mjs)) is the **creds-gated companion
gate**: when creds are present it runs a REPRESENTATIVE answer-quality shard — `answer-reliability.mjs`
sharded to the high-value rows (the Carter golden-VALUE child-support answer, the maintenance aggregate, and
the SCHED cell-tally count rows: system-wide max, per-month, specific-person count, the adversarial
no-fabrication guard), each at the strict 5/5 bar, **plus** `cold-start-durability.mjs` (uploaded sheet
survives a cold start, owner-scoped, cited) — and **FAILS LOUD (exit 1) on any real miss**.

**Skip honesty (CI vs human):** every `tests/evals/*.mjs` shard SKIPS LOUDLY when creds are absent. The
skip's EXIT CODE is now mode-dependent, decided in one place ([`tests/evals/_skip.mjs`](../../tests/evals/_skip.mjs)):
default (a human, no flag) exits 0 (benign — the loud "NOT a pass" banner still prints); under **`CI_STRICT=1`
or `REQUIRE_CREDS=1`** a creds-skip exits **NON-ZERO** — in CI a skip is a FAILURE, never a silent pass. So
`CI_STRICT=1 npm run test:gate` is the real answer-quality gate (creds-skip ⇒ fail); a human without creds
runs `npm run test:gate` and gets a clear "this proved nothing — run with creds" notice instead of a false green.

## 6. The API contract layer (`tests/api/*`)
Every route handler under `src/app/api/*` is driven directly — the **real handler runs**; only its I/O
seams are `mock.module`'d (the auth resolver, the Supabase client/stores, `NextResponse`). This guards the
HTTP contract a **non-technical client hits**, which the engine evals and the live journeys did not cover
deterministically: auth/role gating (401/403), input validation + status codes, **per-user owner-scoping**
(a member's reads/writes carry `.eq("owner_id", self)`; an admin's do not), the **write-only-key**
protection (a blank submit must not wipe a stored key; `__clear__` clears it), the **self-lockout** guards
(an admin can't deactivate/demote themselves), demo-gating of the bundled corpus, the friendly/redacted
error mapping (a provider key never reaches the client), and the **never-500** contracts (local-models
probe, history with the store off). **119 cases across 12 handler test files** (every `src/app/api/*`
route handler except the `history/[session_id]` per-session sub-route, which the main `history` handler test
covers); every guarded branch proven RED-first by removing the guard and watching exactly its test fail.
Harness: `tests/api/_harness/` (the `@/`-alias + `next/server` resolve hook, and a recording fake Supabase
builder that captures the owner-scoping).

## 7. Journey purity — a journey MUTATES state ONLY through the real UI

**The rule.** A journey (`tests/journeys/*.mjs`) may change product state ONLY through real UI interactions
(Playwright clicks / typing / uploads). A raw `fetch()` to `/api/*` is allowed ONLY for **(a)** read-only
assertion probes (GET), or **(b)** an explicitly-exempted mutation carrying a `// purity-exempt: <reason>`
comment on the line(s) directly above it.

**Why (the F1 case, 2026-07-02).** A chat's Knowledge-Space membership was written by the JOURNEY itself via
a raw `POST /api/spaces/sessions` (`apiAssignSession`). So when the real product wire that registers a chat
into its space was **missing**, a space's chat list was permanently empty for real users — yet the journeys
stayed **green**, because they had assigned the session themselves through the API. *A test that mutates
through the API instead of the UI cannot catch a broken UI wire — it IS the wire.* The bug shipped behind
green tests. The fix moved chat→space registration to the `/api/ingest` + `/api/ask` seams; the journeys now
prove it through the **real upload UI** (knowledge-spaces KS-5 / KS-7), and `apiAssignSession` was deleted.

**Enforcement.** [`tests/unit/journey-purity.test.mts`](../../tests/unit/journey-purity.test.mts) statically
scans every journey for `fetch()` mutations (`method: POST|PUT|PATCH|DELETE`) and FAILS, `file:line`, on any
that lack a `purity-exempt:` comment. It is a **ratchet**: enforced for every journey NOT in the file's
`LEGACY_UNMIGRATED` ledger — including the two files the rule was born from (knowledge-spaces, lifecycle) and
any NEW journey (enforced by default, so the floor only rises). The ledger lists pre-existing / concurrent
journeys awaiting annotation, each with the reason its mutations are legitimate infra (teardown, settings
capture/restore, chat seeding); as each is next edited, annotate its mutations and remove it from the ledger.
A guard test also asserts the two F1 files can never be quietly moved INTO the ledger.

**The legitimate exemptions** (each carries its own `purity-exempt:` reason at the call site): `lifecycle`'s
`apiAsk` asks — a deliberate, documented SDK-budget choice (space_id / global_mode / model injected
deterministically for the capped 6-call flow); API space create/delete used as setup/teardown; and the
SDK-scenario ingest that seeds a file for a gated ask.

## 8. Tonight's test additions (2026-07-02 — F1/F2/F3 + harness)

| Added | Layer | File | RED-first (fix reverted ⇒) | Notes |
|---|---|---|---|---|
| **F1** chat→space via real UI | E2E | knowledge-spaces **KS-7** | revert the ingest→`assignSessionToSpace` seam ⇒ the uploaded chat never appears | real paperclip upload; read-only `GET /api/spaces/sessions` probe asserts appearance |
| **F2** space delete + residue | E2E | knowledge-spaces **KS-5** | revert the DELETE union-cleanup ⇒ seeded `ask_history`/`session_titles` linger | real-UI sidebar delete→confirm; psql 0-rows (session_spaces/ask_history/session_titles) + manifest probe |
| **F1/F2/F7** seams | API | spaces-session-bookkeeping | remove a seam / the ownership guard ⇒ its case fails | register-on-ask/upload · GET table+manifest merge · DELETE union cleanup · POST 404 ownership gate |
| **F3** negative citation | Integration (live) | negative-citation eval | revert the grounding floor ⇒ grounded=true / citation fabricated | opt-in `NUCLEUS_RUN_NEG_CITATION=1`; exactly 1 Haiku ask; asserts grounded=false / 0 evidence / filename absent |
| **F3** grounding module | Unit | grounding.test.mts | mutate SOURCES_USED parse / floor ⇒ unit fails | explicit `NONE` must NOT trigger the all-files floor |
| Journey-purity lint | Unit | journey-purity.test.mts | drop a `purity-exempt:` comment ⇒ that file fails | §7; ratchet with the LEGACY ledger |
| Model-echo asserts | E2E | lifecycle SDK steps | pin `AGENT_MODEL=Sonnet` ⇒ STEP 3 fail-fasts | `resp.model`: 5×`claude-haiku` + 1×`claude-sonnet-4-6` |
| Prod-URL pin | Unit | prod-url-pin.test.mts | drift a harness default off `PRODUCTION_FRONTEND_URL` ⇒ fails | single source of truth for the journey/eval BASE (F6) |
| Hard-floor CI | CI | .github/workflows/ci.yml | — | typecheck + unit + api + components on every push/PR |
