# Nucleus — Client Agent Bring-Up Runbook

**Audience:** an **AI coding assistant** (with a shell + a browser) standing up the entire Nucleus stack
**from zero on the CLIENT's own accounts.** Execute it top-to-bottom. Every phase ends with a **`VERIFY:`**
block — a concrete command/probe and its expected output. **Do not proceed past a phase whose VERIFY has
not passed.**

This is the machine-actionable companion to the human-facing `docs/HANDOFF.md` and `docs/SETUP.md`. Where
those explain *why*, this one gives *exact commands, exact console paths, and a pass/fail probe per step.*

> **Secrets discipline (non-negotiable).** Everything in `<ANGLE_BRACKETS>` is a placeholder you obtain and
> paste into a secret store (Vercel env / Fly secret / local `.env.local`). **Never** echo a real key into a
> chat transcript, a commit, a log line, or a shared file. Set every deployed variable **durably** (dashboard
> or `vercel env add` / `flyctl secrets set`) — never with `vercel deploy -e KEY=val`, which lives for one
> build only and then silently vanishes.

> **Cost discipline.** The Anthropic key is the only thing that costs money **per question**. Real answers are
> billed. During bring-up you make **exactly one** paid ask (Phase 5). All other verification is **zero-Claude**
> (HTTP probes, `pnpm test`, the knowledge-spaces journey). Do not sweep the paid path.

---

## What Nucleus is (one paragraph, so you know what you're wiring)

Two services the client owns, plus one database:
1. **Website / UI** — a Next.js app on **Vercel** (login, upload, chat). Always warm.
2. **Answer engine** — a small service on **Fly.io** (app `nucleus-agent`) that reads the client's files with
   **Claude (Anthropic)** and writes cited answers. Scales to zero when idle.
3. **Supabase** — Postgres (logins, settings, history, Knowledge Spaces) + a private Storage bucket
   (`documents`) holding uploaded file bytes.

When a user asks a question, Vercel's `/api/ask` forwards it to Fly's `/api/agent` over HTTPS with a shared
secret (`INTERNAL_AGENT_TOKEN`); the Fly engine fetches the relevant files from Supabase, uploads them to
Anthropic's Files API, Claude reads/computes over them, and the cited answer comes back. **There is no Google /
Gemini / GCP anywhere in the deployed path.**

---

## ASSUMPTIONS (verify before you start)

| Assumption | Detail |
|---|---|
| **OS** | macOS, Linux, or Windows via WSL2. You have a POSIX shell + a browser. |
| **Node.js** | **20+ minimum; Node 24 recommended** (the CI workflow and the Fly `Dockerfile` both build on Node 24). |
| **Package manager** | **pnpm** (the only committed lockfile is `pnpm-lock.yaml`; the Fly image uses `pnpm@11.5.2`). Install: `npm install -g pnpm`. See the **`npm ci` caveat** in Phase 0. |
| **Postgres client** | `psql` available (for applying migrations), **or** the Supabase CLI, **or** the Supabase dashboard SQL Editor. |
| **CLIs** | `git`, `curl`. Install `vercel` (`npm i -g vercel`), `flyctl` (https://fly.io/docs/flyctl/install/), optionally `supabase` (`npm i -g supabase`). |
| **Repo** | Canonical source is `github.com/masterit770-hub/ai-business-assistant` (client should fork or be granted access). |

## WHAT YOU NEED FROM THE HUMAN (an agent cannot do these alone)

Collect these up front; each blocks a specific phase.

- **Payment methods / cards** for: **Anthropic** (billed per ask — Phase 1/4), **Fly.io** (~pennies while serving; scale-to-zero — Phase 4). Vercel and Supabase start free.
- **Email + phone confirmations / 2FA** to create and verify the GitHub, Vercel, Fly.io, Supabase, and Anthropic accounts.
- **Interactive logins** you can't script: `vercel login`, `flyctl auth login`, `gh auth login` (or `supabase login`). Ask the human to run these (e.g. paste `! flyctl auth login` in the session).
- **Repo access:** you own `masterit770-hub/ai-business-assistant` already — just ensure your assistant has a token with read access.
- **Decisions:** the Vercel project name + subdomain, the Fly app name (default `nucleus-agent`) and region (default `iad`), the Supabase region, and the **answer-model pin** (Sonnet for best answers vs Haiku for cheapest — Phase 4).
- **An Anthropic monthly spend cap / alert** set in the Anthropic console (the client's key hit its cap once from over-testing; do this before real use).

---

## PHASE 0 — Prerequisites + clone

```bash
# 0.1 Tooling present?
node -v            # expect v20+ (v24 recommended)
pnpm -v            # expect 8+ (9/11 fine); if missing: npm install -g pnpm
git --version
curl --version | head -1
vercel --version   # if missing: npm install -g vercel
flyctl version     # if missing: install per https://fly.io/docs/flyctl/install/
psql --version     # OR: supabase --version  (either path works for migrations)

# 0.2 Clone the repo
git clone https://github.com/masterit770-hub/ai-business-assistant nucleus
cd nucleus

# 0.3 Install dependencies (native build scripts must be approved on this stack, or the
#     dev server can exit before serving with ERR_PNPM_IGNORED_BUILDS).
pnpm install
pnpm approve-builds --all
```

> **`npm ci` caveat (TODO-for-Chris):** `.github/workflows/ci.yml` runs `npm ci`, which requires a
> `package-lock.json` — but the repo commits only `pnpm-lock.yaml`. Use **`pnpm`** for all local install/test
> steps in this runbook. If you want CI green as written, either commit a `package-lock.json` or switch the CI
> workflow to pnpm. This does not block bring-up.

**VERIFY:**
```bash
node -v && pnpm -v && test -f pnpm-lock.yaml && echo "repo+tooling OK"
ls supabase/migrations | wc -l    # expect 17  (001 … 017)
```
Expected: versions print, `repo+tooling OK`, and `17`.

---

## PHASE 1 — Account registrations

Create each account in the browser (human confirms email/payment). Capture the listed values into your secret
notes (never into the repo).

| # | Account | Console path / action | Capture |
|---|---|---|---|
| 1.1 | **GitHub** | Fork or accept access to `github.com/masterit770-hub/ai-business-assistant`. | repo URL (git remote) |
| 1.2 | **Supabase** | https://supabase.com → **New project**. Pick org, name (`nucleus`), a strong **DB password** (save it), a **region** near users. Wait ~2 min for "Project is healthy". | **Project ref** (the subdomain of the Project URL), **DB password** |
| 1.3 | **Supabase keys** | **Project Settings → API**. | **Project URL** (`https://<ref>.supabase.co`), **anon public** key, **service_role secret** key |
| 1.4 | **Supabase DB conn** | **Project Settings → Database → Connection string → URI** (use the **Session/Direct** connection, port 5432). | the `postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres` URI (contains the DB password) |
| 1.5 | **Vercel** | https://vercel.com → sign up (link GitHub). You'll import the repo in Phase 4. | Vercel team/account |
| 1.6 | **Fly.io** | https://fly.io → sign up, **add a payment card**. `flyctl auth login`. | Fly account |
| 1.7 | **Anthropic** | https://console.anthropic.com → sign up, **add billing**, set a **monthly spend cap/alert**. **Create an API key** (`sk-ant-…`). | **`ANTHROPIC_API_KEY`** |

Also **generate a shared internal token** now (any long random string — used by both Vercel and Fly):
```bash
openssl rand -hex 32     # → copy the output; this is your INTERNAL_AGENT_TOKEN
```

**VERIFY:** you can name, without opening the repo's `.secrets/`, all of: Supabase Project URL, anon key,
service_role key, DB connection URI, `sk-ant-…` key, and the `INTERNAL_AGENT_TOKEN` you generated. If any is
missing, do not proceed — later phases will fail opaquely.

---

## PHASE 2 — Secrets matrix (the single source of truth)

Set **every** variable below in the place its row names. **Build-time** variables must exist *before* the build
runs; **runtime** variables are read on each request. All names are verified against the codebase (see the
appendix). `VERIFY` for landing is per-row; a whole-environment probe is at the end of Phases 4–5.

> **⚠️ The `NEXT_PUBLIC_*` build-time gotcha (from `CLAUDE.md`).** `next build` **bakes `NEXT_PUBLIC_*` into the
> browser JS bundle at build time.** On **Vercel**, the platform injects env vars into the build automatically —
> setting them in the dashboard is enough. On **Fly**, secrets are **runtime-only and do NOT reach the build**;
> the `Dockerfile` therefore accepts them as `--build-arg` (`ARG NEXT_PUBLIC_SUPABASE_URL` / `ARG
> NEXT_PUBLIC_SUPABASE_ANON_KEY`). In the **two-service split (the deployed setup), the browser loads from
> Vercel, not Fly**, so the Fly engine only needs these at **runtime** for its server-side Supabase reads — which
> `SUPABASE_URL` already covers. You must pass `--build-arg` on Fly **only if you serve the UI from Fly**
> (standalone/monolith mode). See Phase 4.

| # | Variable | Where it comes from | Where it is set | Build-time vs runtime | How to verify it landed |
|---|---|---|---|---|---|
| 1 | `FLY_AGENT_URL` | The Fly app's public URL (`https://nucleus-agent.fly.dev`). Fill **after** Phase 4 Fly deploy. | **Vercel** env | runtime (server) | `vercel env ls` shows it; a real ask returns `_engine.lane:"fly-agentic"` (Phase 5). |
| 2 | `INTERNAL_AGENT_TOKEN` | The random string from Phase 1 (`openssl rand -hex 32`). | **Vercel** env **AND** **Fly** secret — **identical value** | runtime (server) | `curl -X POST https://nucleus-agent.fly.dev/api/agent` → `401` (gate is live). A mismatch makes real asks fail 401. |
| 3 | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL (Phase 1.3). | **Vercel** env; **Fly** secret (runtime fallback); **Fly `--build-arg`** *only for a Fly-served UI* | Vercel: build-time (auto). Fly: runtime | View-source of the Vercel `/sign-in` page references the Supabase URL; server reads it via `SUPABASE_URL ?? NEXT_PUBLIC_SUPABASE_URL`. |
| 4 | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase **anon public** key (Phase 1.3). | **Vercel** env; **Fly `--build-arg`** *only for a Fly-served UI* | Vercel: build-time (auto) | Browser can reach Supabase auth on the Vercel app (sign-in loads, no console `undefined` errors). |
| 5 | `SUPABASE_URL` | Same Project URL as row 3 (set **equal** to it). | **Vercel** env **AND** **Fly** secret | runtime (server) | If unset, saved prompts/keys silently run in per-instance memory (Phase 6 troubleshooting). |
| 6 | `SUPABASE_SERVICE_ROLE_KEY` | Supabase **service_role secret** key (Phase 1.3). **Server-only, never to the browser.** | **Vercel** env **AND** **Fly** secret | runtime (server) | Upload + list of a document works (needs storage write); `supabaseEnabled()` gates every DB path. |
| 7 | `ANSWER_ENGINE` | Literal `messages` (selects the Claude Messages + code-execution engine). | **Fly** secret | runtime (server) | A real ask returns `_engine.answerEngine:"messages"` and Fly logs `[messages] resolve … model=…`. |
| 8 | `ANTHROPIC_API_KEY` | The `sk-ant-…` key (Phase 1.7). The **billed** key. | **Fly** secret | runtime (server) | A real ask returns a grounded answer; Fly logs `[messages] uploaded …` / `resolve`. |
| 9 | `AGENT_MODEL` | The model pin: `claude-sonnet-4-6` (prod default, best) or omit for the in-code default `claude-haiku-4-5` (cheapest). Allowed: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-5`. | **Fly** secret (optional) | runtime (server) | A real ask echoes `model` in the result; Fly log `resolve … model=<pin>`. Unset to revert to Haiku. |
| 10 | `ANTHROPIC_AUTH_TOKEN` | A Claude-**subscription** bearer, **local dev only** (so local runs don't spend the billed key). Alternative to `ANTHROPIC_API_KEY` locally. | **`.env.local`** (repo root, git-ignored) | runtime (server) | `pnpm dev` answers a question locally without a billed key. Never set this in prod. |
| 11 | `ASSISTANT_TODAY` | **Leave UNSET on real data.** Only freezes "today" for the sample demo's date math. | (nowhere, on live data) | runtime | Absent in `vercel env ls`; date questions compute against the real date. |

**Optional / legacy / mode-specific (NOT required for the deployed Claude setup):**

| Variable | Purpose | Set where |
|---|---|---|
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | The **legacy fallback** answer pipeline (OpenAI-compatible; DeepSeek default). Runs **only when `ANSWER_ENGINE` is unset.** Not used when `ANSWER_ENGINE=messages`. | Fly/Vercel, only if you deliberately run the fallback |
| `LOCAL_TIMEOUT_MS` | Timeout (ms, default 45000) for **Local (Ollama)** mode requests. | `.env.local` / Fly, only if using Local mode |
| `NEXT_PUBLIC_SITE_URL` | Overrides the base URL used to build **invite links** (`src/lib/account/invite.ts`). Auto-derived on Vercel; set only for a custom domain. | Vercel, optional |

Durable-set commands:
```bash
# Vercel (repeat per variable; prompts for the value so it's not in shell history):
vercel env add FLY_AGENT_URL production
vercel env add INTERNAL_AGENT_TOKEN production
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add SUPABASE_URL production

# Fly (persist across deploys):
flyctl secrets set ANSWER_ENGINE=messages -a nucleus-agent
flyctl secrets set ANTHROPIC_API_KEY=<sk-ant-…> -a nucleus-agent
flyctl secrets set AGENT_MODEL=claude-sonnet-4-6 -a nucleus-agent
flyctl secrets set INTERNAL_AGENT_TOKEN=<same-as-vercel> -a nucleus-agent
flyctl secrets set NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co -a nucleus-agent
flyctl secrets set SUPABASE_URL=https://<ref>.supabase.co -a nucleus-agent
flyctl secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key> -a nucleus-agent
```

**VERIFY:**
```bash
vercel env ls production        # rows 1–6 present, ASSISTANT_TODAY absent
flyctl secrets list -a nucleus-agent   # rows 2,5,6,7,8,9 present (values masked)
```

---

## PHASE 3 — Database bring-up

Supabase holds logins, settings, history, Knowledge Spaces, and the private file bucket. **No `vector`
extension and no search index are needed** — the engine reads whole files via Anthropic.

### 3.1 Apply all migrations, in order (001 → 017)

They are **idempotent** (safe to re-run). Load-bearing for the current app: `001, 002, 003, 004, 005, 007,
008, 009, 013, 014, 015, 016, 017`. Migrations `006, 010, 011, 012` belong to the **removed** search pipeline
(`doc_chunks` / pgvector / `uploaded_rows`) — harmless to apply but not required.

**psql (recommended, scriptable):**
```bash
# CONN = the Session/Direct URI from Phase 1.4 (contains the DB password). Do NOT echo it.
export CONN='postgresql://postgres:<DB_PASSWORD>@db.<ref>.supabase.co:5432/postgres'
for f in supabase/migrations/0*.sql; do
  echo "applying $f"
  psql "$CONN" -v ON_ERROR_STOP=1 -f "$f" || { echo "FAILED on $f"; break; }
done
```

**Supabase CLI alternative:**
```bash
supabase link --project-ref <ref>
supabase db push
```

**Dashboard alternative:** SQL Editor → paste each file's contents in order (`001` … `017`) → Run.

What the load-bearing migrations create (so you can sanity-check the schema):
- `001_profiles_and_roles` — `profiles` + a signup trigger; **the first user to sign up becomes admin** (the trigger promotes the earliest-created user when there is no admin). Foundation of per-user isolation.
- `002_engine_settings` — `engine_settings` (saved keys, editable prompts, the `spaces_seeded` flag).
- `003_ask_history` / `004_ask_sessions` / `007_session_titles` / `008_ask_history_trace` — the per-user Q&A log, chat sessions, rename, and the replayable "why" panel.
- `005_deleted_sources` — admin can hide a bundled source.
- `009_profile_is_demo` — `is_demo` gate so a **real client user starts with a clean bucket** (only demo accounts see the bundled sample corpus).
- `013`–`015` — per-user settings + **per-chat document scoping**.
- `016_knowledge_spaces` — `knowledge_spaces` + `session_spaces` (**required** by the current app).
- `017_anthropic_file_cache` — `anthropic_file_cache` (caches the Anthropic `file_id` per owner+doc+content SHA so identical bytes upload once; **RLS**: an owner sees only their own rows; the engine's service-role client bypasses RLS).

### 3.2 Create the private `documents` storage bucket

**Load-bearing for answering:** at answer time the engine fetches these bytes and uploads them to Anthropic. A
missing bucket means uploaded docs **cannot be read**. (The app auto-creates it on first upload if the
service-role key has storage permission, but create it up front.)

- Supabase → **Storage → New bucket** → name **exactly** `documents` → **Public = OFF** → **Create**.

### 3.3 RLS expectations

Per-user isolation is enforced two ways: **RLS policies** on the user-facing tables (e.g. `anthropic_file_cache`
`USING (owner_id = auth.uid())`), and **owner-scoped queries** in the engine. The engine and ingest paths use
the **service-role key**, which **bypasses RLS by design** — isolation for those server paths comes from the
`ownerId` scoping resolved server-side from the session, never from client input.

**VERIFY:**
```bash
# Tables exist (via psql):
psql "$CONN" -c "\dt public.*" | grep -E 'profiles|engine_settings|ask_history|deleted_sources|session_titles|knowledge_spaces|session_spaces|anthropic_file_cache'
# is_demo column exists:
psql "$CONN" -c "\d public.profiles" | grep is_demo
```
Expected: all of `profiles, engine_settings, ask_history, deleted_sources, session_titles, knowledge_spaces,
session_spaces, anthropic_file_cache` listed, and `is_demo` present. In **Storage**, a private bucket named
`documents` exists. *(You should NOT need to find a `doc_chunks` table or the `vector` extension.)*

---

## PHASE 4 — Deploys

Deploy Fly first (so you have its URL), then Vercel, then set `FLY_AGENT_URL` and redeploy Vercel.

### 4.1 Fly answer engine (`nucleus-agent`)

The repo root has `fly.toml` (`app = "nucleus-agent"`, `primary_region = "iad"`, **`min_machines_running = 0`**
— scale-to-zero: the machine suspends when idle and auto-resumes on the next request; **billing accrues only
while a request is being served**, and the first ask after a long idle is slightly slower).

```bash
flyctl auth login                       # human runs this
# First time only, if the app doesn't exist yet (creates it against the existing fly.toml):
flyctl launch --no-deploy               # accept the existing fly.toml; app name nucleus-agent
# Deploy:
flyctl deploy -a nucleus-agent
```
Secrets for the engine were set in Phase 2. (For a **Fly-served UI / monolith** only — not the split — add
`flyctl deploy --build-arg NEXT_PUBLIC_SUPABASE_URL=… --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=…` so the
browser bundle is baked; the split doesn't need this.)

**VERIFY (Fly):**
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://nucleus-agent.fly.dev/api/agent
# → expect 401  (engine is up; the x-agent-token gate works). 503 = INTERNAL_AGENT_TOKEN not set on Fly.
```

### 4.2 Vercel website (UI)

Git-link the repo so `main` auto-deploys.

```bash
# Dashboard: Vercel → Add New → Project → import the nucleus repo → framework auto-detects Next.js →
#   set env vars (Phase 2 rows 1–6) BEFORE the first deploy → Deploy.
# CLI alternative:
vercel link
vercel --prod
```
Now set `FLY_AGENT_URL=https://nucleus-agent.fly.dev` on Vercel (Phase 2 row 1) and **redeploy** so the UI can
reach the engine.

**VERIFY (Vercel):**
```bash
curl -sI https://<YOUR_APP>.vercel.app/sign-in | head -1
# → expect: HTTP/2 200
curl -s https://<YOUR_APP>.vercel.app/api/ingest
# → expect JSON: {"maxBytes":15728640,"maxMb":15,"formats":["PDF","Word","Excel","CSV"]}
```
If `/sign-in` isn't 200 or the JSON is missing, a Supabase env var is missing/misnamed or `FLY_AGENT_URL`
isn't set — fix durably and redeploy.

---

## PHASE 5 — First-run verification

### 5.1 Create the first admin, then lock the door

There are **no prebuilt accounts**. Bootstrap yours:
1. Supabase → **Authentication → Sign-in / Providers** → temporarily set **"Allow new users to sign up" = ON**.
2. Open `https://<YOUR_APP>.vercel.app/sign-in` → **sign up** with the client's email/password. The **first**
   account becomes **admin** (the `001` trigger).
3. Supabase → set **"Allow new users to sign up" = OFF** again.

**VERIFY:** signed in, the **Admin** panel (Users) is visible. From here only the admin creates accounts, and
deactivating a user bounces them on their next click.

### 5.2 Upload a fixture + one paid ask (⚠️ this is the one billed call)

1. On the dashboard, **Upload** a small fixture (PDF / CSV / XLSX ≤ 15 MB). The repo's `data/` sample files
   work if you have a demo account; a real (non-demo) account starts with a clean bucket, so upload your own.
2. **Ask one question** about it, e.g. *"What does this document say about &lt;a fact in the file&gt;?"*

**Expected response shape** (the `/api/ask` JSON): a grounded, **cited** answer; the result echoes the resolved
`model` (e.g. `claude-sonnet-4-6` if you pinned Sonnet), ends its text with a `SOURCES_USED:` line driving the
evidence panel, and carries `_engine.lane:"fly-agentic"`, `_engine.answerEngine:"messages"`, plus a
`session_id`. In `flyctl logs -a nucleus-agent` you should see `[messages] resolve … model=… files=N`.

> **Cost note:** this single ask is billed. Measured costs (see `docs/claude-call-log.md` USAGE rows):
> file-heavy **Haiku** asks **$0.05–0.16**, light Haiku asks ~**$0.003**, **Sonnet** ~**$0.08**. One ask is fine;
> do not loop.

### 5.3 Zero-Claude checks (free — run these freely)

```bash
# Full offline test suite (unit + api + components) — no Claude, no network to Anthropic:
pnpm test
# Knowledge-Spaces journey against the live deployment — ZERO Claude cost:
NUCLEUS_BASE=https://<YOUR_APP>.vercel.app node scripts/run-journeys.mjs knowledge-spaces
```
**Expected:** `pnpm test` green (three suites); the knowledge-spaces journey passes (creates/opens/deletes
spaces, asserts scoping, no billed asks).

**VERIFY (whole chain):** admin panel visible (5.1), the one paid ask returned grounded + cited with the model
echo and `lane:"fly-agentic"` (5.2), and both zero-Claude checks pass (5.3).

---

## PHASE 6 — Operations

### Key rotation
- **Anthropic key:** create a new `sk-ant-…` in the console → `flyctl secrets set ANTHROPIC_API_KEY=<new> -a nucleus-agent` → revoke the old key in the console. (Fly redeploys the machine on a secret change.)
- **Supabase service-role key:** rotate in **Project Settings → API** → update it on **both** Vercel (`vercel env add SUPABASE_SERVICE_ROLE_KEY production`, remove the old) **and** Fly (`flyctl secrets set …`) → redeploy both.
- **`INTERNAL_AGENT_TOKEN`:** rotate on **both** sides at once (they must match) — set the new value on Fly and Vercel, then redeploy Vercel. A mismatch makes every ask 401 until reconciled.

### Model swap (no code change)
```bash
flyctl secrets set AGENT_MODEL=claude-sonnet-4-6 -a nucleus-agent   # best answers (prod default)
flyctl secrets unset AGENT_MODEL -a nucleus-agent                   # revert to cheapest (claude-haiku-4-5)
```
The `[messages] resolve … model=…` Fly log line stamps the live model. Sonnet is materially better but roughly
5× Haiku's cost.

### Cost expectations + monthly cap
- **Per ask (measured, `docs/claude-call-log.md`):** file-heavy Haiku **$0.05–0.16**, light Haiku ~**$0.003**, Sonnet ~**$0.08**.
- **Set a monthly spend cap / alert** in the Anthropic console. The billed key previously hit its monthly cap from untracked over-testing, which blocked live answers until reset. Watch it, especially on Sonnet.

### The many-attachments caveat
The engine attaches **every in-scope file** for a chat/space to a single Anthropic request — it does **not** cap
the count itself. Anthropic's Files/Messages API bounds how many document/container blocks (and total bytes) a
single request can carry, so a chat or Knowledge Space with a very large number of large files can hit that
limit or the context window and fail/truncate. **TODO-for-Chris:** the exact per-request attachment ceiling
(the "~16 attachments" figure) is an Anthropic-API constraint, **not enforced in this codebase** — confirm the
current number against Anthropic's docs and, if needed, add an app-side cap. Practical guidance today: keep
per-space file counts modest and split very large corpora across spaces.

### Local (Ollama) mode — legacy, optional (full detail in `docs/LOCAL-MODEL.md`)
Runs the answer model on the client's own hardware. **v0.5 is chat-only** (it does **not** read uploaded
documents, and says so). Two shapes:
1. **Box-local:** install Ollama, `ollama pull <model>`; it serves an OpenAI-compatible API at
   `http://localhost:11434/v1`. In **Settings → Model → Local**, set the endpoint `http://localhost:11434/v1`
   and a model id (e.g. `qwen2.5` / `llama3.2:3b`), switch `model_mode` to **Local**.
2. **Cloud app + tunnel:** expose the box's Ollama with cloudflared —
   `cloudflared tunnel --url http://localhost:11434 --http-host-header localhost:11434 --protocol http2`
   (the `--http-host-header` flag is **not optional** — Ollama 403s any request whose `Host` isn't localhost) —
   then set the Local endpoint to `https://<tunnel-host>/v1`. Optional: `LOCAL_TIMEOUT_MS` (default 45000).

### HIPAA (Azure OpenAI) mode — optional
Selecting **HIPAA** in Settings currently returns an honest **503** (the Azure/BAA backend is not wired to the
Messages engine on this deployment). Only relevant if you later wire Azure OpenAI under a Microsoft BAA — see
`docs/HANDOFF.md` for the field mapping (`hipaa_endpoint`, `hipaa_api_key`, `hipaa_model`, `hipaa_api_version`).

### Deploy mechanics recap
- **Vercel:** push to `origin/main` → auto-deploys. Confirm live with the Phase 4.2 curl probes.
- **Fly:** `flyctl deploy -a nucleus-agent`. Confirm with the Phase 4.1 `401` probe. Fly secrets are write-only and persist across deploys.

---

## Appendix — Env var verification (grep-checked against the codebase)

**Verified present in `src/` and used as described** (these are the ones this runbook sets):
`FLY_AGENT_URL`, `INTERNAL_AGENT_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANSWER_ENGINE`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`AGENT_MODEL`, `ASSISTANT_TODAY`, `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `LOCAL_TIMEOUT_MS`,
`NEXT_PUBLIC_SITE_URL`. (Local-mode's tunnel host is entered in **Settings → Model → Local** as the endpoint —
it is **not** an app env var; `TUNNEL_URL` appears only in a test script, see below.)

**Present in the codebase but deliberately OMITTED from the required setup, with why:**

| Env var(s) | Why omitted |
|---|---|
| `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_FS_MODEL`, `RUN_GEMINI` | **Legacy/removed.** Gemini/GCP were excised; the deployed path is Claude-only. (`.env.example` still lists these — it is stale.) |
| `INTERNAL_EMBED_TOKEN`, `NUCLEUS_SELF_URL` | **Removed.** They guarded an internal embedding call that no longer exists. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_PW`, `USER_EMAIL`, `USER_PW`, `NUCLEUS_EMAIL`, `NUCLEUS_PASSWORD`, `REQUIRE_CREDS` | **Test/journey harness credentials** — used by scripts in `scripts/`/`tests/`, not by the app at runtime. |
| `NUCLEUS_BASE`, `BASE`, `BASE_URL`, `PREVIEW_URL`, `FRONTEND_URL`, `VERCEL_URL`, `VERCEL_AUTOMATION_BYPASS_SECRET`, `VERCEL_BYPASS` | **Test-harness base URLs / Vercel-injected / preview-protection bypass** — not app config you set. (`NUCLEUS_BASE` is only for the journey runner.) |
| `CHROME_EXE`, `PW_CHROMIUM_PATH`, `PDF_PATH`, `CI_STRICT`, `BACKEND_ONLY`, `GATE_RELIABILITY_ONLY`, `__INTENT_FORCE_ERROR`, `__ROUTER_FORCE_EMPTY` | **Test tooling / fault-injection flags** — Playwright paths, eval gates, and internal test hooks; never set in production. |
| `TUNNEL_URL` | **Test script only** (`scripts/local-ui-proof.mjs`) — the app does not read it. The Local-mode tunnel host is entered as the endpoint in **Settings → Model → Local**, not via env. |

**Doc-drift notes surfaced during verification (TODO-for-Chris):**
- `docs/HANDOFF.md` and `docs/SETUP.md` say **"sixteen migrations"**; the repo has **17** (`017_anthropic_file_cache` was added). This runbook uses 17.
- `docs/SETUP.md` shows the `/api/ingest` probe returning `formats:["PDF","CSV","XLSX"]`; the code actually returns **`["PDF","Word","Excel","CSV"]`**. This runbook uses the accurate value.
- CI (`.github/workflows/ci.yml`) uses `npm ci` but only `pnpm-lock.yaml` is committed (see Phase 0 caveat).
