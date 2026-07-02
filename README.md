# Nucleus — AI Business Assistant

An AI assistant that answers questions about your documents and business data — with a **citation on every fact**, so you can always check where an answer came from.

- **Cited Q&A** across your documents *and* structured data (contracts, maintenance, case files…) in one answer
- **English & Hebrew**
- **Upload** PDFs, scanned documents, Excel/CSV → ask about them immediately
- **Access control** — admins create accounts and can remove anyone instantly; each user sees only their **own** uploaded documents

It is a **single Next.js application** (the UI and the retrieval/answer engine run together), deployed once.

## Live demo
**https://nucleus-770.vercel.app/sign-in** — sample data is preloaded so you can try it right away. (Demo logins are provided separately.)

## Run it on your own accounts
See **[docs/HANDOFF.md](docs/HANDOFF.md)** — a step-by-step setup guide written so a non-technical owner (or an AI assistant) can follow it: which accounts to open (GitHub, Vercel, Supabase, Google Gemini), how to deploy, and how to make yourself the first admin. Copy `.env.example` to `.env.local` and fill in your own keys.

## Tech
Next.js (App Router) on Vercel · Supabase (auth + users) · Google Gemini File Search (document search) · a configurable answer model (DeepSeek / Gemini / Azure / Vertex — a one-line swap).
