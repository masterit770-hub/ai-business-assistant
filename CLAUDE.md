# Nucleus — project directives

Nucleus is an **AI Business Assistant** delivered as a real Upwork contract to a **non-technical** client (Jenny). It answers business questions over her documents + structured data with **traceable citations**. These are the standing directives for this project — read them before building, don't make the user re-state them.

## Build to the functional outcome, not the client's tech words
The client's spec was partly **generated with ChatGPT and she doesn't understand the technical clauses**. Deliver what she *functionally* wants; **drop the boilerplate plumbing she named but doesn't need**:
- **DROP:** Docker, API/CRM connectors, local-LLM/Ollama, grading/observability dashboards, no-vendor-lock-in ceremony.
- **DELIVER (functional scope):** upload (PDF / Excel / CSV / scanned) → ask → **cited answers**; hybrid **SQL + document** retrieval with dual citations; **Hebrew** Q&A; real **users / auth / kick-out**; **per-user document isolation**; **urgency** flagging; **editable prompts**.
- Litmus before building any "requirement": *does the managed API (Gemini) already do this?* If yes, it's a verification step, not a build.

## Document lane = Gemini File Search (non-negotiable)
- The document RAG lane uses **Gemini File Search** (Google's managed ingest/chunk/embed/retrieve-with-citations). This is the client's explicit, repeated choice. **Do not** re-litigate it or swap in a self-hosted / pgvector path.
- **Gemini is multimodal → it reads scanned/image PDFs natively.** **No separate OCR / Tesseract pipeline.** "Scanned-document support" = push a scan through Gemini and confirm a cited answer.
- Structured data (contracts/maintenance CSVs) flows through the engine's **SQL lane**; `.xlsx` = light convert to that lane, not an OCR-style build.

## Keys & models
- Working **free-tier** Gemini key lives in `.secrets/gemini.env` (gitignored — **never print/commit**). It's on a **no-billing** GCP project (`future-haiku-481700-q6`), which is what grants the free tier; the billing-attached project 429s ("credits depleted").
- Free tier **rate-limits** under bursts. `gemini-2.5-flash` is the reliable default.
- **Anything that is the client's-side config — her own Gemini key, a paid key (to lift rate limits), a stronger model, her own cloud — goes in `docs/HANDOFF.md`. It is a handoff note, NOT a build blocker.**

## Discipline
- **No mock passed off as done.** Verify every feature **live** before claiming it works — the polished-shell-over-mocks oversell is what broke trust here.
- This is **real delivery** (the Zoom demo already happened), not a throwaway demo.

## Where things live
- `docs/PRD.md` — architecture & phased plan · `docs/golden-bar.md` — acceptance criteria + verified golden numbers · `docs/HANDOFF.md` — non-technical owner setup (incl. key/model swap) · `clientchat.md` — the binding client thread + spec.
- Live: Nucleus UI `https://nucleus-woad.vercel.app`; engine `https://contract-retriever-rag.vercel.app` (on the user's account — **do not break**).
