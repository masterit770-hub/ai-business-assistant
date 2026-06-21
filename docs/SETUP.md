# Nucleus — Setup Runbook (from scratch)

**For:** a human engineer **or** an AI assistant standing up Nucleus on **fresh accounts**, with **zero prior context.** Follow the steps in order; each ends with a **checkpoint** ("you should see X"). At the end there's a **smoke test** to prove each environment works.

> 🤖 **Non-technical?** Paste this whole file into an AI assistant and say *"Walk me through this one step at a time; I'm on \<Windows / Mac / Linux\>."* Every command is copy-pasteable. Replace anything in `<ANGLE_BRACKETS>` with your own value. **Never paste a real secret into a chat or commit it** — keys live only in Supabase, Vercel, and your local `.env.local` (which is git-ignored).

**What you're building:** one Next.js app deployed once to **Vercel**, backed by one **Supabase** project that holds your logins, your structured data, your uploaded documents, **and** the self-hosted document search (Postgres + `pgvector`). The answer model is a provider key (DeepSeek by default). **No Google / Gemini / GCP is involved** — document search is self-hosted (an earlier version used Google "Gemini File Search"; it was replaced).

**Prerequisites on your machine (for the deploy + local steps):**
- **Node.js 20+** and **pnpm** (`npm install -g pnpm`).
- The **Vercel CLI** (`npm install -g vercel`) — or use the Vercel dashboard.
- Optionally the **Supabase CLI** (`npm install -g supabase`) — or just use the Supabase dashboard SQL Editor.
- The repo cloned locally: `git clone <YOUR_NUCLEUS_REPO_URL> && cd nucleus`.

---

## 1. Supabase setup

Supabase is your database, your file storage, **and** your document search index. One project covers all three.

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

### 1.3 Enable the `vector` extension
Self-hosted document search needs Postgres's `pgvector`. **Migration `006` enables it for you** (its first line is `create extension if not exists vector;`), so if you apply the migrations below you can skip this. To do it by hand: **Database → Extensions** → search **`vector`** → **Enable**.

**Checkpoint:** **Database → Extensions** shows `vector` as **Enabled**.

### 1.4 Apply all eight migrations
The migrations live in `supabase/migrations/`. They are **idempotent** (safe to re-run). Apply them **in order**.

**Easiest (dashboard):** Supabase → **SQL Editor** → **New query** → open each file in order, paste its full contents, click **Run**. Repeat for all eight:

| # | File | Creates |
|---|---|---|
| 1 | `001_profiles_and_roles.sql` | `profiles` + signup trigger; **first user becomes admin**; per-user isolation foundation. |
| 2 | `002_engine_settings.sql` | `engine_settings` — persists model mode, saved keys, and editable prompts across instances. |
| 3 | `003_ask_history.sql` | `ask_history` — per-user question/answer/citation log. |
| 4 | `004_ask_sessions.sql` | adds `session_id` → multi-turn chat conversations. |
| 5 | `005_deleted_sources.sql` | `deleted_sources` — admin can hide a bundled doc/table from answers. |
| 6 | `006_doc_chunks.sql` | **the document search store**: enables `vector`, creates `doc_chunks` + the `hybrid_match` search function + per-user read security. **Core of self-hosted RAG.** |
| 7 | `007_session_titles.sql` | `session_titles` — rename a conversation. |
| 8 | `008_ask_history_trace.sql` | adds `inspector` + `evidence` columns so a past answer replays its real "why" panel. |

**CLI alternative** (from the repo root):
```bash
supabase link --project-ref <YOUR_PROJECT_REF>   # the ref is the subdomain of your Project URL
supabase db push                                  # applies everything in supabase/migrations/
```

**Checkpoint:** Supabase → **Table Editor** shows `profiles`, `engine_settings`, `ask_history`, `deleted_sources`, `doc_chunks`, and `session_titles`. (You can also run, in the SQL Editor, `select proname from pg_proc where proname in ('hybrid_match','match_doc_chunks');` — both functions should be listed.)

### 1.5 Create the `documents` storage bucket
Uploaded files keep their **original bytes** in Supabase Storage so they can be downloaded/verified later. The app will **auto-create** this bucket on the first upload *if* the service-role key has storage permission — but create it up front to be safe:

1. Supabase → **Storage** → **New bucket**.
2. Name it **exactly** `documents`.
3. **Public** = **OFF** (private).
4. **Create**.

**Checkpoint:** **Storage** lists a **private** bucket named `documents`.

---

## 2. Vercel setup

### 2.1 Import the repo
1. Go to **https://vercel.com** → **Add New… → Project** → import your `nucleus` GitHub repo.
2. Framework preset: **Next.js** (auto-detected). Leave build/output defaults.
3. **Don't deploy yet** — set the environment variables first (next step), or the first build will deploy unconfigured.

*(CLI alternative: from the repo root run `vercel link` and follow the prompts.)*

### 2.2 Set the environment variables — durably

> ⚠️ **Why not `vercel deploy -e KEY=val`?** The `-e` flag injects a variable into **that single build only.** The next time anyone redeploys (a git push, a dashboard "Redeploy", a rollback), the variable is **gone** — and the app silently breaks (e.g. the answer model loses its key). **Always set variables durably** with `vercel env add` or the dashboard, so every future build inherits them.

**Dashboard:** Vercel → your project → **Settings → Environment Variables** → add each of the following (select the **Production** environment; add **Preview**/**Development** too if you want preview deploys to work):

```bash
# ── Answer model (DeepSeek default) ──
LLM_PROVIDER=deepseek
LLM_API_KEY=<YOUR_ANSWER_MODEL_API_KEY>
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat

# ── Supabase ──
NEXT_PUBLIC_SUPABASE_URL=https://<YOUR_REF>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<YOUR_SUPABASE_ANON_KEY>
SUPABASE_SERVICE_ROLE_KEY=<YOUR_SUPABASE_SERVICE_ROLE_KEY>
SUPABASE_URL=https://<YOUR_REF>.supabase.co        # EQUAL to NEXT_PUBLIC_SUPABASE_URL

# ── Internal plumbing ──
INTERNAL_EMBED_TOKEN=<ANY_LONG_RANDOM_STRING>      # e.g. output of: openssl rand -hex 32

# ── Do NOT set ASSISTANT_TODAY on real data (it freezes "today" for the sample demo only) ──
```

**CLI alternative** (run once per variable; it prompts for the value so the secret isn't in your shell history):
```bash
vercel env add LLM_PROVIDER production
vercel env add LLM_API_KEY production
vercel env add LLM_BASE_URL production
vercel env add LLM_MODEL production
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add SUPABASE_URL production
vercel env add INTERNAL_EMBED_TOKEN production
```

**Variable reference (exact names the code reads):**

| Variable | Required? | One-line description |
|---|---|---|
| `LLM_PROVIDER` | yes | Cosmetic label for the active model in the UI/logs (e.g. `deepseek`). |
| `LLM_API_KEY` | yes | Bearer key for the answer model. (Without it, Cloud answers only work if an admin pastes a key in Settings.) |
| `LLM_BASE_URL` | yes | OpenAI-compatible base URL of the answer model (`https://api.deepseek.com`). |
| `LLM_MODEL` | yes | Model id at that provider (`deepseek-chat`). |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Your Supabase Project URL (sent to the browser for auth). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase anon/public key (browser auth). |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase **secret** key (server-side DB + storage writes). Keep private. |
| `SUPABASE_URL` | recommended | Server-side Supabase URL; **set equal to the public URL** so server paths and admin settings persist correctly. |
| `INTERNAL_EMBED_TOKEN` | yes | Shared secret guarding the app's internal `/api/embed` call (server-to-server). |
| `NUCLEUS_SELF_URL` | optional | The app's own base URL for the internal embed call. Auto-derived from `VERCEL_URL` on Vercel — only set for a custom host or local runs. |
| `ASSISTANT_TODAY` | **leave unset on live data** | Freezes "today" for the sample demo's date math. Setting it on real data gives stale answers. |
| `LOCAL_TIMEOUT_MS` | optional | Timeout (ms) for a Local-mode call; defaults to 45000. |

> To swap the answer model to a different provider, change `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` (e.g. point `LLM_BASE_URL` at any OpenAI-compatible endpoint). You can also leave env alone and have an admin **paste a provider key in-app** (Settings → Model → Cloud) — no redeploy.

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

**Checkpoint:** both return as above. If `/sign-in` is not 200 or the JSON is missing, re-check the environment variables (most often a missing/misnamed Supabase or LLM variable) and redeploy.

---

## 3. First admin + lock the door

There are **no prebuilt accounts** on your instance. Create the first admin:

1. Supabase → **Authentication → Sign-in / Providers** → temporarily turn **"Allow new users to sign up" ON**.
2. Open `https://<YOUR_APP>.vercel.app/sign-in` → **sign up** with your email/password. The **first** account automatically becomes the **admin** (the `001` migration's trigger seeds it).
3. Supabase → turn **"Allow new users to sign up" OFF** again.

**Checkpoint:** signed in, you see the **Admin** panel (Users). From here only you create accounts; you can deactivate anyone and they're bounced on their next click.

---

## 4. Run it locally (optional — for development)

You can run the whole app on your own machine. Logins/documents/search still use your Supabase (or run fully offline if you also self-host Supabase — out of scope here).

```bash
# from the repo root:
pnpm install
pnpm approve-builds --all   # IMPORTANT on this stack: approve native build scripts (sharp,
                            # tesseract.js, etc). Without it, pnpm blocks them and `pnpm dev`
                            # can exit before serving (ERR_PNPM_IGNORED_BUILDS).
```

Create a **`.env.local`** in the repo root (it is git-ignored) with the same Supabase + LLM values you put in Vercel:

```bash
LLM_PROVIDER=deepseek
LLM_API_KEY=<YOUR_ANSWER_MODEL_API_KEY>
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
NEXT_PUBLIC_SUPABASE_URL=https://<YOUR_REF>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<YOUR_SUPABASE_ANON_KEY>
SUPABASE_SERVICE_ROLE_KEY=<YOUR_SUPABASE_SERVICE_ROLE_KEY>
SUPABASE_URL=https://<YOUR_REF>.supabase.co
INTERNAL_EMBED_TOKEN=<ANY_LONG_RANDOM_STRING>
```

Then:
```bash
pnpm dev      # serves http://localhost:3000
```

**Checkpoint:** `http://localhost:3000/sign-in` loads. (The bundled sample corpus is committed in `data-index/`, so you don't need to build any index — sample data is queryable out of the box.)

> To run the **answer model on your own hardware** (Ollama) — self-hosted or via a tunnel from the hosted app — see **[LOCAL-MODEL.md](LOCAL-MODEL.md)**.

---

## Smoke tests

Run this once per environment (local, then the live Vercel app) to prove the whole chain works.

1. **Sign in** at `/sign-in` as your admin.
2. **Ask a built-in (golden) question** about the sample data, e.g.:
   - *"Which contracts expire in the next 90 days?"* (structured-data lane), or
   - *"What does the maintenance data say about the highest-spend vendor?"*
   - **Expect:** a concrete answer **with a citation** (a source chip / `[P:...#page]`-style reference). Open the **Inspector** ("why this answer") and confirm it shows the route + the retrieved passages.
3. **Upload a document** (a small PDF, CSV, or XLSX ≤ 15 MB) via the **Upload** control on the dashboard. Wait for it to finish indexing.
4. **Ask about the uploaded document** → **Expect:** a cited answer that quotes/points to the right page of *your* file. (This proves the self-hosted RAG path: extract → embed → store in `doc_chunks` → hybrid retrieve → cite.)
5. **(If you set up Hebrew docs)** ask a question in Hebrew about a Hebrew document → expect a cited Hebrew answer.
6. **Access control:** from **Admin**, create a second user, sign in as them in a private window, confirm they see **only their own** uploads; then deactivate them from Admin and confirm they're bounced.

If all six pass, the environment is good.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Answers work but **model switch / saved keys / prompt edits don't persist** | `SUPABASE_URL` not set (or not equal to the public URL) — server settings fell back to per-instance memory. Set it and redeploy. |
| Live app returns errors right after deploy | A required env variable is missing/misnamed, **or** it was passed with `vercel deploy -e` (non-persistent). Re-add durably via `vercel env add` / dashboard and redeploy. |
| Uploaded-doc answers fail with "no extractable text" | The PDF is a **scan** and OCR couldn't read it in the serverless function (OCR is best-effort). Try a born-digital PDF, or a clearer scan; CSV/XLSX are unaffected. |
| Original uploaded file won't download | The `documents` storage bucket is missing or the service-role key lacks storage permission — create the private `documents` bucket (step 1.5). Indexing/answers still work without it; only the original-file download is affected. |
| `pnpm dev` exits immediately on your box | Run `pnpm approve-builds --all` (native build scripts were blocked — `ERR_PNPM_IGNORED_BUILDS`). |
| Local mode says "couldn't reach your local model" | See [LOCAL-MODEL.md](LOCAL-MODEL.md) — usually the endpoint URL or the tunnel's two required flags. |

*Owner-level overview and the model-mode details are in **[HANDOFF.md](HANDOFF.md)**.*
