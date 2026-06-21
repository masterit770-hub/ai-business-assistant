# Nucleus — Owner & Setup Guide

**For:** the owner (Jenny) and whoever helps her set it up — **a human engineer *or* an AI assistant.**

> 🤖 **Non-technical? Read this first.** You don't need to understand the technical steps. Open an AI assistant (Claude, ChatGPT, etc.), **paste this whole document in, and say: "Walk me through this one step at a time."** This guide is written so an AI can follow it precisely — and by the end, the **entire system** (the app, your logins database, document search, and the AI model — including the HIPAA and offline options) runs on **your own accounts**, depending on nothing of the contractor's.

---

## What Nucleus is (plain English)

An **AI business assistant** that answers questions about **your documents and data** — with a **citation** for every answer, so you can trust where it came from.

- **Upload** PDFs, scanned documents, Excel/CSV → **ask a question** → get a **cited answer**.
- Answers pull from **both** your uploaded documents **and** your structured data (contracts, maintenance spend, etc.) in one reply.
- Works in **English and Hebrew**.
- **You control access:** you create user accounts, and you can **remove anyone instantly**. Each person only sees **their own** uploaded documents.

---

## Two ways to use it

### A) Try the live demo right now (running on the contractor's infrastructure)

**https://nucleus-woad.vercel.app** → sign in at **/sign-in** with:

| Role | Email | Password |
|---|---|---|
| **Admin** — manage users, kick people out, see all documents | `nucleus.admin@meridian.co` | `Demo-Admin-2026!` |
| **Member** — sees only their own uploaded documents | `nucleus.user@meridian.co` | `Demo-User-2026!` |

> Demo accounts on the showcase instance (sample data). Change/delete them before any real use. Passwords are intentionally kept out of source control.

### B) Set up your own (so you own everything) — the rest of this guide.

---

## How it's built (one app)

Nucleus is **a single Next.js web application** that you deploy **once**. It contains everything — the website you log into **and** the "brain" that retrieves and writes the cited answers (routing, the SQL lane for your tables, document search, the citation/verification gate). There is **no second service to deploy or wire up.**

- Hosting: **Vercel** (one project).
- Logins & users: **Supabase** (your database).
- Document search for *uploaded* files: **Google Gemini File Search**.
- The sentence-writing model: an **answer model** — DeepSeek by default in the demo; swap to **your own Gemini** (or Azure/Vertex) for production. One config line.

> *(Internally the app keeps one small helper function for text-embedding; it's part of the same deployment — nothing extra for you to manage.)*

---

## Step 1 — Open your accounts (all free to start)

| Account | What it's for | Link |
|---|---|---|
| **GitHub** | Holds the code (you already have the `ai-business-assistant` repo — accept the invite). | github.com |
| **Vercel** | Runs the app. | vercel.com |
| **Supabase** | Your users/logins database. | supabase.com |
| **Google AI Studio** (Gemini) | Reading & searching your uploaded documents. | aistudio.google.com |
| **An answer-model key** | Writing the answers — **DeepSeek** (cheap) or, for regulated data, **Azure OpenAI / Google Vertex** with a HIPAA BAA. | platform.deepseek.com |

---

## Step 2 — Deploy the app to Vercel + set the settings

Your helper imports the **one** repo into Vercel and sets these environment variables (Vercel → Project → Settings → Environment Variables). The repo's `.env.example` has the annotated list.

```bash
# ── The answer model (writes the sentences) ──
LLM_PROVIDER=deepseek
LLM_API_KEY=<your-key>
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
#   → To run on YOUR Gemini instead (recommended for production), use:
#     LLM_PROVIDER=gemini
#     LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
#     LLM_MODEL=gemini-2.5-flash   (use a BILLING-ENABLED key — see Free vs paid)

# ── Documents (Gemini File Search) ──
GEMINI_API_KEY=<your-gemini-key>
GOOGLE_API_KEY=<same-gemini-key>          # the Google SDK reads THIS name — set both equal
GEMINI_FS_MODEL=gemini-2.5-flash-lite     # the doc-query model (separate, cheaper quota)
GEMINI_FILE_SEARCH_STORE=                 # leave blank for the FIRST deploy → the app creates
#   a store when you upload your first document. Then PIN it: read the created store name and
#   paste it here (Vercel env) so every instance shares ONE store. If you skip this, later
#   uploads can scatter across new stores. (Ask your AI: "upload a test doc, find the
#   GEMINI_FILE_SEARCH_STORE name the app created, and set it in Vercel.")

# ── Logins & users (Supabase, from Project Settings → API) ──
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # server-side only, keep private

# ── Internal plumbing (set once) ──
INTERNAL_EMBED_TOKEN=<any-long-random-string>   # secures the app's internal helper call
# ASSISTANT_TODAY: DO NOT SET on your real data — leave it unset so "today" is the actual
#   date (so "expiring in the next 90 days" computes correctly). It exists only to freeze
#   the sample demo's numbers; setting it on live data gives wrong, stale answers.
```

**Database setup — apply BOTH migrations** in `supabase/migrations/` (the second is **required**, or your model switch + saved keys + prompts won't persist):
- `001_profiles_and_roles.sql` — a `profiles` table + a trigger that gives each signup a profile and makes the **first** user an **admin**.
- `002_engine_settings.sql` — the `engine_settings` table that persists your **model mode, per-mode keys, and editable prompts** across the serverless instances.

Easiest path (AI-friendly): Supabase → **SQL Editor** → paste the contents of each file → Run. (Or with the CLI: `supabase link --project-ref <your-ref>` then `supabase db push`.) Verify: Supabase → **Table Editor** should now show `profiles` and `engine_settings`.

---

## Step 3 — Make yourself the first admin (one time) + lock the door

There are **no prebuilt accounts** on your own instance. You make yourself admin:

1. Supabase → **Authentication → Sign-in/Providers** → temporarily turn **"Allow new users to sign up" ON**.
2. Open your app, **sign up** with your email → the **first** account becomes the **admin**.
3. Turn **"Allow new users to sign up" OFF** again.

From now on **only you (admin) create accounts** — from the in-app **Admin** panel — and you can **kick anyone out instantly** (they lose access on their very next click). Nobody can self-register.

---

## Step 4 — Try it

Sign in → ask about your built-in data (you'll get cited answers) → **Upload** a document → ask about it → cited answer → add a teammate from **Admin**, then deactivate them and watch them get bounced.

---

## Free vs. paid, and real patient/legal data

| Your situation | What to use |
|---|---|
| **Demo / trying it out** | The **free** Gemini tier is fine. Note: it has a **daily limit** — under heavy use, *uploaded-document* questions may say "try again." That's the free rate limit, not a bug (it costs nothing). Questions about your existing data stay instant. |
| **Real, regular use** | Turn on **billing** for your Gemini key (pennies per question) so it never throttles, and point the **answer model** at Gemini too. |
| **Real hospital/legal data (PHI)** | Switch the model to **HIPAA** mode (Settings → Model), paste your **Azure OpenAI** key + endpoint — no redeploy. It **fails closed** (never uses the shared cloud key). Requires a signed **HIPAA BAA** with Microsoft + a covered Azure resource. Never run real patient/legal data through a free developer key. |
| **Run the AI on your OWN hardware** | Switch to **Local** and point it at your own model (Ollama) — works **self-hosted** *or* with the hosted app via a **tunnel**. Click **Detect models** to pick. **→ [LOCAL-MODEL.md](LOCAL-MODEL.md)** (tested, both ways + 24/7). |

---

## Three model modes — Cloud / HIPAA / Local

Nucleus has a **three-way model switch** (top of the Ask panel, and in **Settings → Model**), and **each mode keeps its own saved key**, so you enter them once and flip freely:

- **Cloud** (the default) — a hosted model. Paste **any** OpenAI-compatible key (DeepSeek, OpenAI, Gemini, …); with no key it uses the demo's configured default. Best for everyday use.
- **HIPAA** — a HIPAA-eligible hosted model. Paste your **Azure OpenAI** key + resource endpoint + deployment name. For your protection this mode **fails closed** — it never falls back to the shared cloud key, so PHI-intent traffic can't leak to a non-BAA provider. *(Labeled "HIPAA-eligible under a Microsoft BAA" — eligibility also requires you to sign a BAA with Microsoft and use a covered Azure resource. Google Vertex under a BAA is also possible but needs service-account auth, not a pasted key — ask your helper if you need Vertex.)*
- **Local** — the AI runs on **your own machine** (Ollama). Enter your endpoint and click **Detect models on your box** to pick from what you've installed. Works **self-hosted** (app on the box) **or** with the hosted Vercel app via a **tunnel**. Full tested setup (both ways, the 24/7 self-healing tunnel, the model trade-off) → **[LOCAL-MODEL.md](LOCAL-MODEL.md)**.

All of this is in-app (Settings → Model) — **no redeploy**. Keys are write-only (saved, never shown back).

---

## Set up Azure OpenAI as your HIPAA-eligible AI backend

*(Only if you'll run real patient/legal data. Skip otherwise.)* This connects the app's **HIPAA mode** to Microsoft's Azure OpenAI. By the end you'll have **four values** to paste into **Settings → Model → HIPAA**: an **Endpoint**, an **API key**, a **Deployment name**, and (already defaulted) an **API version**. Your AI helper can do most of the clicking; you approve and copy/paste.

> Set everything up in a **United States region** and keep it there — HIPAA coverage applies to US-hosted resources.

### 1. Create an Azure account + subscription
1. Go to **https://azure.microsoft.com** → **Start free** (or sign in if your business already has an account).
2. Sign up with a work email, phone, and a credit card (identity check; the free tier doesn't charge unless you exceed it). This creates your **subscription** (billing container).
3. **Cost:** opening the account is free. Azure OpenAI is **pay-as-you-go** (billed per million "tokens"). A light internal workload is usually a few to low-tens of dollars/month. Set a **budget/alert** in **Cost Management** to avoid surprises.

### 2. Create an Azure OpenAI resource
1. In the **Azure portal** (https://portal.azure.com) → **Create a resource** → search **Azure OpenAI** → **Create**.
2. **Basics:** **Subscription** (step 1), **Resource group** (new, e.g. `hipaa-ai`), **Region** (a **US** region like *East US 2*), **Name** (e.g. `myclinic-openai`), tier **Standard**.
3. **Next** through the wizard → **Review + submit** → **Create** → **Go to resource**.
4. **Access (2026):** you generally **no longer fill out an access form** — Microsoft grants all customers access to standard models. (A form is only needed for *Limited Access* models or to turn off content filtering — not needed here.) ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/limited-access))

### 3. Deploy a model
1. Go to **https://ai.azure.com**, open your resource → **Deployments** (a.k.a. **Models + endpoints**).
2. **+ Deploy model → Deploy base model** → pick a current **GPT-4-class** model (**`gpt-4o`**, or **`gpt-4o-mini`** for lower cost) → **Confirm**.
3. **Set the Deployment name** (one of your four values) — type anything (e.g. `chat-gpt4o`) and **write down exactly what you typed**. Type **Standard** → **Deploy** → wait for **Succeeded**. ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/create-resource))

### 4. Copy the four values into the app
| App field (Settings → Model → HIPAA) | Where in Azure |
|---|---|
| **Endpoint** | Resource → **Keys and Endpoint** → **Endpoint** (e.g. `https://myclinic-openai.openai.azure.com`). |
| **API key** | Same page → **KEY 1** (or KEY 2). Treat like a password. |
| **Deployment name** | The exact name you typed in step 3. |
| **API version** | App **defaults** this — leave as-is. If ever needed, a recent stable one is **`2024-10-21`**. ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)) |

Paste the first three, save, flip to **HIPAA**. (HIPAA mode **fails closed** — until these are set it refuses to answer rather than fall back to the shared cloud model.)

### The HIPAA BAA — required, and your responsibility
- Azure OpenAI is a **HIPAA-eligible** service; Microsoft offers the **BAA as part of its standard Product Terms / DPA** — no separate per-product contract.
- For most customers the BAA is **already included** in an eligible agreement (a Microsoft **Enterprise Agreement** or a purchase via a **Cloud Solution Provider/partner**). On a basic pay-as-you-go account, **confirm with Microsoft (or your partner)** that your account is under a BAA-covering agreement *before* sending patient data. Terms: **https://www.microsoft.com/licensing/terms**. ([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/2258799/does-azure-openai-services-provide-hipaa-complianc))
- **Honest caveat:** having the BAA, keeping the resource in a **US region**, and using it within HIPAA practices is **your** responsibility. The app **cannot verify** your account is BAA-covered — it just sends requests to the endpoint/key you give it. Don't enter real patient data until you've confirmed coverage.

### Google Vertex AI (GCP alternative) — follow-up only
Google **Vertex AI** is a comparable HIPAA-eligible option, but it authenticates with a **service-account JSON / OAuth token**, not a pasted key — which the current "paste-a-key" HIPAA flow doesn't support. If you specifically need Google, flag it as a **follow-up** to be built; for now Azure is the supported path.

---

## Quick reference

| I want to… | Do this |
|---|---|
| Log into the demo | The accounts above at `nucleus-woad.vercel.app/sign-in` |
| Make myself admin on my own copy | Step 3 (allow signups → sign up first → turn off) |
| Add / remove a user | Admin panel → create account / kick out |
| Add a document | **Upload** on the dashboard |
| Run the answers on Gemini (not DeepSeek) | Set the `LLM_PROVIDER=gemini` block (billing-enabled key) |
| Run the AI on my own machine (Local) | Switch to **Local** (self-host or tunnel), **Detect models** → [LOCAL-MODEL.md](LOCAL-MODEL.md) |
| Use a HIPAA model (Azure) | Switch to **HIPAA**, paste your Azure key + endpoint (Settings → Model) — fails closed |
| Stop document questions throttling | Turn on billing for your Gemini key |
| Go live with real PHI | Vertex/Azure + signed BAA + your own keys |

**You own all of it** — one repo (your GitHub), one app (your Vercel), your Supabase, your keys. Nothing depends on the contractor's accounts after Steps 1–3.

*Technical deep-dive: see [PRD.md](PRD.md) and the repo's `.env.example`.*
