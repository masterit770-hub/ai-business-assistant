# Nucleus — Owner & Setup Guide

**For:** the owner (Jenny) and whoever helps her set it up — **a human engineer *or* an AI assistant.**

> 🤖 **Non-technical? Read this first.** You don't need to understand the technical steps. Open an AI assistant (Claude, ChatGPT, etc.), **paste this whole document in, and say: "Walk me through this one step at a time."** This guide is written so an AI can follow it precisely — and by the end, the **entire system** (the app, your logins database, your document search, and the AI model — including the HIPAA and offline options) runs on **your own accounts**, depending on nothing of the contractor's.

This page is the **spine**. Two companion guides go deeper where you need them:
- **[SETUP.md](SETUP.md)** — the full, copy-pasteable, from-scratch runbook (every command, every checkpoint, a smoke test per environment). Use this when you actually sit down to build it.
- **[LOCAL-MODEL.md](LOCAL-MODEL.md)** — running the AI on your own hardware (Ollama + the tunnel for the hosted app).

---

## What Nucleus is (plain English)

An **AI business assistant** that answers questions about **your documents and data** — with a **citation** for every answer, so you can trust where it came from.

- **Upload** PDFs, scanned documents, Excel/CSV → **ask a question** → get a **cited answer**.
- Answers pull from **both** your uploaded documents **and** your structured data (contracts, maintenance spend, etc.) in one reply.
- Works in **English and Hebrew**.
- **You control access:** you create user accounts, and you can **remove anyone instantly**. Each person only sees **their own** uploaded documents.

---

## How it's built (one app, your accounts)

Nucleus is **a single Next.js web application** that you deploy **once**. It contains everything — the website you log into **and** the "brain" that retrieves and writes the cited answers (routing, the SQL lane for your tables, document search, the citation/verification gate). There is **no second service to deploy or wire up.**

| Piece | What it is | Whose account |
|---|---|---|
| **Hosting** | Vercel — runs the one app | **yours** |
| **Logins & users + document search** | Supabase — Postgres database, file storage, and the **document search index** all live here | **yours** |
| **The answer model** | the AI that *writes* the sentences — DeepSeek by default; swap to your own provider in one config line | **yours** (a key) |

> **Document search is now self-hosted.** Earlier builds searched uploaded documents through Google's "Gemini File Search." That has been **replaced** by a self-hosted search inside **your own Supabase database** (Postgres + the `pgvector` extension), so your documents never leave infrastructure you own. **There is no Google / Gemini / GCP setup anymore** — no Google API key, no "File Search store." (Gemini can still optionally be chosen as the *answer model*, but that's just one provider option among several, not a requirement.)

### How document search works (so you can explain it)

When you upload a PDF, scan, or spreadsheet, the app:
1. **Extracts the text** (and runs **OCR** — Tesseract — on scanned/image pages, best-effort).
2. **Splits it into chunks** and **embeds** each chunk into a number-vector using a **local multilingual model** (multilingual-e5, 384 dimensions) that runs inside your deployment — no external API, and it handles **English + Hebrew** in the same space.
3. **Stores** the chunks + vectors in your Supabase `doc_chunks` table, scoped to the uploading user.

When someone asks a question, retrieval is a **hybrid search**: a **dense** lane (vector cosine similarity) **and** a **keyword** lane (BM25-style full-text), **fused** with Reciprocal Rank Fusion (RRF) so the best passages from both win. The answer model then writes the reply and **cites** the exact pages.

---

## Two ways to use it

### A) Try the live demo right now (running on the contractor's infrastructure)

**https://nucleus-woad.vercel.app** → sign in at **/sign-in**. (Demo logins are provided separately — they're intentionally kept out of source control. Change/delete them before any real use.)

### B) Set up your own (so you own everything)

That's the rest of this guide. The fastest path: hand **[SETUP.md](SETUP.md)** to your AI helper and follow it step by step. The sections below are the **map** of what that involves.

---

## Step 1 — Open your accounts (all free to start)

| Account | What it's for | Link |
|---|---|---|
| **GitHub** | Holds the code (accept the repo invite). | github.com |
| **Vercel** | Runs the app. | vercel.com |
| **Supabase** | Your logins **and** your document search (Postgres + pgvector + file storage). | supabase.com |
| **An answer-model key** | Writing the answers — **DeepSeek** (cheap default) or, for regulated data, **Azure OpenAI** with a HIPAA BAA. | platform.deepseek.com |

> **No Google / Gemini / GCP account is required.** Document search is self-hosted in your Supabase. (Old versions needed a Google AI Studio key — you don't anymore.)

---

## Step 2 — Set up Supabase (database + document search + file storage)

Full click-by-click steps with checkpoints are in **[SETUP.md → Supabase](SETUP.md#1-supabase-setup)**. In summary, you will:

1. **Create a Supabase project** (pick a strong database password, a region near your users).
2. **Copy three values** from **Project Settings → API**: the **Project URL**, the **anon (public) key**, and the **service-role (secret) key**. These become your environment variables (next step).
3. **Enable the `vector` extension** — *this is done for you* by migration `006` (which begins with `create extension if not exists vector;`). You can also enable it by hand under **Database → Extensions → `vector` → Enable**.
4. **Apply all eight migrations** in `supabase/migrations/` (paste each into the **SQL Editor** and Run, in order). They are idempotent (safe to re-run):

   | File | What it creates |
   |---|---|
   | `001_profiles_and_roles.sql` | `profiles` table + a signup trigger; makes the **first** user an **admin**; per-user isolation foundation. |
   | `002_engine_settings.sql` | `engine_settings` key/value table — persists your **model mode, saved provider keys, and editable prompts** across serverless instances. |
   | `003_ask_history.sql` | `ask_history` — every question + answer + citations a user asks (each user sees only their own; admin sees all). |
   | `004_ask_sessions.sql` | adds `session_id` to `ask_history` — groups asks into **multi-turn chat conversations**. |
   | `005_deleted_sources.sql` | `deleted_sources` — lets an admin **hide** a bundled (shared) document/table from answers. |
   | `006_doc_chunks.sql` | **the document search store** — enables `vector`, creates `doc_chunks` (embeddings + full-text), the **hybrid search** function, and the per-user read security. **This is the core of self-hosted RAG.** |
   | `007_session_titles.sql` | `session_titles` — lets a user **rename** a conversation. |
   | `008_ask_history_trace.sql` | adds `inspector` + `evidence` columns so a **past answer replays its real "why" panel** (route, retrieved passages, confidence). |

   *(CLI alternative: `supabase link --project-ref <your-ref>` then `supabase db push`.)*

5. **Create the `documents` storage bucket** (a **private** bucket named exactly `documents`) so original uploaded files can be downloaded later. *The app also creates this bucket automatically on the first upload* if the service-role key has storage permission — but creating it up front is the reliable path. **Storage → New bucket → name `documents` → Public OFF → Create.**

**Checkpoint:** in Supabase → **Table Editor** you should now see `profiles`, `engine_settings`, `ask_history`, `deleted_sources`, `doc_chunks`, and `session_titles`; in **Database → Extensions**, `vector` is **Enabled**; in **Storage**, a private bucket named `documents` exists.

---

## Step 3 — Deploy to Vercel + set the environment variables

Full steps (including **why** you must set variables durably and how to verify the live deploy) are in **[SETUP.md → Vercel](SETUP.md#2-vercel-setup)**. The required environment variables — the **exact names the app reads** — are:

```bash
# ── The answer model (writes the sentences). Default = DeepSeek. ──
LLM_PROVIDER=deepseek                       # cosmetic label for the UI / logs
LLM_API_KEY=<YOUR_ANSWER_MODEL_API_KEY>     # the bearer key for the provider below
LLM_BASE_URL=https://api.deepseek.com       # OpenAI-compatible base URL
LLM_MODEL=deepseek-chat                      # the model id at that provider

# ── Supabase (logins + document search + file storage) ──
NEXT_PUBLIC_SUPABASE_URL=https://<your-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<YOUR_SUPABASE_ANON_KEY>
SUPABASE_SERVICE_ROLE_KEY=<YOUR_SUPABASE_SERVICE_ROLE_KEY>   # server-only, keep private
SUPABASE_URL=https://<your-ref>.supabase.co                  # set EQUAL to the public URL above

# ── Internal plumbing (set once) ──
INTERNAL_EMBED_TOKEN=<ANY_LONG_RANDOM_STRING>   # secures the app's internal embedding call

# ── Do NOT set this on real data ──
# ASSISTANT_TODAY freezes "today" so the SAMPLE demo's date math stays stable. On your
# live data LEAVE IT UNSET so "expiring in the next 90 days" computes against the real date.
```

Notes on the names (verified against the code):
- The app reads **either** `SUPABASE_URL` **or** `NEXT_PUBLIC_SUPABASE_URL` for its server-side database access, but production deployments often only set the public one — so **set `SUPABASE_URL` equal to the public URL** to be safe (otherwise admin settings like the model switch and prompts can silently run in per-instance memory).
- `SUPABASE_SERVICE_ROLE_KEY` is the **secret** key — it bypasses row-level security and is used only server-side. Never expose it to the browser, never commit it.
- The `NEXT_PUBLIC_` prefixed variables are the only two that reach the browser (they're meant to be public).

> ⚠️ **Set variables durably — do not use `vercel deploy -e KEY=val`.** The `-e` flag injects a variable into **that one build only**; the very next redeploy silently loses it (this has broken a live deploy before). Always add variables with **`vercel env add KEY production`** (or in the Vercel dashboard under **Settings → Environment Variables**), *then* deploy. See [SETUP.md → Vercel](SETUP.md#2-vercel-setup) for the exact commands and the post-deploy **curl** check that confirms the live endpoint is actually configured.

**Smoke test after deploy:** sign in, ask a built-in question (you should get a cited answer), upload a document, ask about it (cited answer). See [SETUP.md → Smoke tests](SETUP.md#smoke-tests).

---

## Step 4 — Make yourself the first admin (one time) + lock the door

There are **no prebuilt accounts** on your own instance. You make yourself admin:

1. Supabase → **Authentication → Sign-in / Providers** → temporarily turn **"Allow new users to sign up" ON**.
2. Open your app, **sign up** with your email → the **first** account automatically becomes the **admin** (the `001` trigger seeds it).
3. Turn **"Allow new users to sign up" OFF** again.

From now on **only you (admin) create accounts** — from the in-app **Admin** panel — and you can **kick anyone out instantly** (they lose access on their very next click). Nobody can self-register.

---

## Three model modes — Cloud / HIPAA / Local

Nucleus has a **three-way model switch** (top of the Ask panel, and in **Settings → Model**), and **each mode keeps its own saved key**, so you enter them once and flip freely. All of this is **in-app — no redeploy.** Keys are write-only (saved, never shown back).

- **Cloud** (the default) — a hosted model. The env-configured provider answers by default (DeepSeek). An admin can **paste any** OpenAI-compatible provider key in **Settings → Model** to swap to **OpenAI / Google Gemini / DeepSeek / Azure** at request time. If you select a provider but save no key, it **fails closed** (it won't silently masquerade as that provider).
- **HIPAA** — a HIPAA-eligible hosted model (**Azure OpenAI** under a Microsoft BAA). You paste your Azure **endpoint + key + deployment name**. For your protection this mode **fails closed** — it **never** falls back to the shared cloud key, so PHI-intent traffic can't leak to a non-BAA provider. Setup details below.
- **Local** — the AI runs on **your own machine** (Ollama). Works self-hosted (app on the box) **or** with the hosted Vercel app via a **tunnel**. Full tested setup → **[LOCAL-MODEL.md](LOCAL-MODEL.md)**.

---

## Set up Azure OpenAI as your HIPAA-eligible AI backend (optional)

*(Only if you'll run real patient/legal data. Skip otherwise — Cloud and Local don't need this.)* This connects the app's **HIPAA mode** to Microsoft's Azure OpenAI. By the end you'll have **four values** to paste into **Settings → Model → HIPAA**. The exact env/field names the code reads are `hipaa_endpoint`, `hipaa_api_key`, `hipaa_model` (the deployment name), and `hipaa_api_version` (defaulted). **There is no environment-variable fallback for HIPAA** — if any of endpoint/key/deployment is missing, the mode refuses to answer rather than route to the cloud backend.

> Set everything up in a **United States region** and keep it there — HIPAA coverage applies to US-hosted resources.

### 1. Create an Azure account + subscription
1. Go to **https://azure.microsoft.com** → **Start free** (or sign in if your business already has an account).
2. Sign up with a work email, phone, and a credit card (identity check; the free tier doesn't charge unless you exceed it). This creates your **subscription** (billing container).
3. **Cost:** opening the account is free. Azure OpenAI is **pay-as-you-go** (billed per million "tokens"). A light internal workload is usually a few to low-tens of dollars/month. Set a **budget/alert** in **Cost Management** to avoid surprises.

### 2. Create an Azure OpenAI resource
1. In the **Azure portal** (https://portal.azure.com) → **Create a resource** → search **Azure OpenAI** → **Create**.
2. **Basics:** **Subscription** (step 1), **Resource group** (new, e.g. `hipaa-ai`), **Region** (a **US** region like *East US 2*), **Name** (e.g. `myclinic-openai`), tier **Standard**.
3. **Next** through the wizard → **Review + submit** → **Create** → **Go to resource**.

### 3. Deploy a model
1. Go to **https://ai.azure.com**, open your resource → **Deployments** (a.k.a. **Models + endpoints**).
2. **+ Deploy model → Deploy base model** → pick a current **GPT-4-class** model (**`gpt-4o`**, or **`gpt-4o-mini`** for lower cost) → **Confirm**.
3. **Set the Deployment name** (one of your four values) — type anything (e.g. `chat-gpt4o`) and **write down exactly what you typed**. Type **Standard** → **Deploy** → wait for **Succeeded**.

### 4. Copy the four values into the app
| App field (Settings → Model → HIPAA) | Code key | Where in Azure |
|---|---|---|
| **Endpoint** | `hipaa_endpoint` | Resource → **Keys and Endpoint** → **Endpoint** (e.g. `https://myclinic-openai.openai.azure.com`). |
| **API key** | `hipaa_api_key` | Same page → **KEY 1** (or KEY 2). Treat like a password (write-only — never echoed back). |
| **Deployment name** | `hipaa_model` | The exact name you typed in step 3. |
| **API version** | `hipaa_api_version` | App **defaults** this — leave as-is. If ever needed, a recent stable one is **`2024-10-21`**. |

Paste the first three, save, flip to **HIPAA**. (HIPAA mode **fails closed** — until these are set it refuses to answer rather than fall back to the shared cloud model.)

### The HIPAA BAA — required, and your responsibility
- Azure OpenAI is a **HIPAA-eligible** service; Microsoft offers the **BAA as part of its standard Product Terms / DPA**.
- For most customers the BAA is **already included** in an eligible agreement (a Microsoft **Enterprise Agreement** or a purchase via a **Cloud Solution Provider/partner**). On a basic pay-as-you-go account, **confirm with Microsoft (or your partner)** that your account is under a BAA-covering agreement *before* sending patient data. Terms: **https://www.microsoft.com/licensing/terms**.
- **Honest caveat:** having the BAA, keeping the resource in a **US region**, and using it within HIPAA practices is **your** responsibility. The app **cannot verify** your account is BAA-covered — it just sends requests to the endpoint/key you give it. Don't enter real patient data until you've confirmed coverage.

### Google Vertex AI (GCP alternative) — follow-up only
Google **Vertex AI** is a comparable HIPAA-eligible option, but it authenticates with a **service-account JSON / OAuth token**, not a pasted key — which the current "paste-a-key" HIPAA flow doesn't support. If you specifically need Google, flag it as a **follow-up** to be built; for now Azure is the supported path.

---

## Quick reference

| I want to… | Do this |
|---|---|
| Build my own copy from scratch | Follow **[SETUP.md](SETUP.md)** end to end |
| Make myself admin on my own copy | Step 4 (allow signups → sign up first → turn off) |
| Add / remove a user | Admin panel → create account / kick out |
| Add a document | **Upload** on the dashboard (PDF / CSV / XLSX, ≤ 15 MB) |
| Swap the answer model's provider | **Settings → Model → Cloud**, paste a provider key (no redeploy) |
| Run the AI on my own machine (Local) | Switch to **Local** → **[LOCAL-MODEL.md](LOCAL-MODEL.md)** |
| Use a HIPAA model (Azure) | Switch to **HIPAA**, paste Azure endpoint/key/deployment (fails closed) |
| Go live with real PHI | Azure + signed BAA + your own keys |

**You own all of it** — one repo (your GitHub), one app (your Vercel), your Supabase (logins, documents, search, files), your keys. Nothing depends on the contractor's accounts after the setup steps.

*Technical deep-dive: see [PRD.md](PRD.md) and the repo's `.env.example`.*
