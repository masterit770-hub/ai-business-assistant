# Nucleus Lifecycle Journey — Design Doc

**Status:** Design final; ~70% built (3 modules exist, to be consolidated into one continuous pass during hill-climb).
**Scope:** Lifecycle + UI + grounding-presence + trace-honesty. **Deep answer-quality is OUT** (see [Scope boundary](#scope-boundary)).
**SDK budget:** 4 Haiku calls/run, gated by `JOURNEY_SDK=1`, logged to `docs/claude-call-log.md`. **16 Haiku + 1 final Sonnet topper = 17 SDK calls total** across the full sweep (the Sonnet call runs only if all 16 Haiku runs pass).

---

## 1. Purpose

This is **ONE continuous-pass, real-UI Playwright journey** that reproduces the *whole* client workflow end to end — from an admin creating an account, through uploading her real files, asking grounded questions, restarting cold, isolating chats, deleting docs and chats, to editing the system prompt — and **asserts at each step the exact properties that her reported bugs violated.**

A reader who wasn't here should take away three things:

1. **It is a journey, not a unit test.** State flows forward: the two documents uploaded in Step 2 are the same documents that must survive the cold restart in Step 4, must *not* leak into the empty chat in Step 6, must open the right chat from Sources in Step 8, and one of which gets deleted in Step 9. Nothing is re-seeded between phases. A bug that only shows up *after* a restart, or *across* chats, can only be caught by a test that carries real state across those boundaries — which is precisely the class of bug the client reported ("it didn't read the files", "new chat jumps to another chat", "uploaded files disappeared").

2. **It drives the real UI and the real engine, then checks both the DOM and the database.** Uploads go through the actual paperclip control; questions go through the actual chat box; deletes go through the actual inline controls. After each, it asserts both what the user *sees* (DOM) and what is *true underneath* (Postgres rows, `session_id` linkage, the answer's evidence/trace object). A green DOM over a wrong database row is exactly the false-green that let "chat shows Unassigned / NULL-session leak" ship.

3. **It is built to catch every bug she reported.** Section 6 maps each reported bug (the `B*`, `G*`, `R*`, `S*`, `D*`, `C*`, `P*`, `O*` items) to the step that covers it — or marks it explicitly out of scope (answer-quality, owned by the eval suite) or as a known not-yet-covered gap to close during hill-climb.

---

## 2. The 11 steps (final design)

The journey runs as **one thread, Steps 1 → 11, no re-seeding between phases.** Four steps make a single gated Haiku SDK call each (marked **[SDK n]**); the other seven steps make **zero** model calls and run for free.

| # | Step | SDK? | What it proves |
|---|------|------|----------------|
| **1** | **Account.** Run A: admin logs in → creates a brand-new client account. Run B: sign in to the existing test account `e2e-770-test@example.com`. | — | Onboarding path (Run A) and returning-user path (Run B) both reach a working session. |
| **2** | **Multi-file upload.** Log in as that client. Upload her **two real Hebrew files** (employment PDF + Dec-2024 scheduling `.xlsx`) in **ONE multi-file paperclip selection** into chat-1. | — | Both appear in Sources; DB links **both** to chat-1; **zero unassigned** (`session_id IS NULL` count == 0). This is the exact "upload multiple at once was broken" + "it didn't read the files" path. |
| **3** | **Compound grounded ask.** **[SDK 1]** One Hebrew question that needs **both** files. | **[SDK 1]** | Answer is grounded in **the Excel AND the PDF**; is in Hebrew; the answer element is `dir="auto"` (left-aligned, the RTL fix). Plus full **trace-honesty** (Section 4). |
| **4** | **Cold restart (MIDDLE).** Brand-new browser context → sign back in. | — | chat-1 + its 2 docs + the Step-3 answer all **persisted**. Everything below runs on this freshly-reloaded state, so persistence is load-bearing, not cosmetic. |
| **5** | **New empty chat.** Create chat-2. | — | chat-2 is **truly empty**: no leftover file, did **not** jump back to chat-1. (The "new chat bug / school2 file persists" class.) |
| **6** | **Empty-chat isolation ask.** **[SDK 2]** In empty chat-2, ask about chat-1's file content. | **[SDK 2]** | Model says it has **no files**; trace shows **zero evidence** for this chat — no cross-chat leak. (Per-chat context isolation, the real forcing function.) |
| **7** | **Single upload into chat-2.** Upload one file into chat-2. | — | Only that file shows; DB links it to chat-2 **only**. |
| **8** | **Sources navigation.** From Sources, click chat-1's doc, then chat-2's doc. | — | chat-1's doc opens **chat-1**; chat-2's doc opens **chat-2** (right chat each — sidebar de-dupe/sort/open-to-right-chat). |
| **9** | **Delete doc + re-ask.** Delete **one** of chat-1's 2 docs. **[SDK 3]** re-ask specifically about **that** doc's content. | **[SDK 3]** | Model says it's **GONE**; only the remaining doc is visible/cited; the trace **no longer cites** the deleted doc. Proves delete removes the doc from *retrieval*, not just from the DOM/DB. |
| **10** | **Delete one chat.** Delete one chat. | — | That chat is gone; the **other** chat + its docs **remain**. |
| **11** | **System-prompt control.** Change the system prompt to a **distinctive marker style** (begin every answer with a unique token + numbered bullets) via the inline admin editor; reload to confirm it persisted. **[SDK 4]** ask again. | **[SDK 4]** | Prompt **persists** across reload; the answer **carries the marker** (prompt reached generation) and is **still grounded**. |

**The 4 gated Haiku SDK steps are 3, 6, 9, and 11.** Steps 1, 2, 4, 5, 7, 8, 10 are zero-SDK.

---

## 3. SDK budget & how it runs

- **Model:** every lifecycle call uses **Haiku** (`claude-haiku-4-5`). This journey tests *lifecycle, grounding presence, and trace shape* — not numeric answer correctness — so Haiku is correct per the Rule-#0 policy. **One final Sonnet call "tops it off":** after all 16 Haiku runs pass, a single `claude-sonnet-4-6` ask on **prod** re-runs the compound grounded question (Step 3) and asserts the answer is genuinely *correct* (not just grounded) — the one answer-**quality** confirmation, run only on green.
- **Gate:** all four asks are behind **`JOURNEY_SDK=1`** (off by default). With the flag off the journey **self-skips the paid asks honestly** (logs a SKIP, does **not** report a false green) and the entire lifecycle/upload/Sources/DB-linkage/persistence/delete plumbing still runs for free.
- **Call log:** every paid ask appends a row to **`docs/claude-call-log.md`** (date, env, model, question, answer brief, trace, justification, cost).
- **Budget arithmetic — 17 SDK calls total:**

  | | New account (Run A) | Existing account (Run B) | per-env |
  |---|---|---|---|
  | **LOCAL** (Playwright vs local `next dev`) — Haiku | 4 | 4 | 8 |
  | **PROD** — Haiku | 4 | 4 | 8 |
  | **PROD** — **Sonnet topper** (only if all 16 pass) | — | — | **1** |
  | | | | **17 total** |

  **4 Haiku/run × 2 runs (A + B) × 2 envs (LOCAL then PROD) = 16, + 1 Sonnet quality topper on prod = 17.**

- **Run order:** **LOCAL first** (Playwright against a local dev server; with `ANTHROPIC_API_KEY` unset → subscription creds, $0 to the client key), **then PROD** once local is green. Never fire prod asks before local passes.
- **Accounts:** Run B always uses **`e2e-770-test@example.com`** — a **safe, throwaway test account**. The journey **never touches the live owner account**. Run A creates and uses a disposable account; Run B signs into the test account without creating or deactivating it.

---

## 4. Trace-honesty checks — what "evidence/passages are correct" means concretely

The third pillar of this journey (alongside lifecycle and grounding-presence) is **trace honesty**: the inspector/trace the user sees must *honestly* reflect what the engine actually read — the model genuinely **accessed the docs and performed real tool actions on them** (no phantom citations, no inflated counts, no cross-chat leak). These run on the SDK steps (3, 6, 9), reading the answer's `evidence`/`route`/`inspector`/`toolCalls`/`filesRead` object (surfaced from the inspector panels, or captured from the `/api/ask` JSON in the page context).

These assertions are deliberately written **to the engine's *real* behavior** (verified against `src/lib/engine/answer-agentic.ts` and `answer-helpers.ts`), so they pass honestly today and turn **RED the day the engine changes** — they do not over-claim fidelity the agentic path cannot provide. **Reasoning / numeric-answer correctness is explicitly NOT asserted here** (deferred to the eval suite + the single Sonnet topper) — the bar is *access + action*, not *right answer*.

**0. Access + action (the client's primary bar — the model reaches the docs and showcases a real tool action).** On Step 3 (`[SDK 1]`) assert, from the answer object the engine already populates (`answer-agentic.ts:214–233, 256–271, 316–321`):
   - **Access:** `filesRead` contains **both** uploaded files (the PDF and the xlsx) — the agent actually opened them.
   - **Action:** `toolCalls` contains **≥1 `Read`** (the engine routes PDF → `Read` tool) **and ≥1 `Bash`** (xlsx/CSV → `Bash`/python for computation; `Grep`/`Glob` count too) — i.e. the agent demonstrably *grepped / read / ran code* on the real files, exactly like the cloud app's "Ran 2 commands, viewed a file".
   - The inspector trace text reflects it: *"Agent read N file(s): …"* and *"K Read call(s) + M Bash command(s)"* are present and non-zero.
   This is the showcase the client asked for; it is robust (no dependence on the answer's wording) and would go **RED** if the agent answered without ever touching the files.

1. **Citation resolves (filename-level, the honest version).** For every citation token matching `[P:<file>#<n>]` in the answer, assert the **filename** is present among `evidence.chunks[].doc` and cross-checks against the chat's real files (`docsInChat` / `_files.json` / `route.rationale`).
   *Why filename and not exact-token:* the engine hardcodes evidence chunks to page `#0`, so an exact `token===t` resolve returns `null` for any non-page-0 PDF citation and the chip renders inert. Asserting locator/page fidelity would **falsely fail** — the agentic engine does not provide per-citation page/row locators. We assert what is real (the filename), not what is faked (the locator).

2. **No phantom `[S:]` citations.** `evidence.rows.length === 0` always in the agentic path, so any `[S:table#id]` (SQL-style) token is unresolvable **by construction**. Assert the answer contains **no `[S:]` tokens**; if one appears, flag it — it can never resolve.

3. **Passage / evidence-count consistency** (the #91 inspector-bug class). Assert `inspector.passages === inspector.evidenceCount` **and** `inspector.evidenceCount <= evidence.chunks.length`. Do **not** assert equality with `chunks.length` — files read via Bash/python (e.g. `.xlsx`) inflate chunks but not the Read-tool passages counter, so `passages <= chunks` is the honest invariant; equality would false-fail.

4. **Grounded ↔ sources coherence.** Assert `route.sources === ['documents']` **iff** `grounded` is true, and `grounded` iff (`filesRead.length > 0` OR `citationCount > 0` OR `evidence.chunks.length > 0`).
   - **Step 3 (grounded ask):** `route.sources === ['documents']`, `mode === 'grounded'`, `evidence.chunks.length >= 2`, and **both** Hebrew filenames appear in `evidence.chunks[].doc`.
   - **Step 6 (empty chat-2):** `route.sources === []`, `mode === 'general'`, `evidence.chunks.length === 0`, `inspector.passages === 0` — **zero evidence proves no cross-chat leak in the trace**.

5. **Page-flattening documented as reality.** Assert every `evidence.chunks[].page === 0` and every chunk token ends in `#0`. This documents the engine's real behavior and turns the assertion RED the day the engine emits real page locators (so it's updated deliberately, not silently).

6. **Do NOT key on `validation.ok`.** It is always `{ok:true, reasons:[]}` in the agentic path (no validation/citation gate). Any check on `validation.ok` is a **no-op / false-green**. Likewise `confidence` is derived (`0.90` grounded / `0.40` not) — assert it **tracks** grounded, not as an independent quality signal.

7. **Delete-removes-from-retrieval (Step 9 / [SDK 3]).** After deleting one of chat-1's docs and re-asking about it: the trace (`evidence.chunks[].doc` / `route.rationale`) **no longer names the deleted doc**, and the remaining doc is still cited. This is the real proof that delete removed the doc from retrieval, not just from the DOM/DB row.

---

## 5. Scope boundary

**In scope:** lifecycle (create → upload → ask → restart → isolate → delete → prompt), **UI** (the real controls, DOM state, RTL/`dir`), **grounding presence** (is the answer grounded in the *right* files; is an empty chat genuinely empty), and **trace honesty** (does the trace *honestly* reflect what was read; no phantom citations; no cross-chat leak).

**Out of scope — owned by the eval suite, not this journey:** deep **answer-quality / extraction correctness**. This journey asserts grounding *presence* and trace *shape*; it does **not** assert whether the numeric or extracted answer is *correct*. The following live in the eval suite (`her-data-coverage.md`, `count-coverage.md`, the RED-first evals):

- **Count/aggregation correctness** (C1–C18): superlatives, windowed reads, cross-sheet sums, specific-person counts, classifier punts, Hebrew sanitize/key.
- **Retrieval depth & routing correctness** (R1 MENDA depth, R4/R5/R6 cross-corpus routing & mislabel, R3 page-cap stress).
- **Grounding-content correctness** (G1 fabrication, G2/G8 honest-refusal content, G5/G6 alimony truth+recommendation, G7 payroll reasoning, O3 cross-doc contradiction).
- **Other journeys / non-lifecycle concerns:** B8/D3 **bulk-delete** (own journey, `bulk-delete.mjs`), B15 **branding** (own coverage), S4 **cross-OWNER tenant isolation** (this journey is single-owner cross-CHAT only), and deploy/build/env items (B1–B5, P2 prod-instance settings, O1 env date).

The split in one line: **this journey checks that grounding and the trace are *honest and correctly wired*; the eval suite checks that the *answer is correct*.**

---

## 6. Bug → step coverage matrix

Legend — **covered** = a built/designed step asserts it; **out_of_scope** = belongs to the eval suite or another journey (Section 5); **not_covered** = in scope for this journey but a known gap to close during hill-climb (Section 7).

| Bug (id / description) | Lifecycle step | Status |
|---|---|---|
| **B5 / S2** — "it didn't read the files" (unassigned `session_id=null` upload invisible) | Step 2 (zero unassigned) + Step 3 [SDK 1] (both files cited) | **covered** |
| **B6 / P1** — prompt edits not saved | Step 11 (change prompt via inline editor, assert persists across reload) | **covered** |
| **B7 / D1** — Sources not reachable for deleting | Step 9 (delete a chat-1 doc via inline DeleteControl) | **covered** |
| **B9** — can't upload multiple files at once | Step 2 (the ONE multi-file paperclip selection) | **not_covered** *(needs single `setInputFiles([pdf,xlsx])`; currently two sequential single-file calls — see §7)* |
| **B10 / S1 / R3** — doc not linked / chat "Unassigned" / NULL-session leak | Step 2 (DB links both to chat-1, zero unassigned) + Step 6 [SDK 2] (empty chat-2 sees no chat-1 docs) | **covered** |
| **B11 / Task #113** — new chat jumps to another chat / school2 file persists | Step 5 (chat-2 truly empty; did not jump to chat-1) | **covered** |
| **B12 / O2** — answers right-aligned / whole-answer RTL | Step 3 [SDK 1] (answer element `dir="auto"`, left-aligned RTL fix) | **covered** |
| **B13** — markdown not rendered (literal asterisks / pipe-tables) | none yet (no markdown-render DOM check) | **not_covered** *(add a cheap DOM check on the Step-3 or Step-11 answer — see §7)* |
| **B14 / Task #95** — "can't even say hi" (reads every doc on a greeting) | none (no greeting fast-path / latency assertion) | **not_covered** *(decide explicitly: add a zero-doc "hi" check, or declare out of scope — see §7)* |
| **G3 / #91** — inspector "insufficient" on a cited grounded answer | Step 3 [SDK 1] trace-honesty (`passages === evidenceCount`, `evidenceCount <= chunks.length`, `rows === 0`) | **covered** |
| **R2 / R3** — doc-lane route=[] / catalog persist | Step 3 [SDK 1] (grounded in BOTH files → route reaches documents; persist+catalog visibility end-to-end) | **covered** |
| **R7 / D7** — incoherent history/resume trace; crash on resumed route | Step 4 (cold restart: chat-1 + 2 docs + answer persist and reload renders without crash) | **covered** |
| **S3** — per-chat context isolation (the real forcing function) | Step 6 [SDK 2] (agent in chat-2 genuinely cannot see chat-1's files; trace zero evidence) | **covered** |
| **S1/S2 (trace side)** — no cross-chat evidence leak in the trace | Step 6 [SDK 2] trace-honesty (trace shows ZERO evidence for empty chat) | **covered** |
| **D2** — delete doc left orphan blob/manifest | Step 9 (asserts DOM+DB row gone) | **not_covered** *(does not yet assert Storage blob / `_files.json` manifest removed — see §7)* |
| **D4** — history surfaced only `ask_history` sessions ("No conversations yet") | Step 4 (cold restart) + Step 8 (Sources → right chat) surface history for a populated account | **covered** *(the docs-only/title-only no-asks edge is not isolated)* |
| **D5** — sidebar de-dupe / sort / open-to-right-chat | Step 8 (chat-1's doc opens chat-1; chat-2's doc opens chat-2) | **covered** |
| **D6** — uploaded files "disappeared" / non-durable | Step 4 (cold restart: docs persist in a brand-new browser context) | **covered** |
| **D3 (sub: delete one CHAT)** — other chat + docs remain | Step 10 (delete one chat → gone; other chat + its docs remain) | **covered** |
| **Delete-doc-then-re-ask** — model says deleted doc is GONE; trace no longer cites it | Step 9 [SDK 3] | **not_covered** *(designed, but not yet in any built file — see §7)* |
| **P2/P3** — settings not persisted across prod instances; "Saved"-lie on non-2xx | Step 11 (prompt persists across reload AND reaches generation via [SDK 4] marker) | **covered** *(prod-instance fallback & false-Saved-on-error edges not isolated)* |
| **Prompt reached generation** — distinctive marker token appears in the answer | Step 11 [SDK 4] (answer carries the marker → prompt reached generation, still grounded) | **covered** |
| **Citation trace-honesty** — every citation resolves to a real file | Step 3 [SDK 1] trace-honesty (every `[P:]` filename present among evidence) | **covered** |
| **B1 / G6** — alimony: grounded + honest "no alimony" + still recommend | Step 11 touches grounding presence only | **out_of_scope** |
| **B2 / G6 RG1** — alimony: truth AND OpenAI-style recommendation | — answer-quality content correctness | **out_of_scope** |
| **B3 / C6** — count wrong (said 18 when it was 10) | — deep count correctness | **out_of_scope** |
| **B4 / R4 / C7** — "names not in the excel" / wrong-corpus routing | Step 6 [SDK 2] asserts no cross-*chat* leak, but not cross-*corpus* count correctness | **out_of_scope** |
| **B8 / D3** — bulk-delete (checkboxes, delete several at once) | own journey (`bulk-delete.mjs`); lifecycle is single-doc + single-chat delete only | **out_of_scope** |
| **B15** — branding (NUCLEUS 770 headline) | cosmetic; own coverage | **out_of_scope** |
| **G1 / G5** — Beyonce ungrounded answer / discarded evidence in fallback | Step 3 + Step 6 exercise the grounded/general boundary, not the specific fabrication | **out_of_scope** |
| **G2 / G8** — cited-refusal slipping through / honest-refusal trust | — refusal/fallback content correctness | **out_of_scope** |
| **G4** — silent DeepSeek masquerade | — provider/key fail-closed behavior | **out_of_scope** |
| **G7 / SUM2** — payroll-by-filename misjudgment | — deep answer reasoning | **out_of_scope** |
| **R1 / R6** — MENDA under-retrieval / clean sheet hijacked by cell-tally | — retrieval depth / routing correctness | **out_of_scope** |
| **R5** — router incoherence / Hebrew doc mislabeled English | Step 3 lightly touches Hebrew handling; mislabel-detection not asserted | **out_of_scope** |
| **S4** — tenant isolation (cross-owner read) | — cross-OWNER isolation; journey is single-owner cross-CHAT | **out_of_scope** |
| **C1–C5, C8–C18** — count/aggregation correctness | — deep count/extraction correctness | **out_of_scope** |
| **O1 / O3 / B-deploy / embedding-skip / scanned-PDF ingest** — env/deploy & deep answer-quality | — deploy/build/env and deep answer-quality | **out_of_scope** |

---

## 7. Known gaps to close during hill-climb (the `not_covered` rows)

These are **in scope for this journey** but not yet exercised by the built code. Closing them is part of consolidating the three modules into one continuous pass:

1. **B9 — make Step 2 a single multi-file selection.** Change `paperclipUpload(page, absPath)` → `paperclipUpload(page, absPaths[])` and call `input.setInputFiles([files.pdf, files.xlsx])` in **one** call. The current built code does **two sequential single-file uploads** (`onboarding:187/193`, `isolation:129/130`), which **bypasses the exact "upload multiple at once" path the client said was broken** — a false-green. Then assert `chat-upload-success` once for the batch, `docsInChat(owner, chat1) >= 2`, and `unassignedRows(owner) === 0`.

2. **SDK 3 — add the delete-doc-then-re-ask (Step 9).** It exists in the design but in **no built file**. After deleting one of chat-1's two docs, fire [SDK 3]: re-ask specifically about the **deleted** doc's content; assert the model says it's GONE, only the remaining doc is cited, and the trace no longer names the deleted doc. Converts a DOM/DB-only delete check into a real **retrieval-removal** check.

3. **B13 — add a markdown-render DOM check.** On a grounded answer (reuse the Step-3 or Step-11 answer, **no extra SDK call**), assert the answer element renders real markup (`<strong>` / `<ul>` / `<table>`) rather than literal `**` or pipe-tables.

4. **B14 — decide greeting fast-path explicitly.** Either add a zero-doc bare "hi" ask asserting the trace shows ZERO files read (`passages === 0`, `route.sources === []`), so a greeting does not read every document — or **explicitly declare it out of this journey's scope.** Currently it is neither covered nor cleanly out-of-scope.

5. **D2 — assert storage/manifest removal on delete.** Step 9's delete asserts DOM + DB-row gone; add an assertion that the deleted doc's **Storage blob and `_files.json` manifest entry** are also gone, so a "soft delete" that orphans storage is caught.

### Consolidation work (3 modules → 1 continuous pass)

- **Consolidate** the three current files — `lifecycle-onboarding.mjs`, `lifecycle-isolation.mjs`, `lifecycle-prompt-control.mjs` (each with its own sign-in, seed, cleanup, and 1–2 SDK calls) — into **ONE** file running Steps 1–11 in a single thread with **4 SDK calls/run** and **no re-seeding** between phases.
- **Parametrize Run A / Run B** from one file (e.g. `RUN=A|B` env or argv), not two copies.
- **Move the cold restart to the MIDDLE** (Step 4) so Steps 5–11 all run on freshly-reloaded state. Today the cold restart is the *last* step of onboarding.
- **Wire trace-honesty (Section 4) into the SDK steps.** The built asks today check answer **text only** (Hebrew refs regex, `dir=auto`, says-no-files, marker); none read the inspector/evidence object yet.
- **Unify the duplicated helpers** (`paperclipUpload`, `docsInChat`, `herFiles`, `logSdkCall`) into one place (or promote to `lib.mjs`) so the multi-file fix and trace-honesty helpers live in exactly one spot.
- **Preserve the SDK gate, call log, and Haiku pin** through the merge — do not let consolidation silently fire 8 paid asks by default.

---

## 8. How to run it

Journeys run through the suite runner:

```bash
# Full journey suite (zero-SDK checks only; paid asks self-skip)
npm run test:journeys          # → node scripts/run-journeys.mjs

# Lifecycle journey, LOCAL, with the 4 paid Haiku asks enabled — Run A (new account):
JOURNEY_SDK=1 RUN=A node tests/journeys/lifecycle-journey.mjs        # (consolidated file, post-merge)

# Run B (existing safe test account e2e-770-test@example.com):
JOURNEY_SDK=1 RUN=B node tests/journeys/lifecycle-journey.mjs
```

Run order and safety:

1. **LOCAL first**, against a local `next dev` (port 3000, `ANSWER_ENGINE=agentic`), with **`ANTHROPIC_API_KEY` unset** so model calls use subscription creds ($0 to the client key).
2. **PROD only after LOCAL is green.**
3. Run **A then B** in each env → 4 + 4 = 8 SDK calls/env → **16 total**.
4. With `JOURNEY_SDK` **unset**, every paid ask self-skips honestly and the full lifecycle/upload/DB-linkage/persistence/delete/Sources plumbing still runs for free.
5. Every paid ask appends to `docs/claude-call-log.md`.

> Until the consolidation in §7 lands, the journey still lives in three files: `lifecycle-onboarding.mjs`, `lifecycle-isolation.mjs`, `lifecycle-prompt-control.mjs`. These are the source modules being merged into the single `lifecycle-journey.mjs` described above.

---

## 9. Current implementation status

- **Design:** final and correctly scoped (lifecycle + grounding-presence + trace-honesty). ~20 lifecycle/UI/leak/persistence/delete/prompt bugs map cleanly to concrete steps with real DB + UI assertions, verified against live code.
- **Build:** ~70% built across **three** modules; SDK gating, Haiku pin (`claude-haiku-4-5`), and call-log append are all real in the built files.
- **Open before "comprehensive" for this scope** (the §7 gaps): (1) **B9 multi-file upload** — the headline reported bug — is **not yet actually exercised** (two sequential single-file uploads, a false-green); (2) the **delete-doc-then-re-ask [SDK 3]** is designed but in **no built file**; (3) the built SDK steps assert answer **text only** — the **trace-honesty** assertions (Section 4) are not wired in yet; and the work still lives in three files, not the one continuous parametrized pass.
- **Next:** finish the five §7 refinements, then re-walk **RED-first** (prove each new assertion fails on the un-fixed app) and **live-verify** end to end as one pass on both envs **before** any "perfect" claim.
