# Golden Bar — Nucleus AI Business Assistant (Phase 1)
### 13 acceptance criteria (+2 added capabilities) · real files · exact expected citations

**Companion to:** [PRD.md](PRD.md) (§5 references this document) · **Status:** the acceptance bar the verifier enforces

> Criteria **#1–#13** are the client's contracted acceptance criteria (numbered exactly as in `clientchat.md`). **#G** (admin-configurable urgency classification) and **#H** (admin user management: provision / active users / revoke) are net-new platform capabilities the client added; they're lettered, not numbered, so the contracted 13 keep their numbers. **#8** is sharpened to require Hebrew-language **output** (not just Hebrew input).

> Every example below uses the client's **real on-disk files** (`/home/codex/Projects/Contract-Retriever-RAG/data/`). Numbers and pages are **verified** against the raw CSVs/PDFs (commands run during design). Reference "today" = **2026-06-09** (the demo's `ASSISTANT_TODAY`). A verifier must be able to **FAIL** a toy/wrong build against each. Citation format: `[S:<table>#<rowkey>]` for structured, `[P:<doc>#<printed-page>]` for documents.
>
> **The page gotcha:** the court PDF has 7 *physical* pages but printed "PAGE N" labels to 24; the Final Judgment is printed **PAGE 24** (physical page 6) — citations must resolve to the retrieved chunk regardless.
>
> **Data sensitivity:** the client's real domains are **hospital + legal (HIPAA/PHI + legal privilege)**. **Every golden here runs on MOCK/sample data only** (the provided `data/` files) with the **free dev Gemini key** — **never real PHI**. Real-PHI production is the client's compliant deploy-time choice (Azure/Vertex under a HIPAA BAA, or fully local Ollama so data never leaves her infrastructure) — see [PRD.md](PRD.md) §0.1 and [HANDOFF.md](HANDOFF.md).

---

## #1 — PDF retrieval (Case File Q&A)
- **Q:** "What was the final child support amount, and who got primary residence?"
- **Expected answer:** **$1,285/month**; **primary residence to Joni Carter** (joint legal custody).
- **Exact citations:** `[P:FAMILY-COURT-CASE-FILE#24]` (Final Judgment). Both facts trace to the same Final Judgment block.
- **Fails a toy build if:** it returns an uncited number, a number not equal to $1,285, or cites the wrong page.

## #2 — OCR document retrieval
- **Setup:** ingest a **scanned/image** version of the Carter Final Judgment page (rasterized) through the OCR path.
- **Q:** "What did the court order for child support?" → **$1,285/month**, cited to the **OCR'd page** with page preserved.
- **Fails if:** OCR text isn't searchable, or the citation loses the source page.

## #3 — Excel retrieval
- **Setup:** convert `school data 3.csv` (maintenance) to `.xlsx` and ingest via the Excel path.
- **Q:** "What was our total maintenance spend, and how much in 2026?"
- **Expected:** **$40,597.00 across 750 tickets** all-time; **$13,485.66 across 248 tickets** in 2026 — cited to **Excel rows** (top contributors drillable).
- **Fails if:** totals differ, or citations don't resolve to specific spreadsheet rows.

## #4 — SQLite retrieval (Contract Intelligence)
- **Q:** "What contracts expire in the next 90 days, and what's their combined annual value?"
- **Expected:** **38 contracts** expiring in (2026-06-09, 2026-09-07], **combined annual value $18,924,883.79**, each row cited (e.g. *Zoombeat — Automation Specialist IV — End 6/21/2026 — $428,720.60* → `[S:contracts#<id>]`).
- **Plus honest data note:** the `Contract ID` column actually holds **job titles**, and **285 rows have End < Start** — surfaced, not silently cleaned.
- **Fails if:** the count/value is fabricated or uncited, or it invents penalty terms (there is no penalty column).

## #5 — Hybrid SQL + PDF retrieval ⭐ (the client's headline request)
- **Q (her exact example):** *"Which customers have overdue payments and what does the agreement say about service suspension?"*
- **Honest reality on the supplied data:** the maintenance table has **no payment-status/due-date field** and there is **no service-agreement document** — so the literal question is met by **honest refusal + schema citation** (this is itself a golden: see #10b). **To demonstrate the dual-citation hybrid the client asked to *see*** (router picking *both* sources, citations from DB *and* document in one answer), the build must run it on a corpus that supports it. **Two acceptable paths — client picks one:**
  - **(a)** Ingest a **real contract PDF + a contracts/receivables table that share a vendor key** (e.g. a client-supplied vendor agreement + an AR table), so the answer reads e.g. *"Vendor Oyoba has an overdue balance of $X `[S:receivables#12]`; the agreement permits suspension after 30 days past due `[P:vendor-agreement#4]`"* — **two citations, two namespaces, one answer, no invented join.**
  - **(b)** A **constructed-but-real** demo corpus (a synthesized AR table + a synthesized service agreement PDF, page-numbered) wired through the real engine.
- **Exact-citation bar (whichever path):** the single answer must carry **≥1 `[S:...]` and ≥1 `[P:...]`**, the routing panel must show **both** sources selected, and the two domains must **not** be merged on a fabricated join.
- **Fails a toy build if:** it answers from only one source, fabricates an overdue list on the maintenance data, or invents a join between the school data and the Carter case file.

## #6 — Hybrid Excel + PDF retrieval
- **Q:** "Summarize 2026 maintenance spend and cite any contract clause about maintenance scope."
- **Expected:** **$13,485.66 (2026)** from the **Excel** source `[S/Excel:...]` + the relevant clause from a **PDF** `[P:...]` — dual citation, same composition discipline as #5.
- **Fails if:** only one source fires, or citations don't span both.

## #7 — API integration example
- **Setup:** register one **real** connector (e.g. a live public API or a mock CRM endpoint) in the connector framework.
- **Q:** a question that routes to the API → answer cites the **API result** as a resolvable source (`[API:<connector>#<record>]`), routing panel shows the API source selected.
- **Fails if:** the "API" is hardcoded, or the result isn't citable/traceable.

## #8 — Hebrew Q&A (incl. cross-lingual) ⭐
- **The requirement (client re-emphasized):** the assistant must **answer IN Hebrew**, not merely accept Hebrew input. The output language matches the question's language, and citations are preserved across the language boundary.
- **Cross-lingual golden (the client's explicit hard case):** the Carter Final Judgment is **English**; ask in **Hebrew**: *"מה גובה דמי המזונות שנפסקו ולמי ניתנה המשמורת העיקרית?"* ("What child-support amount was awarded and who got primary custody?")
- **Expected:** the answer is **written in Hebrew** — child support **1,285 לחודש** ($1,285/month); **משמורת עיקרית לג'וני קרטר** (primary residence Joni Carter) — **with the citation preserved**: `[P:FAMILY-COURT-CASE-FILE#24]`.
- **Fails a toy build if:** it can't answer a Hebrew question over an English doc, **answers in English when asked in Hebrew** (input accepted but output in the wrong language), or drops the citation. (This is the single most technically uncertain criterion — see [PRD.md](PRD.md) §7.)

## #9 — Local LLM operation
- **Setup:** switch the model selector to a **local** model (Ollama: Llama/Qwen/Mistral); re-run the #4 contract-expiry golden.
- **Expected:** the **same grounded, cited** answer (**38 / $18,924,883.79**) produced by the **local** model — proving the abstraction layer swaps models without re-architecting.
- **Fails if:** local mode falls back to the cloud model, or produces an uncited/wrong answer.

## #10 — Citation validation (two sub-goldens)
- **10a (positive):** the #1 answer passes `validateAnswer()` — every citation resolves to retrieved evidence; confidence score present.
- **10b (the honest-refusal negative — the trust property):** Q = *"Which customers have overdue payments and what does the agreement say about service suspension?"* on the **maintenance data** → the system **refuses honestly**: "This data has no payment-status or due-date field and no service-agreement document, so I can't determine overdue payments," **cites the schema as evidence**, and **pivots to the real spend analysis it can do**. A fabricated overdue list must be **rejected**, not shown.
- **Fails if:** an uncited factual claim ships, or the refusal is replaced by invention.

## #11 — Retrieval trace inspection
- **For the #5 hybrid answer**, the UI trace panel must show: the **route decision + rationale**, the **SQL** run (or intent + params), the **retrieved chunks with page numbers**, the **citations**, and the **validation result + confidence**.
- **Fails if:** any of these is missing or not tied to the actual answer shown.

## #12 — Grading prompt evaluation workflow
- **Setup:** run the LLM-as-judge over a fixed set including the #1, #4, #5, #8 goldens.
- **Expected:** per-answer graded scores for **answer quality, citation quality, retrieval quality, grounding, hallucination risk**, surfaced in the eval dashboard; the honest-refusal (#10b) scores **high** on grounding/low on hallucination (refusing correctly is good).
- **Fails if:** grades are hardcoded, or the dashboard doesn't reflect real eval runs.

## #13 — E2E deployment from client-owned repo (client self-hosts)
- **Deployment model:** the **contractor hosts only a portfolio demo**; the **client self-hosts** the owned repo on **her own cloud**, with **her own Azure OpenAI key via env**.
- **Expected:** following only the [HANDOFF.md](HANDOFF.md) doc, `git clone <client repo>` → copy `.env.example` → `.env` → set **her Azure key/endpoint/deployment** → `docker compose up` → the app boots, the index builds, and the **#1 + #4 + #5 goldens pass against the deployed instance**. The repo is the **client's**; [HANDOFF.md](HANDOFF.md) + architecture + env-setup docs are present and written for a **non-technical owner to hand to her own engineer** (clone → set env → run → operate). The handoff doc presents the **compliance deployment options** for real PHI (Azure/Vertex under a HIPAA BAA, or fully local Ollama) as **one env-var swap**, with **no provider baked in**.
- **Fails if:** it only runs on the contractor's machine, requires Vercel, the repo isn't the client's, the Azure key is hardcoded rather than env-supplied, a single cloud provider is hardwired (no model-abstraction swap), or a non-technical owner couldn't stand it up — or pick a compliant PHI path — from the handoff doc alone.

## #G — Urgency classification at ingestion (admin-configurable prompt) ⭐ NEW
- **Capability:** at ingestion each document is classified for urgency by an **admin-editable prompt** — edited in the **prompt-management admin UI** (a named visible surface that holds the **system prompt** *and* this **urgency-classification prompt**) — stored as document metadata (urgency + the determining rationale), and shown as a color badge (green/amber/red) in the documents table, making the Nucleus dashboard's existing urgency column **real and configurable**. Ties to the spec's **Prompt Management** section.
- **Setup:** as admin, set an urgency prompt, e.g. *"Classify urgency High/Medium/Low: legal filings with imminent court deadlines or final judgments are High; routine records are Low. Give a one-line rationale."*
- **Q / action:** ingest `📄 FAMILY COURT CASE FILE (MOCK) – FINAL VERSION.pdf`.
- **Expected:** the document is flagged **High → red badge**, with a **stored rationale that cites the determining content** (e.g. "contains a Final Judgment / dissolution order on PAGE 24"). The rationale is grounded in the document, not invented.
- **Re-derivation:** change the prompt (e.g. *"only documents filed in the last 7 days are High; everything else Low"*) and re-run → the **same document's urgency re-derives** (now Low/green, since Filed 10 Feb 2026 is outside the window) with an updated rationale.
- **Fails a toy build if:** urgency is a hardcoded/static field (as in today's mock), ignores the admin prompt, doesn't change when the prompt changes, or the rationale isn't grounded in the document's actual content.

## #H — Admin user management: provision, see active users, revoke ⭐ NEW
- **Capability:** the admin (Jenny) **provisions user accounts**, **sees who is actively using the app** (active users / live sessions), and can **revoke ("kick out") any user at any time** — deactivating a user **cuts their access and invalidates their sessions**. Ties to the spec's **User Management** + **Admin Features** sections. (Role-*ready*; per-source role enforcement is Phase-2.)
- **Setup:** as admin, create a user `alice@client.test`; Alice logs in and is shown in the admin's **active-users** view with a live session.
- **Action:** the admin **deactivates / revokes** Alice.
- **Expected:** Alice's **existing session is invalidated immediately** (her next request is rejected / she's signed out) **and** she **can no longer log in** with those credentials; the admin's active-users view no longer shows her as active. A re-activated user can log in again.
- **Fails a toy build if:** the admin can't actually create users, the active-users view is static/mock (today's UI shows a single hardcoded user), revoke only hides the row in the UI but the user can still log in or their session keeps working, or deactivation isn't enforced server-side on the next request.

---

## Honest risk / feasibility (from [PRD.md](PRD.md) §7, reproduced here)

| Risk | Reality | Mitigation |
|---|---|---|
| **#5 hybrid not answerable on supplied data** | The maintenance CSV has no overdue/payment field; no service-agreement PDF exists. The literal example **cannot** be answered truthfully from what was provided. | **Decision needed from client:** supply a real contract+AR pair (5a) or accept a constructed-but-real demo corpus (5b). The *honest refusal* (#10b) ships regardless — it's a feature, not a gap. |
| **#8 Hebrew cross-lingual quality** | Multilingual embeddings make retrieval work; **generation quality** in Hebrew on Azure OpenAI is good but **untested here**, and citation-preservation across languages needs hardening. Highest technical uncertainty. | Hebrew fixtures + a generation prompt that forces citation copy-through; verify on the real EN-doc/HE-question golden before claiming done. |
| **#2 OCR quality** | OCR on a clean rasterized page is reliable; messy scans degrade. | Tesseract + page-preserving citations; scope the golden to a clean scan; flag low-confidence OCR. |
| **#9 local-LLM answer quality** | Small local models (Llama/Qwen/Mistral 7–8B) follow the strict cite-every-claim instruction **less reliably** than Azure OpenAI; `validateAnswer()` will reject more often. | Set expectation: local is the *paid, capable-but-lower-fidelity* option; the abstraction layer is what's graded, not parity with cloud. |
| **#7 API example** | A "real CRM/QuickBooks" integration is out of Phase-1 scope; an illustrative connector is in. | One real public API or mock-CRM connector, clearly labeled as the extensible-architecture proof. |
| **Scope vs. budget** | The contract enumerates a platform that, at market rates, is a multi-week senior build. The posted Upwork figures (Est. $200, funded $65, Milestone-1 only) are **wildly below** that scope. This is a fixed reality to name, not solve here. | Flag to the lead/client: either phase the *billing* to match the 3-phase delivery the spec itself describes, or right-size Phase-1 scope. The engineering plan is correct regardless; the commercial terms are a separate conversation the contractor must have. |

---

## Provenance — how the load-bearing numbers were verified

Each figure below was computed/extracted directly from the real files during design (not copied from the demo docs):

- **Contracts (#4):** `school data 1.csv` (1000 rows) — **38** contracts with End Date in (2026-06-09, 2026-09-07], combined Annual Cost **$18,924,883.79**; **285** rows have End < Start; `Contract ID` column holds job titles, not IDs.
- **Maintenance (#3, #6, #10b):** `school data 3.csv` (750 rows) — all-time Total Cost **$40,597.00 / 750 tickets**; 2026 **$13,485.66 / 248 tickets**; top vendor **Oyoba $949.94**. Columns: `Ticket ID, Vendor, Invoice, Labor Cost, Parts Cost, Total Cost, Completion Date` — **no payment-status/due-date field** (the basis for #5/#10b honest refusal).
- **Case file (#1, #2, #8):** `📄 FAMILY COURT CASE FILE (MOCK) – FINAL VERSION.pdf` — 7 physical pages, printed labels to PAGE 24. Final Judgment (printed **PAGE 24**, physical page 6): marriage dissolved, **joint custody**, **primary residence Joni Carter**, **child support $1,285/month**. Cover sheet (printed PAGE 1) Filed: **10 February 2026**.
- **Filing-date conflict:** the cover sheet reads "**10 February 2026**"; `story if the Carters .pdf` reads "**February 3**" — a real, surfaceable conflict present in both source files.
- **Urgency golden (#G):** uses the same court file — the determining content (a **Final Judgment / dissolution order** on printed PAGE 24) and the **Filed: 10 February 2026** date are both real and extracted above, so the High-urgency rationale and the prompt-change re-derivation (last-7-days → Low) are grounded in verified document content, not invented.
- **Deployment (#13):** today's demo deploys on **Vercel** (`Contract-Retriever-RAG`); this build re-targets **Docker + docker-compose**, a **client-owned repo**, and **client self-hosting** with **her own Azure key via env** — the contractor hosts only a portfolio demo.
