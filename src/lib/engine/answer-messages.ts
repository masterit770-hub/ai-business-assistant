// MESSAGES-API ANSWER ENGINE — the plain Claude Messages API + server-side code_execution tool
// + Files API. Same AnswerResult shape as answerAgentic(), but WITHOUT the local 224MB Claude
// Code subprocess: the owner's files are uploaded to Anthropic's Files API and read in a
// server-side sandbox. Selected via ANSWER_ENGINE=messages.
//
// AUTH: ANTHROPIC_API_KEY (billed, prod) OR ANTHROPIC_AUTH_TOKEN (the Claude subscription bearer,
// for local dev — same credential the Agent SDK uses).
//
// FILES: PDFs are attached as native `document` blocks (Claude reads them directly). Spreadsheets
// and CSVs are attached as `container_upload` blocks so the code-execution sandbox reads them with
// python/pandas. Per-chat scoping is identical to the agentic engine (reuses listOwnerFiles).
import { createHash } from "node:crypto";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { getSetting } from "./settings.ts";
import { supabaseEnabled } from "./supabase.ts";
import { fetchOriginalFile } from "./doc-files.ts";
import { listOwnerFiles, buildAgenticInspector } from "./answer-agentic.ts";
import { listSpaces } from "./spaces.ts";
import { deriveGrounding } from "./grounding.ts";
import { getCachedFileId, putCachedFileId, invalidateFileIds } from "./anthropic-file-cache.ts";
import type { AnswerResult } from "./answer.ts";
import type { RoutePlan } from "./router.ts";

const nowMs = () => Date.now();

// The cache is a BEST-EFFORT seam: a read/write must never make answering worse than the
// pre-cache behavior. These wrappers guarantee that AT THE CALL SITE too — even if the
// cache module itself were to throw, a get behaves as a MISS and a write/invalidate is a
// silent no-op. (The module also guards internally; this is belt-and-suspenders so the
// engine's reliability never depends on the cache's contract holding.)
async function safeGetCachedFileId(ownerId: string, docId: string, sha: string): Promise<string | null> {
  try {
    return await getCachedFileId(ownerId, docId, sha);
  } catch {
    return null;
  }
}
async function safePutCachedFileId(ownerId: string, docId: string, sha: string, fileId: string): Promise<void> {
  try {
    await putCachedFileId(ownerId, docId, sha, fileId);
  } catch {
    /* best-effort */
  }
}
async function safeInvalidateFileIds(ownerId: string, docIds: string[]): Promise<void> {
  try {
    await invalidateFileIds(ownerId, docIds);
  } catch {
    /* best-effort */
  }
}

// A create() error that means "a file_id I referenced is gone" (expired/deleted/unknown) —
// as opposed to a model/auth/quota error. General over the Files API's error vocabulary
// (owner- and corpus-agnostic), like the typed-error detectors in llm.ts. Used only to
// decide whether to invalidate CACHED ids + re-upload + retry once.
function isStaleFileReferenceError(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  if (err?.status === 404) return true;
  const msg = (err?.message ?? String(e)).toLowerCase();
  return /file/.test(msg) && /(not[\s_]?found|no longer|does not exist|expired|unknown|invalid)/.test(msg);
}

function makeClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (apiKey) return new Anthropic({ apiKey });
  if (authToken) return new Anthropic({ authToken });
  throw new Error("answer-messages: no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN available");
}

const MIME: Record<string, string> = {
  spreadsheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function buildMessagesSystemPrompt(fileList: string, customPrompt?: string | null, globalMode = false): string {
  const persona = customPrompt && customPrompt.trim() ? customPrompt.trim() : "You are a business assistant.";
  const scopeLine = globalMode
    ? `\nThis is an ENTIRE-WORKSPACE search spanning multiple Knowledge Spaces. Each file below is tagged with its [Space: ...]. When you use a file, tell the user which Space it came from, and keep evidence from different spaces correctly attributed — never mix them up.\n`
    : "";
  return `${persona}

The user's uploaded files are attached to this conversation. Read them and answer from what you actually find — never guess from filenames.
${scopeLine}
AVAILABLE FILES:
${fileList}

HOW TO READ THE FILES:
- Spreadsheets (.xlsx/.xls) and CSV: they are in your code-execution sandbox. Use python (pandas/openpyxl) to read ALL sheets, then compute (counts, sums, rankings) — do not eyeball.
- PDFs: they are attached as documents — read them directly.
- For any counting/ranking/total/superlative question, read ALL files and combine before answering.
- Answer ONLY from what you actually find. If the files don't contain the answer, say so honestly.

NO-DOCUMENTS CASE: if there are no files in this chat, do NOT fabricate a document-grounded answer — say there are no documents here and to upload one. (You may still answer a genuinely general question from general knowledge.)

SOURCES — REQUIRED (this powers the app's evidence/citations panel):
End your ENTIRE reply with ONE final line, in EXACTLY this format, listing every file you actually used (exact filenames from AVAILABLE FILES):
  SOURCES_USED: <file one>, <file two>
If you used no files at all, write exactly:
  SOURCES_USED: NONE
This line is MANDATORY and must be the LAST line of your reply.`;
}

/**
 * Same signature + return shape as answerAgentic(). model defaults to Sonnet (prod default).
 */
export async function answerMessages(
  question: string,
  ownerId: string,
  // Default HAIKU — cheap for local/tests (Rule #0). Prod overrides to Sonnet via the AGENT_MODEL
  // Fly secret (read in /api/agent before this is called), matching the agentic engine's policy.
  model = "claude-haiku-4-5",
  chatId?: string | null,
  history?: { question: string; answer: string }[],
  spaceOpts?: { spaceId?: string | null; globalMode?: boolean }
): Promise<AnswerResult> {
  const startTime = nowMs();
  const client = makeClient();

  // 1) Gather this chat's files. spaceOpts drives Knowledge-Spaces scoping in listOwnerFiles:
  //    globalMode → all the owner's files across spaces; spaceId → only that space's files;
  //    neither → fall back to per-chat (migration 015). Identical seam the agentic engine uses.
  const fileIndex = supabaseEnabled() ? await listOwnerFiles(ownerId, chatId, spaceOpts) : [];
  console.log(
    `[messages] files owner=${ownerId.slice(0, 8)} chat=${chatId ?? "(none)"} ` +
      `space=${spaceOpts?.spaceId ?? "(none)"} global=${!!spaceOpts?.globalMode} n=${fileIndex.length}`
  );

  // 2) Fetch bytes → REUSE a cached Files-API upload when the exact content was uploaded
  //    before (keyed by owner+doc+sha256), else upload fresh and cache the file_id. This
  //    kills the per-ask re-upload leak: identical bytes upload ONCE and are reused on every
  //    later ask. The bytes + sha are kept on each prepared entry so a stale cached file_id
  //    can be re-uploaded fresh at create time without re-fetching. `fromCache` marks entries
  //    whose file_id came from the cache (the only ones that can be stale).
  type Prepared = {
    name: string;
    type: string;
    fileId: string;
    isPdf: boolean;
    spaceId?: string | null;
    docId: string;
    sha: string;
    mime: string;
    bytes: Buffer;
    fromCache: boolean;
  };
  const prepared: Prepared[] = [];
  let cacheHits = 0;
  let uploadedCount = 0;
  for (const { docId, displayName, type, space_id } of fileIndex) {
    const fetched = await fetchOriginalFile(ownerId, docId);
    if (!fetched) {
      console.warn(`[messages] fetch failed docId="${String(docId).slice(0, 40)}" — skipped`);
      continue;
    }
    const bytes = Buffer.from(fetched.bytes);
    const mime = fetched.contentType || MIME[type] || "application/octet-stream";
    const isPdf = type === "pdf" || mime === "application/pdf";
    const sha = createHash("sha256").update(bytes).digest("hex");

    const cachedId = await safeGetCachedFileId(ownerId, docId, sha);
    if (cachedId) {
      cacheHits++;
      prepared.push({ name: displayName, type, fileId: cachedId, isPdf, spaceId: space_id ?? null, docId, sha, mime, bytes, fromCache: true });
      console.log(`[messages] cache HIT "${displayName.slice(0, 40)}" -> ${cachedId} (${type})`);
      continue;
    }
    try {
      const fo = await client.beta.files.upload({
        file: await toFile(bytes, displayName, { type: mime }),
        betas: ["files-api-2025-04-14"],
      });
      uploadedCount++;
      await safePutCachedFileId(ownerId, docId, sha, fo.id);
      prepared.push({ name: displayName, type, fileId: fo.id, isPdf, spaceId: space_id ?? null, docId, sha, mime, bytes, fromCache: false });
      console.log(`[messages] uploaded "${displayName.slice(0, 40)}" -> ${fo.id} (${type})`);
    } catch (e) {
      console.warn(`[messages] upload failed "${displayName.slice(0, 40)}": ${(e as Error)?.message}`);
    }
  }
  console.log(`[messages] files cached=${cacheHits} uploaded=${uploadedCount}`);

  // 3) System prompt (owner-scoped custom prompt + file guidance + SOURCES_USED contract).
  //    In global (entire-workspace) mode, label each file with its Space so the answer can
  //    attribute sources to their spaces; build the id→name map once.
  const spaceNameById = spaceOpts?.globalMode
    ? new Map((await listSpaces(ownerId).catch(() => [])).map((s) => [s.id, s.name]))
    : null;
  const customPrompt = await getSetting("system_prompt", ownerId).catch(() => null);
  const fileListStr = prepared.length
    ? prepared
        .map((f) => {
          const label = spaceNameById && f.spaceId ? `  [Space: ${spaceNameById.get(f.spaceId) ?? "?"}]` : "";
          return `  - ${f.name}  (${f.type})${label}`;
        })
        .join("\n")
    : "  (no files are attached to this chat)";
  const system = buildMessagesSystemPrompt(fileListStr, customPrompt, !!spaceOpts?.globalMode);

  // 4) Messages: prior turns (memory) + the new user message with file blocks. The prior
  //    turns are fixed; the file blocks reference each prepared file's CURRENT file_id, so
  //    the message set is (re)built from `prepared` — letting the staleness retry below pick
  //    up freshly re-uploaded file_ids without reconstructing anything else.
  const historyMessages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const h of (history ?? []).slice(-12)) {
    if (h?.question) historyMessages.push({ role: "user", content: h.question });
    if (h?.answer) historyMessages.push({ role: "assistant", content: h.answer });
  }
  const buildMessages = (): Anthropic.Beta.BetaMessageParam[] => {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: question }];
    for (const f of prepared) {
      if (f.isPdf) {
        content.push({ type: "document", source: { type: "file", file_id: f.fileId } });
      } else {
        content.push({ type: "container_upload", file_id: f.fileId } as Anthropic.Beta.BetaContentBlockParam);
      }
    }
    return [...historyMessages, { role: "user", content }];
  };

  console.log(
    `[messages] resolve owner=${ownerId.slice(0, 8)} model=${model} files=${prepared.length} ` +
      `customPromptLen=${customPrompt?.length ?? 0} historyTurns=${(history ?? []).length}`
  );

  const runCreate = (): Promise<Anthropic.Beta.BetaMessage> =>
    client.beta.messages.create({
      model,
      betas: ["files-api-2025-04-14", "code-execution-2025-08-25"],
      max_tokens: 4096,
      system,
      messages: buildMessages(),
      tools: [{ type: "code_execution_20250825", name: "code_execution" } as unknown as Anthropic.Beta.BetaToolUnion],
    });

  // 5) The call. If it fails because a CACHED file_id is stale (the Files API dropped it),
  //    invalidate those cache rows, re-upload just the cache-hit files fresh, and retry ONCE
  //    — so a reuse cache can never make answering less reliable than always re-uploading.
  //    (A fresh-upload-only ask has no stale ids, so it never triggers the retry.)
  let res: Anthropic.Beta.BetaMessage;
  try {
    try {
      res = await runCreate();
    } catch (createErr) {
      const staleHits = prepared.filter((f) => f.fromCache);
      if (!isStaleFileReferenceError(createErr) || staleHits.length === 0) throw createErr;
      console.warn(
        `[messages] create hit a stale file reference — invalidating ${staleHits.length} cached id(s) + re-uploading`
      );
      await safeInvalidateFileIds(ownerId, staleHits.map((f) => f.docId));
      for (const f of staleHits) {
        const fo = await client.beta.files.upload({
          file: await toFile(f.bytes, f.name, { type: f.mime }),
          betas: ["files-api-2025-04-14"],
        });
        f.fileId = fo.id;
        f.fromCache = false;
        await safePutCachedFileId(ownerId, f.docId, f.sha, fo.id);
        console.log(`[messages] re-uploaded stale "${f.name.slice(0, 40)}" -> ${fo.id} (${f.type})`);
      }
      res = await runCreate();
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error(`[messages] create failed: ${msg.slice(0, 200)}`);
    return {
      question,
      route: { sources: [], docFilter: null, rationale: "Messages API: engine error." },
      answer: `The engine encountered an error: ${msg.slice(0, 200)}`,
      mode: "general",
      grounded: false,
      evidence: { rows: [], chunks: [] },
      validation: { ok: true, reasons: [] },
      model,
    };
  }
  const totalMs = nowMs() - startTime;

  // 6) Final answer text (the trailing SOURCES_USED contract line is parsed + stripped in step 8).
  const blocks = res.content ?? [];
  const finalAnswer = blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { text?: string }).text ?? "")
    .join("\n")
    .trim();

  // 7) Tool trace from the server-side code-execution blocks.
  const toolCalls = blocks
    .filter((b) => /code_execution|server_tool_use|tool_use/.test(b.type))
    .map((b) => ({ tool: /code|bash/.test(b.type) ? "Bash" : "tool", args: ((b as { input?: Record<string, unknown> }).input ?? {}) }));
  const usedFileTools = blocks.some((b) => /code_execution|server_tool_use/.test(b.type));

  // 8) Grounding — agent-declared SOURCES_USED is primary; [P:] tokens + an ABSENT-line floor are
  //    the backstops. An explicit "SOURCES_USED: NONE" is honored (no floor, no false citations).
  const { displayAnswer, declaredSources, evidenceSourceNames, grounded, citedTokens } = deriveGrounding({
    finalAnswer,
    preparedFiles: prepared,
    usedFileTools,
  });

  const evChunks = Array.from(evidenceSourceNames).map((name) => ({
    doc: name,
    page: 0,
    token: `[P:${name}#0]`,
    text: `(read by agent: ${name})`,
    score: undefined as number | undefined,
    denseRank: undefined as number | undefined,
    bm25Rank: undefined as number | undefined,
    rrfScore: undefined as number | undefined,
  }));
  const citationCount = citedTokens.length > 0 ? citedTokens.length : evidenceSourceNames.size;
  const route: RoutePlan = {
    sources: grounded ? ["documents"] : [],
    docFilter: null,
    rationale: grounded
      ? `Messages API + code execution: used ${Array.from(evidenceSourceNames).join(", ")} (${toolCalls.length} code step(s)).`
      : "Messages API: no files used — answered from general knowledge.",
  };
  console.log(
    `[messages] grounding declared=${JSON.stringify(declaredSources)} usedFileTools=${usedFileTools} evidence=${evidenceSourceNames.size}`
  );

  const usage = (res.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  const inspector = buildAgenticInspector({
    answer: displayAnswer,
    toolCalls,
    filesRead: Array.from(evidenceSourceNames),
    totalMs,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    turns: toolCalls.length,
    route,
    citationCount,
    evidenceCount: evidenceSourceNames.size,
    model,
  });

  return {
    question,
    route,
    answer: displayAnswer || "(no answer produced by the agent)",
    mode: grounded ? "grounded" : "general",
    grounded,
    evidence: { rows: [], chunks: evChunks },
    validation: { ok: true, reasons: [] },
    inspector,
    // The model actually sent to messages.create — so a caller/journey can ASSERT which
    // model ran (guards the "prod silently ran Haiku" false-green class).
    model,
  };
}
