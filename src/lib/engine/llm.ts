// Model-abstraction layer (OpenAI-compatible chat completions). Provider-neutral:
// the generation model is selected entirely by env, so swapping providers is a
// config change, never a code change. Key is env-only (never committed).
//
//   LLM_PROVIDER  a label for messages/observability (e.g. "deepseek", "gemini",
//                 "azure-openai"). Cosmetic only — the wire format is OpenAI-compat.
//   LLM_BASE_URL  the OpenAI-compatible base (…/v1 or provider equivalent).
//   LLM_MODEL     the model id at that provider.
//   LLM_API_KEY   bearer key for that provider.
//
// Verified providers (all OpenAI-compatible, drop-in):
//   DeepSeek      BASE=https://api.deepseek.com                                  MODEL=deepseek-chat
//   Gemini (GCP)  BASE=https://generativelanguage.googleapis.com/v1beta/openai  MODEL=gemini-2.5-flash
//   Azure OpenAI  BASE=https://<resource>.openai.azure.com/openai/deployments/<dep>  (PROD default, client-supplied)
const PROVIDER = process.env.LLM_PROVIDER ?? "deepseek";
const BASE = process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.LLM_MODEL ?? "deepseek-chat";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function llmConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY);
}

// Transient statuses worth a retry: 429 (rate limit) and 5xx (the free tier
// returns 503 "model experiencing high demand" under load). A 4xx like 401/400
// is a real config error — never retried.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chat(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number } = {}
): Promise<string> {
  const key = process.env.LLM_API_KEY;
  if (!key) throw new Error("LLM_API_KEY not set");
  const payload = JSON.stringify({
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0,
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  });

  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: payload,
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      return data.choices?.[0]?.message?.content ?? "";
    }
    const body = await res.text().catch(() => "");
    // Provider-labelled so a billing/auth error names the active backend.
    lastErr = `${PROVIDER} (${MODEL}) ${res.status}: ${body.slice(0, 300)}`;
    // Only retry transient capacity/rate errors; surface real config errors now.
    if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) break;
    // Exponential backoff with jitter (the free tier's 503 spikes are brief).
    await sleep(700 * 2 ** (attempt - 1) + Math.floor(Math.random() * 300));
  }
  throw new Error(lastErr);
}
