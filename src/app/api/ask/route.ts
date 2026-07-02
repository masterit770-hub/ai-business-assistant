import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getCurrentUser } from "@/lib/supabase/auth";
import { answerQuestion } from "@/lib/engine/answer";
import { answerAgentic } from "@/lib/engine/answer-agentic";
import { answerMessages } from "@/lib/engine/answer-messages";
import { answerLocal } from "@/lib/engine/answer-local";
import { runWithOwner } from "@/lib/engine/request-context";
import { getModelMode } from "@/lib/engine/settings";
import { backendConfigured } from "@/lib/engine/llm";
import { logAsk } from "@/lib/engine/ask-history";
import { friendlyAskError } from "@/lib/engine/error-message";
import { assignSessionToSpace } from "@/lib/engine/spaces";

// When ANSWER_ENGINE=agentic, use the Claude Agent SDK path (model is the router)
// instead of the existing hybrid RAG + text-to-SQL pipeline. The agentic path uses
// Claude CLI subscription auth — no LLM_API_KEY required for local testing.
const USE_MESSAGES = process.env.ANSWER_ENGINE === "messages";
// Either agent-style engine (Agent SDK OR the Messages-API + code-exec engine) bypasses the
// hybrid RAG pipeline. USE_AGENTIC keeps its old meaning (used for the FLY-forward + backend gate).
const USE_AGENTIC = process.env.ANSWER_ENGINE === "agentic" || USE_MESSAGES;

// VERCEL/FLY SPLIT: when FLY_AGENT_URL is set (Vercel frontend build), the agentic
// engine runs on Fly (can sleep when idle) and this route just proxies to it.
// The ownerId is ALWAYS resolved server-side here from the real Supabase session —
// NEVER from client input — before being forwarded to Fly.
// When FLY_AGENT_URL is not set (standalone Fly monolith or local dev), answerAgentic
// runs in-process as before.
const FLY_AGENT_URL = process.env.FLY_AGENT_URL?.replace(/\/$/, "") ?? "";
const INTERNAL_AGENT_TOKEN = process.env.INTERNAL_AGENT_TOKEN ?? "";

/**
 * Forward an agentic question to the Fly agent endpoint.
 * ownerId is resolved server-side from the Supabase session by the caller — never
 * from client input. Returns the AnswerResult JSON from Fly, or throws on error.
 */
async function forwardToFlyAgent(
  question: string,
  ownerId: string,
  chatId: string,
  history: { question: string; answer: string }[],
  model?: string,
  spaceOpts?: { spaceId?: string | null; globalMode?: boolean }
): Promise<ReturnType<typeof JSON.parse>> {
  const url = `${FLY_AGENT_URL}/api/agent`;
  const body: Record<string, unknown> = { question, ownerId, chatId };
  if (model) body.model = model;
  // Conversation memory: forward prior turns so the agent isn't contextless every turn.
  if (history.length) body.history = history;
  // Knowledge Spaces: forward the space scoping so the Fly engine scopes files to the space
  // (or all spaces in global mode). Without this, prod would ignore spaces entirely.
  if (spaceOpts?.spaceId) body.space_id = spaceOpts.spaceId;
  if (spaceOpts?.globalMode) body.global_mode = true;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agent-token": INTERNAL_AGENT_TOKEN,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Fly agent returned ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

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
  // The agentic path uses Claude CLI subscription auth — no LLM_API_KEY required.
  // Only check backendConfigured for the regular (non-agentic) pipeline.
  if (!USE_AGENTIC && !(await backendConfigured())) {
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
  let spaceId: string | null = null;
  let globalMode = false;
  // Optional per-request model override — used by the journey's Sonnet answer-quality step
  // (call #6) to force Sonnet for that single ask without changing the server default.
  // Validated against the allowlist; unknown values are silently ignored (fall back to default).
  let modelOverride: string | undefined;
  const ALLOWED_MODELS = new Set([
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-5",
  ]);
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
    // Knowledge Space scoping (migration 016):
    //   space_id → scope files to this space (cross-chat in-space read)
    //   global_mode → cross-space global search (all owner files)
    if (typeof body?.space_id === "string" && body.space_id.trim()) {
      spaceId = body.space_id.trim();
    }
    if (body?.global_mode === true) {
      globalMode = true;
      spaceId = null; // global mode overrides space filter
    }
    // Per-request model override (journey Sonnet step; allowlisted only).
    if (typeof body?.model === "string" && ALLOWED_MODELS.has(body.model)) {
      modelOverride = body.model;
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

  // Knowledge Space bookkeeping: when this chat is asked inside a space (space_id present,
  // and NOT global mode — global search is not a single space), idempotently record the
  // session→space association so the space's "chats" list and its delete-cleanup can find
  // this chat. Placed BEFORE the lane dispatch so it holds for EVERY engine lane
  // (fly-forward / messages / agentic / rag), which all share this resolved sessionId.
  // BEST-EFFORT: a bookkeeping failure must never break the answer, so it never throws
  // (assignSessionToSpace swallows its own errors; the .catch is belt-and-suspenders).
  if (spaceId) {
    await assignSessionToSpace(user.id, sessionId, spaceId).catch(() => {});
  }

  try {
    // PER-USER settings: run the whole answer under this user's owner context so the
    // engine resolves THEIR system prompt + model config (cloud/Azure/local) — read deep
    // in answer.ts/llm.ts via the ALS owner — not the shared default or another user's.
    //
    // ANSWER_ENGINE=agentic: bypass the hybrid RAG pipeline and use the Claude Agent SDK
    // directly. The agentic path fetches this owner's files from Supabase Storage into a
    // temp working dir, then the SDK agent (Bash + Read + Glob + Grep) reads + computes
    // the answer. Auth: Claude CLI subscription (no LLM_API_KEY needed locally).
    // Demo-gating and owner-scoping are unchanged (answerAgentic is always owner-scoped
    // to the requesting user's files — it never sees another owner's storage).
    // Per-chat scoping (migration 014): pass the session_id as chatId so retrieval is
    // scoped to (owner + chat). A freshly minted sessionId on a brand-new first turn is
    // also passed but has no effect until files are uploaded to that chat.
    // VERCEL/FLY SPLIT: if FLY_AGENT_URL is configured (this is the Vercel frontend),
    // forward the agentic question to the Fly agent endpoint. ownerId is resolved here
    // from the Supabase session — NEVER from client input — before forwarding.
    // If FLY_AGENT_URL is not set, run in-process as before (standalone Fly monolith).
    // Build space opts — passed to the agentic engine's file scoping layer.
    const spaceOpts = (spaceId || globalMode)
      ? { spaceId: spaceId ?? null, globalMode }
      : undefined;

    // MODEL MODE (Settings → Model, per-owner) drives the answer lane. Resolved here
    // under the owner's ALS context so it reflects THIS user's choice:
    //   • "local" → answerLocal runs IN-PROCESS. The endpoint is user-provided (their
    //     own machine, or a cloudflared tunnel reachable from anywhere), so a Local
    //     answer is NEVER forwarded to Fly — it round-trips through their own model.
    //   • "hipaa" → 503 with an honest message: the HIPAA (Azure OpenAI/BAA) backend
    //     is configurable in Settings but isn't wired to the current answer engine on
    //     this deployment, so we don't silently route PHI-intent traffic elsewhere.
    //   • "cloud"/absent → EXACTLY the existing behavior (fly-forward / messages /
    //     agentic / rag), unchanged.
    const modelMode = await runWithOwner(user.id, () => getModelMode());
    if (modelMode === "hipaa") {
      return NextResponse.json(
        {
          error:
            "HIPAA mode is selected in Settings → Model, but the HIPAA (Azure OpenAI under a Microsoft BAA) backend isn't available on this deployment. Switch to Cloud or Local mode, or ask your administrator to wire up the Azure endpoint.",
        },
        { status: 503 }
      );
    }

    const result = modelMode === "local"
      ? await runWithOwner(user.id, () => answerLocal(question, user.id, sessionId, history, spaceOpts))
      : (USE_AGENTIC && FLY_AGENT_URL && INTERNAL_AGENT_TOKEN)
      ? await runWithOwner(user.id, () =>
          forwardToFlyAgent(question, user.id, sessionId, history, modelOverride, spaceOpts)
        )
      : USE_MESSAGES
      ? await runWithOwner(user.id, () => answerMessages(question, user.id, modelOverride, sessionId, history, spaceOpts))
      : USE_AGENTIC
      ? await runWithOwner(user.id, () => answerAgentic(question, user.id, undefined, sessionId, history, spaceOpts))
      : await runWithOwner(user.id, () =>
          answerQuestion(question, {
            ownerId: user.id,
            role: user.role,
            // Demo accounts see the bundled sample corpus; a real client user (isDemo=false)
            // retrieves only from their own uploads (clean bucket).
            isDemo: user.isDemo,
            history,
            chatId: sessionId,
          })
        );
    // Persist this ask to the user's history under its conversation's session_id.
    // BEST-EFFORT: logAsk catches every error internally, so a logging failure NEVER
    // breaks the answer or changes the response below. We await it (rather than
    // fire-and-forget) so the write actually completes before this serverless
    // function returns and is potentially frozen.
    await logAsk(user.id, result, sessionId);
    // Echo the session_id so the client keeps using it for the rest of the conversation.
    // _engine: which answer lane actually ran (ANSWER_ENGINE is invisible in fly logs +
    // blanked by `vercel env pull`, so expose the runtime decision here for diagnostics).
    return NextResponse.json({
      ...result,
      session_id: sessionId,
      _engine: {
        answerEngine: process.env.ANSWER_ENGINE ?? null,
        useAgentic: USE_AGENTIC,
        flyConfigured: Boolean(FLY_AGENT_URL && INTERNAL_AGENT_TOKEN),
        lane:
          modelMode === "local"
            ? "local"
            : USE_AGENTIC && FLY_AGENT_URL && INTERNAL_AGENT_TOKEN
            ? "fly-agentic"
            : USE_AGENTIC
              ? "inproc-agentic"
              : "rag",
      },
    });
  } catch (e) {
    // Keep the REAL detail server-side only (provider/model/status/body that chatCloud
    // throws) — it's diagnostic, but a raw provider blob must never reach the user. The
    // client receives a friendly, actionable line classified from the known failure
    // shapes (rate-limit / bad key / timeout / generic).
    console.error("[api/ask] generation failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: friendlyAskError(e) }, { status: 500 });
  }
}
