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

> **Local ONLY works when you self-host Nucleus on the same machine/network as the model.**

The **hosted demo** (`https://nucleus-woad.vercel.app`) runs in the cloud. The cloud **cannot reach a model on your computer** — there's no tunnel from the internet into your living room. So if you flip the **demo** to Local and ask a question, Nucleus won't crash — it shows a **friendly setup message** explaining exactly this:

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
ollama pull qwen2.5        # a good, small default — or:
ollama pull llama3         # another solid choice

ollama serve               # usually already running after install
```

Ollama now serves an **OpenAI-compatible** endpoint at **`http://localhost:11434/v1`**. That's the address Nucleus needs.

### 3. Point Nucleus at your model (Settings → Model)

1. Open Nucleus (`http://localhost:3000`), sign in as the **admin**.
2. Go to **Settings → Model & Prompts → Model**.
3. In **Local model endpoint**, enter: `http://localhost:11434/v1`
4. In **Local model name**, enter the model you pulled: `qwen2.5` (or `llama3`).
5. Click **Save prompts** (it saves the Model section too).

### 4. Flip the big switch to Local and ask

1. At the top of the **Ask panel** (or in the Model section), click **Local** — the **Local** side fills with the teal accent: you're now Local.
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

Contrast with the **hosted cloud demo**: that one only uses **cloud** models — it's for trying Nucleus quickly without installing anything, and it **cannot** use a local model (the cloud can't reach your computer).

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
| Example endpoint | `http://localhost:11434/v1` (Ollama) |
| Good default models | `qwen2.5`, `llama3` (pull with `ollama pull <name>`) |
| Demo can use Local? | **No** — the hosted demo can only use Cloud models; Local needs self-host |
| If Local isn't set up | Friendly setup message (no crash) |
| If Local is unreachable | Calm, fast message naming the endpoint (no long hang) |

*Setup of the rest of the app (logins, document search, the cloud answer model) is in [HANDOFF.md](HANDOFF.md).*
