// Local multilingual embeddings via transformers.js (Xenova/multilingual-e5-small).
// No API key — runs locally at build time (to embed PDF chunks) and at query time
// (to embed the question). Multilingual → the Hebrew-readiness seam.
//
// e5 models expect "query: " / "passage: " prefixes; we apply them so EN and HE
// land in the same space.
// This module is a thin CLIENT: it does NOT import transformers.js (that would pull
// the heavy embed deps into every function that touches the engine). The actual
// embedding runs in the dedicated /api/embed function (src/lib/engine/embed-core.ts).
// Splitting it keeps /api/ask under Vercel's per-function size limit while staying ONE
// deployment. When NOT on a server with a reachable /api/embed (local scripts/tests),
// we fall back to importing embed-core directly.
function baseUrl(): string | null {
  // Same-origin internal call. On Vercel, VERCEL_URL is the deployment host.
  const explicit = process.env.NUCLEUS_SELF_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const vurl = process.env.VERCEL_URL;
  if (vurl) return `https://${vurl}`;
  return null;
}

async function embed(text: string, prefix: "query" | "passage"): Promise<number[]> {
  const base = baseUrl();
  if (base) {
    const res = await fetch(`${base}/api/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.INTERNAL_EMBED_TOKEN
          ? { "x-internal-token": process.env.INTERNAL_EMBED_TOKEN }
          : {}),
        // bypass Vercel deployment protection for the internal hop on preview
        ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
          ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
          : {}),
      },
      body: JSON.stringify({ text, prefix }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(`embed function ${res.status}: ${d?.error ?? "failed"}`);
    }
    const d = await res.json();
    return d.embedding as number[];
  }
  // No server URL (local script/test) → embed in-process.
  const { embedText } = await import("./embed-core.ts");
  return embedText(text, prefix);
}

export const embedQuery = (t: string) => embed(t, "query");
export const embedPassage = (t: string) => embed(t, "passage");

export function cosineSim(a: number[], b: number[]): number {
  // vectors are L2-normalized → dot product is cosine similarity
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
