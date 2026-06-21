# Nucleus — project directives

Nucleus is an **AI Business Assistant** delivered as a real Upwork contract to a **non-technical** client (Jenny). It answers business questions over her documents + structured data with **traceable citations**. These are the standing directives for this project — read them before building, don't make the user re-state them.

## Build to the functional outcome, not the client's tech words
The client's spec was partly **generated with ChatGPT and she doesn't understand the technical clauses**. Deliver what she *functionally* wants; **drop the boilerplate plumbing she named but doesn't need**:
- **DROP:** Docker, API/CRM connectors, local-LLM/Ollama, grading/observability dashboards, no-vendor-lock-in ceremony.
- **DELIVER (functional scope):** upload (PDF / Excel / CSV / scanned) → ask → **cited answers**; hybrid **SQL + document** retrieval with dual citations; **Hebrew** Q&A; real **users / auth / kick-out**; **per-user document isolation**; **urgency** flagging; **editable prompts**.
- Litmus before building any "requirement": *does the existing engine (the self-hosted hybrid RAG + text-to-SQL) already do this?* If yes, it's a verification step, not a build.

## Document lane = self-hosted Supabase pgvector HYBRID (replaced Gemini)
- **HISTORY:** the doc lane used to be Gemini File Search. Its free key ran out of quota and the client said "build everything ourselves on Supabase." **Gemini + GCP are now fully removed.** Do not reintroduce them.
- The document RAG lane is now **self-hosted HYBRID search on Supabase Postgres + pgvector**: dense cosine × BM25 lexical → Reciprocal Rank Fusion (RRF, k=60). Embeddings are **local multilingual-e5** (384-dim). Bundled docs use an in-process hybrid over `data-index/`; uploaded docs persist to `doc_chunks` (migration 006) and retrieve via the `hybrid_match` RPC, owner-scoped (per-user isolation). The inspector shows real dense/BM25/RRF.
- **Scanned/image PDFs → OCR (Tesseract.js, best-effort)** in `/api/ingest` only. The text layer is the contract; OCR is enrichment that never breaks ingest.
- Structured data (contracts/maintenance CSVs) flows through the engine's **text-to-SQL lane**; `.xlsx` = light convert to that lane.
- **Demo data is gated:** the bundled sample corpus is shown/retrieved only for `profiles.is_demo` accounts (migration 009). A real client user starts with a clean bucket. The demo accounts are the admin + the regular-user login in `.secrets/demo-accounts.txt`.

## Keys & models
- The LLM is **provider-neutral via env**: `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`. Three model modes: **Cloud** (default DeepSeek), **HIPAA** (Azure OpenAI, fails closed), **Local** (Ollama via the cloudflared tunnel). See `src/lib/engine/llm.ts` + `docs/HANDOFF.md`.
- **There is NO Gemini/GCP key anymore.** `.secrets/gemini.env` is dead for this build. Supabase creds live in `.secrets/supabase.env` (gitignored — **never print/commit**).
- **Anything that is the client's-side config — her own cloud key, a stronger model, her Azure deployment — goes in `docs/HANDOFF.md` / `docs/SETUP.md`. It is a handoff note, NOT a build blocker.**

## Discipline
- **No mock passed off as done.** Verify every feature **live** before claiming it works — the polished-shell-over-mocks oversell is what broke trust here.
- This is **real delivery** (the Zoom demo already happened), not a throwaway demo.

## Where things live
- `docs/PRD.md` — architecture & phased plan · `docs/golden-bar.md` — acceptance criteria + verified golden numbers · `docs/HANDOFF.md` — non-technical owner setup (incl. key/model swap) · `clientchat.md` — the binding client thread + spec.
- Live: Nucleus UI `https://nucleus-woad.vercel.app`; engine `https://contract-retriever-rag.vercel.app` (on the user's account — **do not break**).
