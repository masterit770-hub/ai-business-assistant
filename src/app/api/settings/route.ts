import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { getSettings, setSetting, type SettingKey } from "@/lib/engine/settings";

// Admin Prompt-config — engine logic IN-PROCESS (no proxy). GET reads the live
// editable prompts; PUT persists edits, which the engine then uses for real
// generation + urgency classification. ADMIN-ONLY: these prompts change every
// user's answers, so only an admin may read/write them.
export const runtime = "nodejs";

// Every admin-editable setting the PUT will persist when present in the body. The
// MODEL keys (the Cloud⇄Local switch + the owner's local endpoint/model) live here
// alongside the prompts; all are admin-only to write.
const KEYS: SettingKey[] = [
  "system_prompt",
  "urgency_prompt",
  "model_mode",
  "local_endpoint",
  "local_model",
];

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  if (user.role !== "admin") {
    return NextResponse.json({ error: "admins only" }, { status: 403 });
  }
  try {
    return NextResponse.json(await getSettings());
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
  if (user.role !== "admin") {
    return NextResponse.json({ error: "admins only" }, { status: 403 });
  }
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
    if (m !== "cloud" && m !== "local") {
      return NextResponse.json(
        { error: 'model_mode must be "cloud" or "local"' },
        { status: 400 }
      );
    }
    body.model_mode = m;
  }
  try {
    for (const key of KEYS) {
      if (typeof body[key] === "string") {
        await setSetting(key, body[key] as string);
      }
    }
    return NextResponse.json(await getSettings());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to save settings" },
      { status: 500 }
    );
  }
}
