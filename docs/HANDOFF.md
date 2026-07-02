# Nucleus — Owner & Setup Guide

**For:** the owner (Jenny) and whoever helps her set it up — **a human engineer *or* an AI assistant.**

> 🤖 **Non-technical? Read this first.** You don't need to understand the technical steps. Open an AI assistant (Claude, ChatGPT, etc.), **paste this whole document in, and say: "Walk me through this one step at a time."** This guide is written so an AI can follow it precisely — and by the end, the **entire system** (the app, your logins database, your file storage, and the AI that reads your documents and writes the answers) runs on **your own accounts**, depending on nothing of the contractor's.

This page is the **spine**. Two companion guides go deeper where you need them:
- **[SETUP.md](SETUP.md)** — the full, copy-pasteable, from-scratch runbook (every command, every checkpoint, a smoke test per environment). Use this when you actually sit down to build it.
- **[LOCAL-MODEL.md](LOCAL-MODEL.md)** — running the AI on your own hardware (Ollama + the tunnel for the hosted app).

---

## What Nucleus is (plain English)

An **AI business assistant** that answers questions about **your documents and data** — with a **citation** for every answer, so you can trust where it came from.

- **Upload** PDFs, Excel/CSV (and Word) → **ask a question** → get a **cited answer**.
- Answers pull from your uploaded documents **and** your spreadsheets/tables (contracts, maintenance spend, etc.) in one reply — the AI reads whole files and computes over your spreadsheets.
- Works in **English and Hebrew**.
- **You control access:** you create user accounts, and you can **remove anyone instantly**. Each person only sees **their own** uploaded documents.
- **Knowledge Spaces** organize your files into topics (Finance, Contracts, HR, …); opening a space scopes your questions to just that space's files, or search across everything at once. (See the "Knowledge Spaces & Connected Sources" section below.)

---

## How it's built (two services, your accounts)

Nucleus runs as **two pieces you own**, both on your own accounts:

1. **The website (UI)** — a Next.js app on **Vercel** (the pages you log into, the upload button, the chat). This stays "always warm" so it opens fast.
2. **The answer engine** — a separate small service on **Fly.io** (the app named `nucleus-agent`) that actually *reads your files and writes the answers* using **Claude (Anthropic)**.

When you ask a question, the Vercel website forwards it to the Fly answer engine over a private, shared-secret connection; the engine reads your files with Claude and sends the cited answer back.

> **Why two services?** Earlier notes said "one app, no second service to deploy." That is no longer true — the answer engine now runs on Fly so it can use Claude's document-reading tools. You deploy **both**; the SETUP runbook covers each. (A single-app "standalone" mode still exists as a fallback for local development, but the deployed setup is the two-service split.)

| Piece | What it is | Whose account |
|---|---|---|
| **Website (UI)** | Vercel — runs the Next.js app you log into | **yours** |
| **Answer engine** | Fly.io — the `nucleus-agent` app that reads your files + writes answers with Claude | **yours** |
| **Logins, users & file storage** | Supabase — Postgres database (accounts, settings, history, Knowledge Spaces) + private file storage for your uploaded files | **yours** |
| **The answer model** | **Claude (Anthropic)** — the AI that reads your documents and writes the cited sentences | **yours** (an Anthropic API key) |

> **Your documents are read by Anthropic.** Be aware of the privacy posture: when you ask a question, the app uploads the relevant original files to **Anthropic's Files API** so Claude can read them, then Claude reads/computes over them in Anthropic's server-side sandbox. Your files leave your Supabase to reach Anthropic for reading. (Anthropic does not train on API traffic, but the files do go to Anthropic — this replaces the older "your documents never leave infrastructure you own" claim, which described an earlier design that has been removed.) **There is no Google / Gemini / GCP setup** — no Google API key, no "File Search store."

### How the answer engine reads your files (so you can explain it)

There is **no search index** to build and no "chunking/embedding" step anymore. Instead, the engine hands your **whole original files** to Claude and lets Claude read them:

1. When you upload a file, the app stores the **original bytes** in your Supabase Storage bucket (`documents`) — nothing is pre-processed or indexed.
2. When you ask a question, the engine uploads the relevant files to **Anthropic's Files API** and reads them:
   - **PDFs** are attached as native document blocks — Claude reads them directly (including scanned/image PDFs, which Claude reads without any separate OCR step).
   - **Spreadsheets and CSVs** (`.xlsx` / `.xls` / `.csv`) are handed to a **code-execution sandbox** where Claude runs Python (`pandas`) to read and compute over them — so it can total a column, filter rows, etc.
3. Claude writes the answer and ends with a `SOURCES_USED:` line naming the files it used. That declaration (plus page tokens like `[P:file#page]`) drives the **evidence / citations panel** you see next to the answer.

Because Claude reads the actual files, both English and Hebrew documents are read directly — there is no separate language model or embedding step to configure.

---

## Two ways to use it

### A) Try the live demo right now (running on the contractor's infrastructure)

**https://nucleus-770.vercel.app** → sign in at **/sign-in**. (The website runs on Vercel; the answer engine runs behind it on Fly as `nucleus-agent`.) Demo logins are provided separately — they're intentionally kept out of source control. Change/delete them before any real use.

### B) Set up your own (so you own everything)

That's the rest of this guide. The fastest path: hand **[SETUP.md](SETUP.md)** to your AI helper and follow it step by step. The sections below are the **map** of what that involves.

---

## Step 1 — Open your accounts (all free to start)

| Account | What it's for | Link |
|---|---|---|
| **GitHub** | Holds the code (the canonical repo is `github.com/qufeiz/nucleus-770`; accept the invite / fork). | github.com |
| **Vercel** | Runs the website (UI), git-deployed from the repo's main branch. | vercel.com |
| **Fly.io** | Runs the answer engine (the `nucleus-agent` app that reads your files with Claude). | fly.io |
| **Supabase** | Your logins, settings, history, **Knowledge Spaces**, and private file storage. | supabase.com |
| **Anthropic** | The **answer model** — Claude reads your documents and writes the cited answers. You create an API key (`sk-ant-…`). | console.anthropic.com |

> **No Google / Gemini / GCP account is required.** (Old versions needed a Google AI Studio key — you don't anymore.)
>
> **Anthropic billing/cap:** the Anthropic account is the one that actually costs money per question. **Set up billing and a monthly spend cap / alert** on it — the client's key once hit its monthly cap and that blocked live answers until the cap reset. Treat it like the Azure cost-alert note further down.
>
> **DeepSeek is optional.** A DeepSeek (or any OpenAI-compatible) key is only needed if you want to run the older *fallback* answer pipeline (see the model-modes note below); it is **not** the main answer model.

---

## Step 2 — Set up Supabase (database + file storage)

Full click-by-click steps with checkpoints are in **[SETUP.md → Supabase](SETUP.md#1-supabase-setup)**. In summary, you will:

1. **Create a Supabase project** (pick a strong database password, a region near your users).
2. **Copy three values** from **Project Settings → API**: the **Project URL**, the **anon (public) key**, and the **service-role (secret) key**. These become your environment variables (next step).
3. **Apply all sixteen migrations** in `supabase/migrations/` (paste each into the **SQL Editor** and Run, in order `001` → `016`). They are idempotent (safe to re-run). The load-bearing ones for the current app:

   | File | What it creates |
   |---|---|
   | `001_profiles_and_roles.sql` | `profiles` table + a signup trigger; makes the **first** user an **admin**; per-user isolation foundation. |
   | `002_engine_settings.sql` | `engine_settings` key/value table — persists your **saved keys, editable prompts, and internal flags** (including the "spaces already seeded" flag) across serverless instances. |
   | `003_ask_history.sql` | `ask_history` — every question + answer + citations a user asks (each user sees only their own; admin sees all). |
   | `004_ask_sessions.sql` | adds `session_id` to `ask_history` — groups asks into **multi-turn chat conversations**. |
   | `005_deleted_sources.sql` | `deleted_sources` — lets an admin **hide** a bundled (shared) document/table from answers. |
   | `007_session_titles.sql` | `session_titles` — lets a user **rename** a conversation. |
   | `008_ask_history_trace.sql` | adds `inspector` + `evidence` columns so a **past answer replays its real "why" panel** (route, evidence, confidence). |
   | `009_profile_is_demo.sql` | `is_demo` flag on `profiles` — gates the bundled **sample corpus** so a real client user starts with a **clean bucket** (only demo accounts see the samples). |
   | `013`–`015` | per-user settings + **per-chat document scoping** (uploads are linked to the chat they were added in). |
   | `016_knowledge_spaces.sql` | the `knowledge_spaces` and `session_spaces` tables that power **Knowledge Spaces** (topic folders + which chat belongs to which space). **The current app requires these.** |

   *(Migrations `006`, `010`, `011`, `012` belong to the **old, removed** document-search pipeline — e.g. `006_doc_chunks.sql` created a `doc_chunks`/`pgvector` search store. The live answer engine no longer reads any of them; they are harmless to apply but not required. You do **not** need to enable the `vector` extension.)*

   *(CLI alternative: `supabase link --project-ref <your-ref>` then `supabase db push`.)*

4. **Create the `documents` storage bucket** (a **private** bucket named exactly `documents`). This bucket is **load-bearing now**: it holds the original bytes of every uploaded file, and those bytes are what the answer engine uploads to Anthropic at answer time. *The app also creates this bucket automatically on the first upload* if the service-role key has storage permission — but creating it up front is the reliable path. **Storage → New bucket → name `documents` → Public OFF → Create.**

**Checkpoint:** in Supabase → **Table Editor** you should now see `profiles`, `engine_settings`, `ask_history`, `deleted_sources`, `session_titles`, `knowledge_spaces`, and `session_spaces` (plus `is_demo` as a column on `profiles`); in **Storage**, a private bucket named `documents` exists. *(You do not need to verify a `doc_chunks` table or the `vector` extension — those belong to the removed search pipeline.)*

---

## Step 3 — Deploy the two services + set the environment variables

There are **two deployments** and their environment variables live in **two places**. Full steps (including **why** you must set variables durably and how to verify each live deploy) are in **[SETUP.md → Vercel](SETUP.md#2-vercel-setup)** and **[SETUP.md → Fly answer engine](SETUP.md#3-fly-answer-engine)**.

### 3a — On the **Fly** answer engine (`nucleus-agent`) — Fly *secrets*

These select and power the Claude answer engine. Set them as **Fly secrets** (`flyctl secrets set NAME=value -a nucleus-agent`):

```bash
ANSWER_ENGINE=messages                       # selects the Claude Messages + code-execution engine
ANTHROPIC_API_KEY=<YOUR_ANTHROPIC_KEY>       # sk-ant-… — the billed key that reads your files + writes answers
AGENT_MODEL=claude-sonnet-4-6                # prod model pin (better answers). Omit to fall back to the
                                             # in-code default claude-haiku-4-5 (cheaper). Allowed:
                                             # claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-5
INTERNAL_AGENT_TOKEN=<ANY_LONG_RANDOM_STRING>  # shared secret; MUST match the same value on Vercel (below)

# The engine also needs the same Supabase values as the UI (it fetches your files to read them):
NEXT_PUBLIC_SUPABASE_URL=https://<your-ref>.supabase.co
SUPABASE_URL=https://<your-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<YOUR_SUPABASE_SERVICE_ROLE_KEY>
```

### 3b — On the **Vercel** website (UI) — Environment Variables

```bash
# ── Point the website at the Fly answer engine ──
FLY_AGENT_URL=https://nucleus-agent.fly.dev    # the Fly app's URL
INTERNAL_AGENT_TOKEN=<SAME_VALUE_AS_ON_FLY>    # must match the Fly secret above (server-to-server auth)

# ── Supabase (logins + settings + Knowledge Spaces + file storage) ──
NEXT_PUBLIC_SUPABASE_URL=https://<your-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<YOUR_SUPABASE_ANON_KEY>
SUPABASE_SERVICE_ROLE_KEY=<YOUR_SUPABASE_SERVICE_ROLE_KEY>   # server-only, keep private
SUPABASE_URL=https://<your-ref>.supabase.co                  # set EQUAL to the public URL above

# ── Do NOT set this on real data ──
# ASSISTANT_TODAY freezes "today" so the SAMPLE demo's date math stays stable. On your
# live data LEAVE IT UNSET so "expiring in the next 90 days" computes against the real date.
```

Notes on the names (verified against the code):
- **The answer model is Claude** — it needs `ANTHROPIC_API_KEY` on the Fly engine (not `LLM_API_KEY`). The Vercel `/api/ask` route forwards your question to Fly and does **not** require an LLM key on the primary path.
- **To change the answer model**, set `AGENT_MODEL` on Fly (`flyctl secrets set AGENT_MODEL=claude-sonnet-4-6 -a nucleus-agent`); to revert to the cheaper default, `flyctl secrets unset AGENT_MODEL -a nucleus-agent`.
- `INTERNAL_AGENT_TOKEN` must be the **same random string** on both Vercel and Fly — it's how the Fly engine knows the request really came from your website (unauthenticated calls get a 401).
- The app reads **either** `SUPABASE_URL` **or** `NEXT_PUBLIC_SUPABASE_URL` for server-side database access — **set `SUPABASE_URL` equal to the public URL** to be safe (otherwise admin settings and saved prompts can silently run in per-instance memory).
- `SUPABASE_SERVICE_ROLE_KEY` is the **secret** key — it bypasses row-level security and is used only server-side. Never expose it to the browser, never commit it.
- The `NEXT_PUBLIC_` prefixed variables are the only two that reach the browser (they're meant to be public).

> **About the `LLM_*` / DeepSeek variables (optional, legacy).** The older answer path — a self-hosted retrieval pipeline that used `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` (DeepSeek by default, Azure for HIPAA, Ollama for Local) — still exists as a **fallback** and only runs when `ANSWER_ENGINE` is unset. The deployed setup uses the Claude engine above, so these are **not required**. If you keep them, treat them as "legacy / optional," not "the answer model."

> ⚠️ **Set variables durably — do not use `vercel deploy -e KEY=val`.** The `-e` flag injects a variable into **that one build only**; the very next redeploy silently loses it (this has broken a live deploy before). On **Vercel** always add variables with **`vercel env add KEY production`** (or the dashboard under **Settings → Environment Variables**); on **Fly** use **`flyctl secrets set`** (Fly secrets persist across deploys). *Then* deploy. See [SETUP.md → Vercel](SETUP.md#2-vercel-setup) for the exact commands and the post-deploy **curl** check that confirms the live endpoint is actually configured.

**Smoke test after deploy:** sign in, ask a built-in question (you should get a cited answer), upload a document, ask about it (cited answer). See [SETUP.md → Smoke tests](SETUP.md#smoke-tests).

---

## Step 4 — Make yourself the first admin (one time) + lock the door

There are **no prebuilt accounts** on your own instance. You make yourself admin:

1. Supabase → **Authentication → Sign-in / Providers** → temporarily turn **"Allow new users to sign up" ON**.
2. Open your app, **sign up** with your email → the **first** account automatically becomes the **admin** (the `001` trigger seeds it).
3. Turn **"Allow new users to sign up" OFF** again.

From now on **only you (admin) create accounts** — from the in-app **Admin** panel — and you can **kick anyone out instantly** (they lose access on their very next click). Nobody can self-register.

---

## The answer model — Claude (and the legacy Cloud / HIPAA / Local modes)

**In the deployed setup, the answer model is Claude (Anthropic).** Your questions are answered by Claude reading your files (see "How the answer engine reads your files" above), authenticated with your `ANTHROPIC_API_KEY` on the Fly engine. **To change the Claude model** you set `AGENT_MODEL` on Fly (Sonnet for best answers, Haiku for cheapest) — see Step 3a. The in-app **Settings → Model → Cloud** panel, when it's used, stores an **Anthropic** key override (paste your `sk-ant-…`), matching this Claude-only path.

Nucleus **also** still carries the older **three-way model switch** (Cloud / HIPAA / Local) that drives the **legacy fallback** answer pipeline. It only takes over when `ANSWER_ENGINE` is unset, so on the deployed Claude setup you can ignore it. It remains available if you ever need it:

- **Cloud (legacy)** — a hosted OpenAI-compatible model (DeepSeek by default). An admin can paste a provider key in **Settings → Model** at request time. If you select a provider but save no key, it **fails closed**.
- **HIPAA** — a HIPAA-eligible hosted model (**Azure OpenAI** under a Microsoft BAA). You paste your Azure **endpoint + key + deployment name**. For your protection this mode **fails closed** — it **never** falls back to the shared cloud key, so PHI-intent traffic can't leak to a non-BAA provider. Setup details below.
- **Local** — the AI runs on **your own machine** (Ollama). Works self-hosted (app on the box) **or** with the hosted app via a **tunnel**. Full tested setup → **[LOCAL-MODEL.md](LOCAL-MODEL.md)**.

Each mode keeps its own saved key (write-only — saved, never shown back), all **in-app, no redeploy**.

---

## Knowledge Spaces & Connected Sources (for the owner)

**Knowledge Spaces** are topic folders that keep your files organized and keep answers focused.

- Every account **automatically gets 6 default spaces** the first time it opens the spaces view: **Finance, Contracts, HR, Projects, Legal, Sales.** This happens for new signups (on first load) and for existing accounts (on their next load). No setup needed.
- **Opening a space scopes your questions to that space's files** — a chat inside "Finance" sees every file you put in Finance (across any chat in that space) and **never** sees another space's files. This keeps, say, a legal question from pulling in HR spreadsheets.
- An **"Entire Workspace"** toggle flips off the per-space filter and searches **across all your spaces at once**.
- You can **create, rename, and delete** your own spaces. Deleting a space is permanent and only affects your own spaces. (Seeding runs **once** — if you delete a default space, it is **not** re-created.)

**Connected Sources** is a panel inside each space that lists where that space can read from.

- The **only real, working source today is "Uploaded Documents"** — the PDF / Excel / CSV (and Word) files you upload into that space. The answer engine reads **only** these uploaded files.
- The panel **also shows 9 "Coming soon" connector cards** — PDF Folder, SQLite, Excel, CRM, SharePoint, Google Drive, Outlook, REST API, Local Folder. **These are visual placeholders only.** They are **not connected**, do **not** feed the answer engine, and do **not** affect answers. They're labelled "Coming soon" on purpose so no one is misled into thinking they're live.
- Connecting to external systems (folders, databases, CRM, SharePoint, Google Drive, Outlook, REST APIs) is a **future phase**. **Today, only uploaded PDF / Excel / CSV documents actually work.**

## Editing how the assistant answers (your prompt)

Each signed-in user has **their own** answering style (system prompt). You can change it in **two places — both save the same per-user prompt**:

- **Answer Setup** strip (above the chat box): pick a style preset, or click **Edit prompt** to type your own, then **Save prompt**.
- **Settings → Prompts**: the full editor for the assistant persona + the document-urgency prompt, with **Save prompts**.

What to expect when you save:
- You'll see **"Saved"** only when the change was actually stored. If a save fails (e.g. you picked a cloud provider with no key, or the connection dropped), you now get a **clear red error** instead — it will **never show "Saved" for a change that didn't save.** (This fixes the earlier "I changed the prompt but it didn't stick" report — that was a save silently failing while still showing "Saved".)
- Your prompt is **private to you** and **persists** — reload, sign out and back in, or come back days later and your saved prompt is still there. One user's prompt never affects another's.

## When your documents don't fully cover a question

Nucleus always tries to **help**, not dead-end:

- If your files **contain** the answer, it answers from them and **cites** the exact page/row.
- If your files **partly** cover an **advice / "how should I" / recommendation** question, it grounds on what your files do say (cited) **and still gives you a substantive, ChatGPT-style recommendation** from general knowledge for the rest — it will **not** stop at "that isn't in your documents" or tell you to go find another file.
- If you ask for a **specific fact** that simply **isn't in your file** (e.g. a count or name the file never lists), it tells you so **honestly** rather than inventing one — that honest answer is the correct answer; it won't make up a fact about your data.
- A purely **general-knowledge** question (a definition, "what is the capital of …") is answered normally, with a note that it's general knowledge, not from your file.

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
| Organize files by topic | Use **Knowledge Spaces** (Finance / Contracts / … ; open one to scope questions to it) |
| Change the answer model | Set **`AGENT_MODEL`** on Fly (Sonnet ↔ Haiku), or paste an Anthropic key in **Settings → Model → Cloud** |
| Run the legacy fallback AI on my own machine (Local) | Switch to **Local** → **[LOCAL-MODEL.md](LOCAL-MODEL.md)** |
| Use a HIPAA model (Azure, legacy path) | Switch to **HIPAA**, paste Azure endpoint/key/deployment (fails closed) |
| Go live with real PHI | Azure + signed BAA + your own keys |

**You own all of it** — one repo (your GitHub), the website (your Vercel), the answer engine (your Fly), your Supabase (logins, files, Knowledge Spaces), and your Anthropic key. Nothing depends on the contractor's accounts after the setup steps.

*Technical deep-dive: see [PRD.md](PRD.md) and the repo's `.env.example`.*
