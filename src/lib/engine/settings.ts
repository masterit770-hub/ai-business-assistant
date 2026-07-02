// Editable engine settings — the system prompt (governs grounded generation) and
// the urgency prompt (governs the dashboard badge classification). The admin
// Prompt-config panel reads + writes these, and the engine reads them at request
// time, so editing a prompt actually changes behaviour.
//
// Persistence mirrors the document store: a Supabase `engine_settings` row when
// configured (durable), else a process-level in-memory value (fallback). A
// missing/blank value falls back to the built-in default, so the engine always
// has a working prompt.
import { supabaseEnabled, admin } from "./supabase.ts";
import { currentOwner } from "./request-context.ts";

// Editable settings are of two shapes:
//  • PROMPT settings (system_prompt, urgency_prompt) — long free text; a blank
//    value means "fall back to the built-in default".
//  • MODEL settings (model_mode, local_endpoint, local_model) — the Cloud⇄Local
//    switch. `model_mode` chooses which backend answers at REQUEST time; the two
//    `local_*` keys hold the OWNER's own machine's OpenAI-compatible endpoint +
//    model id (only used when mode === "local"). A blank value falls back to the
//    default (e.g. an empty endpoint means "Local isn't configured yet").
//  • CLOUD PROVIDER settings (cloud_provider, cloud_api_key, cloud_model,
//    cloud_base_url, azure_endpoint, azure_api_version) — a RUNTIME override of the
//    cloud backend. The demo's cloud provider is normally env-only (DeepSeek); these
//    let an admin "paste a key" in Settings to swap to OpenAI / Azure OpenAI / Google
//    Gemini with NO redeploy. EVERY key defaults to "" meaning "use the env default",
//    so an unconfigured workspace answers exactly as before. `cloud_api_key` is
//    WRITE-ONLY over the API (the GET never returns its value — see settings route).
export type SettingKey =
  | "system_prompt"
  | "urgency_prompt"
  | "model_mode"
  | "local_endpoint"
  | "local_model"
  | "cloud_provider"
  | "cloud_api_key"
  | "cloud_model"
  | "cloud_base_url"
  | "azure_endpoint"
  | "azure_api_version"
  // HIPAA-eligible mode (Azure OpenAI under a Microsoft BAA). A SEPARATE, independent
  // set of slots so a HIPAA (Azure) key NEVER overwrites the cloud key. `hipaa_api_key`
  // is WRITE-ONLY over the API, exactly like cloud_api_key.
  | "hipaa_api_key"
  | "hipaa_endpoint"
  | "hipaa_api_version"
  | "hipaa_model"
  // Cache (JSON map docId→urgency) of the bundled sample docs' classified urgency, so
  // the dashboard shows a badge on EVERY document (not just uploads) without an LLM call
  // per request. Derived (classified) once + cleared when urgency_prompt changes (so it
  // re-derives — the #G behavior for bundled docs).
  | "bundled_urgency"
  // Flag set once per owner when the default Knowledge Spaces have been seeded.
  // Value "1" = already seeded; absent/non-"1" = not yet seeded. Gated on the FLAG,
  // NOT on "0 spaces" — so a user who deletes their spaces doesn't re-trigger the seed.
  | "spaces_seeded";

// The built-in defaults. The system-prompt default is the FULL generation
// contract (kept in answer.ts historically); here we expose only the
// admin-editable "answering style" preamble, which is prepended to the immutable
// grounding rules so a prompt edit can change tone/strictness without letting the
// user delete the citation guarantees. The urgency default classifies a doc.
//
// MODEL defaults: Cloud is the default backend (the working env-configured
// provider — DeepSeek/Gemini), so an unconfigured workspace keeps answering
// exactly as before. `local_endpoint` defaults to "" (empty = Local not set up
// → the friendly guidance fires, never a crash). `local_model` defaults to a
// sensible Ollama model so the owner usually only has to set the endpoint.
export const DEFAULTS: Record<SettingKey, string> = {
  system_prompt: `You are NUCLEUS 770, a sharp, helpful business assistant. Answer clearly, concretely, and concisely. When the user's documents or data are provided as evidence, ground your answer strictly in them and cite every fact; otherwise answer from your general knowledge.`,
  urgency_prompt: `Classify the document's urgency for the dashboard badge.
- HIGH: contracts/notices expiring within 30 days, renewals, anything time-critical or financially material this month.
- MEDIUM: items needing attention this quarter — pending reviews, upcoming renewals 30–90 days out.
- LOW: reference material, completed items, nothing time-sensitive.
Answer with exactly one word: high, medium, or low.`,
  model_mode: "cloud",
  local_endpoint: "",
  local_model: "qwen2.5",
  // CLOUD PROVIDER override — all blank by default = "use the env-configured cloud
  // backend" (the demo's DeepSeek), so behavior is unchanged until an admin sets one.
  cloud_provider: "",
  cloud_api_key: "",
  cloud_model: "",
  cloud_base_url: "",
  azure_endpoint: "",
  azure_api_version: "",
  // HIPAA mode (Azure OpenAI) override — all blank by default = "not configured".
  // Independent of the cloud_* slots, so the two keys never collide.
  hipaa_api_key: "",
  bundled_urgency: "{}",
  hipaa_endpoint: "",
  hipaa_api_version: "",
  hipaa_model: "",
  // Not seeded by default (empty string → first listSpaces() call triggers seeding).
  spaces_seeded: "",
};

// In-memory fallback store (used when Supabase isn't configured). On globalThis so
// Next.js dev module reloads don't silently reset it.
const g = globalThis as unknown as { __nucleusSettings?: Partial<Record<SettingKey, string>> };
function mem(): Partial<Record<SettingKey, string>> {
  if (!g.__nucleusSettings) g.__nucleusSettings = {};
  return g.__nucleusSettings;
}

/**
 * Read a setting for the CURRENT USER (the stored per-user override, else the shared
 * NULL-owner workspace default, else the built-in default). The owner is the per-request
 * ALS owner (`currentOwner()`); pass `ownerId` explicitly to override. `bundled_urgency`
 * is a workspace-level cache (NOT a user setting) so it is always read globally.
 */
export async function getSetting(key: SettingKey, ownerId = currentOwner()): Promise<string> {
  const owner = key === "bundled_urgency" ? undefined : ownerId;
  if (!supabaseEnabled()) return mem()[key] ?? DEFAULTS[key];
  let q = admin().from("engine_settings").select("value, owner_id").eq("key", key);
  if (owner) {
    // The user's OWN row OR the shared (NULL-owner) default; order so the user's row
    // (non-null owner) wins when present, the default is the fallback.
    q = q
      .or(`owner_id.eq.${owner},owner_id.is.null`)
      .order("owner_id", { ascending: true, nullsFirst: false })
      .limit(1);
  } else {
    q = q.is("owner_id", null).limit(1);
  }
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`settings read failed: ${error.message}`);
  const v = data?.value;
  return v && v.trim() ? v : DEFAULTS[key];
}

// The admin-panel view of settings. NOTE: this deliberately does NOT include the
// raw `cloud_api_key` — the secret is WRITE-ONLY over the API. Instead the panel
// gets `cloud_api_key_set` (a boolean) so the UI can show "key saved" without ever
// echoing the secret back. All other cloud-provider fields are non-secret config.
export type AdminSettings = Omit<
  Record<SettingKey, string>,
  "cloud_api_key" | "hipaa_api_key" | "bundled_urgency" | "spaces_seeded"
> & {
  cloud_api_key_set: boolean;
  hipaa_api_key_set: boolean;
};

/** Read all editable settings for the admin panel — the api key is masked to a bool. */
export async function getSettings(): Promise<AdminSettings> {
  return {
    system_prompt: await getSetting("system_prompt"),
    urgency_prompt: await getSetting("urgency_prompt"),
    model_mode: await getModelMode(),
    local_endpoint: await getSetting("local_endpoint"),
    local_model: await getSetting("local_model"),
    cloud_provider: await getSetting("cloud_provider"),
    cloud_model: await getSetting("cloud_model"),
    cloud_base_url: await getSetting("cloud_base_url"),
    azure_endpoint: await getSetting("azure_endpoint"),
    azure_api_version: await getSetting("azure_api_version"),
    // HIPAA (Azure) non-secret config — its own independent slots.
    hipaa_endpoint: await getSetting("hipaa_endpoint"),
    hipaa_api_version: await getSetting("hipaa_api_version"),
    hipaa_model: await getSetting("hipaa_model"),
    // Write-only: never the value, only whether a key is stored.
    cloud_api_key_set: (await getSetting("cloud_api_key")).trim().length > 0,
    hipaa_api_key_set: (await getSetting("hipaa_api_key")).trim().length > 0,
  };
}

export type ModelMode = "cloud" | "hipaa" | "local";

/**
 * The active backend for this request: "cloud" (the env-configured provider —
 * the default, unchanged behavior), "hipaa" (Azure OpenAI under a Microsoft BAA),
 * or "local" (the owner's own machine). Anything other than the literal "local" or
 * "hipaa" resolves to "cloud", so a corrupt/blank value fails safe to the working
 * cloud default rather than to a half-configured backend.
 */
export async function getModelMode(): Promise<ModelMode> {
  const v = (await getSetting("model_mode")).trim().toLowerCase();
  if (v === "local") return "local";
  if (v === "hipaa") return "hipaa";
  return "cloud";
}

export type ModelConfig = {
  mode: ModelMode;
  /** OpenAI-compatible base URL of the owner's local model, e.g. http://localhost:11434/v1. "" when unset. */
  localEndpoint: string;
  /** Model id to request at the local endpoint, e.g. qwen2.5 / llama3. */
  localModel: string;
};

/** The effective model config (mode + local endpoint/model), read at request time. */
export async function getModelConfig(): Promise<ModelConfig> {
  return {
    mode: await getModelMode(),
    localEndpoint: (await getSetting("local_endpoint")).trim(),
    localModel: (await getSetting("local_model")).trim() || DEFAULTS.local_model,
  };
}

// ── CLOUD PROVIDER override (paste-a-key model swap) ───────────────────────────
// The set of cloud providers an admin can pick in Settings. "" means "no override —
// use the env-configured cloud backend" (the demo default). The recognized values
// all speak the OpenAI chat-completions wire format (azure differs only in URL +
// auth-header shape — handled in llm.ts).
export type CloudProvider = "" | "openai" | "azure" | "gemini" | "deepseek";

const CLOUD_PROVIDERS: CloudProvider[] = ["openai", "azure", "gemini", "deepseek"];

/** Normalize the stored provider string to a known value, else "" (= env default). */
export async function getCloudProvider(): Promise<CloudProvider> {
  const v = (await getSetting("cloud_provider")).trim().toLowerCase();
  return (CLOUD_PROVIDERS as string[]).includes(v) ? (v as CloudProvider) : "";
}

export type CloudConfig = {
  /** "" = no override (use env). Otherwise the selected provider. */
  provider: CloudProvider;
  /** The provider API key (secret). "" when not set → llm.ts falls back to env. */
  apiKey: string;
  /** Model id / Azure deployment name. "" when not set. */
  model: string;
  /** Optional OpenAI-compatible base URL override (openai/custom). "" when unset. */
  baseUrl: string;
  /** Azure resource endpoint, e.g. https://my-resource.openai.azure.com. */
  azureEndpoint: string;
  /** Azure api-version, e.g. 2024-10-21. */
  azureApiVersion: string;
};

/**
 * The effective cloud-provider override, read at REQUEST time. When `provider` is
 * "" the caller (llm.ts) keeps the existing env behavior unchanged. A provider with
 * no api key set is treated as "not actually overridden" by llm.ts (so a half-filled
 * form can't silently break the working cloud default).
 */
export async function getCloudConfig(): Promise<CloudConfig> {
  return {
    provider: await getCloudProvider(),
    apiKey: (await getSetting("cloud_api_key")).trim(),
    model: (await getSetting("cloud_model")).trim(),
    baseUrl: (await getSetting("cloud_base_url")).trim(),
    azureEndpoint: (await getSetting("azure_endpoint")).trim(),
    azureApiVersion: (await getSetting("azure_api_version")).trim(),
  };
}

// ── HIPAA mode (Azure OpenAI under a Microsoft BAA) ────────────────────────────
// An INDEPENDENT set of slots from cloud_* so a HIPAA (Azure) key never collides
// with the cloud key. Azure-shaped (api-key header + deployment URL + api-version).
// There is deliberately NO env fallback for this mode (see llm.ts): if it isn't
// configured it fails closed with a clear error rather than silently routing
// PHI-intent traffic to the non-BAA env (DeepSeek) backend.
export type HipaaConfig = { apiKey: string; endpoint: string; apiVersion: string; model: string };

/** The effective HIPAA (Azure) config, read at REQUEST time. */
export async function getHipaaConfig(): Promise<HipaaConfig> {
  return {
    apiKey: (await getSetting("hipaa_api_key")).trim(),
    endpoint: (await getSetting("hipaa_endpoint")).trim(),
    apiVersion: (await getSetting("hipaa_api_version")).trim(),
    model: (await getSetting("hipaa_model")).trim(),
  };
}

/**
 * Persist a setting override for the CURRENT USER (per-request ALS owner, or `ownerId`
 * if passed). Empty/blank clears it (the read then falls back to the shared default).
 * `bundled_urgency` is a workspace-level cache → always written globally (NULL owner).
 */
export async function setSetting(
  key: SettingKey,
  value: string,
  ownerId = currentOwner()
): Promise<void> {
  const owner = key === "bundled_urgency" ? null : ownerId ?? null;
  if (!supabaseEnabled()) {
    if (value.trim()) mem()[key] = value;
    else delete mem()[key];
    // Editing the urgency prompt invalidates the cached bundled-doc urgency so it
    // re-derives on the next documents load (the #G re-derivation, for bundled docs).
    if (key === "urgency_prompt") delete mem().bundled_urgency;
    return;
  }
  const { error } = await admin()
    .from("engine_settings")
    .upsert(
      { owner_id: owner, key, value, updated_at: new Date().toISOString() },
      { onConflict: "owner_id,key" }
    );
  if (error) throw new Error(`settings write failed: ${error.message}`);
  // Changing the urgency prompt clears the (global) bundled-urgency cache → re-derivation.
  if (key === "urgency_prompt") {
    await admin().from("engine_settings").delete().eq("key", "bundled_urgency").is("owner_id", null);
  }
}
