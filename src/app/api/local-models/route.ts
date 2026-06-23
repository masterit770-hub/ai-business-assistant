import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { getSetting } from "@/lib/engine/settings";
import { runWithOwner } from "@/lib/engine/request-context";
import { ollamaTagsUrl, extractModelNames } from "@/lib/engine/local-models";

// Detect the models actually installed on the OWNER's box, for the Settings →
// Model → Local picker. The admin configures an OpenAI-compatible `local_endpoint`
// (e.g. http://localhost:11434/v1, or a tunnel URL); Ollama lists pulled models at
// its NATIVE API <base>/api/tags. We derive that base server-side and fetch it.
//
// ADMIN-ONLY (same guard as /api/settings): the endpoint is admin-configured and
// trusted. This route only ever calls THAT endpoint. It NEVER throws a 500 — any
// failure (no endpoint, timeout, connection refused, non-200, bad JSON) returns a
// calm { models: [], reachable: false, reason } so the UI can show a friendly hint
// and the admin can still type a model name by hand (the free-text fallback).
export const runtime = "nodejs";

// Response shape (always 200 unless auth fails):
//   { models: string[]; reachable: boolean; reason?: string }
export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // PER-USER: each user has their OWN local endpoint, so each lists the models on their
  // own box (not admin-gated).
  const endpoint = await runWithOwner(user.id, () => getSetting("local_endpoint"));
  const url = ollamaTagsUrl(endpoint);
  if (!url) {
    return NextResponse.json({ models: [], reachable: false, reason: "no endpoint set" });
  }

  // Bound the probe: an unreachable/hung endpoint must not hang the admin panel.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json({ models: [], reachable: false, reason: `endpoint returned ${res.status}` });
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return NextResponse.json({ models: [], reachable: false, reason: "bad response (not JSON)" });
    }
    return NextResponse.json({ models: extractModelNames(body), reachable: true });
  } catch (e) {
    // Timeout (AbortError) or any connection error → unreachable, never a 500.
    const reason = e instanceof Error && e.name === "AbortError" ? "timed out" : "couldn't connect";
    return NextResponse.json({ models: [], reachable: false, reason });
  } finally {
    clearTimeout(timer);
  }
}
