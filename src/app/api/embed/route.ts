import { NextResponse } from "next/server";
import { embedText } from "@/lib/engine/embed-core";

// Dedicated embedding function. Isolated from /api/ask so the heavy local-embedder
// deps (transformers.js + onnxruntime-web WASM) live in THIS function only — keeping
// /api/ask under Vercel's per-function size limit. It's still ONE deployment (one
// project, one repo); this is just an internal microfunction /api/ask calls.
//
// AUTH: internal-only. It's invoked server-to-server by the in-process engine, not by
// the browser, so it's gated by a shared secret (INTERNAL_EMBED_TOKEN) rather than a
// user session. No user data flows here — only the text to embed.
export const runtime = "nodejs";
// The first call cold-starts + loads the WASM embedding model (slow); warm calls are
// fast. Allow headroom so a cold start never times out (Vercel max is 300s).
export const maxDuration = 120;

// Warmup: load the WASM embedding model so the user's FIRST real question doesn't
// eat the cold start (~30-60s). The dashboard fires this on mount. No data in/out, so
// it needs no auth — it just primes the function.
export async function GET() {
  try {
    await embedText("warmup", "query");
    return NextResponse.json({ ok: true, warm: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "warmup failed" },
      { status: 200 } // warmup never blocks anything
    );
  }
}

export async function POST(req: Request) {
  const token = process.env.INTERNAL_EMBED_TOKEN;
  if (token && req.headers.get("x-internal-token") !== token) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let text = "";
  let prefix: "query" | "passage" = "query";
  try {
    const body = await req.json();
    text = (body?.text ?? "").toString();
    if (body?.prefix === "passage") prefix = "passage";
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });
  try {
    const embedding = await embedText(text, prefix);
    return NextResponse.json({ embedding });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "embedding failed" },
      { status: 500 }
    );
  }
}
