# Her-data coverage — the data-driven scenario bar (HARD GATE)

> **THIS BAR REFLECTS HER REAL ON-DISK FILES** in `/home/codex/Projects/nucleus/data/` (re-derived
> 2026-06-24 by the independent verifier). The PRIOR version of this file was built over the WRONG
> owner — the demo-admin account `3d1ca025` — and ground-truthed an entirely different corpus
> (a hebrew-invoice PDF, a MENDA strategy memo, "Danieli" intake/legend/plan sheets). **None of those
> files are in her real `data/` folder.** That stale version is preserved at
> `her-data-coverage.DEMO-OWNER.bak.md` for audit; do not test against it. Every expected answer below
> was **recomputed from the raw files on disk** (parsing the CSVs/XLSX/PDF-text directly) — not copied
> from the old numbers, not guessed.

> ### ⚖️ DOC-LANE @ 79472c6: persist FIXED (#82 done) · doc-ROUTE INTENT MISS still OPEN (Jenny's likely real bug)
> **#82 FK-retry fix VERIFIED** on committed 79472c6 (residue-clean, correct ownerId arg): persist
> lands, doc_chunks for owner = 19, no FK error. The classifier unit test (isTransientOwnerFkError:
> 23503→retry, RLS→no) is deterministic/removable-handler-proof; the e2e gate needs the
> __FORCE_OWNER_FK_ERROR hook for a deterministic RED (the ~1/8 probabilistic RED can false-pass).
> **STILL OPEN — a SEPARATE router-intent bug (NOT persist, NOT FK, NOT my harness):** with the owner's
> 19 chunks present, "who is the petitioner?" grounds only **2/5** (cites Joni when it routes), and
> **"how many children do the Carters have?" → 0/5, ALL mode=general, reliably "Beyoncé and Jay-Z."**
> The ROUTER never routes "how many children" to documents → answers from general knowledge → fabricates.
> This is a doc-ROUTE INTENT miss (the "never ungrounded over own data" guarantee, applied to DOCS) — the
> **most plausible cause of Jenny's actual prod ungrounding**, and a direct #81 concern (search_documents
> only helps if the model decides to call it). Needs its own task; #77 LIVE must cover "how many children".
> Repro: scratchpad/doclane-final.mjs. (Earlier RE-RECONCILED block below for record.)
>
> ### ~~⚖️ DOC-LANE — RE-RECONCILED~~ (SUPERSEDED — persist now fixed @ 79472c6; route-intent miss is the open item)
> **Corrected on committed 5091904, residue-clean, with the CORRECT ingestPdf signature:** persist
> WORKS — doc_chunks for owner = **19** (no silent failure, no null-owner). My earlier "doc lane fully
> broken" was inflated by TWO of MY OWN HARNESS BUGS: (1) I passed OWNER into ingestPdf's 3rd arg
> (`label`) instead of the 4th (`ownerId`) → rows persisted with owner_id=NULL → owner query found 0;
> (2) reused a detached buffer. Engineer was right that persist isn't broken. **I retract "doc lane
> fully broken / silent persist failure."**
> **REAL RESIDUAL (open):** even with rows correctly persisted, the doc lane is FLAKY by phrasing —
> "who is the petitioner?" grounds 2/3 (Joni cited), but **"how many children do the Carters have?"
> grounds 0/3 and reliably fabricates Beyoncé (mode=general)** with docs present. So it's an
> intermittent doc-ROUTING/retrieval miss on some phrasings, NOT persist. → chase for #81's
> search_documents foundation + the #77 LIVE check. (FK-race + harness-bug history below for record.)
>
> ### ~~⚖️ DOC-LANE — SETTLED (FK race)~~ (SUPERSEDED by the RE-RECONCILED block — persist works, routing flaky)
> **#82 persist failure = REAL but flaky: an auth.users FK timing race** (engineer2's committed
> doc-persist-grounding eval reproduced it: `insert into doc_chunks violates FK doc_chunks_owner_id_fkey`,
> persisted=0, 4/15; other runs 15/15 — won/lost the race). Owner_id → auth.users(id) (migs 006/012); a
> just-created throwaway owner isn't visible to the FK check yet → insert rejected. The read-back fix
> (#82) is VALIDATED (reports persisted=0, no false-green) but HARDENS reporting — it does NOT fix the FK
> drop. Engineer fix: verify/retry auth-user before insert + harness awaits auth propagation. RE-CERTIFY
> #82 clean N/N after the producer is killed.
> **⚠️ SEPARATE + STILL OPEN — Jenny's PRODUCTION ungrounding:** she is an ESTABLISHED user (owner
> pre-exists in auth.users → NO FK race), so the FK race does NOT explain her live Beyoncé/ungrounded
> answers. The real cause of HER experience is UNEXPLAINED and stays open for the **#77 LIVE upload check
> on nucleus-woad** (ingest a doc as her real account on the deployed app → does it ground?). Do NOT let
> the FK finding close the client-facing symptom. (Original UNRECONCILED block below for record.)
>
> ### ~~⚠️ DOC-LANE — DOWNGRADED to UNRECONCILED~~ (SUPERSEDED by the SETTLED block above)
> **CORRECTION:** the "silent persist failure" cause below is DISPROVEN. On a clean DB every persist
> primitive works (raw insert, embed, storeDocChunks direct, full real-chunk batch all land). The
> original doc_chunks=0 was likely the concurrent residue leak (deleting rows mid-run, after pre-flight)
> + version-skew (dirty mid-edit tree vs committed 932aebc). Needs a committed-SHA ingestPdf run to
> settle: lands → phantom (reduces to read-back hardening); 0 → a real ingestPdf chunk/batch bug. The
> Beyoncé SYMPTOM was real; the storeDocChunks CAUSE is unproven. (Original block kept below for record.)
>
> ### ~~🟥 DOC-LANE ROOT CAUSE — ISOLATED~~ (SUPERSEDED — see correction above)
> Her ENTIRE uploaded-PDF Q&A is broken; root cause pinpointed to ONE place:
> - **(a) uploaded-doc persist** → SILENT FAILURE: ingestPdf reports `persisted=11`, `doc_chunks` rows for
>   the fresh owner = **0**, no error. Question → route=[], general, fabricates ("no access" / Beyoncé).
> - **(b) bundled demo-doc lane** → ✅ WORKS: isDemo:true "how many children do the Carters have" →
>   route=["documents"], grounded, "Emma(11)/Noah(8)/Olivia(5)" cited [P:family-court...#6].
> **Verdict: HER-UPLOAD-SPECIFIC.** RAG retrieval + answer logic are FINE (bundled in-process index
> grounds correctly). The bug is ONLY the uploaded→`doc_chunks` persist (storeDocChunks, pgvector-store.ts
> :102 — insert returns success, 0 rows land; `persisted` reports `rows.length`, a false-green). The
> bundled DEMO masked it = textbook demo-vs-real gap. **Hard prereq for #81** (the ReAct doc-tool queries
> doc_chunks; can't find unpersisted rows). Fix = doc_chunks RLS vs uploaded_rows / embedding-col +
> return a re-read verified count. Task #82.

> ### 🧪 #81 CERT ACCEPTANCE BAR — owned by the VERIFIER (the ReAct loop must hit ALL on the realistic corpus, committed SHA, residue-clean, member-scoped)
> The doc-route-intent bug + the count + the cross-corpus mis-route ALL fold into #81 (no current-router
> patch — FROZEN). The loop's system prompt extends the never-ungrounded-over-own-data guarantee to
> DOCUMENTS. I OWN these acceptance rows in the #81 cert + the #77 live check:
> 1. **DOC ROUTE (both phrasings, deterministic):** "who is the petitioner?" → **Joni**, grounded+cited
>    **100%** (not 2/5); "how many children do the Carters have?" → **Emma/Noah/Olivia**, grounded+cited,
>    **NEVER Beyoncé/general** — with her PDFs uploaded the real way (correct ownerId). Currently 0/5 → must be N/N.
> 2. **COUNT (her #1, ≥15 serial deterministic):** "who participates the most" / "who is more active" /
>    HE forms → **רינה אנטוב=10** over the FULL realistic corpus (grids + enrollment + people), **no
>    enrollment/people-name leak, no enrollment-gender leak** (the cross-corpus mis-route that REOPENED #70).
>    FLAG: verify the loop's counting is TOOLED (CODE tallies), not the model EYEBALLING the grid.
> 3. **NO-FAB over own data:** a question about content in her OWN docs/tables routes to that source or an
>    honest grounded-limit — never ungrounded general (the guarantee, applied to BOTH lanes).
> 4. **Tenant isolation (removable check):** the loop's SQL/doc tools physically reach ONLY the caller's
>    own rows; stub the scope → cross-owner read → RED.
> All on a COMMITTED SHA, residue-clean pre/post, MEMBER-scoped (never admin/3d1ca025), ≥15× serial where
> reliability is the bar. #70 is NOT done (reopened by the cross-corpus gender leak) — it lives here now.

> ### 🎯 ARCHITECTURE-INDEPENDENT ACCEPTANCE TARGETS (survive the #81 router→ReAct pivot)
> The architecture is pivoting (remove the upfront router → ChatGPT-style model-driven tool use: SQL over
> her owner-scoped tables + doc search; the model picks the table itself — task #81, subsumes #70/#80/#72).
> **This bar is UNCHANGED — it grades what JENNY SEES over HER REAL FILES, not the implementation.** The
> new architecture must hit ALL of these, on her REALISTIC multi-file corpus (all files ingested
> together), on a COMMITTED SHA, residue-clean:
> 1. **Count (#70):** 8/8 serial on her literal words ("who participates the most", "who is more active",
>    "מי משתתפת הכי הרבה", "מי הכי פעילה", "who appears most often") → **רינה אנטוב = 10**, names from her
>    שיבוצים Excel — NEVER enrollment names (Zebulon Macer/Brana Matthensen), NEVER `school_data_2`.
> 2. **CSV aggregates (#80):** "most popular course" → **physics 93** (not "only one course record");
>    "who enrolls in the most courses" → **"every student once, no top student"** (not a fabricated
>    winner); contracts ΣannualCost = **494,513,028.33**, top vendor = **Meevee 10** (not "only one
>    vendor"); payroll routes (not "no access to school data 4").
> 3. **Doc lane / RG1 (#82/#72):** her PDF questions READ her PDFs (doc_chunks must persist); "how many
>    children do the Carters have" → **Emma/Noah/Olivia** (never Beyoncé); RG1 alimony states **"no
>    alimony award — only $1,285/mo child support + equal split"** AND gives a substantive recommendation.
> These three are the same REDs I graded provisionally — they become the pivot's pass conditions. The
> implementation is the swappable knob; the bar is not.

> ### ⚠️ GRADE PROVENANCE — all grades below are PROVISIONAL (pre-commit working tree)
> **Per the grade-committed-SHAs protocol (2026-06-24):** every result in this bar so far was graded
> against **HEAD `932aebc` + a DIRTY working tree** — the engineer was actively editing
> `cell-tally.ts` / `router.ts` / `text-to-sql.ts` (diff-hash `2a7c8263`). That moving target is the
> root of the earlier version-skew confusion (my PASS vs lead's FAIL = different tree states). So:
> - **SCHED count rows** (SC1/SC-ACTIVE/SC-HE) — graded on the dirty tree; **provisional, NOT a #70
>   close.** The binding re-grade waits for a COMMITTED SHA (5×/8× serial, residue-clean, full corpus).
> - **CSV REDs** (LK5/EG4/AD-CSV1, contracts/payroll superlative, doc-lane) — `text-to-sql.ts`/`router.ts`
>   are in the dirty set, so these are **"to confirm on commit SHA."** They're almost certainly real on
>   committed code (the #80/#82 fixes aren't started), but re-confirm on a committed SHA.
> - **RG1 alimony + the doc-lane silent-persist (#82)** touch `pgvector-store.ts` (NOT in the dirty set),
>   so those are closer to committed-state — still stamp the SHA.
> **Rule going forward: stamp the graded SHA (or "dirty tree @ HEAD+hash") on every result; the binding
> count re-grade runs only on a committed SHA the engineer posts.**

**The gap this closes.** Coverage must enumerate EVERY file Jenny actually has and derive the realistic
questions she'd ask over *each*. This doc is that pass over her real corpus: **11 files** — 7 CSVs,
2 divorce-case PDFs, 2 Hebrew scheduling XLSX — across **all question TYPES** (lookup · count/aggregate
· superlative · summary · cross-file · doc-Q&A · recommendation/grounding · adversarial/no-fabrication ·
messy-structure edge cases) plus a **generality layer** (a fresh synthetic input per type).

**How this gate runs:** the **engineer** implements/exercises a guard for each row over an **ISOLATED
throwaway owner** (create → ingest her real files → ask → assert → delete; NEVER her live accounts),
RED-first; the **verifier** independently re-checks each row and re-walks the data for gaps. Status:
`⬜ pending` → `🟢 guard green (eval/in-proc)` → `✅ confirmed LIVE on nucleus-woad`. A `🟥` row is a
confirmed bug with the correct expected answer attached.

> **Derived from:** her real files, parsed on disk:
> `/home/codex/Projects/nucleus/data/` — 7 `school data*.csv`, 2 PDFs (the Carter divorce case),
> `שיבוצים יוני 2024…xlsx` + `שיבוצים אוגוסט 2024…xlsx`. Ground-truth scripts (throwaway, not committed):
> `scratchpad/gt-csvs.mjs`, `scratchpad/tally-grids.mjs`, `data/pdf-pages.json` (pre-extracted PDF text).
> **PII discipline:** the scheduling files contain YOUTH names. This bar quotes only **aggregates** and
> the **single top name** where it is load-bearing for a count assertion; it never enumerates a roster
> of minors. The divorce PDFs are explicitly labeled MOCK/fictional, so named parties (Joni/Michel
> Carter) are usable as ground-truth facts.

---

## 0 — The corpus inventory (what she ACTUALLY has on disk)

> Re-derived by parsing each file directly. **A naming trap, ground-truthed and flagged:** the file
> *named* `שיבוצים אוגוסט 2024` ("August") contains, in its title row, **חודש יולי 2024** — i.e. its
> CONTENT is **July**, not August. Ground-truth was computed from CONTENT, not the filename.

### CSV / structured data — 7 (these are synthetic Mockaroo-style datasets)
| key | file | what it is | rows (data) | ground-truthed shape |
|---|---|---|---|---|
| C-PEOPLE | `school data .csv` | a people / contact list | **1000** | cols: id, first_name, last_name, email, gender, ip_address. **Header↔data mis-aligned** (the `id` column holds a name-like token; first/last appear shifted) — a real messy-data trap. |
| C-CONTRACTS | `school data 1.csv` | vendor contracts | **1000** | Contract ID, Vendor, Start/End Date, Annual Cost. **347 distinct vendors**; ΣAnnual Cost = **494,513,028.33**; max single = **998,528.37**; most-frequent vendor = **Meevee (10)**. |
| C-ENROLL | `school data 2.csv` | student course enrollment | **1000** | term_name, course_code, student_full_name, status, credits. **1000 DISTINCT students** (every student appears exactly once). **12 distinct courses**; most-popular = **physics (93)**, then bible/biology/photography (90 each). |
| C-MAINT | `school data 3.csv` | maintenance tickets | **750** | Ticket ID, Vendor, Invoice, Labor/Parts/Total Cost, Completion Date. ΣTotal Cost = **40,597.00**; most-frequent vendor = **Thoughtstorm (8)**. |
| C-PAY-A | `school data 4.csv` | payroll (run A) | **235** | record/employee, name, pay_period, department, job_title, …gross_pay, net_pay. **235 distinct employees**; Σgross_pay = **4,823,732.48**; Σnet_pay = **2,472,635.23**; biggest dept by headcount = **Sales (31)**; max base_salary_month = **19,885.59**. |
| C-INVSUM | `school data 5.csv` | invoices summary | **788** | id, students, invoices_per_student_per_year, total_invoices. **Degenerate: every row identical** (students=180, total_invoices=1080). Σtotal_invoices = 851,040 (meaningless — see adversarial AD-CSV3). |
| C-PAY-B | `school data 6.csv` | payroll (run B) | **720** | employee_full_name, department, …base_salary_monthly, net_pay, currency_code. **720 distinct employees**; Σnet_pay = **14,775,684.71**; biggest dept = **Accounting (71)**; currencies multi (CNY 121, EUR 89, …). |

> **Data-quality landmines baked into these CSVs (each is a no-fabrication trap, not a bug to "fix"):**
> - The literal string `error: undefined method `first' for nil:NilClass` appears as a CELL VALUE in
>   C-ENROLL (`term_name`), C-PAY-A (`pay_method`, `payroll_notes`) — a Mockaroo generation error frozen
>   into the data. The engine must NEVER present it as a real term/method; treat as missing/garbage.
> - C-ENROLL `status` column holds **gender values** (Male/Female/Non-binary), NOT enrollment status —
>   a mis-labeled column. "How many enrolled / what's the status breakdown" must not be answered from it.

### Documents (PDF) — 2 (BOTH are the same fictional Carter divorce case)
| key | file | what it is | citable ground-truth (from `data/pdf-pages.json`) |
|---|---|---|---|
| D-CASEFILE | `📄 FAMILY COURT CASE FILE (MOCK) – FINAL VERSION.pdf` | a 24-page mock family-court case file | Maricopa County AZ, Case **FC-2026-10458**; **Joni Carter (Petitioner) vs Michel Carter (Respondent)**; Dissolution; **Filed 10 Feb 2026**; Judge Hon. Rebecca Lawson; **3 children** (Emma 11, Noah 8, Olivia 5). Incomes: Joni $95k, Michel $130k. Assets: home $620k, mortgage $280k, savings $74.5k, investments $112k. **Final Judgment:** marriage dissolved · joint custody · primary residence Joni · **asset division: equal split** · **child support $1,285/month** · home sale within 12 months. **NO alimony / spousal-support award anywhere.** |
| D-STORY | `story if the Carters .pdf` | the narrative "Carter Family Story" of the same case | married **June 14 2014** Phoenix AZ; children **Emma (2015), Noah (2018), Olivia (2021)**; Michel = construction PM; divorce **filed Feb 3 2026**; reasons: gambling addiction, alcohol, a domestic-violence incident, harm to children. **No financial award stated** (narrative, not judgment). |

> **Cross-document CONTRADICTION (ground-truthed, must be surfaced not hidden):** the two files
> disagree on the **filing date** — case file says **10 Feb 2026**, story says **Feb 3 2026** — and on
> the children's **ages vs birth-years** framing. An honest answer must cite the specific source or
> surface the discrepancy, never silently assert one. (See XF-DOC2.)

### Hebrew scheduling grids (XLSX) — 2 (messy monthly calendar grids)
| key | file | content month (NOT filename) | shape |
|---|---|---|---|
| S-JUN | `שיבוצים יוני 2024 - סיון תשפד (1).xlsx` | **June 2024** (title: סיון תשפ״ד) | sheet `גיליון1`, weekly blocks: a date-header row (columns = weekdays), then under each day an **ACTIVITY** label, then **PEOPLE** rows. `גיליון2` empty. |
| S-AUG→JUL | `שיבוצים אוגוסט 2024 - אב תשפד.xlsx` | **July 2024** (title row: חודש יולי 2024) ⚠ filename says August | same grid shape. |

> **The activity-as-person trap (ground-truthed, the crown-jewel adversarial case):** in these grids a
> cell can hold a PERSON, an ACTIVITY/place, or a day-header. **`חדר מתנות` (gift-room) is a PLACE/
> activity, not a participant** — yet it appears in person-position **13×** across both grids (8× in
> July alone), which is MORE than the true top participant. A naive occurrence-counter crowns
> `חדר מתנות` (or over-counts a real name to 18). The correct engine splits the judgment: **CODE
> tallies exact occurrences; the MODEL classifies each distinct value as person vs activity/place** and
> excludes the non-people. See SCHED rows.

**Corpus totals:** **11 files** = 7 CSVs + 2 PDFs + 2 XLSX. "How many files" answers must reconcile to
this (or honestly to whatever store it can see), never an invented number.

---

## A — LOOKUPS (a specific field / value in one file)
| id | question (her language where natural) | expected answer / honest-limit | file(s) | status |
|---|---|---|---|---|
| LK1 | "who is the petitioner / who filed for divorce?" | **Joni Carter** (Petitioner) vs Michel Carter (Respondent); cited D-CASEFILE | D-CASEFILE | ⬜ |
| LK2 | "how much is the child support?" | **$1,285 / month**; cited; the exact figure, never rounded/invented | D-CASEFILE | ⬜ |
| LK3 | "how many children do the Carters have / their names?" | **3 — Emma, Noah, Olivia**; cited. (Ages are source-specific — see N1.) | D-CASEFILE/D-STORY | ⬜ |
| LK4 | "which vendor has the most contracts?" | **Meevee (10 contracts)**; cited C-CONTRACTS; ground-truthed, not guessed | C-CONTRACTS | ⬜ |
| LK5 | "what is the most popular course?" | **physics (93)**; biology/bible/photography tie at 90 | C-ENROLL | 🟥 **graded WRONG: engine said "biology, 86" — wrong winner AND wrong count (biology=90, top=physics=93; 86 is literature). Real GROUP BY/superlative error over a clean 1000-row CSV.** |
| LK6 | "what was the judge's name / case number?" | Hon. Rebecca Lawson; FC-2026-10458; cited D-CASEFILE | D-CASEFILE | ⬜ |

## B — COUNTS / AGGREGATES (ground-truthed, exact)
| id | question | expected answer (ground-truthed) | file(s) | status |
|---|---|---|---|---|
| CT1 | "how many files do I have?" | **11** (7 spreadsheets + 2 PDFs + 2 schedules), or honestly to what the store sees; never a vaguer/invented number | all | ⬜ |
| CT2 | "how many students are enrolled?" | **1000** enrollment rows / 1000 distinct students; cited C-ENROLL; not from the mis-labeled `status` col | C-ENROLL | ⬜ |
| CT3 | "how many distinct vendors are in the contracts?" | **347**; cited C-CONTRACTS | C-CONTRACTS | ⬜ |
| CT4 | "what is the total annual contract cost?" | **494,513,028.33** (Σ Annual Cost); cited | C-CONTRACTS | 🟢 graded ✅ (residue-clean, exact full-table SUM) |
| CT5 | "how many employees are on payroll?" | C-PAY-A = **235**, C-PAY-B = **720**; must say WHICH file (two separate payroll runs), not silently merge or pick one | C-PAY-A/B | ⬜ |
| CT6 | "how many courses are offered?" | **12** distinct courses; cited C-ENROLL | C-ENROLL | ⬜ |
| CT7 | "total maintenance cost?" | **40,597.00** (Σ Total Cost); cited C-MAINT | C-MAINT | ⬜ |

<!-- RESIDUE-CLEAN ENROLLMENT GRADE (2026-06-24, pre/post 0 orphans) -->
> **Enrollment CSV grade (residue-clean):** "which course has the most students" → 🟥 RED (physics 93
> right, but "only one course record" fabrication — truncated 1-row window #80); "what is the most
> popular course" → ✅ PASS ("physics, 93", clean) — SAME fact, opposite behavior by phrasing, proving
> the window read is non-deterministic; "who enrolls in the most courses" → 🟥 RED ("only one student:
> Zebulon Macer" — truth is 1000 distinct, no superlative); error-string term landmine → ✅ no-fab PASS;
> status-gender landmine → 🟡 FLAKY (disclaimer present this run, absent in a prior clean run). Dominant
> root cause = the truncated 1-row window read (#80).

<!-- TWO DISTINCT ROOT CAUSES (do not merge) -->
> **Two compounding-but-distinct root causes (proven separately, 2026-06-24, SHA 932aebc+dirty):**
> 1. **#80 — superlative lane, TWO sub-bugs (both fire SINGLE-TABLE, residue-clean — independent of
>    cross-corpus; SUM/COUNT/MAX over the full table are otherwise EXACT, so NO row-cap):**
>    (1a) **GROUP-BY-count superlative computes the WRONG ANSWER** — "which vendor has the most
>    contracts" → "Edgepulse, 2" (GT Meevee=10): wrong winner AND wrong count, not just prose. Likely
>    LIMIT-1 applied BEFORE/instead of the GROUP BY aggregate, so it groups within a 1-row window.
>    (1b) **MAX/ORDER-BY correct but PROSE mis-renders** — "highest annual cost" → right number
>    998,528.37 but "this is the only row returned." Rendering only. ("which course has the most
>    students" → "only one course record" is the same 1a/1b family; "what is the most popular course" →
>    clean physics 93 shows it's phrasing-sensitive.)
> 2. **Cross-corpus wrong-table routing** — needs a competing table: SCHED→`school_data_2` (names not in
>    her excel), payroll→`general` ("no access to school data 4"). Compounds #80 (wrong table → LIMIT-1
>    misread) but is NOT required to trigger #80.
> NOTE: the biology=86 vs physics=93 flip is CONFOUNDED (residue + corpus both varied) — not cited as the
> cross-corpus proof. Clean proofs: SCHED→school_data_2 (cross-corpus) and the single-table "only one
> record" (#80).

<!-- #80 GRADED GREEN @ 5b4b2b2 (2026-06-25, member-scoped, residue-clean) -->
> ### ✅ #80 LIMIT-1 NARRATION — GRADED GREEN @ SHA 5b4b2b2 (course/student, single-table)
> Independent grade, her real enrollment CSV, member throwaway owner, residue-clean, 3× serial:
> "which course has the most students" → **physics, 93** cited, 3/3, **0/3 "only one course" fabrication**;
> "what is the most popular course" (no-reg) → physics 93, 3/3; "which student enrolls the most" → honest
> **"each enrolls once, no top"** (cnt=1 for all), 3/3, NO false "only one student record"; "how many
> enrollment records" (no-reg) → **1000**, 3/3. The ranked-groups fix kills the LIMIT-1 "only one record"
> RED. Engineer's gate (clean-table-superlative.mjs) confirmed removable-handler-proof + serial. VENDOR
> ("most contracts" → route=[]/general) is the #81 router-strand, NOT a #80 requirement — out of scope.

<!-- RESIDUE-CLEAN CONTRACTS+PAYROLL GRADE (2026-06-24, pre 0/0) -->
> **Contracts/payroll aggregate grade (residue-clean) — REFINES #80:** SUM and COUNT over the FULL
> table are EXACT — "total annual cost" → ✅ **494,513,028.33**, "how many contracts" → ✅ **1000**. So
> #80 is **NOT a row-cap / sampled read.** The bug is the **superlative/top-N lane only**: "which vendor
> has the most contracts" → 🟥 "only one vendor record: Edgepulse, 2" (GT Meevee=10); "highest annual
> cost" → 🟥 right number (998,528.37) but "the only row returned." A `ORDER BY x LIMIT 1` result is
> mis-RENDERED as "the evidence contains only one record." **Separately: payroll (school data 4/6, both
> ingested) → 🟥 ALL route=[]/general ("I don't have access to school data 4") — multi-table routing
> fails for similarly-named tables, same class as the SCHED→school_data_2 cross-corpus bug.** CT4
> (Σannual)/CT3-style counts are GREEN; the superlative + multi-table-routing rows are RED.

<!-- BINDING GRADE @ SHA 2421756 (committed, ui-redesign) -->
> ### #70 @ SHA 2421756 — FIX CONFIRMED, deterministic certification PENDING a quiet DB
> Engineer's committed eval (grids-only, reset-once): **13/13 GREEN** (all phrasings → רינה אנטוב=10).
> My CROSS-CORPUS extension (grids + enrollment[1000 names] + people[1000 names], 3×3 serial,
> residue-clean PRE-FLIGHT): **2/3 runs 9/9 PASS** (wrong-corpus rejection HOLDS, no enrollment-name
> leak); 1 run 0/3 FAIL **confounded by a concurrent teammate grader (dist-count.mjs) spiking 1000-row
> residue mid-run** → it routed to the people-list. So the fix LOOKS real but I cannot stamp
> deterministic while the shared DB churns mid-run. NOTE: my first attempt 0/3 was MY harness's per-ask
> reset-RACE (a false RED) — fixed to reset-once → 9/9. Certify on a quiet-DB window, 3× serial.

<!-- #70 CERTIFIED @ dc9019f (2026-06-24) -->
> ### ✅ #70 COUNT — FULLY CLOSED (cert @ dc9019f + fail-safe @ 5091904, lead-accepted 2026-06-24)
> Count: 15/15 cross-corpus deterministic @ dc9019f. FAIL-SAFE (#70-close @ 5091904): router unit
> 14/14, removable-handler-proof ("classifier ERROR over the caller's grid → routes structured, never
> punts"). Count path (cell-tally/router/answer) BYTE-IDENTICAL dc9019f→5091904, so the cert carries
> (a live 5× at 5091904 would re-run identical code = redundant). #70 = DONE. Remaining for the doc-lane
> story: the #77 LIVE preview check (count + real-PDF-upload over HTTP) gates the prod promote.
>
> ### ~~✅ #70 COUNT — CERTIFIED DETERMINISTIC @ SHA dc9019f~~ (rolled into the FULLY CLOSED block above) (engine=2421756 byte-identical + FK-await harness)
> Binding re-grade, residue-clean PRE-FLIGHT, full realistic corpus (June+Aug grids + enrollment[1000]
> + people[1000]): **15/15** — EN "who participates the most" 5/5, EN "who is more active" 5/5, HE
> "מי משתתפת הכי הרבה" 5/5 → **רינה אנטוב=10**, grounded, ZERO enrollment/people-list name leaks.
> **Jenny's #1 "names not in the excel" bug is DETERMINISTICALLY GONE.** The cold-start 1/8 miss was a
> HARNESS FK-await race (not a product gap) — fixed in dc9019f's harness; engine unchanged. RECONCILED:
> run-2's earlier "Lorena Grunnill" people-list route was **residue-CONFOUNDED, NOT a real gap** — proven
> because a 107-row residue spike hit r4 of ALL 3 phrasings THIS run and every one STILL passed 5/5 (the
> wrong-corpus rejection holds even under residue). #70 = DONE.

<!-- PIVOTAL: T2 catalog-pagination fix CLOSES cross-corpus count + doc-route AT SOURCE (@ 2e14642, 2026-06-25) -->
> ### ✅✅ ROOT CAUSE FOUND — T2 catalog-pagination fix (@ 2e14642) closes BOTH #81-bound symptoms AT THE SOURCE
> Pivotal grade, cold-start-rehydrate SIMULATED (big tables ingested FIRST → grids/PDF → resetStore +
> hydrateUploadedTables → ask), member-scoped, residue 0/0, on her FULL realistic corpus (June+Aug grids
> + enrollment[1000] + people[1000] + 2 PDFs):
> • CROSS-CORPUS COUNT: EN "who participates most" **10/10**, HE **10/10**, EN "more active" **10/10** →
>   רינה אנטוב=10 FROM THE GRID, **0/30 enrollment/people/gender leak** (pre-T2: ~4/8 wrong).
> • DOC-ROUTE: "how many children?" **5/5** (Emma/Noah/Olivia cited, **0 Beyoncé**, was 0/5 before!);
>   "who is the petitioner?" **5/5** (Joni cited).
> **VERDICT: the grid-blindness + the doc-route Beyoncé were ONE root cause — a CATALOG-VISIBILITY bug,
> NOT router-intent.** A ≥1000-row table/doc-set pushed her grid AND her PDFs past PostgREST's page cap →
> invisible to the owner catalog → wrong-corpus/general/Beyoncé. Range-pagination makes the catalog see
> everything → both ground perfectly. So my earlier "doc-route INTENT miss" framing was WRONG — it was
> the SAME page-cap mechanism (the case PDF fell past the doc-list page cap). #81's rewrite is NOT needed
> for these symptoms; deploying 2e14642 should close Jenny's #1 count bug AND her doc ungrounding.

<!-- #77 LIVE GREEN @ preview 2e14642 (2026-06-25, over real HTTP) -->
> ### ✅✅✅ #77 LIVE — GREEN over real HTTP @ preview (SHA 2e14642): the catalog fix holds for Jenny
> Throwaway user on the LIVE preview, signed in via the real SSR session cookie, uploaded her FULL corpus
> the cold-start way (1000-row enrollment + people CSVs FIRST, then grids + Carter PDF) via live
> /api/ingest (all HTTP 200), then asked via live /api/ask:
> • COUNT: EN "who participates most" **5/5** + HE "מי משתתפת הכי הרבה" **5/5** → רינה אנטוב=10 FROM THE
>   GRID, cited, **0/10 enrollment/gender/people leak**.
> • DOC: "how many children?" **5/5** (Emma/Noah/Olivia cited [P:family-court#6], **0 Beyoncé**);
>   "who is the petitioner?" **5/5** (Joni cited).
> 20/20 over real HTTP. Jenny's #1 count bug AND the doc Beyoncé bug are GONE live. Throwaway user
> deleted, residue 0/0, nucleus-woad untouched. (Harness note: my first live attempt 401'd on a hand-built
> cookie — fixed by using @supabase/ssr's own cookie writer; a harness bug, not the engine.) GREEN TO PROMOTE.

## SCHED — the scheduling grids (HER LITERAL WORDS — superlative + count, the activity-as-person trap)

> **Phrasings are driven by HER TRANSCRIPT, not paraphrases** (`docs/client-messages-draft.md`). This
> is where the previous green-but-blind gap lived: the old tests passed on the phrasing the code already
> handled ("who is scheduled the most") and never included her verbatim words. A phrasing the engine
> can't answer **over her own data** is a **RED, not an edge case.** Each row tags whether the phrasing
> is HER VERBATIM words (✎, with the transcript line) or a natural synonym that must also work.
> Ground truth over June+July grids: **רינה אנטוב = 10** (over-count was 18; activity-trap = `חדר מתנות`,
> 13× in person-position — never a participant). **GRADED on her real files via throwaway owner
> (`scratchpad/her-words-grade.mjs`), 2026-06-24.**

| id | question (✎ = HER VERBATIM) | expected answer (ground-truthed) | file(s) | status |
|---|---|---|---|---|
| SC1 ✎ | **"who participates the most"** (line 467) | **רינה אנטוב, 10**; cited. NEVER 18 (her exact complaint), NEVER `חדר מתנות` (place, 13×, classified out). | S-JUN+S-AUG→JUL | 🟥 **RED — false-green corrected: cross-corpus contamination, 3/8 in realistic multi-file corpus. See CORRECTION.** |
| SC-ACTIVE ✎ | **"who is more active"** (line 420 — "gave names that are not in the excel, asked 3 times") | **רינה אנטוב, 10**, route=structured/grounded; never `general`, never names-not-in-file | S-JUN+S-AUG→JUL | 🟢 graded ✅ on engineer's NEW phrasing-independent classifier (5/5 serial); was 🟥 on OLD committed code — **pending commit + committed-state gate.** See reconciliation note. |
| SC-HE-PART ✎ | `מי משתתפת הכי הרבה?` (her HE phrasing) | **רינה אנטוב, 10**, structured/grounded | S-* | 🟢 graded ✅ |
| SC-HE-ACTIVE | `מי הכי פעילה?` (HE "most active") | **רינה אנטוב, 10**, structured/grounded | S-* | 🟢 graded ✅ |
| SC-SYN-SCHED | "who is scheduled the most" (the OLD false-green phrasing the code already handled) | **רינה אנטוב, 10** | S-* | 🟢 graded ✅ |
| SC-MOST-OFTEN | "who appears most often" / "who is here the most" (natural EN synonyms) | **רינה אנטוב, 10**; must NOT fall through to general (same trigger gap as SC-ACTIVE) | S-* | ⬜ (LIKELY RED — comparative/"often" not in ranking cue) |
| SC2 | "who participates the most in June" (single grid) | June top participant within S-JUN only (רינה אנטוב = 5 in June); per-month scope | S-JUN | ⬜ |
| SC3 | `כמה פעמים רינה אנטוב משובצת?` (how many times is <top name> scheduled) | **10** across both; per-file 5 + 5 if asked per-file; cited | S-JUN+JUL | ⬜ |
| SC4 (adv) | "what is the most common activity" | an ACTIVITY answer (e.g. הרכב + ימי הולדת = 9) — DISTINCT from the person answer | S-* | ⬜ |
| SC5 (adv) | "who participates the most" where `חדר מתנות` would naively win | classify `חדר מתנות` as place/activity, EXCLUDE it; answer is a person, never the gift-room | S-* | 🟢 (proven within SC1 — runner-ups all people) |

> ### 🟥 SCHED-RED — "who is more active" punts to `general` (HER words, graded FAIL on her files)
> **Graded behaviour (in-process, throwaway owner, her 2 real xlsx, 2026-06-24):** `route=[]`,
> `mode=general`, answer = *"I cannot determine who is more active because you have not specified which
> individuals…"* — it REFUSES over her OWN uploaded grid. This is the exact class she reported on
> transcript line 420 ("gave names that are not in the excel, asked 3 times").
> **Root cause (verified, not guessed):** `isCellTallyQuestion` gates the cell-tally lane behind a
> hand-maintained **cue-word regex** (a "ranking cue" list + an "occurrence cue" list). Her "who is
> **more** active" matched the occurrence list but not the ranking list, so the lane never fired and the
> answer fell through to `general`. The HE `מי הכי פעילה?` happened to match the HE list. The DIAGNOSIS
> is not "the list is missing one word" — it is that **a maintained cue-word list is the wrong
> mechanism**: every new natural phrasing she invents is a fresh miss (the same treadmill as having to
> add "participates", then "more active", then the next word forever).
> **Fix direction (engineer) — REMOVE the cue-word gate, make it PHRASING-INDEPENDENT.** The trigger
> must decide INTENT by MEANING (an LLM intent flag / classifier judging "is this an
> occurrence-ranking question over the grid?" in ANY EN/HE phrasing), NOT by matching a maintained word
> list. **Do NOT just add `more`/`more often` to the regex — that is the band-aid that was rejected.**
> **Acceptance:** ANY natural EN/HE phrasing of a count/ranking over her grid works with no maintained
> phrase list, proven on UNSEEN phrasings the code has never been tuned for. (This is task #69 as
> reframed.)
>
> ### ✅ RECONCILED (2026-06-24, second pass) — version skew, NOT flakiness
> The lead's run showed "who participates the most" PUNTING to general; my first run showed it GREEN.
> Reconciled by re-running each LITERAL string **5× serial** on two code states:
> - **OLD committed code** (keyword cue-word gate): "who is more active" had no ranking cue → general. RED.
> - **NEW working tree** (engineer's `cell-tally.ts` "phrasing-independent intent classifier" — an LLM
>   call that judges occurrence-ranking INTENT by MEANING, not keywords, task #69): **ALL 5 phrasings
>   5/5 DETERMINISTIC-PASS** — "who participates the most", **"who is more active"**, "who appears most
>   often", `מי משתתפת הכי הרבה?`, `מי הכי פעילה?` — all grounded/structured/רינה אנטוב=10.
> So the contradiction was **version skew** (lead = old code, me = engineer's in-progress fix), **not
> RNG flakiness and NOT a synonym crutch.** The engineer's chosen fix is BETTER than my suggested regex
> broadening — it kills the cue-word gate entirely. **Caveat:** this passes on UNCOMMITTED working-tree
> code; #70 is NOT done until the engineer commits and it survives the deterministic gate in a committed
> state. Re-grade on the committed SHA before marking GREEN.
>
> ### 🟥 CORRECTION (third pass — SUPERSEDES the green above): CROSS-CORPUS CONTAMINATION
> My "5/5 GREEN" runs ingested ONLY the 2 grids — a clean-room that HID the real bug. The lead demanded
> an 8× serial measurement over her REALISTIC multi-file corpus (grids + the 2 divorce PDFs + the
> enrollment CSV in one owner — how Jenny actually uses it). Result collapsed:
> - "who participates the most?" → **3/8** (5/8 wrong); "מי משתתפת הכי הרבה?" → **0/8**; "scheduled the
>   most" → **0/8**. All `mode=grounded` (so NOT a general-punt — it confidently answered WRONG).
> **Root cause (characterized):** when the enrollment CSV `school_data_2` (which has a
> `student_full_name` column) is in the corpus, the SCHED question routes to **`school_data_2`** instead
> of the grids, then hits the truncated-window read → answers *"a single record: Zebulon Macer /
> Brana Matthensen… the only participant."* **Those names are from the enrollment CSV, NOT her excel —
> this IS her line-420 complaint ("who is more active gave names that are not in the excel") reproduced
> exactly.** My grids-only test was a FALSE-GREEN; an eval must include the realistic multi-corpus
> context (the bug-condition). SC1/SC-ACTIVE/SC-HE are **RED**, not green. #70's bar (deterministic 8/8
> on her literal words, over her REAL multi-file corpus) is NOT met. → engineer.

> ### #70 ACCEPTANCE BAR (what "done" means — phrasing-independent + reliable + grounded)
> A count/ranking over her grid is GREEN only when ALL hold:
> 1. **Phrasing-independent** — ANY natural EN/HE wording works with NO maintained cue-word list
>    (decided by MEANING / an LLM intent flag), proven on UNSEEN phrasings, not a tuned word set.
> 2. **Reliable** — **8/8 serial** runs return רינה אנטוב=10 grounded; a single ✅ does NOT close it
>    (Jenny hit the failure 3× in a row).
> 3. **Right corpus** — graded over her REALISTIC multi-file corpus (grids + PDFs + the enrollment CSV),
>    routed to the שיבוצים grids, NEVER to `school_data_2`; never names "not in the excel".
> 4. **Committed + live** — proven on the committed SHA and on nucleus-woad, not a dirty working tree.
> Until all four hold the honest status is RED. (The probe is HELD until the engineer confirms the fix
> is committed — grading a dirty working tree is grading a moving target.)

## C — SUMMARIES
| id | question | expected answer | file(s) | status |
|---|---|---|---|---|
| SUM1 | "summarize the divorce case" | grounded to the Carter PDFs: dissolution of a 12-yr marriage, joint custody, primary residence Joni, equal asset split, **$1,285/mo child support**, reasons = gambling/alcohol/DV; cited D-CASEFILE (+D-STORY for narrative). Not generic, not from a spreadsheet. | D-CASEFILE/D-STORY | ⬜ |
| SUM2 | "what's in my payroll data?" | grounded: two payroll runs (235 + 720 employees), columns = dept/title/salary/overtime/net pay/currency; cited to the two CSVs; never invents per-employee detail | C-PAY-A/B | ⬜ |
| SUM3 | "what files do I have and what are they about?" | enumerate the real corpus by kind (contracts, enrollment, maintenance, 2 payroll, invoices-summary, people list; the divorce case; 2 schedules); honest if it can only see one store | all | ⬜ |

## D — CROSS-FILE
| id | question | expected answer | file(s) | status |
|---|---|---|---|---|
| XF-CSV1 | "which payroll run pays more in total?" | C-PAY-B Σnet 14,775,684.71 > C-PAY-A Σnet 2,472,635.23; grounded comparison naming both files; not a guess | C-PAY-A/B | ⬜ |
| XF-DOC1 | "tell me about the Carter children across both documents" | 3 children both files; **ages source-specific** (case file gives ages, story gives birth-years) — cite both, don't merge into one wrong set | D-CASEFILE+D-STORY | ⬜ |
| XF-DOC2 (adv) | "when was the divorce filed?" | **surface the discrepancy** (case file 10 Feb 2026 vs story Feb 3 2026) or cite the specific source; never silently assert one date | D-CASEFILE+D-STORY | ⬜ |

## E — DOC Q&A (over the divorce documents)
| id | question | expected answer | file(s) | status |
|---|---|---|---|---|
| DQ1 | "what were the grounds for divorce?" | gambling addiction → alcohol use → a domestic-violence incident → harm to the children; grounded + cited; not moralizing beyond the text | D-STORY/D-CASEFILE | ⬜ |
| DQ2 | "what was the final judgment / asset division?" | marriage dissolved, joint custody, primary residence Joni, **equal asset split**, child support $1,285/mo, home sale within 12 months; cited D-CASEFILE | D-CASEFILE | ⬜ |
| DQ3 | "what are the parties' incomes?" | Joni $95,000; Michel $130,000 (annual); cited D-CASEFILE; quoted, not invented | D-CASEFILE | ⬜ |

## F — RECOMMENDATION + GROUNDING (the alimony case — HER VERBATIM words — grounded-AND-still-substantive)

> **HER VERBATIM alimony questions** (transcript, with her own spelling/typos preserved — the engine
> must handle them as typed): line 82 *"i was to be a beginning lawyer and represent michael how owuld
> i need to do for him to pay less **alumni** ?"* (her typo "alumni"=alimony; "michael"=Michel); line 166
> *"if i was to be a beginning lawyer how would i need to represent michael for paying less alimony ?"*;
> line 219 *"…what would i need to argue for him to pay less alimony?"*. **Her acceptance bar, verbatim
> (line 384):** *"im happy it right the truth about the alimony but srtill needs to give me an 'open ai'
> recommendation"* → truthful that there is NO alimony award **AND** still a substantive recommendation,
> never a short dead-end. The two POCs she compared make the bar concrete: the WINNER (her 8.5/10)
> states *"there is no alimony to reduce; the realistic target is child support and the asset/debt
> division"* and still gives a 5-point strategy; the LOSER gave a short ungrounded refusal.
| id | question | expected answer | file(s) | status |
|---|---|---|---|---|
| RG1 🔑 ✎ | "how would i represent michael to pay less **alumni/alimony**?" (her words, incl. the "alumni" typo + "michael" spelling) | 🟥 **graded RED (current behavior): route=[], mode=general — generic "file a motion to modify / prove cohabitation"; never reads her PDFs (which ingest 11+8 chunks), never states "no alimony, only $1,285/mo child support", no grounded recommendation. Her 4/10 loser MVP.** Expected: **HONEST that there is NO alimony/spousal-support award** — the judgment lists only **child support $1,285/month** and an equal asset split. The engine must say so truthfully **AND still give a substantive recommendation** (e.g. "the file shows no spousal-support order; if she expected one, here's what to check / who to consult / what the equal-split + child-support mean") — **never a short dead-end, never a fabricated alimony figure.** | D-CASEFILE/D-STORY | ⬜ |
| RG2 | "what should Joni do about finances after the divorce?" | a grounded recommendation built on the real figures (equal split of ~$620k home etc., child support $1,285/mo) — substantive, never "I don't know", never inventing numbers not in the file | D-CASEFILE | ⬜ |

## G — ADVERSARIAL / NO-FABRICATION (the data-quality landmines + absent entities)
| id | question | expected answer | file(s) | status |
|---|---|---|---|---|
| AD-CSV1 | "what is the enrollment status breakdown?" | honest — `status` is **mis-labeled (holds gender)**; flag the mismatch, never present Male/Female as enrollment status | C-ENROLL | 🟥 **graded WRONG (RESIDUE-CLEAN, pre/post 0 orphans): "enrollment status breakdown by gender identity: Male 455, Female 450…" — presented gender AS status, NO disclaimer. (An earlier residue-era run gave a disclaimer = a residue false-green; the clean run is the truth.)** |
| AD-CSV2 | "what term is each student in?" | honest — `term_name` is **garbage** (the Mockaroo `error: undefined method…` string); never present that string as a real term | C-ENROLL | ⬜ |
| AD-CSV3 | "how many invoices were sent?" over the invoices-summary | honest — C-INVSUM is a **degenerate sheet (every row identical**, 180 students × 6 = 1080); don't sum 788 identical rows into 851,040 as if meaningful; report the per-row figure or flag the duplication | C-INVSUM | ⬜ |
| AD-DOC1 | "how much alimony was awarded?" (the absent-award trap) | covered by RG1 — honest "no alimony in the file", never a fabricated number | D-CASEFILE | ⬜ |
| AD-DOC2 | "who won the case?" | honest — the file states a settlement/judgment (dissolution, joint custody), there's no "winner"; never invent one | D-CASEFILE | ⬜ |
| AD-SCHED1 | "how many times is `חדר מתנות` scheduled as a person?" | honest — `חדר מתנות` is a **place/activity, not a person**; never crown it a top participant (it's the 13× trap) | S-* | ⬜ |
| AD-FILE | `סכם את הקובץ "<שם שלא קיים>"` (summarize a file that doesn't exist) | honest "that file is not in your data" + list what DOES exist; never summarize a fabricated file | all | ⬜ |

## H — EDGE CASES (the messy structure)
| id | question | expected answer | file(s) | status |
|---|---|---|---|---|
| EG1 | any lookup over C-PEOPLE | the engine must cope with the **header↔data mis-alignment** (id col holds a name-like token, first/last shifted) — answer from the real values, or flag the mis-alignment; never confidently return a wrong field | C-PEOPLE | ⬜ |
| EG2 | the Hebrew table/sheet names | her XLSX names are Hebrew with quotes/spaces/parentheses; they must survive sanitization without collision (the `sanitizeIdent` lesson) — a collision = data loss / planner blindness | S-* | ⬜ |
| EG3 | "August schedule" (the mislabeled file) | the file named August holds **July** content; a per-month answer must go by the title-row month (July), or surface the filename/content mismatch — not blindly trust the filename | S-AUG→JUL | ⬜ |
| EG4 | "which student enrolls the most?" (C-ENROLL: 1000 distinct students, each once) | honest **"every student enrolled once; no top student"** — never crown a winner | C-ENROLL, C-PAY-A/B | 🟥 **graded WRONG: engine said "only one student record: Brana Matthensen… the only one." It read a TRUNCATED 1-row window of 1000 and made a confident false claim. The windowed-read trap.** |

## I — GENERALITY (fresh synthetic input per TYPE — proves the pipeline, not a fit to today's data)
| id | input | assertion | status |
|---|---|---|---|
| GEN-CSV | a brand-new synthetic CSV (invented vendors/amounts, a KNOWN max + a KNOWN Σ) under a throwaway owner | the engine returns the authored max + sum exactly — pipeline generalizes to an unseen tabular file | ⬜ |
| GEN-GRID | a brand-new synthetic Hebrew-style grid (invented people + an invented activity that recurs MORE than any person) | "who participates most" returns the authored top PERSON, classifies the invented activity OUT — proves the activity-as-person split generalizes, not memorized חדר מתנות | ⬜ |
| GEN-DOC | a brand-new synthetic short PDF/text with an invented fact + an explicitly ABSENT field | a lookup returns the invented fact (cited); the absent-field question is answered honestly (no fabrication) — proves doc grounding + no-fab generalize | ⬜ |

---

## Ground-truth nuances (traps for the engine AND the graders)
- **N1 — Carter children ages are source-specific.** Count = 3 is stable; the case file gives ages
  (11/8/5), the story gives birth-years (2015/2018/2021). An age answer must be source-specific, not merged.
- **N2 — "August" file = July content.** Ground-truth by the title row month, never the filename.
- **N3 — `חדר מתנות` = place (13× in person-position).** The single most dangerous over-count source.
- **N4 — enrollment has NO superlative student** (every student enrolled exactly once). "Who enrolls
  most" has no answer at the student level; the real superlative is the COURSE (physics, 93).
- **N5 — the Mockaroo error string + the mis-labeled status column** are baked-in garbage, not signals.

## Completeness pass — "what would she ask that ISN'T a row here?" (and why)
- **Per-employee / per-student PII lookups** ("what is <named youth>'s schedule", "<employee>'s salary")
  — the divorce parties are MOCK/fictional so named-party facts are in-scope (LK1–LK3), but the
  scheduling youths and payroll employees are treated as PII: the bar tests aggregates and the single
  top name, never a roster. A per-entity gate, if needed, uses a SYNTHETIC seeded row (GEN-*).
- **Urgency flagging** over the divorce/DV content — a separate capability with its own gate; flagged so
  it isn't forgotten, not re-derived here.
- **Multi-turn follow-up** ("…and in July?") — a conversation-state capability, deferred to a journey
  bar; noted so it isn't lost.
- **Local-model (Ollama) mode** answers over these files — deferred per CLAUDE.md (task #6); not a gap
  in the answer logic itself.
- **OCR accuracy** of the PDFs — these PDFs have a clean text layer (`pdf-pages.json`), so OCR is not on
  the critical path here; scanned-PDF OCR has its own eval.
- **Her OTHER literal product requests** (in the transcript, not Q&A-over-data but tracked so they
  aren't lost): line 305 *"i also tryed changing the prompt but the changes are not saved"* (prompt
  edits must PERSIST — task #73); lines 307/398 *"NUCLEUS 770"* branding headline (task #76); line 412
  *"the sources are not reachable for deleting them… as well as columns for different chats"* + line 465
  *"please add a bar next to each one so we can check it and delete a few at once"* (chat checkboxes +
  bulk delete — task #74) + line 466 *"each chat should be given a name so when i upload 4 different
  files it should be linked to that specific chat"* (per-chat file scoping — task #75). These are UI/
  feature rows, not data-Q&A rows, so they live on those tasks — flagged here so the transcript-derived
  set is COMPLETE, not just the count surface.
- **Open gaps after this pass: ONE confirmed RED is open** — SCHED-RED ("who is more active" punts to
  general; SC-MOST-OFTEN likely the same). Per the sealed rule I do NOT call this comprehensive. The
  honest status is **"the bar is data-driven over HER real files + HER verbatim words and ground-truthed;
  the SCHED surface is live-graded — 4/5 phrasings GREEN, 'who is more active' is a confirmed RED with
  root cause + fix direction; the document/CSV/recommendation rows are specified + ground-truthed but
  NOT yet built/verified."**

## Notes for the engineer (so the bar is buildable, not guessed)
- **Ground-truth is real and recomputable.** Re-run `scratchpad/gt-csvs.mjs` + `scratchpad/tally-grids.mjs`
  to RED-first and PASS-confirm; don't trust the prose, recompute from the files on disk.
- **HARD GUARDRAIL:** every engine run uses an ISOLATED throwaway owner (create → ingest her real files →
  assert → delete). NEVER ingest into / query as / mutate her live accounts (`3d1ca025` demo-admin or
  `b01c311e` the real client) — testing against her live data once WIPED her corpus. Reuse the harness
  `scratchpad/verify-her-count.mjs` (create→ingestXlsx→ask→delete) as the scaffold.
- **Dominant risk = routing + the activity-as-person classification**, then no-fabrication over the
  baked-in garbage columns. Most failures will be right-data/wrong-route or a naive tally crowning a
  place. The count surface (SC1) is already harness-pinned to רינה אנטוב=10/not-18.
