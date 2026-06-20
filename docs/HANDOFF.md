# Nucleus — Owner & Setup Guide

**For:** the owner (Jenny) and whoever helps her set it up — **a human engineer *or* an AI assistant.**

> 🤖 **Non-technical? Read this first.** You don't need to understand the technical steps. Open an AI assistant (Claude, ChatGPT, etc.), **paste this whole document in, and say: "Walk me through this one step at a time."** This guide is written so an AI can follow it precisely.

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
GEMINI_FS_MODEL=gemini-2.5-flash-lite     # the doc-query model (separate, cheaper quota)
# Create a Gemini File Search store once and pin its id (ask your AI: "create a Gemini
# File Search store with my key and give me its name").

# ── Logins & users (Supabase, from Project Settings → API) ──
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # server-side only, keep private

# ── Internal plumbing (set once) ──
INTERNAL_EMBED_TOKEN=<any-long-random-string>   # secures the app's internal helper call
# ASSISTANT_TODAY pins the sample data's "today" so demo numbers stay consistent;
# remove it for live use.
ASSISTANT_TODAY=2026-06-09
```

**Database setup:** the repo ships a Supabase migration (a `profiles` table + a trigger that gives each new signup a profile and makes the **first** user an **admin**). Apply it once: `supabase link --project-ref <your-ref>` then `supabase db push` (or paste the migration SQL into Supabase → SQL Editor).

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
| **Real hospital/legal data (PHI)** | Use **Google Vertex AI** or **Azure OpenAI** with a signed **HIPAA BAA**, your own keys. Switching the answer model is a config change (`LLM_*`), no rebuild. Never run real patient/legal data through a free developer key. |
| **Run the AI on your OWN hardware** | Flip the big **Cloud ⇄ Local** switch to **Local** and point it at your own model (e.g. Ollama). Only works when you **self-host** Nucleus on the same machine/network. **→ see [LOCAL-MODEL.md](LOCAL-MODEL.md).** |

---

## Cloud ⇄ Local — run the AI on your own machine

Nucleus has a prominent **Cloud ⇄ Local** switch (top of the Ask panel, and in **Settings → Model**). **Cloud** (the default) uses a hosted model; **Local** runs the AI on **your own hardware** (e.g. an Ollama model on your server). The hosted demo can only use **Cloud** — Local works when you **self-host** the app on the same machine/network as your model. Full step-by-step (run the repo on your box → install Ollama → enter your endpoint → flip the switch), the "serve my own clients from my own box" topology, and the honest "local model ≠ fully offline" caveat are in **→ [LOCAL-MODEL.md](LOCAL-MODEL.md)**.

---

## Quick reference

| I want to… | Do this |
|---|---|
| Log into the demo | The accounts above at `nucleus-woad.vercel.app/sign-in` |
| Make myself admin on my own copy | Step 3 (allow signups → sign up first → turn off) |
| Add / remove a user | Admin panel → create account / kick out |
| Add a document | **Upload** on the dashboard |
| Run the answers on Gemini (not DeepSeek) | Set the `LLM_PROVIDER=gemini` block (billing-enabled key) |
| Run the AI on my own machine (Local) | Self-host + flip the **Cloud ⇄ Local** switch → [LOCAL-MODEL.md](LOCAL-MODEL.md) |
| Stop document questions throttling | Turn on billing for your Gemini key |
| Go live with real PHI | Vertex/Azure + signed BAA + your own keys |

**You own all of it** — one repo (your GitHub), one app (your Vercel), your Supabase, your keys. Nothing depends on the contractor's accounts after Steps 1–3.

*Technical deep-dive: see [PRD.md](PRD.md) and the repo's `.env.example`.*
