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
| DV1 | per-month: `...באוגוסט` / `ביוני` / `ביולי` / `בדצמבר` | correct **per-month** tied group (counts differ by month) | 🟢 evals `HE/sched-august-most` (Aug 7-way @5) + `HE/sched-december-most` (Dec 3-way @18) 5/5 |
| DV2 | synonyms / language: `מי הכי פעילה?`, `who is scheduled the most?`, `who's most active?` | same correct answer as CA1 | 🟢 eval `EN/sched-most-active` 5/5 (the EN false-deflect RED is fixed) |
| DV3 | inverse: `מי משובצת הכי מעט?` (least) | correct **minimum**, tie group if tied | 🟢 eval `HE/sched-least` 5/5 (direction-aware lane) + unit `LEAST picks the MIN group` |
| DV4 | specific person: `כמה פעמים משובצת <real name>?` | that person's **exact count**, cited | ⬜ (normal SQL lane, not cell-tally — not guarded this round) |
| DV5 | filter-by-count: `מי משובצת בדיוק 5 פעמים?` | the exact set at that count | ⬜ (not guarded this round) |
| DV6 | cross-month: `בכל החודשים מי משובצת הכי הרבה?` | correct **aggregate across sheets** | 🟢 same unified cross-sheet path as CA2 (=29) |

## C — Edge cases (derived)
| id | input | expected | status |
|---|---|---|---|
| EG1 | the top is a **tie** (the real case) | name the FULL group; **never collapse to one**; never demote a tied member to a lower count | 🟢 unit `a genuine TIE … returned IN FULL` + gate test + Aug/Dec evals |
| EG2 | highest raw value is an **activity/room** (gift-room=8) | excluded; never named as the "who" | 🟢 unit `excludes the activity label` + grader forbids `AUG_ACTIVITIES` |
| EG3 | a genuine **single** leader exists | name just that one — don't fabricate a tie | 🟢 unit `MOST picks the true max group` + prompt no-fabricated-tie rule (verified in repro) |
| EG4 | sparse / no determinable ranking | honest about it — don't guess | ⬜ (lane fail-soft → honest-limit floor exists; no dedicated guard this round) |

## D — Adversarial: must NOT fabricate
| id | input | expected | status |
|---|---|---|---|
| AD1 | a fact NOT in the sheet: `מה הטלפון/הכתובת של <real name>?` | honest "not in your file" — **never invent** | ⬜ (smoke-test held; no dedicated eval row added this round) |
| AD2 | superlative over a **non-existent field**: `מי הכי מבוגרת?` (no ages) | honest; no fabricated ranking | ⬜ (not guarded this round) |
| AD3 | **false premise**: `<name> משובצת 20 פעמים, מי עוד?` | reject the false count; correct from the data | ⬜ (not guarded this round) |
| AD4 | **non-existent name**: `כמה פעמים משובצת <made-up name>?` | honest "not in your file" / 0 — never invent a count | ⬜ (not guarded this round) |

## E — Self-consistency & validation (the dangerous green-check class)
| id | input | expected | status |
|---|---|---|---|
| SV1 | any count answer | the named leader/count **matches the answer's own cited `[S:]` rows** (no "evidence shows 10, prose says 5") | 🟢 the unified tally makes rows+`verifiedTally` agree by construction; the SV2 gate enforces stated==verified |
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
> Safety bar HELD across all adversarial probes: no fabricated missing facts, no activity-as-person.
>
> **Still ⬜ (NOT guarded this round — open gaps, honestly flagged):** DV4, DV5 (specific-person count /
> filter-by-count — these route through the normal SQL lane, not cell-tally), EG4 (sparse), AD1–AD4
> (adversarial — the prior smoke-test showed these HELD, but no dedicated regression row was added). These
> are the next slice, not closed.
>
> **Status legend note:** 🟢 = guard green (unit/eval on this box). NONE are ✅ yet — ✅ requires the
> **verifier's** independent LIVE re-test on nucleus-woad (the engineer does not self-certify or deploy).

---

**How this gate runs:** the engineer implements a guard for EACH row (eval over her real owner + unit where
deterministic), proves it RED-first, and reports completion **row by row**. The verifier re-checks each row —
including **live on nucleus-woad** for A/B/D — and marks `✅`. The capability ships only when **every row is
`✅`**. "Open gaps: none" must be earned by an adversarial "what would she do that isn't a row here?" pass — never asserted.
