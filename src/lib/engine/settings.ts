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

// Editable settings are of two shapes:
//  • PROMPT settings (system_prompt, urgency_prompt) — long free text; a blank
//    value means "fall back to the built-in default".
//  • MODEL settings (model_mode, local_endpoint, local_model) — the Cloud⇄Local
//    switch. `model_mode` chooses which backend answers at REQUEST time; the two
//    `local_*` keys hold the OWNER's own machine's OpenAI-compatible endpoint +
//    model id (only used when mode === "local"). A blank value falls back to the
//    default (e.g. an empty endpoint means "Local isn't configured yet").
export type SettingKey =
  | "system_prompt"
  | "urgency_prompt"
  | "model_mode"
  | "local_endpoint"
  | "local_model";

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
  system_prompt: `You are Nucleus, a sharp, helpful business assistant. Answer clearly, concretely, and concisely. When the user's documents or data are provided as evidence, ground your answer strictly in them and cite every fact; otherwise answer from your general knowledge.`,
  urgency_prompt: `Classify the document's urgency for the dashboard badge.
- HIGH: contracts/notices expiring within 30 days, renewals, anything time-critical or financially material this month.
- MEDIUM: items needing attention this quarter — pending reviews, upcoming renewals 30–90 days out.
- LOW: reference material, completed items, nothing time-sensitive.
Answer with exactly one word: high, medium, or low.`,
  model_mode: "cloud",
  local_endpoint: "",
  local_model: "qwen2.5",
};

// In-memory fallback store (used when Supabase isn't configured). On globalThis so
// Next.js dev module reloads don't silently reset it.
const g = globalThis as unknown as { __nucleusSettings?: Partial<Record<SettingKey, string>> };
function mem(): Partial<Record<SettingKey, string>> {
  if (!g.__nucleusSettings) g.__nucleusSettings = {};
  return g.__nucleusSettings;
}

/** Read a setting (the stored override, or the built-in default). */
export async function getSetting(key: SettingKey): Promise<string> {
  if (!supabaseEnabled()) return mem()[key] ?? DEFAULTS[key];
  const { data, error } = await admin()
    .from("engine_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(`settings read failed: ${error.message}`);
  const v = data?.value;
  return v && v.trim() ? v : DEFAULTS[key];
}

/** Read all editable settings (for the admin panel). */
export async function getSettings(): Promise<Record<SettingKey, string>> {
  return {
    system_prompt: await getSetting("system_prompt"),
    urgency_prompt: await getSetting("urgency_prompt"),
    model_mode: await getModelMode(),
    local_endpoint: await getSetting("local_endpoint"),
    local_model: await getSetting("local_model"),
  };
}

export type ModelMode = "cloud" | "local";

/**
 * The active backend for this request: "cloud" (the env-configured provider —
 * the default, unchanged behavior) or "local" (the owner's own machine). Anything
 * other than the literal "local" resolves to "cloud", so a corrupt/blank value
 * fails safe to the working cloud default rather than to a half-configured local.
 */
export async function getModelMode(): Promise<ModelMode> {
  const v = (await getSetting("model_mode")).trim().toLowerCase();
  return v === "local" ? "local" : "cloud";
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

/** Persist a setting override. Empty/blank clears it (back to the default). */
export async function setSetting(key: SettingKey, value: string): Promise<void> {
  if (!supabaseEnabled()) {
    if (value.trim()) mem()[key] = value;
    else delete mem()[key];
    return;
  }
  const { error } = await admin()
    .from("engine_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(`settings write failed: ${error.message}`);
}
