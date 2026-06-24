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
| **Component** | one **stateful UI component** rendered in isolation; props → state → interaction → render | UI-state bugs (the "Saved"-lie, greying, confirm flows, disabled states) | hitting the real backend (mock the fetch, assert the state machine) | `tests/components/*.test.tsx` **← does not exist yet** |
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
| 1 | Upload→ingest (pdf/excel/word/csv/scanned) | 🟢 ocr-decision, pdf-pagination | 🟢 upload-formats, scanned-pdf-ocr | 🟢 ingest-route | 🟢 chat-upload, upload-button | 🟡 documents | — |
| 2 | Document Q&A — grounded + cited | 🟢 answer-helpers, validate-answer | 🟢 case-file-grounding, answer-reliability | 🟢 ask-route | 🟢 assistant-console | 🟡 chat, golden-evals | — |
| 3 | Structured / text-to-SQL (lookup, SUM/COUNT) | 🟢 sql-guard, structured-store, table-view | 🟢 router-decisions, edge AGG | 🟢 table-route | 🟢 table-viewer | 🔴 | — |
| 4 | **Grid count / ranking (cell-tally)** | 🟢 cell-tally + cell-tally-coverage + gate units | 🟢 answer-reliability SCHED — all variations 5/5 serial | — | — | 🟡 core live-verified on nucleus-woad (#44); DV5/EG4/AD4 deploy-pending | 🟢 count-coverage.md — all 24 rows guard-green |
| 5 | Hebrew / cross-lingual Q&A | 🟢 | 🟢 cold-start HE, edge cross-lingual | — | — | 🔴 | — |
| 6 | Grounding fidelity / no-fabricate / validateAnswer | 🟢 validate-answer, validate-claim-support, salvage | 🟢 answer-reliability, edge UNANSWERABLE | 🟢 ask-route (friendly error) | — | 🟡 | 🟡 needs the adversarial set |
| 7 | Recommendation — never dead-end | 🟢 grounded-general-fallback | 🟢 recommendation-substance | — | — | 🔴 | — |
| 8 | Keyless / model-mode → clear error | 🟢 cloud-provider, hipaa-mode, keyless, model-switch | 🟢 keyless-model-error | 🟢 settings, test-connection, local-models | 🟢 models-panel, model-switch | 🟡 model-modes | — |
| 9 | Per-user settings / **prompt-save** | 🟢 settings-save-feedback | 🟢 per-user-settings, prompt-save-roundtrip | 🟢 settings-route (write-only-key) | 🟢 answer-setup, prompts-panel, account-panel | 🔴 | — |
| 10 | Cold-start durability (docs + settings) | — | 🟢 cold-start-durability, settings-durability | — | — | — | — |
| 11 | Delete source (purged from retrieval) | 🟢 deleted-sources | 🟢 edge DELETE | 🟢 documents-route (403 boundary) | 🟢 materials-rail, uploaded-docs, bundled-docs | 🟢 documents — two-step inline confirm → excluded, live-verified | — |
| 12 | Multi-chat / conversations | 🟢 conversation, session-titles, ask-sessions | 🟢 ask-history | 🟢 history-route (owner-scope) | 🟢 conversations-column, history-panel | 🔴 | — |
| 13 | Auth / kick-out / per-user isolation | 🟢 account-validate, invite | 🟢 edge ISOLATION | 🟢 admin-users, documents-file (isolation) | 🟢 auth-form, users-panel | 🟢 auth, admin | — |
| 14 | Urgency flagging | 🟡 | 🟡 | — | 🟡 (rail badge) | 🔴 | 🔴 **uncovered** |
| 15 | UI render (chat / sources / inspector / citations / account) | 🟢 answer-helpers | — | — | 🟢 console, rail, account, table-viewer | 🟢 chat, rail-render, citations, account | — |

**What the matrix says now (honest):** unit + integration are strong; the **API contract layer** (§6) closed
the route-handler gap — 119 tests across all 11 handlers, every guarded branch RED-first; the **Component**
column went from 0 → **16 stateful components / 149 tests** (the prompt-save-lie class — Save-only-on-real-
success, confirm-gated destructive actions, owner/role UI boundaries — is now guarded). Genuinely
presentational components (answer-view, inspector-panels render-only; theme-toggle/simple-tabs/app-sidebar)
remain uncovered **by judgment**, not gap — they carry no fetch/destructive state machine. The **count**
capability is now guard-complete (all 24 count-coverage rows green; the core surface live-verified on
nucleus-woad — DV5/EG4/AD4 are committed + eval-green, deploy-pending). The **live E2E journey suite is
green 9/9** — two journeys were stale FALSE-REDs (the old `window.confirm` delete + the pre-sub-tab admin
nav) and were fixed to drive the shipped UI; the delete is now live-verified end-to-end (two-step inline
confirm → row removed → excluded from the answer corpus → restored). Still open: **urgency** (barely covered).

---

## 3. The standards (non-negotiable — this is the "very high bar")
1. **Real path.** Never mock the thing under test. Integration uses the real Supabase/engine; the in-memory fallback is never the proof.
2. **RED-first.** Every guard is watched failing with the fix removed. *A test never seen to fail is not a test.*
3. **Facts, not shape.** Assert the golden VALUE from the source; "a response came back / a cite exists" is not a pass.
4. **Variations + adversarial, not the canonical case.** Each capability's scenario doc enumerates the phrasings a user would type **and** the inputs designed to make it lie.
5. **No pass@K.** Strict N/N; lenient sampling masked a 33–40% failure rate before.
6. **Every stateful component has a component test.** (The layer that was missing entirely.)
7. **One index, earned "no gaps."** This file is the single source of truth; "Open gaps: none" is earned by an adversarial "what would the user do that isn't a row?" pass — never asserted.
8. **Lead-owned.** The lead designs the scenarios, maintains this matrix, runs the adversarial pass, and gates row-by-row. The user is never the QA brain.

## 4. The ship gate
A change ships only when **every matrix cell it touches is 🟢**, its **scenario doc is all ✅ (incl. live)**,
and `tsc` + the full unit suite are green. The verifier gates against **this doc**, not whatever the eval included.

## 5. Run
```
npx tsc --noEmit
npm test                                                       # unit + api + component (the deterministic gate)
npm run test:unit                                              # unit only
npm run test:api                                               # API route-handler contracts (tests/api/*) — see §6
npm run test:components                                        # component (vitest) only
for f in tests/evals/*.mjs; do node --experimental-strip-types "$f"; done   # integration (serial; creds)
# E2E: Playwright via chromium-1223 vs nucleus-woad (or a preview)
```
Checklists: [README.md](./README.md) (45 journeys) · [count-coverage.md](./count-coverage.md) (24 count rows).

## 6. The API contract layer (`tests/api/*`)
Every route handler under `src/app/api/*` is driven directly — the **real handler runs**; only its I/O
seams are `mock.module`'d (the auth resolver, the Supabase client/stores, `NextResponse`). This guards the
HTTP contract a **non-technical client hits**, which the engine evals and the live journeys did not cover
deterministically: auth/role gating (401/403), input validation + status codes, **per-user owner-scoping**
(a member's reads/writes carry `.eq("owner_id", self)`; an admin's do not), the **write-only-key**
protection (a blank submit must not wipe a stored key; `__clear__` clears it), the **self-lockout** guards
(an admin can't deactivate/demote themselves), demo-gating of the bundled corpus, the friendly/redacted
error mapping (a provider key never reaches the client), and the **never-500** contracts (local-models
probe, history with the store off). 100 cases across all 9 handlers; every guarded branch proven RED-first
by removing the guard and watching exactly its test fail. Harness: `tests/api/_harness/` (the `@/`-alias +
`next/server` resolve hook, and a recording fake Supabase builder that captures the owner-scoping).
