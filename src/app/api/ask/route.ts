import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth";
import { answerQuestion } from "@/lib/engine/answer";
import { backendConfigured } from "@/lib/engine/llm";

// Consolidated single app: the retrieval/answer engine runs IN-PROCESS here (no
// separate engine service, no ENGINE_URL proxy hop). The polished Nucleus UI calls
// this same-origin route → real routing + hybrid SQL/RAG retrieval + grounded
// generation + validateAnswer → grounded, cited answer. No mock, no fabrication.
//
// AUTH: requires a signed-in, enabled user. Per-user doc isolation comes straight
// from the session — answerQuestion scopes UPLOADED-doc retrieval (Gemini File
// Search) to this user's own uploads; an ADMIN sees all uploads. The bundled
// corpus is shared/read-only for everyone.
export const runtime = "nodejs";
// Headroom for a cold /api/embed (loads the WASM model on first call); warm is fast.
export const maxDuration = 120;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  if (!(await backendConfigured())) {
    return NextResponse.json(
      {
        error:
          "No model backend is configured. Set LLM_API_KEY on the server, or paste a cloud provider key in Settings → Model.",
      },
      { status: 503 }
    );
  }

  let question = "";
  try {
    const body = await req.json();
    question = (body?.question ?? "").toString().trim();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  try {
    const result = await answerQuestion(question, { ownerId: user.id, role: user.role });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "internal error" },
      { status: 500 }
    );
  }
}
