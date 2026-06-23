import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { getModelConfig } from "@/lib/engine/settings";
import { runWithOwner } from "@/lib/engine/request-context";
import {
  chatWithUsage,
  isLocalNotConfigured,
  isLocalUnreachable,
  isHipaaNotConfigured,
  isCloudProviderNotConfigured,
} from "@/lib/engine/llm";

// "Test connection" — make ONE tiny REAL chat call against the model backend as it is
// currently SAVED (Cloud provider override / HIPAA Azure / env default), so the owner
// learns a bad key immediately instead of by asking a real question and getting a
// failure. It reuses the engine's provider resolution (chatWithUsage → getModelConfig +
// resolveCloudTarget/resolveHipaaTarget), so this exercises the EXACT path a live
// answer takes — not a separate, drifting probe.
//
// ADMIN-ONLY (same guard as /api/settings, /api/local-models): keys are admin config.
// NO SECRETS are returned or logged — only ok/failure + a friendly, key-free message
// and which provider/model answered. The route never 500s on a provider error: a bad
// key comes back as { ok: false } with a friendly message, not a stack trace.
export const runtime = "nodejs";
export const maxDuration = 60;

// A trivial, deterministic probe. Cheap (a handful of tokens) and self-describing in
// logs; temperature 0 so it's reproducible. We don't care about the content — only
// that a real backend accepted the request and produced a response.
const PROBE = "Reply with the single word: ok";

// Map the engine's typed config errors to a friendly, actionable message — WITHOUT
// echoing any key. These are the "you haven't finished setting this up" cases, distinct
// from a real auth/billing failure from the provider.
function friendlyConfigMessage(e: unknown): string | null {
  if (isCloudProviderNotConfigured(e)) {
    return "A cloud provider is selected but no API key is saved for it. Paste your key in the Cloud model section and Save, then test again.";
  }
  if (isHipaaNotConfigured(e)) {
    return "HIPAA mode isn't fully configured yet. Set the Azure key, resource endpoint, and deployment name in the HIPAA model section and Save, then test again.";
  }
  if (isLocalNotConfigured(e)) {
    return "Local mode is on but no local endpoint is set. Add your model server's address in the Model section and Save, then test again.";
  }
  if (isLocalUnreachable(e)) {
    return "Local mode is on but the local model couldn't be reached. Make sure your model server is running and the endpoint is correct (and saved), then test again.";
  }
  return null;
}

// Strip anything key-shaped out of a provider error before it ever reaches the client
// or a log line. The engine's error strings are built from provider/model/status/body
// (never the key — see llm.ts), but we defensively redact bearer/api-key fragments and
// long token-like runs in case a provider echoes the key back in its error body.
function sanitizeError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/(api[-_]?key["':=\s]+)[A-Za-z0-9._-]+/gi, "$1***")
    .replace(/sk-[A-Za-z0-9]{8,}/g, "sk-***")
    .replace(/[A-Za-z0-9_-]{32,}/g, "***")
    .slice(0, 240);
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // PER-USER: every user tests THEIR OWN model config (not admin-gated).
  return runWithOwner(user.id, async () => {
  // The mode tells the user which backend we actually tested (so the result is
  // unambiguous: "your Cloud key works" vs "your HIPAA/Azure key works").
  const { mode } = await getModelConfig();

  try {
    const { content, usage } = await chatWithUsage([{ role: "user", content: PROBE }], {
      temperature: 0,
    });
    // A live backend accepted the request. We don't grade the content — any non-throw
    // means the provider/key resolved and answered.
    return NextResponse.json({
      ok: true,
      mode,
      provider: usage.provider,
      model: usage.model,
      message: `Connected — ${usage.provider} (${usage.model}) responded.`,
      sample: (content ?? "").trim().slice(0, 80),
    });
  } catch (e) {
    // First, the "not finished setting up" cases get a precise, friendly nudge.
    const configMsg = friendlyConfigMessage(e);
    if (configMsg) {
      return NextResponse.json({ ok: false, mode, message: configMsg });
    }
    // Otherwise it's a real provider failure (bad key, billing, wrong endpoint). Return
    // a friendly, key-free message — never a 500, never the secret.
    const raw = e instanceof Error ? e.message : "the connection test failed";
    return NextResponse.json({
      ok: false,
      mode,
      message: `Couldn't connect: ${sanitizeError(raw)}`,
    });
  }
  });
}
