# Local model — run the AI on your own hardware

**For:** the owner (Jenny) and whoever sets it up — **a human engineer *or* an AI assistant.**

> 🤖 **Not technical? Do this:** open an AI assistant (Claude, ChatGPT, …), **paste this whole file in, and say "walk me through this one step at a time, I'm on \<Windows / Mac / Linux\>."** Every command below was actually run and verified on a real box — it is written so an AI can follow it exactly.

---

## ⚠️ v0.5 scope — Local mode is CHAT-ONLY (read this first)

Local mode today is **chat-only**. When you switch to Local:

- ✅ Your message genuinely round-trips through **your own model** (e.g. Ollama on your box) and the reply renders in the app. Your prompt goes **only to your endpoint** — never to a cloud AI provider.
- ❌ Local mode **does NOT read your uploaded documents, spreadsheets, or business data.** It answers from the model's **own general knowledge only**.
- ✅ **It is honest about that.** If you ask about your files, Local mode says plainly *that it can't read documents in Local mode* and suggests switching to Cloud — it **never** makes up what a document says. (This is enforced two ways: a system-prompt instruction that names your files and forbids fabricating their contents, and a visible note in **Settings → Model**.)

**Why chat-only?** A small local CPU model can't do the document retrieval + citation work the Cloud engine does. Rather than fake it (fabricated "citations" from a model that never read the file), Local mode stays honest and does the one thing it can do well: chat. **Reading your documents in Local mode is the planned upgrade** — see **[The GPU-day upgrade path](#the-gpu-day-upgrade-path)** at the end.

> To ask questions **about your documents/data**, use **Cloud** mode. That is the full retrieval + citation engine.

---

## What "Local" means

The AI assistant has a model switch with **three** choices (top of the Ask panel, and in **Settings → Model**):

| Mode | Where the AI runs | Reads your documents? | Key it uses |
|---|---|---|---|
| **Cloud** | a hosted model (the demo ships on one we configured — no setup) | ✅ yes — full retrieval + citations | the server's Anthropic key (or your own) |
| **HIPAA** | a HIPAA-eligible hosted model (Azure OpenAI) | ✅ yes (when wired) | your **Azure OpenAI** key (under a Microsoft BAA) |
| **Local** | **your own computer or server** | ❌ **no (v0.5, chat-only)** | none — it's your machine |

This guide is about **Local**: the model that *writes the answer* runs on **your** hardware, from its own general knowledge. Document search, retrieval, and citation are **Cloud-only** in this version.

---

## Two ways to run Local — pick one

```
A) SELF-HOST (simplest, nothing to expose)        B) CLOUD APP + YOUR BOX (one shareable link)
   browser → app ON your box → Ollama (localhost)    browser → app on Vercel → tunnel → Ollama on your box
   no tunnel needed                                   needs a tunnel (covered below)
```

- **A — Self-host** the whole app on the box next to the model. Give people that box's address. Nothing leaves your machine for the AI step, and there's **no tunnel**. Simplest and most robust.
- **B — Keep the hosted (Vercel) app** and point it at the model on your box via a **tunnel**. One shareable link for everyone; the model still runs on your box. This is what you do if you host the app on Vercel like the demo.

Both are written out below, both tested end-to-end.

---

## Step 0 (both ways): install the model

On the box that will run the AI:

```bash
# 1. install Ollama (one click): https://ollama.com
# 2. pull a model and start the server:
ollama pull llama3.2:3b       # a small, fast chat model (verified on a plain CPU box, ~5s cold)
ollama serve                  # usually already running after install
```

Ollama now serves an **OpenAI-compatible** API at **`http://localhost:11434/v1`** — that's the address the app needs. You did **not** write any service; Ollama *is* the service, and it already speaks the same protocol the cloud does.

Verify it works (optional):
```bash
curl http://localhost:11434/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"llama3.2:3b","messages":[{"role":"user","content":"say OK"}],"stream":false}'
# → returns a JSON chat completion. (Verified live.)
```

---

## A) Self-host the app on your box (no tunnel)

You run the app and the model on the same machine.

```bash
# on the box (needs Node.js 20+ and pnpm: `npm install -g pnpm`):
git clone <your-nucleus-repo-url>
cd nucleus
pnpm install
pnpm approve-builds --all   # approve native build scripts (sharp, tesseract.js, …) so the
                            # build/run isn't blocked (ERR_PNPM_IGNORED_BUILDS)
pnpm build                  # builds the production app
pnpm start                  # serves http://localhost:3000  ("Ready" + HTTP 200)
```

> Logins run on your **Supabase** — set that up first via **[SETUP.md](SETUP.md)**. Switching the **model** to Local changes only *who writes the answer* (and, in v0.5, means documents aren't read — see the scope note above).

Then in the app (`http://localhost:3000`), signed in as **admin**:
1. **Settings → Model**.
2. Flip the switch to **Local**. (Read the on-screen note: *documents are not read in Local mode*.)
3. **Local model endpoint:** `http://localhost:11434/v1`
4. Click **Detect models on your box** → it lists the models you've pulled → **click one** (e.g. `llama3.2:3b`). *(Or type the name in the field — both work.)*
5. **Save**. Optionally use a **Test connection** to confirm the endpoint answers.
6. Ask a chat question — the answer is now written on your box. 🎉

People you give the box's address to all get chat answers generated on your hardware.

---

## B) Cloud app on Vercel + model on your box (tunnel)

The Vercel app can't reach your machine's `localhost` directly — a **tunnel** gives your model a public URL the cloud app can call. (The app calls your endpoint server-side, so it works from anywhere the tunnel is reachable.)

### B1. Open the tunnel (the two flags are NOT optional)

```bash
# install cloudflared (one binary): https://github.com/cloudflare/cloudflared
cloudflared tunnel --url http://localhost:11434 \
    --http-host-header localhost:11434 \
    --protocol http2
# → prints a public URL like https://random-words.trycloudflare.com — leave it running.
```

> 🔑 **Why the two flags** (we hit both failures without them):
> - **`--http-host-header localhost:11434`** — Ollama returns a blank **403** to any request whose `Host` header isn't localhost (an anti-hijacking check). This flag makes the tunnel send `Host: localhost`, which Ollama accepts.
> - **`--protocol http2`** — the default QUIC transport drops intermittently (tunnel connects, then answers stop). HTTP/2 is stable.
>
> *(`ngrok http 11434` also works and needs neither flag — it sends the right Host by default.)*

### B2. Point the app at it

In the hosted app → **Settings → Model** (signed in as admin):
- Flip to **Local**.
- **Local model endpoint:** your tunnel URL **+ `/v1`** → e.g. `https://random-words.trycloudflare.com/v1`
- **Save**, then click **Detect models on your box** → click your model.

*(A chat message sent in Local mode round-trips through the box over the tunnel and renders; the response is stamped `model: local:<name>` so you can confirm it came from your model. Documents are still not read — that's Cloud mode.)*

### B3. Make it 24/7 (always-on box)

A plain quick-tunnel URL **changes every restart**. For an always-on box, run the **self-healing supervisor** included in the repo — it keeps Ollama + the tunnel alive and, if the tunnel restarts on a new URL, **re-points the app automatically** so Local never silently breaks:

```bash
# from the repo root, with your Supabase service-role key available in .secrets/supabase.env:
bash scripts/local-tunnel-supervisor.sh   # leave it running (or install as a service)
```

*(Verified: killing the tunnel mid-run, the supervisor brought up a new one and re-synced the app's endpoint in ~18s with no human action; Local kept answering.)*

> **Cleaner alternative for a fixed URL:** a **named** Cloudflare tunnel (free account) gives a *stable* hostname that survives restarts, so you set the endpoint once and never touch it. Run `cloudflared tunnel login`, create a named tunnel, and route it to `http://localhost:11434` with `--http-host-header localhost:11434`. Use this if you want a permanent address instead of the supervisor.

> ⚠️ **Security:** a tunnel URL is **public** — anyone who has it can use your model. Treat it like a password; for real use put auth in front (named Cloudflare tunnel + Access, or an API gateway). The question/answer text transits the cloud app to your box; the *model* runs on your hardware, but it is **not** air-gapped (for that, self-host — option A).

---

## Which model? (the model is the swappable knob)

In v0.5 the model's job is **chat**, so pick for chat quality + speed on your box:

| Model | Speed (warm) | Chat quality | Use it when |
|---|---|---|---|
| **`llama3.2:3b`** | fast (~1–5s CPU) | good general chat | a solid default on a plain CPU box (tested) |
| **`qwen2.5:1.5b`** | fastest | weaker, terser | smallest footprint; you want speed over depth |
| **`qwen2.5:7b`+ / llama3.1:8b** | slower on CPU | best | you have a strong box / GPU |

Switching is one click — **Detect models → click another model**. Other families work too (`llama3`, `mistral`, …). Answer *quality* is out of scope to certify in v0.5 (a small CPU model is a small CPU model); what's guaranteed is that the message genuinely runs on **your** model and that Local mode never pretends to read your files.

---

## If Local isn't set up / can't be reached

- **No endpoint entered**, then you ask in Local mode → a calm message: *"Local mode is on, but no local model endpoint is set yet — open Settings → Model…"* (no crash, no fabricated answer).
- **Endpoint set but unreachable** (Ollama off, wrong URL, tunnel down) → *"Local model endpoint unreachable at \<endpoint\> — is Ollama running / is the tunnel up?…"* — names the address, fails in a few seconds, never hangs, never 500s.

Both are friendly `200` answers carrying a `localGuidance` flag, so the Ask surface shows a calm setup/troubleshooting note instead of an error.

---

## Honest caveat — "Local model" ≠ fully offline, and ≠ document-aware

Switching the **model** to Local runs **the chat AI on your hardware**. It does not, by itself, make the whole app offline, and (v0.5) it does not read your documents:

| Part | After switching to Local | Notes |
|---|---|---|
| **The AI that writes chat answers** | **your hardware** | ✅ now local; your prompt goes only to your endpoint |
| **Reading uploaded documents/data** | **not done in Local mode** | ❌ v0.5 chat-only — use Cloud to ask about files |
| Login / accounts | Supabase | ⚠️ cloud unless you self-host Supabase |
| Structured/document storage | your Supabase | ⚠️ on your Supabase (unused by the Local chat path) |

A full air-gap is a further step (self-host Supabase too). The switch gives you the biggest privacy piece for chat: **the model itself on your machine.**

---

## The GPU-day upgrade path

Reading documents in Local mode is **designed, not built** — it's the natural next version once the hardware can run a model big enough to use it:

- **v1 (the plan): file the document TEXT straight into the model's context, within a token budget.** When the owner has a GPU that can run a capable model with a large context window, the simplest honest upgrade is to fetch the in-scope files' extracted text and put it directly in the prompt (bounded by a token budget), then let the model answer + cite from what it was given. This is deliberately **simpler** than rebuilding the full hybrid-RAG retrieval stack locally ("the RAG swamp") — it trades cost/context for a large reduction in moving parts, and it's honest (the model only sees text it was actually given). See `docs/overnight-2026-07-02-plan.md` for the framing.
- **v2 (parked): an agent framework + Docker sidecar** (e.g. smolagents in a container) is **explicitly out of scope** and parked — see `docs/AGENT-HANDOFF.md`. Do not build it as part of Local mode.

Until then, Local mode is chat-only and says so.

---

## Quick reference

| Thing | Value |
|---|---|
| What Local does (v0.5) | **chat only**, on your model; **does not read your documents** |
| Ollama endpoint | `http://localhost:11434/v1` (self-host) · `https://<tunnel>/v1` (cloud app + tunnel) |
| Tested model | **`llama3.2:3b`** (small, fast on CPU) |
| Pick a model | **Detect models on your box** → click one (or type it) |
| Confirm it ran locally | the answer's response JSON is stamped `model: local:<name>` |
| Ask about documents | use **Cloud** mode (Local can't read files in v0.5) |
| Tunnel command | `cloudflared tunnel --url http://localhost:11434 --http-host-header localhost:11434 --protocol http2` |
| 24/7 tunnel | `scripts/local-tunnel-supervisor.sh` (self-healing) or a named Cloudflare tunnel (fixed URL) |
| If unreachable | calm, fast message naming the endpoint (no hang, no 500) |

*Setup of the rest of the app (logins, document search, the cloud/HIPAA models) is in [HANDOFF.md](HANDOFF.md).*
