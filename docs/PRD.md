# PRD — Nucleus AI Business Assistant (Phase 1)
### Source-grounded, hybrid SQL + RAG, self-hosted, client-owned

**Author:** PM · **Status:** For approval (design only — no code written) · **Client:** Jenny Parts · **Budget reality:** see §8

> The 13-criterion golden acceptance bar referenced throughout (§5) is maintained as a separate companion artifact: [golden-bar.md](golden-bar.md).

---

## 0. What this document is (and the one thing to decide first)

This is the design for the *real* Phase-1 build the client contracted — not the demo, and not a 20% slice. The Zoom session already happened; it was the sell. This build delivers all **13 acceptance criteria** against the client's **real files**, wrapping the **existing, proven Contract-Retriever-RAG engine** under the **existing polished Nucleus UI**, deployed Dockerized from a **client-owned GitHub repo** with **Azure OpenAI as the default model** and a **paid local-LLM option**.

**The decision the client must approve before any code (Phase-0 gate):**

| Phase-0 question | The honest answer this build commits to |
|---|---|
| **Visible outcome** | A logged-in user opens Nucleus, types a business question (EN or HE) and gets a **routed, grounded, cited** answer — every fact traceable to a real DB row or PDF page — **answered in the language asked** (a Hebrew question gets a Hebrew answer, citations preserved), with the routing decision and retrieval trace visible. At ingestion, each document is **auto-classified for urgency by an admin-configurable prompt** and shown with a color badge (green/amber/red). Admins manage sources, models, prompts (incl. the urgency prompt), and see an eval dashboard. |
| **Is the external system really wired up?** | **Yes.** Azure OpenAI is a **real** API call (default), called with **the client's own Azure key via env** on **her own cloud** (the contractor hosts only a portfolio demo; the client self-hosts the owned repo); local Ollama/Llama/Qwen/Mistral is a **real** swappable backend behind a model-abstraction layer. Today's Nucleus UI is **100% mock** (`src/lib/mock.ts` — the ask panel renders one hardcoded answer; the dashboard's urgency column is a static field); this project replaces that mock with the live engine and makes urgency a **real, prompt-derived** value. The Contract-Retriever-RAG engine is **already real** (real DeepSeek routing, real local embeddings, real SQLite + vector retrieval, real `validateAnswer()` gate). |
| **Honest label** | Phase 1 of 3. Single-tenant. **Two spec items cannot be answered from the data as supplied** and are met by *honest refusal* + a *re-supply path*, not fabrication (see §7). The "API integration example" is a real-but-illustrative connector, not a production CRM/QuickBooks integration. The deployment model is **client-self-hosted**: she clones, sets her env, and runs it — guided by a written handoff doc (§6, criterion #13). |
| **Out of scope (Phase 1)** | Production CRM/email/cloud-storage/ERP/case-management connectors (architecture-ready only); multi-tenant RBAC enforcement (role-*ready*, not role-*enforced*); RTL visual polish beyond correct Hebrew answers+citations; fine-tuned Hebrew generation prompts; billing/payment processing for the paid local-LLM tier (the *gate* exists; charging is later); contractor-hosted production hosting (the contractor hosts only a portfolio demo — the client self-hosts). |

### 0.1 Data Sensitivity & Compliance

The client's real domains are **hospital + legal** — i.e. **regulated data**: **HIPAA / PHI** (protected health information) and **legal privilege**. The architecture is built so this is the **client's deploy-time choice**, never a provider baked in by the contractor (the contract already mandates **no vendor lock-in**). The rules:

- **Demo + all testing use MOCK/sample data only** — the provided `data/` files (the mock Carter case file, the synthetic school CSVs) — run with the **free dev Gemini key**. **Never real PHI.** No real patient or privileged data touches the demo, the test fixtures, or the contractor's machine.
- **Production with real PHI is the client's compliant deployment**, selected via **one env-var swap** through the model-abstraction layer (no re-architecture):
  - **(a) Compliant cloud under a signed HIPAA BAA on her own account** — **Azure OpenAI** or **GCP Vertex AI**, with the **Business Associate Agreement** in place and her own keys/account. Data is processed under her BAA, not the contractor's.
  - **(b) Fully local / on-prem (Ollama)** — the **strongest privacy posture**: the local-LLM path means **data never leaves her infrastructure** — no external API call, nothing sent to any cloud provider. This is a core reason the spec mandates the **local-LLM + model-abstraction layer**, and it's the recommended posture where privilege/PHI sensitivity is highest.
- **No single cloud provider is baked in.** The model-abstraction layer keeps (a) and (b) — and a swap between Azure and Vertex — a configuration choice, satisfying the no-lock-in requirement and letting compliance drive the deployment.

The options + their tradeoffs are documented for her in [HANDOFF.md](HANDOFF.md) (§6) so the compliance decision is made knowingly at deploy time. **This PRD makes no compliance claim about the demo beyond "mock data only";** a real PHI deployment's BAA/DPA and security review are the client's to execute on her chosen path.

---

## 1. The full real-world workflow (mapped, not inferred)

The client is not building a PDF chatbot. The real workflow a business user runs:

1. **Onboard sources** — upload PDFs (native + scanned), CSV/Excel, point at a SQLite DB, register an API connector. The system **vets each source at intake** (the data-quality discipline) and reports what each can honestly answer. At ingestion, each document is **classified for urgency by an admin-configurable prompt** and stored with that urgency (+ the determining rationale) as document metadata, surfaced as a color badge (green/amber/red) in the documents table.
2. **Ask a free-form question** in English or Hebrew — facts, summary, analysis, comparison, or *recommendation grounded in a document* (the client's 17 Jun clarification: the system must still *answer* an advice-style question if the document supports it, and *say so* if it doesn't — not silently "no RAG identified").
3. **The router decides** which source(s) are relevant (SQL / document / spreadsheet / API / hybrid) and **shows its choice + rationale**.
4. **Hybrid retrieval** runs (vector + BM25 + metadata-filtered + entity-aware, cross-source).
5. **Grounded generation** composes an answer **only** from retrieved evidence, with an inline citation per claim.
6. **Validation** runs before delivery — citation verification, evidence consistency, confidence score; ungrounded/fabricated answers are **rejected**, not shown.
7. **The user sees** the answer, every citation (DB row / PDF page / OCR page / Excel row / API result), and can **inspect the trace** (route, SQL, chunks, validation result).
8. **History** persists (session / query / source).
9. **Admins** manage sources, documents, connectors, **select the model** (Azure default; local = paid), and read an **eval/grading dashboard** (LLM-as-judge over answer/citation/retrieval/grounding/hallucination quality). Two admin surfaces are named, visible deliverables:
   - **User management** — the admin **provisions user accounts**, **sees who is actively using the app** (active users / live sessions), and can **revoke ("kick out") a user at any time**: deactivating a user **cuts their access and invalidates their sessions** so they can no longer log in. (Role-*ready*; per-source role enforcement is Phase-2.)
   - **Prompt management** — an editable admin UI for the **system prompt** **and** the **per-document urgency-classification prompt** (the one that drives the document urgency badges, capability ＋ / golden #G); editing the urgency prompt **re-derives** document urgency.
10. **The whole thing is owned by the client** — their GitHub repo from day one, Dockerized, deployable to their cloud, with deployment/architecture/env docs.

"Complete" for Phase 1 = a user and an admin can do all of the above **for real**, demonstrated against the 13 criteria in [golden-bar.md](golden-bar.md). A 20% toy slice would be: one PDF, semantic search, one hardcoded answer, no routing, no validation, no admin, no Hebrew, no Docker. That is explicitly **not** this.

---

## 2. Architecture (engine + model-abstraction + UI + deploy)

```
┌────────────────────────── Nucleus UI (Next.js, existing shell) ──────────────────────────┐
│  Landing · Auth · Dashboard(Documents + Ask) · Sources/Admin · Settings · Eval dashboard   │
│  ADMIN: User mgmt (provision · active users · revoke) · Prompt mgmt (system + urgency)      │
│  TODAY: 100% mock (src/lib/mock.ts). THIS BUILD: wired to the live engine via /api/*        │
└───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                             │  POST /api/ask {question, lang}
┌───────────────────────────────────────────▼───────────────────────────────────────────────┐
│                       ENGINE (reuse Contract-Retriever-RAG/lib/engine/*)                     │
│                                                                                             │
│   ROUTER ──► RETRIEVAL ───────────────────► EVIDENCE ──► GROUNDED GEN ──► validateAnswer()  │
│  (visible)   SQL | Vector+BM25 | OCR |     (rows+ids,    (cite every     (+ confidence,     │
│              Excel | API connector          pages,        claim)          consistency)      │
│              + metadata/entity filters      rows, results)                                  │
│                                                                                             │
│   INGESTION: parse → vet (data-quality) → URGENCY CLASSIFY (admin prompt → badge+rationale) │
│                                                                                             │
│   ┌──────────────── MODEL-ABSTRACTION LAYER (net-new) ────────────────┐                     │
│   │  default: Azure OpenAI   │  paid: Ollama / Llama / Qwen / Mistral  │  swap w/o re-arch  │
│   └────────────────────────────────────────────────────────────────────┘                   │
│   PROMPT MGMT: system · routing · retrieval · grading · URGENCY (admin-editable)            │
│                                                                                             │
│   OBSERVABILITY: route · SQL · chunks · citations · validation · eval  (all persisted)      │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
   STORES: read-only SQLite (CSV/Excel→tables) · in-app vector index (PDF/OCR chunks) · auth/history + doc-metadata (urgency) DB
   DEPLOY: Docker + docker-compose · CLIENT-owned GitHub repo · CLIENT self-hosts on her own cloud (her Azure key via env);
           contractor hosts only a portfolio demo
```

**Non-negotiables honored** (from the contract): self-hosted/owned/transparent hybrid RAG+SQL; no managed/black-box RAG; visible routing; model-abstraction with Azure default + local; Hebrew incl. cross-lingual; grounded/no-hallucination with full citation framework; validation + grading/LLM-as-judge; observability; user+admin management; Dockerized; client-owned repo; Nucleus UI as the front end.

**The two model changes from the demo** (both required by the contract, both net-new):
- Demo uses **DeepSeek**; contract requires **Azure OpenAI default** + **local paid**. → build the **model-abstraction layer** (the demo's `lib/engine/llm.ts` is an OpenAI-compatible client — Azure is a config/provider swap; Ollama is a second provider).
- Demo is on **Vercel**; contract requires **Docker + docker-compose + cloud (not desktop-only) + client-owned repo**. → containerize; the bundled-index build step already runs at build time.

---

## 3. What's REUSED vs NET-NEW (per acceptance criterion)

The existing engine is a large head-start. The honest split:

| # | Acceptance criterion | Existing engine status | This build |
|---|---|---|---|
| 1 | PDF retrieval | ✅ **Built & proven** (page-cited Carter Q&A) | Wire to Nucleus UI |
| 2 | OCR document retrieval | ❌ **Net-new** (engine ingests native PDFs only) | Add OCR ingest (Tesseract) → searchable text + page-preserving citations |
| 3 | Excel retrieval | 🟡 **Partial** (CSV→SQLite works; `.xlsx` not parsed) | Add `.xlsx` ingest → same table/row-citation path |
| 4 | SQLite retrieval | ✅ **Built & proven** | Wire to UI |
| 5 | **Hybrid SQL + PDF** | 🟡 **Engine composes both; the spec's example isn't answerable from this data** | Build a **real contract-document corpus** (or ingest a client contract) so the dual-citation hybrid is demonstrated on data that supports it — **see §7, this is the #1 item** |
| 6 | Hybrid Excel + PDF | 🟡 Same composition path, needs Excel ingest (#3) | Wire once #3 lands |
| 7 | API integration example | ❌ **Net-new** | Build connector framework + one **real** illustrative connector (e.g. a live FX/weather/public API or a mock CRM) returning cited API-result evidence |
| 8 | Hebrew Q&A (incl. cross-lingual) | 🟡 **Architecturally ready** (multilingual embeddings); not hardened/tested | Hebrew test fixtures, normalization seam, cross-lingual golden (EN doc, HE question → **Hebrew-language answer** with citations preserved) |
| 9 | Local LLM operation | ❌ **Net-new** (demo is DeepSeek-only) | Model-abstraction + Ollama provider; one local model answering a golden |
| 10 | Citation validation | ✅ **Built & proven** (`validateAnswer()` + red test) | Extend to OCR/Excel/API citation types; add confidence score |
| 11 | Retrieval trace inspection | 🟡 **Data exists** in API response (`route`, `evidence`, `validation`); not surfaced in Nucleus UI | Build the trace/observability panel in the UI |
| 12 | Grading prompt eval workflow | ❌ **Net-new** | LLM-as-judge over answer/citation/retrieval/grounding/hallucination + eval dashboard |
| 13 | E2E deploy from client repo | 🟡 **Vercel today** | Docker + compose + client-owned GitHub + **client self-host on her cloud** + a written **client-handoff/deployment doc** (§6) |
| ＋ | **Urgency classification at ingestion** (net-new platform capability; ties to spec Prompt Management) | 🟡 **UI exists** (the dashboard urgency column is a static mock field) | Admin-configurable urgency **prompt** → classify each doc at ingestion → store urgency + rationale as metadata → color badge; editing the prompt **re-derives**. Golden: **#G** (see [golden-bar.md](golden-bar.md)) |
| ＋ | **Admin user management** (net-new platform capability; ties to spec User Management + Admin Features) | ❌ **Net-new** (the demo has no auth/users; the mock UI shows a single static user) | Admin **provisions accounts**, **sees active users / live sessions**, and **revokes** a user (deactivate → access cut + sessions invalidated). Golden: **#H** (see [golden-bar.md](golden-bar.md)) |

**Reuse summary:** ~4 criteria essentially done (1, 4, 10, and the composition half of 5/11), ~3 partial (3, 6, 8), ~6 net-new (2, 7, 9, 12, 13, plus the model-abstraction layer, the urgency-classification capability, admin user management, and the entire UI-to-engine wiring). The grounding/citation/validation **core** — the hardest, most differentiating part — is **proven**.

---

## 4. Phased build order (front-load the acceptance-critical backbone)

Ordered so the trust-defining, hardest-to-fake capabilities land first and each phase is independently demonstrable:

- **Phase A — Backbone wired & honest (the spine).** Engine under Nucleus UI for real; `/api/ask` live; SQL (#4) + native-PDF (#1) + **dual-citation hybrid** (#5, on a corpus that supports it) + grounded/no-hallucination + `validateAnswer()` (#10) + retrieval-trace panel (#11). **Gate:** the Carter golden, the contract-expiry golden, and the hybrid dual-citation golden all pass against real files.
- **Phase B — Model abstraction & Hebrew.** Azure OpenAI default + local Ollama paid option (#9) behind the abstraction layer; Hebrew Q&A incl. cross-lingual EN-doc/HE-question, **answered in Hebrew** (#8). **Gate:** Hebrew golden + local-LLM golden pass.
- **Phase C — Source breadth.** OCR (#2), Excel `.xlsx` (#3), Excel+PDF hybrid (#6), API connector example (#7). **Gate:** one real golden each.
- **Phase D — Admin, eval & ownership.** Auth/accounts/history; **admin user management** (provision · active users · revoke — capability ＋, golden #H); admin (source/doc/connector/model mgmt) + **prompt-management UI** (system prompt + the **urgency-classification prompt** that derives per-doc urgency, capability ＋, golden #G); grading/LLM-as-judge + eval dashboard (#12); Docker + compose + client-owned repo + client self-host + cloud deploy + the **client-handoff/deployment doc** (#13). **Gate:** E2E deploy from the client repo; deactivating a user cuts their access (golden #H); the urgency golden re-derives on prompt change (#G); eval workflow produces graded scores.

---

## 5. Golden bar (companion artifact)

The full 13-criterion golden acceptance bar — each criterion's real question, expected grounded answer, and exact expected citations against the client's real files — is maintained verbatim in **[golden-bar.md](golden-bar.md)**. It is the bar the verifier enforces; a verifier must be able to **fail** a toy/wrong/fabricating build against each criterion.

---

## 6. The doc set this feature owes (for the engineer)

Per the doc pipeline, the deliverable is **Standard/Big tier** (multi-source, external integrations, multi-step). Author, per capability and at the platform level: `00-research` → `01-design` (this PRD is its source) → `02-examples` (the golden-bar examples) → `03-tests` (gate list: **one gate per acceptance criterion + one fixture per golden, incl. the urgency golden #G and the admin-revoke golden #H**) → `04-implementation` + a `user-guide` (Diátaxis how-to, with the golden scenario + real screenshots) + the generated public docs site. The `Derived from:` chain must trace every doc back to this design and the real files.

**Named deliverable — [HANDOFF.md](HANDOFF.md) (the deployment/operate doc for criterion #13; written and persisted in this repo).** Because the **contractor hosts only a portfolio demo and the client self-hosts the owned repo on her own cloud**, this is a first-class deliverable, not an appendix. It is written **for a non-technical owner to hand to her own engineer**, and covers:
- **What she gets** — the client-owned GitHub repo; what's in it; the ownership statement.
- **Clone & configure** — `git clone <her repo>`; copy `.env.example` → `.env`; set **her own Azure OpenAI key/endpoint/deployment** (and the optional local-Ollama vars for the paid tier) — names + where to get each, no secrets in the repo.
- **Run** — `docker compose up`; the bundled index builds; the app comes up; how to reach it.
- **Operate** — admin tasks (manage sources/docs/connectors, **select the model**, **edit prompts incl. the urgency prompt**, read the eval dashboard); where history lives; how to update/redeploy.
- **Data sensitivity & compliance (decision guide)** — a plain-language version of §0.1 for the owner: **the demo/test setup uses mock data + the free dev Gemini key and is NOT for real PHI**; to go live with real hospital/legal data she picks a compliant path by **one env-var swap** — **(a)** Azure OpenAI or GCP Vertex AI under a **signed HIPAA BAA on her own account**, or **(b)** **fully local Ollama** so **data never leaves her infrastructure** (the strongest privacy posture). The tradeoffs (cost/quality/latency vs. privacy), and a note that the BAA/DPA + security review on her chosen path are hers to execute. No provider is baked in.
- **Architecture + env-setup** — a short architecture overview and the full env-var reference, so her engineer can run and extend it.
This doc, plus the repo + Docker/compose, is what criterion #13 verifies (see [golden-bar.md](golden-bar.md) #13).

---

## 7. Honest risk / feasibility (stated once, factually)

| Risk | Reality | Mitigation |
|---|---|---|
| **#5 hybrid not answerable on supplied data** | The maintenance CSV has no overdue/payment field; no service-agreement PDF exists. The literal example **cannot** be answered truthfully from what was provided. | **Decision needed from client:** supply a real contract+AR pair (5a) or accept a constructed-but-real demo corpus (5b). The *honest refusal* (#10b) ships regardless — it's a feature, not a gap. |
| **#8 Hebrew cross-lingual quality** | Multilingual embeddings make retrieval work; **generation quality** in Hebrew on Azure OpenAI is good but **untested here**, and citation-preservation across languages needs hardening. Highest technical uncertainty. | Hebrew fixtures + a generation prompt that forces citation copy-through; verify on the real EN-doc/HE-question golden before claiming done. |
| **#2 OCR quality** | OCR on a clean rasterized page is reliable; messy scans degrade. | Tesseract + page-preserving citations; scope the golden to a clean scan; flag low-confidence OCR. |
| **#9 local-LLM answer quality** | Small local models (Llama/Qwen/Mistral 7–8B) follow the strict cite-every-claim instruction **less reliably** than Azure OpenAI; `validateAnswer()` will reject more often. | Set expectation: local is the *paid, capable-but-lower-fidelity* option; the abstraction layer is what's graded, not parity with cloud. |
| **#7 API example** | A "real CRM/QuickBooks" integration is out of Phase-1 scope; an illustrative connector is in. | One real public API or mock-CRM connector, clearly labeled as the extensible-architecture proof. |
| **Regulated data (HIPAA/PHI + legal privilege)** | The real domains are hospital + legal, so real data is regulated. The demo/test path uses **mock data + the free dev Gemini key** and is **not** a compliant PHI environment — and must never be treated as one. | Demo/test = mock only (enforced as a rule, §0.1). Production = the client's compliant deploy-time choice via one env-var swap: Azure/Vertex under a signed **HIPAA BAA** on her account, or **fully local Ollama** (data never leaves her infra — strongest posture). Documented in [HANDOFF.md](HANDOFF.md); no provider baked in. The BAA/DPA + security review are the client's to execute. |
| **Scope vs. budget** | The contract enumerates a platform that, at market rates, is a multi-week senior build. The posted Upwork figures (Est. $200, funded $65, Milestone-1 only) are **wildly below** that scope. This is a fixed reality to name, not solve here. | Flag to the lead/client: either phase the *billing* to match the 3-phase delivery the spec itself describes, or right-size Phase-1 scope. The engineering plan above is correct regardless; the commercial terms are a separate conversation the contractor must have. |

---

## 8. Recommendation

The existing Contract-Retriever-RAG engine already proves the **hardest, most-differentiating half** of this spec — real routing, hybrid retrieval, grounded generation, and a tested content-fidelity gate — against the client's **real files**, with **every headline number verified**. The net-new work (model-abstraction/Azure+local, OCR, Excel, API connector, Hebrew hardening, grading/eval, Docker/ownership, and wiring the live engine under the already-polished Nucleus UI) is well-defined and phased above. **Two items require a client decision before Phase A** (the #5 corpus choice) and **one is a commercial reality to surface** (scope vs. budget). With those settled, the golden bar in [golden-bar.md](golden-bar.md) is specific enough that the verifier can fail any toy or fabricating implementation.

---

## Files referenced (all absolute)

- Binding spec / client thread: `/home/codex/Projects/nucleus/clientchat.md`
- Existing engine + docs: `/home/codex/Projects/Contract-Retriever-RAG/docs/CLIENT-DELIVERABLE.md`, `/home/codex/Projects/Contract-Retriever-RAG/docs/architecture.md`, `/home/codex/Projects/Contract-Retriever-RAG/docs/features/shared-engine/reference.md`, `/home/codex/Projects/Contract-Retriever-RAG/docs/product/data-quality-assessment.md`
- Real data (golden-bar evidence): `/home/codex/Projects/Contract-Retriever-RAG/data/school data 1.csv` (contracts), `.../school data 3.csv` (maintenance), `.../📄 FAMILY COURT CASE FILE (MOCK) – FINAL VERSION.pdf` (Final Judgment = printed PAGE 24 / physical page 6), `.../story if the Carters .pdf`
- Front-end shell to wire: `/home/codex/Projects/nucleus/src/` (mock data at `/home/codex/Projects/nucleus/src/lib/mock.ts`; ask panel at `/home/codex/Projects/nucleus/src/components/ask-panel.tsx`; dashboard at `/home/codex/Projects/nucleus/src/app/dashboard/page.tsx`)
