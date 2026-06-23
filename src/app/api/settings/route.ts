import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { getSettings, setSetting, getSetting, type SettingKey } from "@/lib/engine/settings";
import { runWithOwner } from "@/lib/engine/request-context";

// Admin Prompt-config — engine logic IN-PROCESS (no proxy). GET reads the live
// editable prompts; PUT persists edits, which the engine then uses for real
// generation + urgency classification. ADMIN-ONLY: these prompts change every
// user's answers, so only an admin may read/write them.
export const runtime = "nodejs";

// Every admin-editable setting the PUT will persist when present in the body. The
// MODEL keys (the Cloud⇄Local switch + the owner's local endpoint/model) live here
// alongside the prompts; the CLOUD PROVIDER keys (the paste-a-key model swap) live
// here too. All are admin-only to write. NOTE: `cloud_api_key` is handled SEPARATELY
// below (write-only, and a blank submit must NOT clobber a stored key).
const KEYS: SettingKey[] = [
  "system_prompt",
  "urgency_prompt",
  "model_mode",
  "local_endpoint",
  "local_model",
  "cloud_provider",
  "cloud_model",
  "cloud_base_url",
  "azure_endpoint",
  "azure_api_version",
  // HIPAA (Azure) NON-SECRET config. `hipaa_api_key` is handled SEPARATELY below
  // (write-only, like cloud_api_key), so it is NOT in this list.
  "hipaa_endpoint",
  "hipaa_api_version",
  "hipaa_model",
];

// The cloud provider values the PUT will accept (besides "" = clear/use env default).
const CLOUD_PROVIDERS = new Set(["openai", "azure", "gemini", "deepseek"]);

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // PER-USER: every signed-in user reads their OWN settings (their prompt + model config,
  // with the shared workspace default as the fallback). Not admin-gated — managing USERS
  // is the only admin-only thing (see /api/admin/users).
  try {
    return NextResponse.json(await runWithOwner(user.id, () => getSettings()));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to read settings" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // PER-USER: every user writes their OWN settings (not admin-gated).
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  // model_mode is constrained to the two valid backends; anything else is a 400 so
  // a typo can't silently leave the workspace in an undefined state.
  if (typeof body.model_mode === "string") {
    const m = body.model_mode.trim().toLowerCase();
    if (m !== "cloud" && m !== "hipaa" && m !== "local") {
      return NextResponse.json(
        { error: 'model_mode must be "cloud", "hipaa", or "local"' },
        { status: 400 }
      );
    }
    body.model_mode = m;
  }
  // cloud_provider is constrained to the known providers (or "" = use env default).
  if (typeof body.cloud_provider === "string") {
    const p = body.cloud_provider.trim().toLowerCase();
    if (p !== "" && !CLOUD_PROVIDERS.has(p)) {
      return NextResponse.json(
        { error: 'cloud_provider must be one of "", "openai", "azure", "gemini", "deepseek"' },
        { status: 400 }
      );
    }
    body.cloud_provider = p;
  }
  try {
    // All writes run under THIS user's owner context → they persist to the user's own
    // settings rows, never the shared default or another user's.
    return await runWithOwner(user.id, async () => {
    // ── BELT-AND-SUSPENDERS: block establishing a KEYLESS cloud provider ──────────────
    // A non-default cloud provider needs a key to work. If this save would leave the
    // workspace pointed at a provider with NO key (none submitted now AND none stored),
    // reject it UPFRONT with a clear 400 — so the user is told to add the key at save
    // time, rather than discovering later (via a failed ask) that the model can't run.
    // (A blank "__clear__" of the key while keeping a non-default provider is also
    // rejected: it would leave the keyless state.) The DEFAULT provider ("") needs no
    // key (it uses the built-in env model), so it is never blocked.
    if (typeof body.cloud_provider === "string" && (body.cloud_provider as string) !== "") {
      const provider = body.cloud_provider as string;
      const submitted =
        typeof body.cloud_api_key === "string" ? (body.cloud_api_key as string).trim() : "";
      const clearing = submitted === "__clear__";
      const submittingKey = submitted.length > 0 && !clearing;
      const storedKey = clearing ? "" : (await getSetting("cloud_api_key")).trim();
      if (!submittingKey && storedKey.length === 0) {
        return NextResponse.json(
          { error: `Set a key for ${provider} — selecting a cloud provider with no API key would leave the model unable to run.` },
          { status: 400 }
        );
      }
    }
    for (const key of KEYS) {
      if (typeof body[key] === "string") {
        await setSetting(key, body[key] as string);
      }
    }
    // cloud_api_key is WRITE-ONLY and protected: only persist when a NON-EMPTY value
    // is submitted, so saving the form without re-typing the key doesn't wipe a
    // stored key. To explicitly CLEAR a key the UI sends the sentinel "__clear__".
    if (typeof body.cloud_api_key === "string") {
      const k = body.cloud_api_key as string;
      if (k === "__clear__") {
        await setSetting("cloud_api_key", "");
      } else if (k.trim()) {
        await setSetting("cloud_api_key", k.trim());
      }
      // empty/whitespace → leave the stored key untouched.
    }
    // hipaa_api_key is its OWN independent write-only slot (the bug fix): an Azure
    // (HIPAA) key persists here and NEVER overwrites the cloud key. Same protection:
    // a blank submit leaves the stored HIPAA key untouched; "__clear__" clears it.
    if (typeof body.hipaa_api_key === "string") {
      const k = body.hipaa_api_key as string;
      if (k === "__clear__") {
        await setSetting("hipaa_api_key", "");
      } else if (k.trim()) {
        await setSetting("hipaa_api_key", k.trim());
      }
      // empty/whitespace → leave the stored hipaa key untouched.
    }
    return NextResponse.json(await getSettings());
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to save settings" },
      { status: 500 }
    );
  }
}
