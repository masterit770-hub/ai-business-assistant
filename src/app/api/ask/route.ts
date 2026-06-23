import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getCurrentUser } from "@/lib/supabase/auth";
import { answerQuestion } from "@/lib/engine/answer";
import { runWithOwner } from "@/lib/engine/request-context";
import { backendConfigured } from "@/lib/engine/llm";
import { logAsk } from "@/lib/engine/ask-history";
import { friendlyAskError } from "@/lib/engine/error-message";

// Consolidated single app: the retrieval/answer engine runs IN-PROCESS here (no
// separate engine service, no ENGINE_URL proxy hop). The polished Nucleus UI calls
// this same-origin route → real routing + hybrid SQL/RAG retrieval + grounded
// generation + validateAnswer → grounded, cited answer. No mock, no fabrication.
//
// AUTH: requires a signed-in, enabled user. Per-user doc isolation comes straight
// from the session — answerQuestion scopes UPLOADED-doc retrieval (Supabase pgvector
// hybrid) to this user's own uploads; an ADMIN sees all uploads. The bundled
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
  let sessionId = "";
  let history: { question: string; answer: string }[] = [];
  try {
    const body = await req.json();
    question = (body?.question ?? "").toString().trim();
    // Multi-turn: the client passes the conversation's session_id (to keep logging this
    // turn into the same thread) and the recent prior turns (so the engine can resolve
    // a follow-up). Both are OPTIONAL — a first turn / a single-shot caller sends
    // neither and behavior is unchanged.
    if (typeof body?.session_id === "string" && body.session_id.trim()) {
      sessionId = body.session_id.trim();
    }
    if (Array.isArray(body?.history)) {
      history = body.history
        .filter(
          (t: unknown): t is { question: string; answer: string } =>
            !!t &&
            typeof (t as { question?: unknown }).question === "string" &&
            typeof (t as { answer?: unknown }).answer === "string"
        )
        .map((t: { question: string; answer: string }) => ({ question: t.question, answer: t.answer }));
    }
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }
  // No session_id from the client → this is the FIRST turn of a new conversation. The
  // SERVER mints the id and returns it; the client then reuses it for every follow-up,
  // so all turns of this chat are tied together (and resumable).
  if (!sessionId) sessionId = randomUUID();

  try {
    // PER-USER settings: run the whole answer under this user's owner context so the
    // engine resolves THEIR system prompt + model config (cloud/Azure/local) — read deep
    // in answer.ts/llm.ts via the ALS owner — not the shared default or another user's.
    const result = await runWithOwner(user.id, () =>
      answerQuestion(question, {
        ownerId: user.id,
        role: user.role,
        // Demo accounts see the bundled sample corpus; a real client user (isDemo=false)
        // retrieves only from their own uploads (clean bucket).
        isDemo: user.isDemo,
        history,
      })
    );
    // Persist this ask to the user's history under its conversation's session_id.
    // BEST-EFFORT: logAsk catches every error internally, so a logging failure NEVER
    // breaks the answer or changes the response below. We await it (rather than
    // fire-and-forget) so the write actually completes before this serverless
    // function returns and is potentially frozen.
    await logAsk(user.id, result, sessionId);
    // Echo the session_id so the client keeps using it for the rest of the conversation.
    return NextResponse.json({ ...result, session_id: sessionId });
  } catch (e) {
    // Keep the REAL detail server-side only (provider/model/status/body that chatCloud
    // throws) — it's diagnostic, but a raw provider blob must never reach the user. The
    // client receives a friendly, actionable line classified from the known failure
    // shapes (rate-limit / bad key / timeout / generic).
    console.error("[api/ask] generation failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: friendlyAskError(e) }, { status: 500 });
  }
}
