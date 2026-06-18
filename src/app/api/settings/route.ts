import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { getSettings, setSetting, type SettingKey } from "@/lib/engine/settings";

// Admin Prompt-config — engine logic IN-PROCESS (no proxy). GET reads the live
// editable prompts; PUT persists edits, which the engine then uses for real
// generation + urgency classification. ADMIN-ONLY: these prompts change every
// user's answers, so only an admin may read/write them.
export const runtime = "nodejs";

const KEYS: SettingKey[] = ["system_prompt", "urgency_prompt"];

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
