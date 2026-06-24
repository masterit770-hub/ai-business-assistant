# Her-data coverage — the data-driven scenario bar (HARD GATE)

**The gap this closes.** Our test coverage orbited ONE capability (counting over the scheduling
grids — well-covered in [`count-coverage.md`](./count-coverage.md), 24 scenarios) and the bundled
DEMO corpus. **Nobody ran the data-driven pass:** enumerate EVERY file Jenny actually uploaded and
derive the realistic questions she'd ask over *each*. This doc is that pass. It spans **ALL her files**
(4 documents + 11 structured tables) and **ALL question TYPES** (lookup · count/aggregate · summary ·
cross-file · doc-Q&A · adversarial/no-fabrication · messy-structure edge cases).

**How this gate runs** (same spirit as `count-coverage.md`): the **engineer** implements a guard for
each row (an eval over her real owner `3d1ca025`, RED-first), the **verifier** re-checks each row
(including live on nucleus-woad where applicable), and a capability ships only when its rows are `✅`.
Status: `⬜ pending` → `🟢 guard green (eval/unit)` → `✅ confirmed LIVE on nucleus-woad`. A `🟥` row is
a confirmed bug with the correct expected answer attached.

> **Derived from:** her REAL uploaded corpus under owner `3d1ca025` (`is_demo=true`, the admin demo
> account). Every expected answer below was **ground-truthed by deterministic SQL over
> `public.uploaded_rows` / `public.doc_chunks`** (counts, distinct values, field presence) — not
> guessed. **PII discipline:** these are youth case files (minors). Question TYPES and expected
> *aggregates* were derived from STRUCTURE (`jsonb_object_keys`, row counts, the legend's categories);
> **no personal values are quoted** in this doc, and expected answers are stated as counts / distinct
> categories / honest-limits, never by naming an individual.

---

## 0 — The corpus inventory (what she actually uploaded)

> Reconciled by `select … group by table_name / doc_label` over owner `3d1ca025`. **The lead's brief
> named a "Garin housing doc" (`מידע כללי העברת מקל - חיה.pdf`) as the wrong-doc in the summary bug —
> that PDF exists in the DB but belongs to a DIFFERENT owner, NOT `3d1ca025`. Her actual document set
> is the four below.** The summary bug is real but the leaked corpus must be re-pinned from a live run
> (see SUM-bug row) — not assumed to be the Garin doc.

### Documents (`doc_chunks`) — 4
| key | doc_label | what it is | citable ground-truth |
|---|---|---|---|
| D-INV | `hebrew-invoice.pdf` | a tax invoice (חשבונית מס) | INV-2026-0418; ₪45,128 pre-VAT + 17% VAT ₪7,672 = **₪52,800** total; supplier **אבן יסמין בע״מ**; 30-day terms; **no phone/address field** |
| D-MENDA | `MENDA_Catalog_Strategy_Options.docx` | a business catalog-strategy memo | exactly **4 options** (Affiliate / House Brand / Hybrid / Marketplace); **House Brand = the preferred near-term path**; decision pends validation calls w/ 5-7 US influencers |
| D-CARTER | `story if the Carters .pdf` | the fictional Carter divorce story (also a bundled-demo doc) | married June 14 2014 Phoenix AZ; **3 children** (Emma 2015, Noah 2018, Olivia 2021); Michel = construction PM |
| D-FAMCOURT | `FAMILY COURT CASE FILE (MOCK) – FINAL VERSION.pdf` | a MOCK family-court case file (11 chunks) | **retrievable content unconfirmed — head chunks render empty in psql (RTL/whitespace); engineer must confirm what grounds before pinning a fact row** |

### Structured tables (`uploaded_rows`) — 11
**Two families.** (a) **Scheduling grids** (5 sheets) — already the subject of `count-coverage.md`;
here we only add the *cross-file* and *what-is-this-sheet* angles, not re-derive the counts. (b) **The
"Danieli young-file" case-management track** (6 sheets) — **entirely uncovered until now.**

| key | table (suffix) | rows | kind / structure |
|---|---|---|---|
| S-JUN | `שיבוצים-יוני-2024-…-גיליון1` | 51 | scheduling grid (covered in count-coverage) |
| S-JUL | `שיבוצים-יולי-2024-…-גיליון1` | 56 | scheduling grid |
| S-AUG | `שיבוצים-אוגוסט-2024-…-גיליון1` | 56 | scheduling grid |
| S-DEC1 | `שיבוצים-דצמבר-2024-…-גיליון1` | 63 | scheduling grid (Dec sheet 1 of 2) |
| S-DEC2 | `שיבוצים-דצמבר-2024-…-גיליון2` | 78 | scheduling grid (Dec sheet 2 of 2) |
| T-INTAKE | `…-דניאלי-אינטייק` | 58 | **intake-FORM template** — section headers (פרטי המועמד/ת, מצב רפואי, תעסוקה, מסגרות חינוך, ביטוח לאומי, ליווי סוציאלי); form-structured, mostly `__EMPTY` + `id` noise columns |
| T-LEGEND | `…-דניאלי-מקרא` | 33 | **the rubric/legend** — two real columns: a **life-domains** column (5 domains) + an **I-competency** column (5 families: I AM/I MIX/I TASK/I NET/I GROW); rest are `__EMPTY` |
| T-PLAN-1 | `…-תכנית-אישית-ינואר-אפריל` | 49 | **personal-plan** period Jan–Apr — sections: choose-3-strengths, choose-3-skills-to-improve, define-a-goal, describe-the-difficulty, the I-AM/I-MIX competencies |
| T-PLAN-2 | `…-תכנית-אישית-מאי-אוגוסט-ממשיכים` | 49 | personal-plan May–Aug **(continuers / ממשיכים)** |
| T-PLAN-3 | `…-תכנית-אישית-מאי-אוגוסט-מסיימים` | 22 | personal-plan May–Aug **(finishers / מסיימים)** — smaller cohort |
| T-PLAN-4 | `…-תכנית-אישית-ספטמבר-דצמבר` | 46 | personal-plan Sep–Dec |

**Ground-truthed structural facts (cited by the rows below):**
- Total uploaded tables for this owner = **11**; total documents = **4**.
- Legend life-domains (distinct, non-blank `השכלה` column) = **5**: תעסוקה (employment), דיור (housing), פנאי (leisure), מצב משפחתי (family status), אחר (other).
- Legend I-competency families = **5**: I AM, I MIX, I TASK, I NET, I GROW (each with sub-skills, e.g. `I TASK - עמידה בזמנים`).
- Personal-plan periods = **4** (Jan–Apr, May–Aug continuers, May–Aug finishers, Sep–Dec).
- The plan sheets REFERENCE the legend's I-competency codes — this is the seam that makes legend↔plan cross-file scenarios real.

---

## A — LOOKUPS (a specific field / a legend code / a doc value)

| id | question (her language where natural) | expected answer / honest-limit | file(s) | status |
|---|---|---|---|---|
| LK1 | `מה הסכום הכולל בחשבונית?` (total on the invoice) | **₪52,800** (incl. 17% VAT), cited `[S?]`/`[D:hebrew-invoice]`; never a different figure | D-INV | ⬜ |
| LK2 | `מה מספר החשבונית ומי הספק?` (invoice no. + supplier) | **INV-2026-0418**, supplier **אבן יסמין בע״מ**, cited | D-INV | ⬜ |
| LK3 | `מה תנאי התשלום בחשבונית?` (payment terms) | **30 days** from receipt, cited | D-INV | ⬜ |
| LK4 | `מה המשמעות של I TASK?` (what does the legend code I TASK mean) | the I-TASK competency family from the rubric (time-management / meeting deadlines / prioritisation — the sub-skills under `I TASK -…`), cited from T-LEGEND; not invented | T-LEGEND | ⬜ |
| LK5 | `אילו תחומי חיים מופיעים במקרא?` (which life-domains are in the legend) | the **5 domains**: תעסוקה, דיור, פנאי, מצב משפחתי, אחר — cited; the full set, not a partial list | T-LEGEND | ⬜ |
| LK6 | `אילו סעיפים יש בטופס האינטייק?` (what sections are in the intake form) | the real section headers (פרטי המועמד/ת · מצב רפואי · תעסוקה · מסגרות חינוך · ביטוח לאומי · ליווי סוציאלי …) — read from the form, not fabricated | T-INTAKE | ⬜ |
| LK7 | `מה ההמלצה המועדפת במסמך MENDA?` (preferred recommendation in the MENDA memo) | **House Brand (אופציה 2)** as the preferred near-term path, cited; not Affiliate/Hybrid/Marketplace | D-MENDA | ⬜ |

## B — COUNTS / AGGREGATES (ground-truthed, exact)

| id | question | expected answer (ground-truthed) | file(s) | status |
|---|---|---|---|---|
| CT1 | `כמה קבצים העליתי בסך הכל?` / "how many files do I have" | **15** total = 4 documents + 11 structured sheets (or stated as "4 documents and 11 sheets"); never a vaguer/invented number | all | ⬜ |
| CT2 | `כמה תקופות תכנית אישית יש?` (how many personal-plan periods) | **4** (Jan–Apr, May–Aug continuers, May–Aug finishers, Sep–Dec), cited | T-PLAN-1..4 | ⬜ |
| CT3 | `כמה תחומי חיים יש במקרא?` (how many life-domains in the legend) | **5**, cited; not 4, not 6 | T-LEGEND | ⬜ |
| CT4 | `כמה משפחות מיומנויות (I…) יש במקרא?` (how many I-competency families) | **5** (I AM, I MIX, I TASK, I NET, I GROW), cited | T-LEGEND | ⬜ |
| CT5 | `כמה אופציות מוצעות במסמך MENDA?` (how many options in MENDA memo) | **4** (Affiliate, House Brand, Hybrid, Marketplace), cited | D-MENDA | ⬜ |
| CT6 | `כמה ילדים יש למשפחת קרטר?` (how many children — Carter) | **3** (Emma, Noah, Olivia), cited | D-CARTER | ⬜ |
| CT7 | the scheduling counts (most-scheduled etc.) | **already covered** — defer to `count-coverage.md` (system-wide max = נגה מאירסון=29, per-month tied groups, etc.); listed here only so this doc's reader knows where they live | S-* | ✅ (count-coverage) |

## C — SUMMARIES (and the KNOWN summary bug)

| id | question | expected answer | file(s) | status |
|---|---|---|---|---|
| SUM1 | `סכם מה כולל מסלול "דניאלי" של התיק הצעיר` (summarize what the Danieli young-file track includes) | a grounded summary built **from her Danieli sheets** — an intake form + a rubric/legend (life-domains + I-competencies) + personal plans across 4 periods (incl. continuers/finishers cohorts); cited `[S:]` to those sheets. Must NOT answer from a document, and must NOT be generic. | T-INTAKE, T-LEGEND, T-PLAN-1..4 | 🟥 **BUG — see below** |
| SUM2 | `סכם את מסמך האסטרטגיה של MENDA` (summarize the MENDA strategy memo) | a grounded summary: 4 options with House Brand preferred near-term, decision pending US-influencer validation; cited to D-MENDA | D-MENDA | ⬜ |
| SUM3 | `על מה מדברת התכנית האישית?` (what is the personal-plan about) | grounded: a self-development plan — pick 3 strengths, 3 skills to improve, define a measurable behavioural goal, describe the difficulty, mapped to the I-competencies; cited to T-PLAN | T-PLAN-* | ⬜ |

> ### 🟥 SUM-bug — the Danieli-summary leaks to the WRONG corpus (RED, must reproduce + fix)
> **Reported behaviour (live on nucleus-woad):** asking to *summarize the Danieli young-file track*
> returned a summary built from the **wrong source — a DOCUMENT, not her Danieli sheets.** The lead
> named the Garin housing PDF as the leaked doc; **that PDF is NOT in owner `3d1ca025`'s corpus**, so
> the actual leaked source must be re-pinned from a live run before the fix is claimed (likely D-MENDA
> or D-CARTER, or an ungrounded `general` answer). **Do not assume the Garin doc.**
>
> **Correct expected answer:** the grounded summary in SUM1 above — sourced from T-INTAKE + T-LEGEND +
> the 4 T-PLAN sheets, cited `[S:]`, never from a document and never `mode=general`.
>
> **Engineer repro (in-process, RED-first):** drive `answerQuestion(SUM1, { ownerId: '3d1ca025…',
> isDemo: true, role: 'admin' })` (mirror `tests/evals/case-file-grounding.mjs`'s import + the
> `runWithOwner` scoping), capture `res.route` / `res.mode` / `res.evidence` — assert it RED first
> (today it cites a doc / answers general), then GREEN (cites the Danieli sheets). This is the
> **summary analogue of the count-coverage routing bugs** (a question over her OWN structured data must
> route to that data, per [[nucleus-unicode-tablenames-and-no-ungrounded-own-data]] gate B).

## D — CROSS-FILE (spanning sheets, or sheets+docs)

| id | question | expected answer | file(s) | status |
|---|---|---|---|---|
| XF1 | `מהן המיומנויות במקרא, ואיך הן מופיעות בתכנית האישית?` (the legend's skills + how they show up in the plan) | grounds in BOTH: the I-competency families from T-LEGEND **and** the plan's "choose 3 skills to improve / strengths" sections that reference them; cites both | T-LEGEND + T-PLAN | ⬜ |
| XF2 | `איזו תקופת תכנית הכי קטנה?` (which plan period is smallest) | the **finishers** sheet (May–Aug מסיימים, 22 rows) is the smallest cohort; grounded comparison across the 4 plan sheets, cited — not a guess | T-PLAN-1..4 | ⬜ |
| XF3 | `כמה מסמכים וכמה גיליונות יש לי, ומה הם?` (how many docs + sheets, and what are they) | **4 documents + 11 sheets**, with the two families named (scheduling grids vs the Danieli track); cited; honest if it can only enumerate one store | all | ⬜ |

## E — DOC Q&A (over EACH actual document, not just the bundled Carter demo)

| id | question | expected answer | file(s) | status |
|---|---|---|---|---|
| DQ1 | `מי הספק בחשבונית וכמה מע״מ שולם?` (supplier + VAT paid) | אבן יסמין בע״מ; VAT = **₪7,672** (17%); cited to D-INV; computed/quoted, not invented | D-INV | ⬜ |
| DQ2 | `מהן 4 האופציות במסמך MENDA, ומה ההבדל ביניהן?` (the 4 options + differences) | Affiliate (client leaves ❌) / House Brand (preferred ✅) / Hybrid (Phase 3) / Marketplace (Phase 4), with the margin/complexity contrasts; cited to D-MENDA | D-MENDA | ⬜ |
| DQ3 | `כמה ילדים יש בסיפור משפחת קרטר ומה שמותיהם?` (Carter children) | **3 — Emma, Noah, Olivia**; cited; this is also the bundled-demo doc, so it must work for HER owner too | D-CARTER | ⬜ |
| DQ4 | a fact-lookup over the Family Court mock case file | **engineer must first confirm retrievable content** (head chunks render empty); then a grounded fact + citation. Until confirmed, this row is **blocked on a content check**, not assumed answerable | D-FAMCOURT | ⬜ (blocked: confirm content) |

## F — ADVERSARIAL / NO-FABRICATION (a null field, an absent entity)

| id | question | expected answer | file(s) | status |
|---|---|---|---|---|
| AD-H1 | `מה מספר הטלפון של הספק בחשבונית?` (supplier phone on the invoice) | honest **"not in the document"** — the invoice has **no phone/address field** (ground-truthed); never a fabricated number | D-INV | ⬜ |
| AD-H2 | `מה הציון/הדירוג של כל מיומנות במקרא?` (the score/rating of each legend skill) | honest — the legend is a **rubric of categories, it carries no scores**; never invent a rating scale | T-LEGEND | ⬜ |
| AD-H3 | `סכם את קובץ "<שם שלא קיים>"` (summarize a sheet/doc that doesn't exist) | honest **"that file is not in your data"** — never summarize a fabricated file; list what DOES exist | all | ⬜ |
| AD-H4 | `כמה מועמדים יש בטופס האינטייק?` (how many candidates in the intake) | honest — the intake is a **blank form TEMPLATE, not a filled roster** (the form-field column has 9 header labels, no candidate rows); never crown a candidate count from `__EMPTY`/`id` noise | T-INTAKE | ⬜ |
| AD-H5 | a 5th option in MENDA / `מהי אופציה 5?` | honest — there are **only 4 options**; never invent option 5 | D-MENDA | ⬜ |

## G — EDGE CASES (derived from the messy structure)

| id | question | expected answer | file(s) | status |
|---|---|---|---|---|
| EG-H1 | any question over the legend/plan/intake sheets | the engine must read the **real header column** (`השכלה`, `תוכנית אישית`, `טופס פגישת אינטייק`) and **ignore `__EMPTY`/`__EMPTY_n`/`id`/`1` noise columns** — a buried-header / form-structured sheet, not a clean table. Answers/counts must come from the real column, never the noise. | T-LEGEND, T-PLAN, T-INTAKE | ⬜ |
| EG-H2 | "rank / who's most …" over a plan or intake sheet | honest **"no metric to rank by"** — these are form-structured, single-template sheets with no recurring entity to tally (the EG4 sparse-grid lesson from count-coverage, applied to the Danieli sheets); never crown a fabricated winner | T-PLAN, T-INTAKE | ⬜ |
| EG-H3 | the two May–Aug plan sheets (continuers vs finishers) | the engine must NOT conflate them — `ממשיכים` (49 rows) and `מסיימים` (22 rows) are **distinct cohorts**; a question about "the May–Aug plan" should disambiguate or cover both, not silently pick one | T-PLAN-2, T-PLAN-3 | ⬜ |
| EG-H4 | the unicode/Hebrew table names | her sheet/table names are Hebrew with quotes and `·`; they must survive sanitisation without collision (the `sanitizeIdent` lesson [[nucleus-unicode-tablenames-and-no-ungrounded-own-data]]) — a name collision here = data loss / planner blindness | all T-* | ⬜ |

---

## Completeness pass — "what would she do that ISN'T a row here?" (and why I left it out)

- **Specific personal values in the case files** (a named youth's plan goal, a candidate's medical
  status). **Deliberately excluded** — PII (minors). The bar tests STRUCTURE, CATEGORY, and AGGREGATE
  answers, and the no-fabrication floor; it never grounds an expected answer in an individual's record.
  If the engineer needs a per-entity lookup gate, derive it from a SYNTHETIC seeded row, never from her
  real youth data.
- **OCR / scanned-PDF accuracy** of the Family Court mock and any image PDFs — **out of scope here**,
  covered by `tests/evals/scanned-pdf-ocr.mjs`. DQ4 only asks that *whatever* grounds is cited
  honestly, pending the content-confirmation check.
- **Urgency flagging** over these docs (the case files could trip urgency) — **out of scope here**, it's
  a separate capability with its own gate; flagged so it isn't forgotten.
- **The full scheduling-count surface** — **intentionally NOT re-derived**; it's `count-coverage.md`'s
  job (24 rows, all green/live). This doc only adds the *cross-file* and *what-is-this-sheet* angles for
  the grids (CT7, XF3) so the two bars don't duplicate or drift.
- **Multi-turn / follow-up** ("…and the previous period?") — a real pattern, but a conversation-state
  capability, not a per-file one; deferred to a journey bar, noted so it isn't lost.
- **Local-model (Ollama) mode** answers over these files — deferred per CLAUDE.md (task #6), not a
  coverage gap in the answer logic.

## Notes for the engineer (so the bar is buildable, not guessed)
- **Ground-truth is real.** Every count/value above was computed by SQL over owner `3d1ca025` — re-run
  the same aggregates to RED-first and to PASS-confirm; don't trust the prose, recompute.
- **The two RED items needing a live run before a fix is claimed:** (1) **SUM-bug** — re-pin the actual
  leaked source (the named Garin doc is NOT in her corpus); (2) **D-FAMCOURT** content — confirm what
  the mock case-file chunks actually contain before pinning DQ4.
- **Routing is the dominant risk** (see the summary below) — most failures here will be *right-data,
  wrong-route*: a question over her OWN sheets answered from a document or in `general` mode. The gate
  that already exists for counts ([[nucleus-unicode-tablenames-and-no-ungrounded-own-data]] gate B) is
  the pattern to extend to summaries and lookups.

---

## ROUND 2 — independent verifier audit (2026-06-24, agent `coverage-verifier`)

An INDEPENDENT verifier re-derived the corpus from the DB and ran the adversarial "what isn't a row
here?" pass. **Inventory (15 files) confirmed; Garin-exclusion confirmed (owner `b01c311e`); ZERO
ground-truth numbers refuted** (all 10 spot-checks re-run by SQL). It found one false-block + ~22
missing scenarios + a real contradiction. Folded in below (lead maintains the matrix, standard #8).

### 🟥→fixed: D-FAMCOURT was FALSELY BLOCKED (the pm's repeated blind spot)
The pm marked the Family Court case file "blocked on content" because head chunks render empty in psql
— an **RTL/whitespace artifact, not absent content.** It is the RICHEST doc in her corpus and is fully
retrievable: p1 cover (Joni Carter Petitioner vs Michel Carter Respondent; Dissolution; **Filed 10 Feb
2026**; Judge Hon. Rebecca Lawson); p2 a 12-section ToC; p3 12-yr marriage; p6 children. **DQ4 is
UN-BLOCKED** and expands into FC-NEW1..5 below. (Lesson: a falsely-blocked row is invisible to a
green check — only an independent data re-walk catches it.)

### Cross-file CONTRADICTION (new, must be surfaced not hidden)
Her own two files disagree on the filing date: **case file = "Filed 10 Feb 2026"** vs **story PDF =
"Feb 3, 2026."** An honest engine must surface the discrepancy or cite the specific source — never
silently assert one. (XF-NEW3.)

### Two ground-truth NUANCES (traps for the engine + the graders)
- **N1 — Carter children:** count = **3** is stable across both files, but **ages differ** between the
  story PDF and the case file → an age answer must be **source-specific**, not merged.
- **N2 — I-competency codes have SUFFIX form too** (`חשיבה יצירתית - I AM`, not only `I AM - …`) → a
  prefix-only parser under-counts; the "5 families" answer must catch both forms.

### +22 new scenarios (all need a LIVE model run to RED/GREEN — flagged, not faked)
| id | question | expected answer / honest-limit | file(s) |
|---|---|---|---|
| FC-NEW1 | parties + case type | Joni Carter (Petitioner) vs Michel Carter (Respondent), Dissolution; cited D-FAMCOURT | D-FAMCOURT |
| FC-NEW2 | filing date + judge | Filed 10 Feb 2026, Hon. Rebecca Lawson; cited | D-FAMCOURT |
| FC-NEW3 | summarize the case file | grounded to D-FAMCOURT (NOT the story PDF, NOT general); cited | D-FAMCOURT |
| FC-NEW4 | what sections does it have | the 12 ToC sections; cited | D-FAMCOURT |
| FC-NEW5 | children ages (case file) | source-specific per N1; cited to D-FAMCOURT | D-FAMCOURT |
| INV-NEW1 | what service was billed | ייעוץ משפטי ובדיקת חוזים; cited | D-INV |
| INV-NEW2 | who is the client (`לקוח:` field the pm never tested) | מנהל תפעול ראשי; cited | D-INV |
| INV-NEW3 | invoice date | 18 באפריל 2026; cited | D-INV |
| INV-NEW4 (adv) | supplier address | honest "not in the document" | D-INV |
| ML-NEW1 | EN: "total on the invoice" | ₪52,800 (mixed-language over a HE doc) | D-INV |
| ML-NEW2 | EN: "how many MENDA options" | 4 | D-MENDA |
| ML-NEW3 | EN: "life-domains in the legend" | the 5 | T-LEGEND |
| MT-NEW1 | "the May–Aug plan" → "finishers specifically" | resolves to מסיימים/22, not re-answers continuers | T-PLAN-2/3 |
| MT-NEW2 | Carter children → "their ages" | source-correct per N1 | D-CARTER/D-FAMCOURT |
| XF-NEW1 | Carter children across story + case file | cite BOTH, honest on the age difference | D-CARTER + D-FAMCOURT |
| XF-NEW2 | the 5 I-families | catch BOTH prefix + suffix forms (N2) | T-LEGEND |
| XF-NEW3 (adv) | "when was the divorce filed" | surface the Feb 3 vs Feb 10 discrepancy / cite the source; never assert one | D-CARTER + D-FAMCOURT |
| AD-NEW1 | "how many youths in the Danieli track" | honest — blank form templates, not a filled roster (extends AD-H4) | T-INTAKE/T-PLAN |
| AD-NEW2 | invoice discount / PO number | honest not-present | D-INV |
| AD-NEW3 | "who won the case" | honest — the mock file has no verdict | D-FAMCOURT |
| WI-NEW1 | "what are the scheduling sheets" | 5 monthly grids; defer counts to count-coverage | S-* |
| WI-NEW2 | docs vs sheets kinds | 4 docs + 11 sheets, two sheet-families | all |

**Status:** the two live REDs (SUM-bug leaked-source re-pin; now FC content is CONFIRMED so the only
live RED left is SUM-bug) need a model run the verifier couldn't do (no LLM key) → **engineer**, RED-first.

---

## ROUND 3 — engineer fixes, re-scoped by the RETRIEVAL-vs-REASONING lens (2026-06-24, `herdata-engineer`)

The four reported bugs were reproduced RED-first in-process over owner `3d1ca025` (when her corpus was
intact at session start) and ground-truthed by SQL. The lead then applied the priority lens: **every
bug is either RETRIEVAL (the system didn't get the right content in front of the model — fix SOLID +
GENERAL, the priority) or REASONING (the model HAD the content but interpreted it loosely — best-effort,
a stronger model fixes it, NO format-specific code).** An earlier draft added format-specific lanes
(a template-detector + a multi-sheet period guard) — those were **REVERTED** as the per-format
anti-pattern; the GENERAL retrieval fixes were kept, and the two reasoning bugs got ONE general prompt
nudge (no detector, no branch).

| bug | class | fix | proof |
|---|---|---|---|
| **2 MENDA incomplete** (preferred not named) | **RETRIEVAL (fixed solid)** | enumeration/summary WHOLE-DOC recall boost in `answer.ts` (`isEnumerationOrSummaryQuestion` + `fetchDocChunksByDoc`/`fetchBundledDocChunks`) — pulls enough of the subject doc so options 2–4 + the preferred reach the model. Also fixed a DEEPER general bug: a multi-chunk single-PAGE doc (docx/one-page memo, MENDA's 7-chunks-all-page-1 shape) collapsed to 1 chunk in `unionByRrf` (keyed by `doc#page`); the boost content-dedups instead. Helps EVERY document, no MENDA-specific code | retrieval gate `RETRIEVAL/MENDA-depth/enough-chunks` (≥4 chunks, was 1) + `…/grounded-cited` |
| **4 summary routing** (leaks to docs / denies own data) | **RETRIEVAL (fixed solid)** | summary-over-own-data router guard (`isSummaryQuestion` + `guardSummaryOverOwnData` in `router.ts`) — a summary of the user's own subject routes to + retrieves their structured sheets, phrasing-robust, never an ungrounded-general denial | retrieval gate `RETRIEVAL/source-routing/structured` + `…/no-denial`, all 3 phrasings; units in `her-data-detectors.test.mts` |
| **1 intake fabrication** (`58 candidates`) | **REASONING (best-effort)** | NO format-specific code (the template-detector was reverted). ONE general grounding-prompt nudge: "if a sheet's rows are form field labels, it's a blank template — say so, don't count rows as records". Retrieval is correct; interpretation is a model-quality gap | reported (not gated) in the retrieval eval as a best-effort signal |
| **3 plan-periods conflation** (`166 periods`) | **REASONING (best-effort)** | same single general nudge: "the number of separate sheets is the number of periods/sections; never sum per-sheet row counts as periods". No detector | reported (not gated) in the retrieval eval |

**Tests:** `tests/evals/her-data-generality.mjs` (the permanent RETRIEVAL gate — synthetic file of each
input type under a throwaway owner, **HARD-gates the retrieval fixes** [right source/chunks retrieved],
**REPORTS the reasoning signals** without gating, deletes the throwaway; 9/9 green) +
`tests/unit/her-data-detectors.test.mts` (7 deterministic detector boundaries for the kept general
fixes). **Gates:** `npx tsc --noEmit` clean; `npm test` 457/457 green; December cell-tally count eval
5/5 (NO count-surface regression after the format-code revert); anti-cheat grep clean (zero
owner-id/her-table/her-number in engine logic). **Caveat (reported, not hidden):** her live
`uploaded_rows`/`doc_chunks` were externally WIPED + partially re-ingested mid-session (now only the 2
December scheduling sheets + family-court remain), so the final RED→GREEN on HER exact data + the rest
of the count surface (June/July/Aug/system-wide) must be re-pinned once her corpus is restored. The
broader model-writes-SQL-against-real-structure rebuild (retiring special-case lanes generally) is the
lead's deliberate next direction, not done tonight.

---

## ROUND 4 — the cell-tally CLEAN-TABLE over-count fix (2026-06-24, `herdata-engineer`)

A new client report: a simple Excel + "who participates most" → RIGHT name, WRONG number (said 18,
truth 10). Root cause: the cell-tally lane counts NAME OCCURRENCES across ALL columns instead of
reading the real table — on a CLEAN tabular sheet that over-counts (a name in a Participant column AND
a Coach column is tallied twice). The lead's call: **a REMOVAL, not new logic** — stop the
occurrence-counter from HIJACKING clean tables; route them to the existing text-to-SQL `GROUP BY` for
the exact count. Keep cell-tally as the fallback ONLY for genuinely messy header-less grids (her
scheduling sheets) text-to-SQL can't parse.

**The minimal diff:** `isGridShaped` (the single gate all three cell-tally detectors share) now also
requires the table's columns to be mostly PLACEHOLDER/positional names (`__EMPTY`, `__EMPTY_3`, `col5`,
`Column1`, a bare number) — the fingerprint of a header-less sheet ingestion auto-named. A CLEAN table
with distinct headers (`participant`, `coach`, `venue`, `notes`) is no longer a "grid" → it falls to
text-to-SQL. No new detector/lane/guard; one structural predicate added to the existing gate. Keyed
only off column NAMES — no dataset/owner/number hardcoding (anti-cheat clean).

**Proof (RED→GREEN, synthetic, throwaway owner):** `tests/evals/clean-table-not-occurrence-count.mjs`
builds the over-count trap — Maya PARTICIPATES 8× but her name OCCURS 16× (also Coach 4× + Notes 4×)
in a 4-named-column table. RED-first (old `isGridShaped`): the clean table got hijacked → wrong count.
GREEN (fix): routes to text-to-SQL → **8, not 16/12**. The same eval's NO-REGRESSION case proves a
HEADER-LESS placeholder-column grid STILL uses the occurrence-tally (Dana = 5 across unnamed columns).
Unit: `tests/unit/cell-tally.test.mts` pins `isGridShaped` (clean named table → false; header-less /
mostly-placeholder grid → true). `tsc` clean; `npm test` 460/460; cell-tally count units 37/37 (messy-
grid path preserved). Did NOT touch her wiped live data (the December SCHED end-to-end re-pin waits on
her corpus restore).

### Meta (feeds the ratchet)
The independent audit found a false-block + 22 gaps the pm's own green-by-row view could not. So the
**completeness audit of a coverage bar should be a standing VERIFIER responsibility** — re-derive the
data, probe missing/falsely-blocked/cross-file/mixed-language/no-fab rows — producing FINDINGS (no test
code, no un-ground-truthable expected answer). The verifier-def's "authors nothing / grade only" is too
narrow: **grading a bar ≠ grading a build.**
