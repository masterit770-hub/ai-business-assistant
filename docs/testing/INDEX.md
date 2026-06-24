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
| **E2E / Journey** | the real user flow through the **deployed** app in a real browser | the integration of *everything* + the deployed env (keys/config) + what the user actually sees | demo-mode shortcuts standing in for the real deployed run | `tests/journeys/*.mjs` + `evals/golden-evals.mjs` (Playwright) |

**Plus, orthogonal to the layers:** a per-capability **scenario design** — client-asked + lead-derived
variations/phrasings/scope + **adversarial** (try to make it fabricate) + self-consistency — applied at
whichever layer(s) the capability lives. Verifying *one canonical phrasing* ≠ verifying the capability.
Model: [`count-coverage.md`](./count-coverage.md). **Every capability gets one.**

---

## 2. Coverage matrix — capability × layer (the gap-finder)
🟢 real guard · 🟡 partial / one-phrasing-only · 🔴 gap · — n/a

| # | Capability | Unit | Integration | Component | E2E | Scenario gate |
|---|---|:--:|:--:|:--:|:--:|---|
| 1 | Upload→ingest (pdf/excel/word/csv/scanned) | 🟢 ocr-decision, pdf-pagination | 🟢 upload-formats, scanned-pdf-ocr | 🔴 chat-upload, upload-button | 🟡 documents | — |
| 2 | Document Q&A — grounded + cited | 🟢 answer-helpers, validate-answer | 🟢 case-file-grounding, answer-reliability | — | 🟡 chat, golden-evals | — |
| 3 | Structured / text-to-SQL (lookup, SUM/COUNT) | 🟢 sql-guard, structured-store, table-view | 🟢 router-decisions, edge AGG | — | 🔴 | — |
| 4 | **Grid count / ranking (cell-tally)** | 🟡 trigger only — 🔴 tally-correctness fixture | 🟡 **one phrasing only** | — | 🔴 **failed live on variations** | 🟡 count-coverage.md (in progress) |
| 5 | Hebrew / cross-lingual Q&A | 🟢 | 🟢 cold-start HE, edge cross-lingual | — | 🔴 | — |
| 6 | Grounding fidelity / no-fabricate / validateAnswer | 🟢 validate-answer, validate-claim-support, salvage | 🟢 answer-reliability, edge UNANSWERABLE | — | 🟡 | 🟡 needs the adversarial set |
| 7 | Recommendation — never dead-end | 🟢 grounded-general-fallback | 🟢 recommendation-substance | — | 🔴 | — |
| 8 | Keyless / model-mode → clear error | 🟢 cloud-provider, hipaa-mode, keyless, model-switch | 🟢 keyless-model-error | 🔴 models-panel, model-switch | 🟡 model-modes | — |
| 9 | Per-user settings / **prompt-save** | 🟢 settings-save-feedback | 🟢 per-user-settings, prompt-save-roundtrip | 🔴 answer-setup, prompts-panel | 🔴 | — |
| 10 | Cold-start durability (docs + settings) | — | 🟢 cold-start-durability, settings-durability | — | — | — |
| 11 | Delete source (purged from retrieval) | 🟢 deleted-sources | 🟢 edge DELETE | 🔴 materials-rail | 🔴 | — |
| 12 | Multi-chat / conversations | 🟢 conversation, session-titles, ask-sessions | 🟢 ask-history | 🔴 conversations-column | 🔴 | — |
| 13 | Auth / kick-out / per-user isolation | 🟢 account-validate, invite | 🟢 edge ISOLATION | 🔴 auth-form, users-panel, user-menu | 🟢 auth, admin | — |
| 14 | Urgency flagging | 🟡 | 🟡 | 🔴 | 🔴 | 🔴 **uncovered** |
| 15 | UI render (chat / sources / inspector / citations / account) | 🟢 answer-helpers | — | 🔴 most panels | 🟢 chat, rail-render, citations, account | — |

**What the matrix says right now (honest):** unit + integration are strong; the **entire Component column
is 🔴** (0 of 26 stateful components — this is where the prompt-save lie lived); **E2E is patchy**; the
**count capability** is mid-fix (one-phrasing integration + a live E2E failure); **urgency** is barely
covered. These 🔴s are the work — not "nice to have."

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
npm test                                                       # unit (+ component, once added)
for f in tests/evals/*.mjs; do node --experimental-strip-types "$f"; done   # integration (serial; creds)
# E2E: Playwright via chromium-1223 vs nucleus-woad (or a preview)
```
Checklists: [README.md](./README.md) (45 journeys) · [count-coverage.md](./count-coverage.md) (24 count rows).
