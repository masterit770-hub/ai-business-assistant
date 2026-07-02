// INTERNAL agent endpoint — for the Vercel frontend → Fly agent split.
//
// When the Next.js UI runs on Vercel (FLY_AGENT_URL set), /api/ask forwards
// the question here over HTTPS with a shared INTERNAL_AGENT_TOKEN. This keeps
// the Claude Agent SDK + its binary entirely on Fly (which can sleep when idle)
// while the Vercel UI stays always-warm (no cold-start on sign-in/render).
//
// CONTRACT:
//   POST /api/agent
//   Header: x-agent-token: <INTERNAL_AGENT_TOKEN>
//   Body JSON: { question: string, ownerId: string, chatId?: string, model?: string }
//
//   On success: 200 + AnswerResult JSON
//   On bad/missing token: 401 { error: "unauthorized" }
//   On bad body: 400 { error: "..." }
//
// AUTH: The token replaces the Supabase user session. The ownerId is ALWAYS
// resolved SERVER-SIDE by /api/ask on the Vercel side (from the real session)
// before forwarding — this endpoint NEVER trusts an ownerId from the client
// directly. The only path that calls this is the token-bearing internal POST
// from /api/ask running on Vercel (where the user is already authenticated).
//
// ISOLATION: the endpoint is Fly-only — it is NOT reachable by end users. Even
// if someone guesses the URL, without the correct INTERNAL_AGENT_TOKEN they get
// a 401. The ownerId → file scoping in answerAgentic() ensures tenant isolation
// regardless.
//
// STANDALONE MODE: if FLY_AGENT_URL is NOT set (standalone Fly deployment, the
// monolith mode), /api/ask handles everything locally and this endpoint is never
// called. The monolith keeps working without any change.

import { NextResponse } from "next/server";
import { answerAgentic } from "@/lib/engine/answer-agentic";
import { answerMessages } from "@/lib/engine/answer-messages";

export const runtime = "nodejs";
// The agentic loop can take up to 60 s for a complex question; allow 300 s for
// headroom. Fly has no serverless timeout (it's a long-running process).
export const maxDuration = 300;

export async function POST(req: Request) {
  // ── Token guard — first check before touching the body ───────────────────
  const tokenEnv = process.env.INTERNAL_AGENT_TOKEN;
  if (!tokenEnv) {
    // Env not set: the endpoint is disabled (safe default — require explicit opt-in).
    return NextResponse.json({ error: "agent endpoint not configured" }, { status: 503 });
  }
  const provided = req.headers.get("x-agent-token") ?? "";
  if (provided !== tokenEnv) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  let question: string;
  let ownerId: string;
  let chatId: string | null = null;
  let model: string | undefined;
  let history: { question: string; answer: string }[] = [];
  let spaceOpts: { spaceId?: string | null; globalMode?: boolean } | undefined;

  try {
    const body = await req.json();
    question = (body?.question ?? "").toString().trim();
    ownerId = (body?.ownerId ?? "").toString().trim();
    if (typeof body?.chatId === "string" && body.chatId.trim()) {
      chatId = body.chatId.trim();
    }
    if (typeof body?.model === "string" && body.model.trim()) {
      model = body.model.trim();
    }
    // Conversation memory: prior turns of THIS chat, forwarded from /api/ask.
    if (Array.isArray(body?.history)) {
      history = body.history
        .filter((h: unknown): h is { question: string; answer: string } =>
          !!h && typeof (h as { question?: unknown }).question === "string" && typeof (h as { answer?: unknown }).answer === "string")
        .map((h: { question: string; answer: string }) => ({ question: h.question, answer: h.answer }));
    }
    // Knowledge Spaces scoping (forwarded from /api/ask on Vercel): scope files to a space,
    // or all spaces in global mode. Absent on a normal (non-space) request.
    {
      const sid = typeof body?.space_id === "string" && body.space_id.trim() ? body.space_id.trim() : null;
      const gm = body?.global_mode === true;
      if (sid || gm) spaceOpts = { spaceId: gm ? null : sid, globalMode: gm };
    }
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Server-side model override: when no explicit model is requested, an ops-set AGENT_MODEL
  // env (a Fly secret) pins the agent's model. Lets us run the answer-quality "Sonnet topper"
  // through the REAL UI (which sends no model) without a code change — toggle on/off via secret.
  if (!model && process.env.AGENT_MODEL?.trim()) {
    model = process.env.AGENT_MODEL.trim();
  }

  if (!question) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }
  if (!ownerId) {
    return NextResponse.json({ error: "ownerId is required" }, { status: 400 });
  }

  // ── Run the agentic engine ───────────────────────────────────────────────
  try {
    // Engine selection: ANSWER_ENGINE=messages → the plain Messages API + code-execution engine
    // (no local subprocess); otherwise the Agent SDK engine. Both return the same AnswerResult.
    const result = process.env.ANSWER_ENGINE === "messages"
      ? await answerMessages(question, ownerId, model, chatId, history, spaceOpts)
      : await answerAgentic(question, ownerId, model, chatId, history, spaceOpts);
    return NextResponse.json(result);
  } catch (e) {
    console.error("[api/agent] answerAgentic failed:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: "agent error: " + (e instanceof Error ? e.message.slice(0, 200) : "unknown") },
      { status: 500 }
    );
  }
}
