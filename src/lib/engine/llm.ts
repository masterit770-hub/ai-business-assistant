// Model-abstraction layer (OpenAI-compatible chat completions). Provider-neutral:
// the cloud generation model is selected by env BY DEFAULT, so swapping providers is
// a config change, never a code change. Key is env-only (never committed).
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
//
// RUNTIME OVERRIDE (no redeploy): an admin can ALSO paste a provider key in Settings
// → that swaps the cloud backend at request time via getCloudConfig() (OpenAI / Azure
// OpenAI / Google Gemini / DeepSeek). When no override is set, the env behavior above
// is used unchanged. See resolveCloudTarget() below for the per-provider request
// shape. NOTE: GCP *Vertex/HIPAA-BAA* uses Google service-account auth (not a static
// key) and is OUT OF SCOPE here — the consumer Gemini API key covers the simple GCP
// swap; a follow-up can add Vertex.
import {
  getModelConfig,
  getCloudConfig,
  getHipaaConfig,
  type CloudConfig,
  type HipaaConfig,
} from "./settings.ts";

const PROVIDER = process.env.LLM_PROVIDER ?? "deepseek";
const BASE = process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.LLM_MODEL ?? "deepseek-chat";

// LOCAL mode timeout. A dead host still fails FAST regardless of this value (the
// TCP connect is refused immediately), so this cap mainly bounds a routable-but-slow
// endpoint. 8s was too tight: when the model runs on a *remote* box reached over a
// tunnel (the "cloud app → your own machine" topology), the cross-region round trip
// + non-streaming generation routinely exceeds 8s and the answer was being dropped
// for the setup-guidance message. 45s covers a real remote/CPU generation while
// staying well under the route's 120s budget.
const LOCAL_TIMEOUT_MS = Number(process.env.LOCAL_TIMEOUT_MS) || 45000;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Real token accounting, surfaced from the provider's `usage` block when present.
// Every field is OPTIONAL: a provider that omits usage (or an unreachable local
// endpoint) yields `undefined`, which the UI renders as "n/a" — never a fabricated
// number. `provider`/`model` record which backend actually answered this call.
export type ChatUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  provider: string;
  model: string;
  // True when this call hit a real backend (so cost/token rows are meaningful);
  // a local call that couldn't report usage still sets this so "1 live call" is honest.
  live: boolean;
};

// The richer return shape: the generated text PLUS the real usage for this call.
export type ChatResult = { content: string; usage: ChatUsage };

// The slice of an OpenAI-compatible chat-completions response we read. `usage` is
// the standard OpenAI/Gemini/DeepSeek token block; absent on some providers.
type ChatCompletion = {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

function readUsage(
  data: ChatCompletion,
  provider: string,
  model: string,
  live: boolean
): ChatUsage {
  const u = data.usage;
  return {
    promptTokens: typeof u?.prompt_tokens === "number" ? u.prompt_tokens : undefined,
    completionTokens:
      typeof u?.completion_tokens === "number" ? u.completion_tokens : undefined,
    totalTokens: typeof u?.total_tokens === "number" ? u.total_tokens : undefined,
    provider,
    model,
    live,
  };
}

// ── Typed, recognizable errors for the Local backend ───────────────────────────
// The Ask path catches these specifically and returns a FRIENDLY 200 answer (the
// guidance text) instead of a scary 500. Both carry a stable `code` so the catch
// is robust to message changes.

/** Local mode is on but the owner hasn't entered a local endpoint yet. */
export class LocalNotConfiguredError extends Error {
  readonly code = "LOCAL_NOT_CONFIGURED" as const;
  constructor() {
    super("Local mode is on, but no local model endpoint is configured.");
    this.name = "LocalNotConfiguredError";
  }
}

/** Local mode is on, an endpoint is set, but the local model couldn't be reached. */
export class LocalUnreachableError extends Error {
  readonly code = "LOCAL_UNREACHABLE" as const;
  readonly endpoint: string;
  constructor(endpoint: string, detail?: string) {
    super(
      `Couldn't reach a local model at ${endpoint}${detail ? ` (${detail})` : ""}.`
    );
    this.name = "LocalUnreachableError";
    this.endpoint = endpoint;
  }
}

export function isLocalNotConfigured(e: unknown): e is LocalNotConfiguredError {
  return e instanceof LocalNotConfiguredError ||
    (e instanceof Error && (e as { code?: string }).code === "LOCAL_NOT_CONFIGURED");
}
export function isLocalUnreachable(e: unknown): e is LocalUnreachableError {
  return e instanceof LocalUnreachableError ||
    (e instanceof Error && (e as { code?: string }).code === "LOCAL_UNREACHABLE");
}

// "Configured" means there IS a backend able to answer. Cloud needs an API key in
// env (unchanged); Local needs the owner's endpoint — but the Ask route decides
// Local's readiness at request time (so it can show the friendly guidance), so for
// the route-level 503 gate we only require that EITHER backend could work. We keep
// the original semantics for cloud (env key present) and treat Local as "the route
// will handle it gracefully", so a Local-mode workspace with no cloud key still
// reaches answerQuestion and produces the guidance rather than a blunt 503.
export function llmConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY);
}

// Request-time "is a backend reachable?" gate for the Ask route. True when ANY of:
//   • the env cloud key is present (the unchanged default), OR
//   • an admin set a runtime cloud override (a provider + pasted key) in Settings, OR
//   • the workspace is in Local mode (the route handles Local readiness gracefully,
//     turning a missing/unreachable endpoint into friendly guidance, not a 503).
// This is what lets a "paste your key" swap work on a server with no env key set.
export async function backendConfigured(): Promise<boolean> {
  if (process.env.LLM_API_KEY) return true;
  const model = await getModelConfig();
  if (model.mode === "local") return true;
  if (model.mode === "hipaa") {
    // HIPAA mode is "configured" only when its own Azure slots are fully set (no env
    // fallback by design — see resolveHipaaTarget); otherwise the route should 503
    // rather than route PHI-intent traffic to the non-BAA env backend.
    const h = await getHipaaConfig();
    return Boolean(h.apiKey && h.endpoint && h.model);
  }
  const cloud = await getCloudConfig();
  return cloud.provider !== "" && cloud.apiKey !== "";
}

// Transient statuses worth a retry: 429 (rate limit) and 5xx (the free tier
// returns 503 "model experiencing high demand" under load). A 4xx like 401/400
// is a real config error — never retried.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Back-compat string entry — most callers (the router, the general-knowledge
// generator) only want the text. It delegates to chatWithUsage and drops the usage.
export async function chat(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number } = {}
): Promise<string> {
  return (await chatWithUsage(messages, opts)).content;
}

// Usage-aware entry — the answer orchestrator uses this so it can surface the REAL
// token counts + which backend answered in the Inspector's Cost & Tokens panel.
export async function chatWithUsage(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number } = {}
): Promise<ChatResult> {
  // Read the Cloud⇄Local switch at REQUEST time so flipping the toggle takes
  // effect on the very next question — no restart, no redeploy.
  const cfg = await getModelConfig();
  if (cfg.mode === "local") {
    return chatLocal(messages, opts, cfg.localEndpoint, cfg.localModel);
  }
  if (cfg.mode === "hipaa") {
    return chatHipaa(messages, opts);
  }
  return chatCloud(messages, opts);
}

// The resolved cloud HTTP target for one request: where to POST, what auth header to
// send, and the provider/model labels for usage + error messages. All providers use
// the SAME OpenAI chat-completions BODY — they differ only in URL + auth header.
type CloudTarget = { url: string; headers: Record<string, string>; provider: string; model: string };

// Default OpenAI-compatible base when a provider override gives no explicit base_url.
const PROVIDER_DEFAULT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

// Shared Azure OpenAI request shape — deployment-scoped URL + `api-key` header (NOT
// Bearer). Used by BOTH cloud-azure and hipaa-azure so the two stay in lockstep; the
// existing azure unit test pins this exact URL/header output. NEVER logs the key.
function buildAzureTarget(
  endpoint: string,
  apiVersion: string,
  model: string,
  apiKey: string,
  providerLabel: string
): CloudTarget {
  const base = endpoint.replace(/\/+$/, "");
  const ver = apiVersion || "2024-10-21";
  return {
    url: `${base}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(ver)}`,
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    provider: providerLabel,
    model,
  };
}

/**
 * Decide the HIPAA (Azure OpenAI under a Microsoft BAA) target for THIS request.
 * Reuses the proven Azure request shape. There is NO env fallback by design: if the
 * Azure key/endpoint/model isn't saved it throws a clear config error rather than
 * silently routing PHI-intent traffic to the non-BAA env (DeepSeek) backend.
 */
export function resolveHipaaTarget(cfg: HipaaConfig): CloudTarget {
  const endpoint = cfg.endpoint.replace(/\/+$/, "");
  if (!endpoint) throw new Error("HIPAA (Azure OpenAI) selected but hipaa_endpoint is not set");
  if (!cfg.model) throw new Error("HIPAA (Azure OpenAI) selected but hipaa_model (deployment name) is not set");
  if (!cfg.apiKey) throw new Error("HIPAA mode selected but no Azure key is saved");
  return buildAzureTarget(endpoint, cfg.apiVersion, cfg.model, cfg.apiKey, "azure-hipaa");
}

/**
 * Decide the cloud target for THIS request. If the admin has set a runtime override
 * in Settings (a provider + a key), build the request per provider. Otherwise fall
 * back to the env-configured backend EXACTLY as before — so the demo default is
 * unchanged. A provider chosen WITHOUT a key is ignored (falls back to env), so a
 * half-filled form can't break the working cloud default.
 */
export function resolveCloudTarget(cfg: CloudConfig): CloudTarget {
  const override = cfg.provider !== "" && cfg.apiKey !== "";
  if (!override) {
    // ── ENV DEFAULT (unchanged behavior) ──
    const key = process.env.LLM_API_KEY;
    if (!key) throw new Error("LLM_API_KEY not set");
    return {
      url: `${BASE}/chat/completions`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      provider: PROVIDER,
      model: MODEL,
    };
  }

  if (cfg.provider === "azure") {
    // Azure OpenAI: deployment-scoped URL + an `api-key` header (NOT Bearer).
    if (!cfg.azureEndpoint.replace(/\/+$/, "")) throw new Error("Azure OpenAI selected but azure_endpoint is not set");
    if (!cfg.model) throw new Error("Azure OpenAI selected but cloud_model (deployment name) is not set");
    return buildAzureTarget(cfg.azureEndpoint, cfg.azureApiVersion, cfg.model, cfg.apiKey, "azure");
  }

  // openai / gemini / deepseek / custom — all OpenAI-compatible: Bearer + base/chat.
  // An explicit cloud_base_url wins (custom/self-hosted gateways); otherwise the
  // provider's known default base.
  const base = (cfg.baseUrl || PROVIDER_DEFAULT_BASE[cfg.provider] || "").replace(/\/+$/, "");
  if (!base) throw new Error(`${cfg.provider} selected but no base URL is known/set`);
  const model = cfg.model || (cfg.provider === "gemini" ? "gemini-2.5-flash" : cfg.provider === "deepseek" ? "deepseek-chat" : "");
  if (!model) throw new Error(`${cfg.provider} selected but cloud_model is not set`);
  return {
    url: `${base}/chat/completions`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    provider: cfg.provider,
    model,
  };
}

// CLOUD — env-configured provider, OR the admin's runtime provider override (read at
// REQUEST time so a pasted key takes effect on the very next question, no redeploy).
// Returns the provider's real `usage` block for honest token accounting.
async function chatCloud(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number }
): Promise<ChatResult> {
  const cfg = await getCloudConfig();
  const target = resolveCloudTarget(cfg);
  const payload = JSON.stringify({
    model: target.model,
    messages,
    temperature: opts.temperature ?? 0,
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  });

  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: payload,
    });
    if (res.ok) {
      const data = (await res.json()) as ChatCompletion;
      return {
        content: data.choices?.[0]?.message?.content ?? "",
        usage: readUsage(data, target.provider, target.model, true),
      };
    }
    const body = await res.text().catch(() => "");
    // Provider-labelled so a billing/auth error names the active backend.
    lastErr = `${target.provider} (${target.model}) ${res.status}: ${body.slice(0, 300)}`;
    // Only retry transient capacity/rate errors; surface real config errors now.
    if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) break;
    // Exponential backoff with jitter (the free tier's 503 spikes are brief).
    await sleep(700 * 2 ** (attempt - 1) + Math.floor(Math.random() * 300));
  }
  throw new Error(lastErr);
}

// HIPAA — Azure OpenAI under a Microsoft BAA. Structurally identical to chatCloud
// (same retry/backoff, same honest usage), but resolves the INDEPENDENT hipaa_* slot
// via getHipaaConfig()+resolveHipaaTarget(). No env fallback: an unconfigured HIPAA
// mode throws a clear config error rather than leaking to the non-BAA env backend.
// The provider label "azure-hipaa" names the right backend on any billing/auth error;
// the error string carries provider/model/status/body only — NEVER the key.
async function chatHipaa(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number }
): Promise<ChatResult> {
  const cfg = await getHipaaConfig();
  const target = resolveHipaaTarget(cfg);
  const payload = JSON.stringify({
    model: target.model,
    messages,
    temperature: opts.temperature ?? 0,
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  });

  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: payload,
    });
    if (res.ok) {
      const data = (await res.json()) as ChatCompletion;
      return {
        content: data.choices?.[0]?.message?.content ?? "",
        usage: readUsage(data, target.provider, target.model, true),
      };
    }
    const body = await res.text().catch(() => "");
    lastErr = `${target.provider} (${target.model}) ${res.status}: ${body.slice(0, 300)}`;
    if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) break;
    await sleep(700 * 2 ** (attempt - 1) + Math.floor(Math.random() * 300));
  }
  throw new Error(lastErr);
}

// LOCAL — call the owner's own OpenAI-compatible endpoint (e.g. an Ollama server
// at http://localhost:11434/v1). No API key (Ollama needs none; we send a
// placeholder bearer for clients that require the header). A short timeout so a
// dead endpoint fails fast. The two failure shapes are TYPED so the Ask path can
// turn them into friendly guidance instead of a 500:
//   • empty endpoint        → LocalNotConfiguredError
//   • unreachable / timeout → LocalUnreachableError(endpoint)
async function chatLocal(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number },
  endpoint: string,
  model: string
): Promise<ChatResult> {
  if (!endpoint) throw new LocalNotConfiguredError();
  // Normalize: tolerate a trailing slash so "…/v1/" and "…/v1" both work.
  const base = endpoint.replace(/\/+$/, "");
  const payload = JSON.stringify({
    model,
    messages,
    temperature: opts.temperature ?? 0,
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Ollama ignores this; a placeholder keeps strict OpenAI clients happy.
        Authorization: "Bearer ollama",
      },
      body: payload,
      signal: controller.signal,
    });
  } catch (e) {
    // A network failure (ECONNREFUSED / DNS) or an abort (timeout) → unreachable.
    const detail =
      (e as Error)?.name === "AbortError"
        ? `timed out after ${LOCAL_TIMEOUT_MS / 1000}s`
        : (e as Error)?.message?.slice(0, 120) || "connection failed";
    throw new LocalUnreachableError(endpoint, detail);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // A reachable-but-erroring local server (e.g. model not pulled) reads as
    // "unreachable for answering" from the owner's perspective; the guidance
    // tells her to confirm the model is pulled and the endpoint is right.
    throw new LocalUnreachableError(endpoint, `HTTP ${res.status}: ${body.slice(0, 160)}`);
  }
  const data = (await res.json()) as ChatCompletion;
  // Ollama (and other OpenAI-compat local servers) usually DO report a usage block;
  // when absent the tokens come back undefined → the UI shows "n/a" rather than a
  // fabricated count. The provider label is "local" + the configured model name.
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    usage: readUsage(data, "local", model, true),
  };
}
