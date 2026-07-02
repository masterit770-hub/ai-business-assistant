// LOCAL (Ollama) ANSWER ENGINE — v0.5, CHAT-ONLY.
//
// The owner flips Settings → Model → Local, sends a message, and the question
// genuinely round-trips through THEIR own OpenAI-compatible endpoint (e.g. an
// Ollama server at http://localhost:11434/v1) and the reply renders. Nothing
// leaves the owner's machine — the whole point of Local mode is privacy.
//
// SCOPE (v0.5, deliberately minimal — client descope 2026-07-02): this is
// CHAT-ONLY. Local mode does NOT read the owner's uploaded documents. Small local
// CPU models can't do the RAG/file work the cloud engine does, so rather than
// fake it, Local mode is honest: the system prompt below NAMES the files in scope
// and instructs the model to say plainly it cannot read them here — never to
// fabricate document content. Reading files into context is the GPU-day upgrade
// path (see docs/LOCAL-MODEL.md), designed but not built.
//
// Same AnswerResult shape as answerMessages()/answerAgentic(), so /api/ask and the
// UI treat a Local answer like any other turn. grounded is ALWAYS false (no
// documents are read), mode is "general", and `model` is `local:<modelname>` so a
// caller/journey can ASSERT the local path actually ran.
import { getSetting } from "./settings.ts";
import { supabaseEnabled } from "./supabase.ts";
import { listOwnerFiles, buildAgenticInspector } from "./answer-agentic.ts";
import type { AnswerResult } from "./answer.ts";
import type { RoutePlan } from "./router.ts";

const nowMs = () => Date.now();

// The chat timeout. A dead host fails FAST regardless (the TCP connect is refused
// immediately); this cap bounds a routable-but-slow endpoint — e.g. a remote box
// reached over the cloudflared tunnel, where a cross-region non-streaming CPU
// generation can take a while. Mirrors llm.ts's LOCAL_TIMEOUT_MS default (45s),
// well under the /api/ask route's 120s budget.
const LOCAL_TIMEOUT_MS = Number(process.env.LOCAL_TIMEOUT_MS) || 45000;

type Msg = { role: "system" | "user" | "assistant"; content: string };

// The OpenAI-compatible chat-completions slice we read (Ollama's /v1 endpoint
// returns this exact shape, usually including a `usage` block).
type ChatCompletion = {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

/**
 * Build the Local-mode system prompt. The HONESTY GUARDRAIL is prompt-level (no
 * keyword filters): it tells the model, in plain language, that Local mode cannot
 * read the user's uploaded files, NAMES the files that exist in scope (so the model
 * can acknowledge them specifically), and forbids fabricating their contents. When
 * asked about a document, the model should say it can't read documents in Local mode
 * and suggest Cloud mode — not guess from the filename.
 */
function buildLocalSystemPrompt(model: string, fileNames: string[]): string {
  const filesBlock = fileNames.length
    ? `\nThe user has uploaded these files to Nucleus (you CANNOT read their contents in Local mode):\n${fileNames
        .map((n) => `  - ${n}`)
        .join("\n")}\n\nIf the user asks anything about these documents or what they contain, say plainly that Local mode cannot read uploaded documents yet, and that they can switch to Cloud mode to ask about their files. Do NOT guess or invent what any document says.`
    : `\nThe user has no uploaded files in scope here. If they ask about "my documents", say Local mode cannot read uploaded documents yet (switch to Cloud mode for that).`;
  return `You are NUCLEUS 770, a helpful business assistant, running in LOCAL mode on the user's own machine (model: ${model}).

LOCAL MODE — IMPORTANT: In this mode you have NO access to the user's uploaded documents, spreadsheets, or business data. You answer only from your own general knowledge. You must never claim to have read a file or fabricate its contents.
${filesBlock}

Answer the user's message helpfully, clearly, and concisely from your general knowledge.`;
}

/**
 * answerLocal — v0.5 chat-only Local answer. Never throws: an unset or unreachable
 * endpoint returns a FRIENDLY AnswerResult (with `localGuidance`) rather than a 500,
 * so the Ask surface shows a calm setup/troubleshooting note.
 */
export async function answerLocal(
  question: string,
  ownerId: string,
  chatId?: string | null,
  history?: { question: string; answer: string }[],
  spaceOpts?: { spaceId?: string | null; globalMode?: boolean }
): Promise<AnswerResult> {
  const startTime = nowMs();

  // The owner's own endpoint + model (per-owner settings written by Settings → Model).
  // A blank local_model falls back to the built-in default; a blank endpoint means
  // "Local isn't set up yet" → friendly guidance below.
  const endpoint = (await getSetting("local_endpoint", ownerId)).trim();
  const model = (await getSetting("local_model", ownerId)).trim() || "qwen2.5";
  const modelLabel = `local:${model}`;

  // No endpoint configured → friendly setup guidance, NOT a throw.
  if (!endpoint) {
    return {
      question,
      route: {
        sources: [],
        docFilter: null,
        rationale: "Local mode is on but no local model endpoint is configured.",
      },
      answer:
        "Local mode is on, but no local model endpoint is set yet. Open Settings → Model, enter your model server's address (for example http://localhost:11434/v1) and the model name, then Save. After that, your questions are answered by the model running on your own machine.",
      mode: "general",
      grounded: false,
      localGuidance: "not-configured",
      evidence: { rows: [], chunks: [] },
      validation: { ok: true, reasons: [] },
      model: modelLabel,
    };
  }

  // HONESTY GUARDRAIL: learn what files exist in scope (same seam the other engines
  // use) so the system prompt can name them and instruct the model to admit it can't
  // read them — instead of fabricating. Best-effort: a listing failure never breaks
  // the answer (we just proceed with no named files).
  let fileNames: string[] = [];
  if (supabaseEnabled()) {
    try {
      const files = await listOwnerFiles(ownerId, chatId, spaceOpts);
      fileNames = files.map((f) => `${f.displayName} (${f.type})`);
    } catch {
      fileNames = [];
    }
  }
  const system = buildLocalSystemPrompt(model, fileNames);

  // Messages: system + recent history (last ~12 turns, like answer-messages) + the
  // new question.
  const messages: Msg[] = [{ role: "system", content: system }];
  for (const h of (history ?? []).slice(-12)) {
    if (h?.question) messages.push({ role: "user", content: h.question });
    if (h?.answer) messages.push({ role: "assistant", content: h.answer });
  }
  messages.push({ role: "user", content: question });

  // Call the owner's OpenAI-compatible endpoint. Normalize a trailing slash so
  // ".../v1" and ".../v1/" both work; the /v1 suffix is KEPT (Ollama's OpenAI chat
  // route is <base>/v1/chat/completions). No API key needed (Ollama ignores it; a
  // placeholder bearer keeps strict clients happy). A short timeout fails a slow/dead
  // endpoint fast.
  const base = endpoint.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ollama" },
      body: JSON.stringify({ model, messages, temperature: 0 }),
      signal: controller.signal,
    });
  } catch (e) {
    const detail =
      (e as Error)?.name === "AbortError"
        ? `timed out after ${LOCAL_TIMEOUT_MS / 1000}s`
        : (e as Error)?.message?.slice(0, 120) || "connection failed";
    return unreachableResult(question, endpoint, model, detail);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return unreachableResult(question, endpoint, model, `HTTP ${res.status}: ${body.slice(0, 160)}`);
  }

  let data: ChatCompletion;
  try {
    data = (await res.json()) as ChatCompletion;
  } catch (e) {
    return unreachableResult(question, endpoint, model, (e as Error)?.message?.slice(0, 120) || "invalid response");
  }

  const content = (data.choices?.[0]?.message?.content ?? "").trim();
  const totalMs = nowMs() - startTime;

  // Local mode is NEVER grounded (no documents are read) → mode "general", no
  // evidence, no citations. `model` = local:<modelname> so a journey can assert the
  // local path actually ran.
  const route: RoutePlan = {
    sources: [],
    docFilter: null,
    rationale:
      "Local mode — answered from the local model's general knowledge. Local mode cannot read uploaded documents in this version.",
  };
  const promptTokens = data.usage?.prompt_tokens ?? 0;
  const completionTokens = data.usage?.completion_tokens ?? 0;
  const inspector = buildAgenticInspector({
    answer: content,
    toolCalls: [],
    filesRead: [],
    totalMs,
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    turns: 1,
    route,
    citationCount: 0,
    evidenceCount: 0,
    model: modelLabel,
  });
  // buildAgenticInspector prices at Anthropic/Haiku rates — WRONG for Local mode, which
  // runs on the owner's OWN hardware and touches no paid API. Overwrite the cost block so
  // the inspector honestly reflects a $0 local call attributed to the local model.
  inspector.cost = {
    liveCalls: 1,
    promptTokens,
    completionTokens,
    usd: 0,
    pricingNote: "Local mode — runs on your own hardware; no paid API call.",
    provider: "local",
    model,
  };

  return {
    question,
    route,
    answer: content || "(the local model returned an empty reply)",
    mode: "general",
    grounded: false,
    evidence: { rows: [], chunks: [] },
    validation: { ok: true, reasons: [] },
    inspector,
    model: modelLabel,
  };
}

/** Friendly "couldn't reach the local model" result — never a 500 throw. */
function unreachableResult(
  question: string,
  endpoint: string,
  model: string,
  detail: string
): AnswerResult {
  console.warn(`[local] endpoint unreachable ${endpoint} (${detail})`);
  return {
    question,
    route: {
      sources: [],
      docFilter: null,
      rationale: `Local mode: the local model at ${endpoint} could not be reached (${detail}).`,
    },
    answer: `Local model endpoint unreachable at ${endpoint} — is Ollama running, and (if it's remote) is the tunnel up? Check the endpoint in Settings → Model, make sure your model server is running and the model is pulled, then try again.`,
    mode: "general",
    grounded: false,
    localGuidance: "unreachable",
    evidence: { rows: [], chunks: [] },
    validation: { ok: true, reasons: [] },
    model: `local:${model}`,
  };
}
