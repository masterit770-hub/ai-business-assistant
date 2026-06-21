# Local model — run the AI on your own hardware

**For:** the owner (Jenny) and whoever sets it up — **a human engineer *or* an AI assistant.**

> 🤖 **Not technical? Do this:** open an AI assistant (Claude, ChatGPT, …), **paste this whole file in, and say "walk me through this one step at a time, I'm on \<Windows / Mac / Linux\>."** Every command below was actually run and verified on a real box — it is written so an AI can follow it exactly.

---

## What "Local" means

The AI assistant has a model switch with **three** choices (top of the Ask panel, and in **Settings → Model**):

| Mode | Where the AI that writes the answer runs | Key it uses |
|---|---|---|
| **Cloud** | a hosted model (the demo ships on one we configured — no setup) | any OpenAI-compatible key (DeepSeek / OpenAI / Gemini …) |
| **HIPAA** | a HIPAA-eligible hosted model | your **Azure OpenAI** key (under a Microsoft BAA) |
| **Local** | **your own computer or server** | none — it's your machine |

This guide is about **Local**: the part of the system that *writes the answer sentences* runs on **your** hardware. Everything else about an answer — finding the right contract rows, retrieving the right document pages, and **citing** them — is **identical** no matter which model writes; the model is just the final writer. (So a weak local model still gets the *right* documents retrieved and shown; see "Which model" below.)

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
ollama pull qwen2.5:1.5b      # the default — small + fast on a plain CPU (see "Which model")
ollama serve                  # usually already running after install
```

Ollama now serves an **OpenAI-compatible** API at **`http://localhost:11434/v1`** — that's the address the app needs. You did **not** write any service; Ollama *is* the service, and it already speaks the same protocol the cloud does.

Verify it works (optional):
```bash
curl http://localhost:11434/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"qwen2.5:1.5b","messages":[{"role":"user","content":"say OK"}],"stream":false}'
# → returns a JSON chat completion. (Verified: ~1s warm on a CPU box.)
```

---

## A) Self-host the app on your box (no tunnel)

You run the app and the model on the same machine. *(Verified on a real box: `npm run build` exits 0, `npm start` serves, and Local answers cite the right pages.)*

```bash
# on the box (needs Node.js 20+):
git clone <your-nucleus-repo-url>
cd nucleus
npm install
npm run build        # verified: builds clean
npm start            # serves http://localhost:3000  (verified: "Ready" + HTTP 200)
```

> Logins (Supabase) and uploaded-document search (Gemini) still use their own keys — see **HANDOFF.md**. Switching the **model** to Local changes only *who writes the answer*, not the rest of the app.

Then in the app (`http://localhost:3000`), signed in as **admin**:
1. **Settings → Model**.
2. **Local model endpoint:** `http://localhost:11434/v1`
3. Click **Detect models on your box** → it lists the models you've pulled → **click one** (e.g. `qwen2.5:1.5b`). *(Or type the name in the field — both work.)*
4. **Save**, then flip the switch to **Local**.
5. Ask a question — the answer is now written on your box. 🎉

People you give the box's address to all get answers generated on your hardware.

---

## B) Cloud app on Vercel + model on your box (tunnel)

The Vercel app can't reach your machine's `localhost` directly — a **tunnel** gives your model a public URL the cloud app can call.

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
- **Local model endpoint:** your tunnel URL **+ `/v1`** → e.g. `https://random-words.trycloudflare.com/v1`
- **Save**, then click **Detect models on your box** → click your model → **Local**.

*(Verified end-to-end: the hosted Vercel demo, flipped to Local through this exact tunnel, answered a document question with the correct figure + page citation, generated on the box.)*

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

The answer is only as good as the model writing it; the retrieval + citation machinery is identical regardless. Tested trade-off on a plain CPU box:

| Model | Speed (warm) | Answer quality | Use it when |
|---|---|---|---|
| **`qwen2.5:1.5b`** (default) | fastest (~1s) | **weak** — often answers generally and **won't cite**, even though the right docs were retrieved | smallest footprint; you accept hit-or-miss answers |
| **`qwen2.5:3b`** | ~1–2s warm | **good** — reliably cites the right page | you want consistent, cited answers (recommended if your box can run it) |
| **`qwen2.5:7b`+** | slower on CPU | best | you have a strong box / GPU |

Switching is one click — **Detect models → click another model**. Other families work too (`llama3`, `mistral`, …).

**What a *weak* model looks like (and why it's honest):** with 1.5b you may ask "what's the child support?" and get *"generally, child support involves…"* with **no citation**. That is **not** the system failing — open the **Inspector** and you'll see the whole chain: the **Router** correctly picked *documents*, **Retrieval** found the right 8 passages (shown, with real cosine scores), and the **Generation** step honestly says *"answered from general knowledge (uncited) — the model didn't ground in the 8 retrieved items, still shown below."* The model was just too small to commit to the evidence; the system stayed honest (no fabricated citation) and still shows you the documents. A bigger model cites them.

---

## If Local isn't set up / can't be reached

- **No endpoint entered**, then you ask in Local mode → a calm message: *"Local mode is on, but no local model is set up yet…"* (no crash).
- **Endpoint set but unreachable** (Ollama off, wrong URL, tunnel down) → *"Local mode is on, but I couldn't reach your local model at \<endpoint\>…"* — names the address, fails in a few seconds, never hangs.

---

## Honest caveat — "Local model" ≠ fully offline

Switching the **model** to Local runs **the AI on your hardware**. It does not, by itself, make the whole app offline:

| Part | After switching to Local | Still cloud? |
|---|---|---|
| **The AI that writes answers** | **your hardware** | ✅ now local |
| Login / accounts | Supabase | ⚠️ unless you self-host Supabase |
| Uploaded-document search | Gemini File Search | ⚠️ unless separately localized |
| Structured data (contracts/maintenance) | in the app, on your box | ✅ already local |

A full air-gap is a further step (self-host the login + document-search lanes too). The switch gives you the biggest piece: **the AI itself on your machine.**

---

## Quick reference

| Thing | Value |
|---|---|
| Ollama endpoint | `http://localhost:11434/v1` (self-host) · `https://<tunnel>/v1` (cloud app + tunnel) |
| Recommended model | **`qwen2.5:1.5b`** default (fast, weak); **`qwen2.5:3b`** for reliable citations |
| Pick a model | **Detect models on your box** → click one (or type it) |
| Tunnel command | `cloudflared tunnel --url http://localhost:11434 --http-host-header localhost:11434 --protocol http2` |
| 24/7 tunnel | `scripts/local-tunnel-supervisor.sh` (self-healing) or a named Cloudflare tunnel (fixed URL) |
| Hosted demo can use Local? | **Yes — with a tunnel.** Without one it shows the friendly setup message |
| If unreachable | calm, fast message naming the endpoint (no hang) |

*Setup of the rest of the app (logins, document search, the cloud/HIPAA models) is in [HANDOFF.md](HANDOFF.md).*
