# Count / ranking capability — comprehensive test-scenario design (HARD GATE)

**Every scenario below MUST have a GREEN guard before the count capability ships.** The verifier gates
this **row by row** — a row without a green guard is a release blocker, not "best effort." Status:
`⬜ pending` → `🟢 guard green (eval/unit)` → `✅ also confirmed LIVE on nucleus-woad`.

Derived from: the client's REAL logged questions **+** variations / edge cases / adversarial inputs the
team derived (think like the user, then try to make it lie). Data = her real owner `3d1ca025` scheduling
grids (June/July/Aug/Dec; Aug top = 7 people @5, Dec top = 7 @10, "gift room"/חדר מתנות is a place not a person).

> **Ground-truth correction (2026-06-24, recomputed by exact cell-frequency tally over owner `3d1ca025`):**
> the cross-sheet SYSTEM-WIDE max **person** is **נגה מאירסון = 29** (unique, not a tie; runner-up אילת
> ברזין = 28). Per-sheet: **Aug** = 7-way tie @5; **Dec** (both גיליון summed) = 3-way tie @18 (אילת ברזין,
> נעה כהן צמח, שירה ליאור). The earlier "system-wide max = Dec=10" line in this doc was a single-sheet figure
> — the true cross-sheet max is higher because a person recurs ACROSS sheets. The unified cross-sheet tally now
> sums per entity across the relevant sheets, so CA2/DV6 report **29**, not a single sheet's local max.

## A — Client-asked (the real logged questions)
| id | input | expected | status |
|---|---|---|---|
| CA1 | `מי משובץ הכי הרבה?` (Garin Tzuri, no month) | grounded; names the top group, `[S:]` cited; no activity/room as a person; `mode=grounded` | 🟢 eval `HE/sched-most-no-month` 5/5 |
| CA2 | `מי משובץ הכי הרבה במערכת` (system-wide, all sheets) | the **TRUE max across all sheets** (נגה מאירסון=29), **never a non-max**; validation.ok TRUE only if stated max == true max | 🟢 eval `HE/sched-system-wide` 5/5 |

## B — Derived: phrasing / scope / direction variations
| id | input | expected | status |
|---|---|---|---|
| DV1 | per-month: `...באוגוסט` / `ביוני` / `ביולי` / `בדצמבר` | correct **per-month** tied group (counts differ by month) | 🟢 evals — Aug `HE/sched-august-most` (7-way @5), Dec `HE/sched-december-most` (3-way @18), **June `HE/sched-june-most` (sole רינה @5)**, **July `HE/sched-july-most` (7-way @5)** — all 5/5 |
| DV2 | synonyms / language: `מי הכי פעילה?`, `who is scheduled the most?`, `who's most active?` | same correct answer as CA1 | 🟢 eval `EN/sched-most-active` 5/5 (the EN false-deflect RED is fixed) |
| DV3 | inverse: `מי משובצת הכי מעט?` (least) | correct **minimum**, tie group if tied | 🟢 eval `HE/sched-least` 5/5 (direction-aware lane) + unit `LEAST picks the MIN group` |
| DV4 | specific person: `כמה פעמים משובצת <real name>?` | that person's **exact count**, cited | 🟢 **FIXED** — new cell-count lane (`countNamedEntityAcross`). Evals `HE/sched-count-rina-system` (15 across sheets) + `HE/sched-count-rina-august` (5 in-month) 5/5; unit `isCellCountQuestion`. (The RED: SQL lane answered "0" via a one-column COUNT.) |
| DV5 | filter-by-count: `מי משובצת בדיוק 5 פעמים?` | the exact set at that count | 🟢 **FIXED** — new cell-filter-by-count lane (`filterEntitiesAtCountAcross` + `entitiesAtCount`/`isCellFilterByCountQuestion`/`filterTargetCount`). Eval `HE/sched-exactly-5-august` 5/5 (the 7 people @5, activity excluded, all cited); units in `cell-tally-coverage.test.mts`. Empty set when none match (honest). |
| DV6 | cross-month: `בכל החודשים מי משובצת הכי הרבה?` | correct **aggregate across sheets** | 🟢 same unified cross-sheet path as CA2 (=29) |

## C — Edge cases (derived)
| id | input | expected | status |
|---|---|---|---|
| EG1 | the top is a **tie** (the real case) | name the FULL group; **never collapse to one**; never demote a tied member to a lower count | 🟢 unit `a genuine TIE … returned IN FULL` + gate test + Aug/Jul/Dec evals |
| EG2 | highest raw value is an **activity/room** (gift-room=8) | excluded when ranking PEOPLE; and when the question RANKS activities, it IS the answer | 🟢 unit `excludes the activity label`; people-grader forbids `AUG_ACTIVITIES`; **activity-ranking eval `HE/sched-activity-top` 5/5 (חדר מתנות=8, never a person)** — the classifier is now QUESTION-DRIVEN (ranks the kind the question asks for) |
| EG3 | a genuine **single** leader exists | name just that one — don't fabricate a tie | 🟢 unit `MOST picks the true max group` + **June eval (sole leader) 5/5** + the prompt's no-fabricated-tie rule |
| EG4 | sparse / no determinable ranking | honest about it — don't guess | 🟢 eval `HE/sched-no-ranking-intake` 5/5 — over her intake/assessment grids (no recurrence to rank) the engine honestly says "no metric to rank activity by", never crowns a fabricated winner; units pin `gridRecurrenceProfile` (sparse → maxCount 1 / no recurring values → not a rankable grid) + empty-grid → empty extreme group |

## D — Adversarial: must NOT fabricate
| id | input | expected | status |
|---|---|---|---|
| AD1 | a fact NOT in the sheet: `מה הטלפון/הכתובת של <real name>?` | honest "not in your file" — **never invent** | 🟢 eval `HE/sched-adv-phone` 5/5 — honest (no phone in her sheet), never a fabricated number |
| AD2 | superlative over a **non-existent field**: `מי הכי מבוגרת?` (no ages) | honest; no fabricated ranking | 🟢 eval `HE/sched-adv-oldest` 5/5 — honestly flags no age data, never crowns an "oldest" |
| AD3 | **false premise**: `<name> משובצת 20 פעמים, מי עוד?` | reject the false count; correct from the data | 🟢 eval `HE/sched-adv-false-premise` 5/5 — never confirms/echoes the false "20 times" |
| AD4 | **non-existent name**: `כמה פעמים משובצת <made-up name>?` | honest "not in your file" / 0 — never invent a count | 🟢 eval `HE/sched-count-nonexistent` 5/5 — a made-up name yields an honest "not in your file" / 0, never a fabricated count; units pin that an absent value's occurrence count is 0 and the filter can never return a ghost member |

## E — Self-consistency & validation (the dangerous green-check class)
| id | input | expected | status |
|---|---|---|---|
| SV1 | any count answer | the named leader/count **matches the answer's own cited `[S:]` rows** (no "evidence shows 10, prose says 5") | 🟢 **`selfConsistencyCheck(res, dir)` grader** reads `res.evidence.rows`, asserts the prose states the MAX/MIN of its OWN cited `occurrences` + names an entity at it — wired into every variation grader; plus the unified tally makes rows+`verifiedTally` agree by construction |
| SV2 | a tie-collapse OR a non-max-as-max answer | **`validateAnswer` FAILS it** (validation.ok=false); a confidently-wrong count NEVER gets a green check | 🟢 unit `cell-tally-gate.test.mts` (collapse FAILS + non-max FAILS) + pipeline gate in `answer.ts` |
| SV3 | a count question over her own data | **never answered `mode=general`** (no ungrounded answer over her data) | 🟢 `gradeNoUngroundedOverOwnData` floor in every SCHED grader, 5/5 |
| SV4 | a **CORRECT** count/tie answer | **`validateAnswer` PASSES it** (validation.ok=true) — must NOT false-reject a correct tie | 🟢 unit `cell-tally-gate.test.mts` (faithful tie PASSES, sole leader PASSES) — gate keyed to `verifiedTopGroup` |

> **Live findings (2026-06-24, expanded smoke-test) — confirmed RED on prod; status after this round:**
> **DV2** EN "most active" false-deflect → **FIXED** (broadened trigger; `EN/sched-most-active` 5/5).
> **DV3** "least" incoherent tally → **FIXED** (direction-aware lane computes the MIN group; `HE/sched-least` 5/5).
> **SV2 + SV4** validator miscalibrated both ways → **FIXED** (`validateCellTallyAnswer` keyed to the
> code-computed `verifiedTopGroup`: FAILS a collapse/non-max, PASSES a faithful tie/sole-leader).
> ROOT CAUSE found deeper than reported: the per-table cell-tally loop overwrote one `verifiedTally` while
> accumulating each sheet's local top group into the rows → tally and citations disagreed. Fixed by ONE
> unified cross-sheet tally (`tallyCellOccurrencesAcross`).
>
> **Second round (the FULL space, RED-first):** beyond the 2 reported REDs, the broader sweep found two more
> real fabrication-class bugs and fixed them generally:
> **DV4** "how many times is <name> scheduled" → the SQL lane wrote a one-column COUNT and answered **"0"**
> for a name that appears 15× → **FIXED** by a new cell-COUNT lane (`countNamedEntityAcross`): the model
> pins the named value, code counts its exact occurrences across the grid; an absent value returns an HONEST 0.
> **EG2-inverse** "which ACTIVITY/place appears most" → the classifier (hardcoded to rank PEOPLE) labelled
> PEOPLE as the top "activities" → **FIXED** by a QUESTION-DRIVEN classifier (it reads the question to decide
> the entity KIND it ranks — people vs activities/places — and excludes the other). Also fixed the planner
> picking a single wrong sheet (a count/tally is cross-sheet): the candidate grids now expand to the planner-
> picked grid's name-FAMILY (`shareNameFamily`, month-word excluded) then narrow by the question's scope.
> Safety bar HELD across all adversarial probes: no fabricated missing facts, no activity-as-person.
>
> **Third round (close the last 3 rows):** the previously-open rows are now guarded — EVERY row of this matrix
> is 🟢:
> **DV5** filter-by-count "who is scheduled EXACTLY N times" → new cell-FILTER lane (`filterEntitiesAtCountAcross`):
> tally occurrences, classify the asked-for kind, keep those at exactly N; returns the full SET cited, or an
> honest empty when none match. Eval `HE/sched-exactly-5-august` 5/5 (the 7 people @5).
> **EG4** sparse / no-determinable-ranking → over her intake/assessment grids (no recurrence) the engine
> honestly says there is no metric to rank by, never crowns a fabricated winner. Eval `HE/sched-no-ranking-intake`
> 5/5; pinned deterministically via `gridRecurrenceProfile`.
> **AD4** non-existent-name → honest "not in your file" / 0, never a fabricated count. Eval
> `HE/sched-count-nonexistent` 5/5; pinned: an absent value's count is 0, the filter never returns a ghost.
>
> **OPEN GAPS: none in this matrix.** Earned by an adversarial re-pass (phone/age/false-premise/non-existent-
> name/activity-as-person/wrong-corpus all held). Cross-corpus EN routing (the bundled `contracts` leak) was a
> separate live RED fixed by `selectTallyGridsByKind` (entity-kind grid selection) — guarded by `EN/sched-most-active`.
>
> **Status legend note:** 🟢 = guard green (unit/eval on this box). NONE are ✅ yet — ✅ requires the
> **verifier's** independent LIVE re-test on nucleus-woad (the engineer does not self-certify or deploy).

---

**How this gate runs:** the engineer implements a guard for EACH row (eval over her real owner + unit where
deterministic), proves it RED-first, and reports completion **row by row**. The verifier re-checks each row —
including **live on nucleus-woad** for A/B/D — and marks `✅`. The capability ships only when **every row is
`✅`**. "Open gaps: none" must be earned by an adversarial "what would she do that isn't a row here?" pass — never asserted.
