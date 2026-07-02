# Nucleus — Setup Runbook (from scratch)

**For:** a human engineer **or** an AI assistant standing up Nucleus on **fresh accounts**, with **zero prior context.** Follow the steps in order; each ends with a **checkpoint** ("you should see X"). At the end there's a **smoke test** to prove each environment works.

> 🤖 **Non-technical?** Paste this whole file into an AI assistant and say *"Walk me through this one step at a time; I'm on \<Windows / Mac / Linux\>."* Every command is copy-pasteable. Replace anything in `<ANGLE_BRACKETS>` with your own value. **Never paste a real secret into a chat or commit it** — keys live only in Supabase, Vercel, and your local `.env.local` (which is git-ignored).

**What you're building:** a **two-service** system on your own accounts — (1) a Next.js **website (UI)** on **Vercel**, and (2) a separate **answer engine** on **Fly.io** (the `nucleus-agent` app) that reads your files and writes the answers using **Claude (Anthropic)**. Both are backed by one **Supabase** project that holds your logins, settings, history, **Knowledge Spaces**, and the private storage bucket for your uploaded files. The answer model is **Claude**, authenticated with an **Anthropic API key** (`sk-ant-…`). **No Google / Gemini / GCP is involved.** (Note: to *read* your documents, the engine uploads them to Anthropic's Files API — your files go to Anthropic to be read; see §3.)

**Prerequisites on your machine (for the deploy + local steps):**
- **Node.js 20+** and **pnpm** (`npm install -g pnpm`).
- The **Vercel CLI** (`npm install -g vercel`) — or use the Vercel dashboard.
- The **Fly.io CLI** (`flyctl`) — install per https://fly.io/docs/flyctl/install/ — for deploying the answer engine (§3).
- Optionally the **Supabase CLI** (`npm install -g supabase`) — or just use the Supabase dashboard SQL Editor.
- The repo cloned locally (canonical repo `github.com/qufeiz/nucleus-770`): `git clone https://github.com/qufeiz/nucleus-770 nucleus && cd nucleus`.

---

## 1. Supabase setup

Supabase is your database (logins, settings, history, **Knowledge Spaces**) **and** your private file storage. There is **no document-search index** — the current answer engine reads whole files via Anthropic (see §3).

### 1.1 Create the project
1. Go to **https://supabase.com** → sign in → **New project**.
2. Pick an **organization**, a **name** (e.g. `nucleus`), a strong **database password** (save it), and a **region** near your users. Create it and wait ~2 minutes for it to provision.

**Checkpoint:** the project dashboard loads and shows "Project is healthy."

### 1.2 Copy your three keys
Go to **Project Settings → API**. Copy these three values — you'll paste them into Vercel and (for local dev) into `.env.local`:

| Value (in the dashboard) | Env variable name the app reads | Secret? |
|---|---|---|
| **Project URL** (e.g. `https://abcdefgh.supabase.co`) | `NEXT_PUBLIC_SUPABASE_URL` **and** `SUPABASE_URL` (set both equal) | no (public) |
| **Project API keys → `anon` `public`** | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | no (public) |
| **Project API keys → `service_role` `secret`** | `SUPABASE_SERVICE_ROLE_KEY` | **YES — keep private** |

> The `service_role` key bypasses all row-level security and is used **server-side only**. Never expose it to the browser, never commit it. The two `NEXT_PUBLIC_` values are the only ones that are meant to be public.

### 1.3 (No `vector` extension needed)
The current answer engine does **not** use Postgres `pgvector` — there is no self-hosted search index. You can skip enabling the `vector` extension. *(The old migration `006` still enables it if you apply every migration; that's harmless, but it is not required.)*

### 1.4 Apply all sixteen migrations
The migrations live in `supabase/migrations/` (`001` … `016`). They are **idempotent** (safe to re-run). Apply them **in order**.

**Easiest (dashboard):** Supabase → **SQL Editor** → **New query** → open each file in order, paste its full contents, click **Run**. Repeat through `016`. The load-bearing ones for the current app:

| # | File | Creates |
|---|---|---|
| 1 | `001_profiles_and_roles.sql` | `profiles` + signup trigger; **first user becomes admin**; per-user isolation foundation. |
| 2 | `002_engine_settings.sql` | `engine_settings` — persists saved keys, editable prompts, and internal flags (incl. the "spaces seeded" flag) across instances. |
| 3 | `003_ask_history.sql` | `ask_history` — per-user question/answer/citation log. |
| 4 | `004_ask_sessions.sql` | adds `session_id` → multi-turn chat conversations. |
| 5 | `005_deleted_sources.sql` | `deleted_sources` — admin can hide a bundled doc/table from answers. |
| 7 | `007_session_titles.sql` | `session_titles` — rename a conversation. |
| 8 | `008_ask_history_trace.sql` | adds `inspector` + `evidence` columns so a past answer replays its real "why" panel. |
| 9 | `009_profile_is_demo.sql` | `is_demo` on `profiles` — gates the bundled sample corpus so a **real** user starts with a **clean bucket**. |
| 13–15 | `013`–`015` | per-user settings + **per-chat document scoping** (uploads linked to the chat they were added in). |
| 16 | `016_knowledge_spaces.sql` | `knowledge_spaces` + `session_spaces` — the tables that power **Knowledge Spaces**. **Required.** |

> Migrations `006`, `010`, `011`, `012` belong to the **old, removed** document-search pipeline (`006_doc_chunks.sql` created a `doc_chunks` / `pgvector` / `hybrid_match` store). The live engine never reads them — applying them is harmless but optional, and **you do not need the `vector` extension.**

**CLI alternative** (from the repo root):
```bash
supabase link --project-ref <YOUR_PROJECT_REF>   # the ref is the subdomain of your Project URL
supabase db push                                  # applies everything in supabase/migrations/
```

**Checkpoint:** Supabase → **Table Editor** shows `profiles` (with an `is_demo` column), `engine_settings`, `ask_history`, `deleted_sources`, `session_titles`, `knowledge_spaces`, and `session_spaces`. *(There is no `doc_chunks` table or `hybrid_match` function to verify — those belong to the removed search pipeline.)*

### 1.5 Create the `documents` storage bucket
Uploaded files keep their **original bytes** in Supabase Storage. **This bucket is load-bearing for answering:** at answer time the engine fetches these bytes and uploads them to Anthropic's Files API so Claude can read them — so a missing bucket means uploaded docs **cannot be read**, not just "can't be downloaded later." The app will **auto-create** this bucket on the first upload *if* the service-role key has storage permission — but create it up front to be safe:

1. Supabase → **Storage** → **New bucket**.
2. Name it **exactly** `documents`.
3. **Public** = **OFF** (private).
4. **Create**.

**Checkpoint:** **Storage** lists a **private** bucket named `documents`.

---

## 2. Vercel setup (the website / UI)

Vercel runs the Next.js **website**. It does **not** answer questions itself — it forwards each question to the Fly answer engine (§3). Deploy Vercel first, then Fly, then come back and fill in `FLY_AGENT_URL`.

### 2.1 Import the repo
1. Go to **https://vercel.com** → **Add New… → Project** → import your `nucleus` GitHub repo.
2. Framework preset: **Next.js** (auto-detected). Leave build/output defaults.
3. **Don't deploy yet** — set the environment variables first (next step), or the first build will deploy unconfigured.

*(CLI alternative: from the repo root run `vercel link` and follow the prompts.)*

### 2.2 Set the environment variables — durably

> ⚠️ **Why not `vercel deploy -e KEY=val`?** The `-e` flag injects a variable into **that single build only.** The next time anyone redeploys (a git push, a dashboard "Redeploy", a rollback), the variable is **gone** — and the app silently breaks (e.g. the answer model loses its key). **Always set variables durably** with `vercel env add` or the dashboard, so every future build inherits them.

**Dashboard:** Vercel → your project → **Settings → Environment Variables** → add each of the following (select the **Production** environment; add **Preview**/**Development** too if you want preview deploys to work):

```bash
# ── Point the website at the Fly answer engine (fill FLY_AGENT_URL after §3) ──
FLY_AGENT_URL=https://nucleus-agent.fly.dev        # the Fly app's URL
INTERNAL_AGENT_TOKEN=<ANY_LONG_RANDOM_STRING>      # MUST match the same secret on Fly (§3)

# ── Supabase ──
NEXT_PUBLIC_SUPABASE_URL=https://<YOUR_REF>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<YOUR_SUPABASE_ANON_KEY>
SUPABASE_SERVICE_ROLE_KEY=<YOUR_SUPABASE_SERVICE_ROLE_KEY>
SUPABASE_URL=https://<YOUR_REF>.supabase.co        # EQUAL to NEXT_PUBLIC_SUPABASE_URL

# ── Do NOT set ASSISTANT_TODAY on real data (it freezes "today" for the sample demo only) ──
```

**CLI alternative** (run once per variable; it prompts for the value so the secret isn't in your shell history):
```bash
vercel env add FLY_AGENT_URL production
vercel env add INTERNAL_AGENT_TOKEN production
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add SUPABASE_URL production
```

**Variable reference (exact names the code reads) — Vercel UI:**

| Variable | Required? | One-line description |
|---|---|---|
| `FLY_AGENT_URL` | yes | URL of the Fly answer engine (e.g. `https://nucleus-agent.fly.dev`). `/api/ask` forwards each question here. |
| `INTERNAL_AGENT_TOKEN` | yes | Shared secret sent as `x-agent-token`; **must match** the same secret on Fly, or the engine returns 401. |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Your Supabase Project URL (sent to the browser for auth). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase anon/public key (browser auth). |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase **secret** key (server-side DB + storage writes). Keep private. |
| `SUPABASE_URL` | recommended | Server-side Supabase URL; **set equal to the public URL** so server paths and admin settings persist correctly. |
| `ASSISTANT_TODAY` | **leave unset on live data** | Freezes "today" for the sample demo's date math. Setting it on real data gives stale answers. |

> **The answer model is Claude, configured on Fly — not here.** To change the answer model, set `AGENT_MODEL` on the Fly engine (§3), not `LLM_*`. The `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` variables are **legacy/optional** — they only drive the old fallback pipeline (Cloud=DeepSeek, HIPAA=Azure, Local=Ollama) that runs solely when `ANSWER_ENGINE` is unset. They are **not required** for the deployed Claude setup. (`INTERNAL_EMBED_TOKEN` and `NUCLEUS_SELF_URL` from earlier versions are **no longer used** — they guarded an internal embedding call that has been removed.)

### 2.3 Deploy
- **Dashboard:** click **Deploy** (or **Redeploy** if you imported earlier). Wait for **Ready**.
- **CLI:** `vercel --prod`.

### 2.4 Confirm the live deploy is actually configured
A green "Ready" badge means the build succeeded — **not** that the keys are wired. Confirm with a live request:

```bash
# The app's home/sign-in page should return HTTP 200:
curl -sI https://<YOUR_APP>.vercel.app/sign-in | head -1
# → expect: HTTP/2 200

# The upload endpoint advertises its real limits/formats (proves the app boots + routes):
curl -s https://<YOUR_APP>.vercel.app/api/ingest
# → expect JSON like: {"maxBytes":15728640,"maxMb":15,"formats":["PDF","CSV","XLSX"]}
```

**Checkpoint:** both return as above. If `/sign-in` is not 200 or the JSON is missing, re-check the environment variables (most often a missing/misnamed Supabase variable, or `FLY_AGENT_URL` not yet set) and redeploy.

---

## 3. Fly answer engine (`nucleus-agent`)

This is the second service — the one that actually **reads your files and writes the answers** using Claude. It runs from the same repo (there's a `fly.toml` at the repo root, `app = "nucleus-agent"`, region `iad`, `min_machines_running = 1`, so it stays warm; ~$10–15/mo).

> **Privacy note:** at answer time this engine uploads your files to **Anthropic's Files API** so Claude can read them. Your files go to Anthropic to be read.

### 3.1 Deploy the engine
From the repo root:
```bash
flyctl auth login
flyctl deploy -a nucleus-agent        # builds + deploys using the repo-root fly.toml
```
*(If the app doesn't exist yet, `flyctl launch --no-deploy` once to create it against the existing `fly.toml`, then `flyctl deploy`.)*

### 3.2 Set the engine's secrets
Set these as **Fly secrets** (they persist across deploys, unlike `-e` build flags):
```bash
flyctl secrets set ANSWER_ENGINE=messages -a nucleus-agent            # selects the Claude Messages + code-execution engine
flyctl secrets set ANTHROPIC_API_KEY=sk-ant-... -a nucleus-agent      # the billed key that reads files + writes answers
flyctl secrets set AGENT_MODEL=claude-sonnet-4-6 -a nucleus-agent     # prod model pin (best answers). Omit for the cheaper
                                                                      #   in-code default claude-haiku-4-5. Allowed:
                                                                      #   claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-5
flyctl secrets set INTERNAL_AGENT_TOKEN=<SAME_VALUE_AS_ON_VERCEL> -a nucleus-agent
# The engine also fetches your files from Supabase, so give it the same Supabase values:
flyctl secrets set NEXT_PUBLIC_SUPABASE_URL=https://<YOUR_REF>.supabase.co -a nucleus-agent
flyctl secrets set SUPABASE_URL=https://<YOUR_REF>.supabase.co -a nucleus-agent
flyctl secrets set SUPABASE_SERVICE_ROLE_KEY=<YOUR_SUPABASE_SERVICE_ROLE_KEY> -a nucleus-agent
```

**Engine variable reference (Fly secrets):**

| Variable | Required? | One-line description |
|---|---|---|
| `ANSWER_ENGINE` | yes | Set to `messages` to select the Claude Messages API + code-execution engine (`agentic` selects the Agent-SDK subprocess variant; unset falls back to the removed-era hybrid RAG pipeline). |
| `ANTHROPIC_API_KEY` | yes | The billed Anthropic key (`sk-ant-…`) Claude uses to read files and write answers. (Locally you can instead use `ANTHROPIC_AUTH_TOKEN`, a Claude-subscription bearer, so dev/tests don't spend the billed key.) |
| `AGENT_MODEL` | optional (prod pin) | Server-side model override, read only when the request sends no explicit model. Prod = `claude-sonnet-4-6`; code default = `claude-haiku-4-5`. Change/revert with `flyctl secrets set/unset AGENT_MODEL -a nucleus-agent`. |
| `INTERNAL_AGENT_TOKEN` | yes | Shared secret; must equal the value on Vercel. The `/api/agent` endpoint rejects calls without a matching `x-agent-token` with 401. |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | yes | Let the engine fetch your uploaded file bytes to send to Anthropic. |

### 3.3 Confirm the engine
The engine should **reject** an unauthenticated call (that proves it's up and the token gate works):
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://nucleus-agent.fly.dev/api/agent
# → expect: 401  (missing/incorrect x-agent-token)
```
Then set `FLY_AGENT_URL=https://nucleus-agent.fly.dev` on Vercel (§2.2) and redeploy the UI so the website can reach the engine.

**Checkpoint:** the curl returns `401`; `flyctl logs -a nucleus-agent` shows an `[agentic] resolve … model=…` line naming your model when you later ask a real question.

---

## 4. First admin + lock the door

There are **no prebuilt accounts** on your instance. Create the first admin:

1. Supabase → **Authentication → Sign-in / Providers** → temporarily turn **"Allow new users to sign up" ON**.
2. Open `https://<YOUR_APP>.vercel.app/sign-in` → **sign up** with your email/password. The **first** account automatically becomes the **admin** (the `001` migration's trigger seeds it).
3. Supabase → turn **"Allow new users to sign up" OFF** again.

**Checkpoint:** signed in, you see the **Admin** panel (Users). From here only you create accounts; you can deactivate anyone and they're bounced on their next click.

---

## 5. Run it locally (optional — for development)

You can run the whole app on your own machine. Logins/files still use your Supabase. For **local answers** you set `ANSWER_ENGINE=messages` and authenticate to Claude — either with a billed `ANTHROPIC_API_KEY`, or (recommended for dev) with `ANTHROPIC_AUTH_TOKEN`, a Claude-subscription bearer, so local runs don't spend the billed key.

```bash
# from the repo root:
pnpm install
pnpm approve-builds --all   # IMPORTANT on this stack: approve native build scripts (e.g. sharp).
                            # Without it, pnpm blocks them and `pnpm dev` can exit before serving
                            # (ERR_PNPM_IGNORED_BUILDS).
```

Create a **`.env.local`** in the repo root (it is git-ignored) with your Supabase values plus the Claude engine selector. In local dev the app runs as a **single process** (no separate Fly service), so leave `FLY_AGENT_URL` unset and the engine runs in-process:

```bash
ANSWER_ENGINE=messages
ANTHROPIC_AUTH_TOKEN=<YOUR_CLAUDE_SUBSCRIPTION_BEARER>   # dev auth (doesn't spend the billed key);
                                                         #   OR use ANTHROPIC_API_KEY=sk-ant-... instead
# AGENT_MODEL=claude-haiku-4-5                            # optional; code already defaults to Haiku locally
NEXT_PUBLIC_SUPABASE_URL=https://<YOUR_REF>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<YOUR_SUPABASE_ANON_KEY>
SUPABASE_SERVICE_ROLE_KEY=<YOUR_SUPABASE_SERVICE_ROLE_KEY>
SUPABASE_URL=https://<YOUR_REF>.supabase.co
```

Then:
```bash
pnpm dev      # serves http://localhost:3000
```

**Checkpoint:** `http://localhost:3000/sign-in` loads. (Bundled sample docs are committed under `data/` and are read the same way as uploads — the raw file is fed to Anthropic's Files API + code-execution sandbox — so there is no index to build.)

> To run the **legacy fallback answer model on your own hardware** (Ollama, via the `LLM_*` path) — self-hosted or via a tunnel from the hosted app — see **[LOCAL-MODEL.md](LOCAL-MODEL.md)**.

---

## Smoke tests

Run this once per environment (local, then the live Vercel app) to prove the whole chain works.

1. **Sign in** at `/sign-in` as your admin.
2. **Ask a built-in (golden) question** about the sample data, e.g.:
   - *"Which contracts expire in the next 90 days?"* (structured-data lane), or
   - *"What does the maintenance data say about the highest-spend vendor?"*
   - **Expect:** a concrete answer **with a citation** (a source chip / `[P:...#page]`-style reference). Open the **Inspector** ("why this answer") and confirm it shows the evidence — the files/sources the model declared it used.
3. **Upload a document** (a small PDF, CSV, or XLSX ≤ 15 MB) via the **Upload** control on the dashboard.
4. **Ask about the uploaded document** → **Expect:** a cited answer that quotes/points to the right part of *your* file. (This proves the real path: the original bytes are stored in the `documents` bucket → uploaded to Anthropic's Files API at answer time → read in the code-execution sandbox — Python/pandas for spreadsheets/CSV, native document block for PDFs — and Claude answers with a `SOURCES_USED:` line that drives the evidence panel.)
5. **(If you set up Hebrew docs)** ask a question in Hebrew about a Hebrew document → expect a cited Hebrew answer.
6. **Access control:** from **Admin**, create a second user, sign in as them in a private window, confirm they see **only their own** uploads; then deactivate them from Admin and confirm they're bounced.

If all six pass, the environment is good.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Answers work but **saved keys / prompt edits don't persist** | `SUPABASE_URL` not set (or not equal to the public URL) — server settings fell back to per-instance memory. Set it and redeploy. |
| Live app returns errors right after deploy | A required env variable is missing/misnamed, **or** it was passed with `vercel deploy -e` (non-persistent). Re-add durably via `vercel env add` / dashboard (or `flyctl secrets set` on the engine) and redeploy. |
| Questions hang or error, but the UI loads | The website can't reach the Fly engine. Check `FLY_AGENT_URL` (Vercel) points at the Fly app, and `INTERNAL_AGENT_TOKEN` is the **same** on both Vercel and Fly (a mismatch → 401). Confirm the engine is up: `curl -X POST https://nucleus-agent.fly.dev/api/agent` should return `401`. |
| Uploaded-doc answers come back ungrounded / "can't read the file" | The `documents` bucket is missing or the engine lacks Supabase access, so the file bytes never reached Anthropic — create the private `documents` bucket (step 1.5) and confirm the Supabase secrets are set on **Fly** too. |
| Answers use the wrong Claude model / cost too much | Check `AGENT_MODEL` on Fly. Set `claude-sonnet-4-6` for best answers, or unset it to fall back to the cheaper `claude-haiku-4-5` default. |
| Original uploaded file won't download | The `documents` storage bucket is missing or the service-role key lacks storage permission — create the private `documents` bucket (step 1.5). |
| `pnpm dev` exits immediately on your box | Run `pnpm approve-builds --all` (native build scripts were blocked — `ERR_PNPM_IGNORED_BUILDS`). |
| Legacy Local (Ollama) mode says "couldn't reach your local model" | See [LOCAL-MODEL.md](LOCAL-MODEL.md) — usually the endpoint URL or the tunnel's two required flags. (Only relevant if you're running the legacy `LLM_*` fallback path.) |

*Owner-level overview and the model-mode details are in **[HANDOFF.md](HANDOFF.md)**.*
