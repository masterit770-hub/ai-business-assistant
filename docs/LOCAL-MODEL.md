# Local model — run the AI on your own hardware

**For:** the owner (Jenny) and whoever helps set it up — **a human engineer *or* an AI assistant.**

> 🤖 **Non-technical? Read this first.** You don't need to understand the technical steps. Open an AI assistant (Claude, ChatGPT, etc.), **paste this whole document in, and say: "Walk me through this one step at a time."** This guide is written so an AI can follow it precisely.

---

## What "Local" means (plain English)

Nucleus has a **big Cloud ⇄ Local switch** at the top of the Ask panel (and in **Settings → Model**). It chooses **where the AI brain runs** — the part that writes the sentences of each answer:

- **Cloud** (the default) — the AI runs on a hosted model in the cloud (the demo uses one we configured for you). Nothing to install. This is what's running right now.
- **Local** — the AI runs **on your own computer or server**, using a model you downloaded. Your questions and answers are generated **on your hardware**.

You flip the switch and **immediately** the active side lights up: "boom, now I'm Local" / "boom, now I'm Cloud." The change takes effect on your **very next question** — no restart, no redeploy.

---

## ⚠️ The one rule that surprises everyone

> **Local needs your model to be reachable by wherever the Nucleus app runs.**

Two ways to do that: **self-host** the app right next to the model, *or* keep the **cloud app** and expose your model with a **tunnel** (both covered below). The **hosted demo** (`https://nucleus-woad.vercel.app`) runs in the cloud and, as shipped, **isn't pointed at any model on your computer** — and the cloud can't reach your `localhost` *directly* (that's exactly what the tunnel solves). So if you flip the **demo** to Local and ask a question, Nucleus won't crash — it shows a **friendly setup message** explaining exactly this:

> *"Local mode is on, but no local model is set up yet. To use Local: run Nucleus on your own machine, install Ollama and pull a model, then enter your endpoint (e.g. `http://localhost:11434/v1`) and model name in Settings → Model. (The hosted demo can't reach a local model — Local works when you self-host.)"*

That message **is the point** of Local on the demo: it shows the switch works and tells you how to make Local real. To actually **use** Local, follow the steps below on your own box.

---

## Step-by-step — make Local real on your own machine

You'll (1) run the Nucleus app on your computer, (2) install a local AI model, (3) point Nucleus at it, (4) flip the switch.

### 1. Run Nucleus on your own machine

On the computer (or server) that will run the AI:

```bash
# get the code
git clone <your-nucleus-repo-url>
cd nucleus

# install + run (needs Node.js 20+)
npm install
npm run dev          # opens the app at http://localhost:3000
```

> For a real/production setup use `npm run build && npm start` instead of `npm run dev`, and put it behind your own domain. Logins (Supabase) and uploaded-document search (Gemini) still need their keys set — see **HANDOFF.md**. **The local model only changes who writes the answer sentences; the rest of the app is unchanged.**

### 2. Install a local AI model (Ollama)

[Ollama](https://ollama.com) is the easiest way to run a model locally. Install it, then pull a model:

```bash
# install Ollama from https://ollama.com (one click), then:
ollama pull qwen2.5:3b     # recommended default on a normal CPU box (see note)
ollama serve               # usually already running after install
```

> 🧠 **Which model? (tested guidance — the model is the part you can swap for quality.)** The answer is only as good as the model writing it; the rest of the pipeline (finding the right contract rows, retrieving the right document pages, citing them) is identical no matter which model you pick.
> - **`qwen2.5:3b` — the sweet spot on a typical CPU.** Fast enough (a few seconds) *and* smart enough to read the evidence and cite it. In our end-to-end test it correctly answered a document question with the right figure **and** the page citation.
> - **`qwen2.5:1.5b` — only if your box is very slow.** It's quick but **too weak**: in testing it retrieved the right data and then failed to use it. Avoid unless you must.
> - **`qwen2.5:7b` (or bigger) — best quality, needs a strong box (ideally a GPU).** On a plain CPU it's slow enough that answers can time out. Use it when you have the hardware.
>
> Other families work too (`llama3`, `mistral`, …) — pick a size that matches your hardware using the same fast-vs-smart trade-off.

Ollama now serves an **OpenAI-compatible** endpoint at **`http://localhost:11434/v1`**. That's the address Nucleus needs.

### 3. Point Nucleus at your model (Settings → Model)

1. Open Nucleus (`http://localhost:3000`), sign in as the **admin**.
2. Go to **Settings → Model & Prompts → Model**.
3. In **Local model endpoint**, enter: `http://localhost:11434/v1`
4. In **Local model name**, enter the model you pulled: `qwen2.5:3b`.
5. Click **Save prompts** (it saves the Model section too).

### 4. Flip the big switch to Local and ask

1. At the top of the **Ask panel** (or in the Model section), click **Local** — the **Local** side fills with the accent color: you're now Local.
2. Ask a question. The answer is now generated **on your hardware**. 🎉

If you flip to Local but **haven't** entered an endpoint yet, a small amber hint appears next to the switch ("Set up Local in Settings → Model"), and asking a question returns the friendly **not-configured** guidance instead of an error.

If the endpoint is set but Nucleus **can't reach** the model (Ollama not running, wrong address, model not pulled), you get a calm, fast message naming the address:

> *"Local mode is on, but I couldn't reach your local model at `http://localhost:11434/v1`. Make sure Nucleus is running on the same machine/network as your model (Ollama running, the model pulled), and that the endpoint in Settings → Model is correct."*

It fails **fast** (a few seconds), never a long hang.

---

## "Serve my own clients from my own box" (the self-host topology)

If you want **your clients** to use Nucleus with the **AI running on your hardware** (so no question or answer text leaves your server's model):

```
        your clients' browsers
                 │   (you give them this URL)
                 ▼
   ┌──────────────────────────────────────────┐
   │  YOUR server / machine                    │
   │                                           │
   │   Nucleus app  ──►  Ollama (local model)  │   ← "Local" mode points here
   │   (npm start)       http://localhost:11434/v1
   └──────────────────────────────────────────┘
```

- You **host the Nucleus app on your own server** (with Ollama running on the same box or same private network).
- You set **Model → Local** with the endpoint `http://localhost:11434/v1` (or your server's internal address).
- You give your clients **your server's URL**. When they ask questions, **the AI runs on your hardware** — the answer sentences are generated by your local model.

Contrast with the **hosted cloud demo as shipped**: out of the box it uses a **cloud** model — quick to try, nothing to install. But you can also keep the cloud app **and** point it at your own local model — that's the tunnel option, next.

---

## Keep the cloud app, run the model on your box (the tunnel option)

You can have **both**: the hosted Vercel app (one shareable link for all your users) **and** the AI model running on your own machine. The only requirement is giving your model a **public address** the cloud app can reach — the cloud can't see your machine's `localhost` directly. A **tunnel** does exactly that.

```
   your users' browsers
          │  (one shareable Vercel link)
          ▼
   Nucleus app on Vercel (cloud)
          │   Local endpoint = your tunnel URL
          ▼
   tunnel (public URL)  ──►  YOUR box: Ollama (local model)
```

> ✅ **This is tested, not theoretical.** We ran the hosted Vercel demo (`nucleus-woad.vercel.app`) flipped to Local, pointed at a box's Ollama through exactly the tunnel command below, and it answered both a contracts question and a document question — the document answer came back with the **correct figure and the page citation**, generated on the box. The two flags below are *why* it works; without them it silently fails.

On the box that runs your model:

```bash
# 1. run your model
ollama serve
ollama pull qwen2.5:3b

# 2. expose it with a tunnel — a Cloudflare quick tunnel (NO account needed).
#    install cloudflared (one binary, https://github.com/cloudflare/cloudflared), then:
cloudflared tunnel --url http://localhost:11434 \
    --http-host-header localhost:11434 \
    --protocol http2
#    → it prints a public URL like https://random-words.trycloudflare.com — leave it running.
```

> 🔑 **The two flags are NOT optional** — we hit both failures and these fix them:
> - **`--http-host-header localhost:11434`** — Ollama refuses requests whose `Host` header isn't localhost (an anti-hijacking safety check) and returns a blank **403**. Without this flag the tunnel works but every answer fails. This flag makes the tunnel send `Host: localhost`, which Ollama accepts.
> - **`--protocol http2`** — the default QUIC transport drops intermittently on some networks (the tunnel registers, then connections die and answers stop). HTTP/2 is stable.
>
> *(Prefer `ngrok`? `ngrok http 11434` also works and needs neither flag — it sends the right `Host` by default.)*

Then in Nucleus → **Settings → Model**:
- **Local model endpoint**: your tunnel URL **+ `/v1`** → e.g. `https://random-words.trycloudflare.com/v1`
- **Local model name**: `qwen2.5:3b`
- **Save**, then flip the switch to **Local**.

Now every user on your Vercel link gets answers generated by the model **on your box** — and Nucleus still finds and cites the right contract rows and document pages exactly as it does on Cloud (retrieval runs in the app regardless of which model writes the answer).

> ⚠️ **Security & reliability — read this before using it for real:**
> - A quick-tunnel URL is **public** — anyone who has it can use your model. Treat it like a password. For real use, put **auth in front** (a named Cloudflare tunnel with Access, or an API key) and use a **stable/named tunnel** — the free quick-tunnel URL **changes every restart**.
> - Your box **and** the tunnel must **stay running**. If either stops, Local answers stop (users get the calm "couldn't reach your local model" message).
> - This is **not air-gapped**: the question/answer text travels from the cloud app to your box over the tunnel. The *model* runs on your hardware, but traffic transits the cloud app. For truly nothing-leaves-my-building, self-host the whole app (the section above).

---

## Honest caveat — "Local model" ≠ fully offline (yet)

Switching the **model** to Local makes **the AI answer on your hardware**. It does **not**, by itself, make the whole app offline:

| Part of Nucleus | Where it runs after you switch to Local | Still cloud? |
|---|---|---|
| **The AI that writes answers** | **Your hardware** (your local model) | ✅ now local |
| **Login / user accounts** | Supabase (cloud) | ⚠️ still cloud, unless you self-host Supabase |
| **Uploaded-document search** | Gemini File Search (cloud) | ⚠️ still cloud, unless separately localized |
| **Structured-data lane (contracts, maintenance)** | In the app, on your box | ✅ already local |

So: **"Local model" means the AI answers on your hardware.** A **full air-gap** (nothing touches the cloud at all) is a **further step** — you'd also self-host the login system and replace the cloud document-search lane. That's possible but out of scope for the switch; the switch gives you the biggest, most-requested piece: **the AI itself running on your machine.**

---

## Quick reference

| Thing | Value |
|---|---|
| Default mode | **Cloud** (unchanged behavior — the working hosted model) |
| Where to flip | Top of the **Ask panel**, or **Settings → Model** (admin-only) |
| Example endpoint | `http://localhost:11434/v1` (Ollama, self-host) · `https://<tunnel>.trycloudflare.com/v1` (cloud app + tunnel) |
| Recommended model | **`qwen2.5:3b`** on a CPU box (fast + cites correctly); `1.5b` too weak; `7b`+ needs a strong box |
| Hosted demo can use Local? | **Yes — with a tunnel.** Point Settings → Model at your tunnel URL (tested end-to-end). Without a tunnel it can't reach your `localhost`, so it shows the friendly setup message |
| If Local isn't set up | Friendly setup message (no crash) |
| If Local is unreachable | Calm, fast message naming the endpoint (no long hang) |

*Setup of the rest of the app (logins, document search, the cloud answer model) is in [HANDOFF.md](HANDOFF.md).*
