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

export type SettingKey = "system_prompt" | "urgency_prompt";

// The built-in defaults. The system-prompt default is the FULL generation
// contract (kept in answer.ts historically); here we expose only the
// admin-editable "answering style" preamble, which is prepended to the immutable
// grounding rules so a prompt edit can change tone/strictness without letting the
// user delete the citation guarantees. The urgency default classifies a doc.
export const DEFAULTS: Record<SettingKey, string> = {
  system_prompt: `You answer business questions using ONLY the retrieved evidence. Be concise and concrete, state verified aggregates exactly, and never speculate beyond the evidence.`,
  urgency_prompt: `Classify the document's urgency for the dashboard badge.
- HIGH: contracts/notices expiring within 30 days, renewals, anything time-critical or financially material this month.
- MEDIUM: items needing attention this quarter — pending reviews, upcoming renewals 30–90 days out.
- LOW: reference material, completed items, nothing time-sensitive.
Answer with exactly one word: high, medium, or low.`,
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
