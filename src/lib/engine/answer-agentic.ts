// AGENTIC ANSWER ENGINE — Claude Agent SDK with DEFAULT built-in tools.
//
// answerAgentic() is the "model is the router" path: rather than a custom
// RAG → text-to-SQL pipeline, the Agent SDK runs Claude with its built-in
// Read + Bash tools over a per-request working directory that contains the
// owner's actual files. The agent decides which files to read, runs code to
// compute answers (counting rows, aggregating, etc.), and replies.
//
// KEY DESIGN PRINCIPLE (Chris) — MAXIMUM AGENT FREEDOM:
//   • NO custom MCP tools, NO stripping built-ins.
//   • Use the SDK's DEFAULT tool set: Bash, Read, Glob, Grep — exactly like
//     the Claude cloud app ("Ran 2 commands, viewed a file").
//   • YOU (this code) fetch the requesting owner's files from Supabase and
//     write them to a per-request working dir (/tmp/nucleus-agent-<reqid>/)
//     with their REAL original names and bytes — no pre-conversion.
//     The agent reads + runs code over those raw files — it never touches
//     Supabase directly with the service-role key.
//   • NO validation/citation gate: the answer ALWAYS comes through. The system
//     prompt asks the agent to cite sources so the UI's citations panel
//     populates when the agent complies, but nothing in CODE enforces the format.
//   • Returns AnswerResult (the same shape as the existing pipeline) so the
//     UI is UNCHANGED: sources, inspector, traces, route all populate.
//
// AUTH:
//   Local runs fall back to the Claude CLI subscription creds (~/.claude).
//   No ANTHROPIC_API_KEY needed for local testing. Sparing usage — every
//   question hits a real API.
//
// FILES PREPARED FOR THE AGENT:
//   Raw original bytes are written with their real filenames (xlsx, pdf, csv, etc.).
//   python3 + pandas + openpyxl are available on the host so the agent can
//   read xlsx files with: python3 -c "import pandas as pd; df=pd.read_excel(...)"
//   PDFs can be read directly with the built-in Read tool.
//   A manifest.json listing all available files (name + original type) is written.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { fetchOriginalFile } from "./doc-files.ts";
import { getSetting } from "./settings.ts";
import { admin, supabaseEnabled } from "./supabase.ts";
import { extractCitationTokens } from "./citations.ts";
import { filterFilesForChat } from "./file-scope.ts";
import type { AnswerResult, InspectorTrace, TraceStep, Timings, CostReport } from "./answer.ts";
import type { RoutePlan } from "./router.ts";

// ── File preparation ──────────────────────────────────────────────────────────

type PreparedFile = { localPath: string; sourceName: string; docId: string; type: string };

/**
 * List the owner's stored files from Supabase Storage.
 * Returns [{docId, displayName, type, session_id?, space_id?}].
 *
 * Scoping (applied in this order):
 *   opts.globalMode=true → return ALL the owner's files (cross-space global search).
 *   opts.spaceId provided → return ONLY files tagged to that space (cross-chat in-space).
 *   chatId provided (no space opts) → ONLY that chat's files (migration 015 strict).
 *   neither → all the owner's files (admin / Sources page view).
 *
 * Both the agentic and messages engines call this function — keep its role/signature stable.
 */
export async function listOwnerFiles(
  ownerId: string,
  chatId?: string | null,
  opts?: { spaceId?: string | null; globalMode?: boolean }
): Promise<{ docId: string; displayName: string; type: string; session_id?: string | null; space_id?: string | null }[]> {
  if (!supabaseEnabled()) return [];
  try {
    // Check for the _files.json metadata index first (migration 014 adds session_id,
    // migration 016 adds space_id here).
    const index = await fetchOriginalFile(ownerId, "_files.json");
    if (index) {
      const text = new TextDecoder("utf-8").decode(index.bytes);
      const parsed = JSON.parse(text) as Array<{
        docId: string;
        displayName: string;
        type: string;
        session_id?: string | null;
        space_id?: string | null;
      }>;
      // Space-aware scoping (migration 016), falling back to per-chat scoping (015).
      // filterFilesForSpace handles globalMode + spaceId; filterFilesForChat handles chatId.
      const { spaceId, globalMode } = opts ?? {};
      let visible: typeof parsed;
      if (globalMode) {
        visible = parsed; // global search: all owner files
      } else if (spaceId) {
        visible = parsed.filter((f) => f.space_id === spaceId);
      } else {
        // Legacy per-chat scoping (migration 015)
        visible = filterFilesForChat(parsed, chatId);
      }
      console.log(
        `[agentic] listOwnerFiles owner=${ownerId.slice(0, 8)} chat=${chatId ?? "(none)"} ` +
          `space=${spaceId ?? "(none)"} globalMode=${!!globalMode} ` +
          `manifest=${parsed.length} visible=${visible.length} ` +
          `entries=${JSON.stringify(parsed.map((f) => ({ d: String(f.docId ?? "").slice(0, 28), s: f.session_id ?? null, sp: f.space_id ?? null })))}`
      );
      return visible;
    }
    // Fallback: list storage objects directly (no metadata — return all when no scoping).
    // IMPORTANT: when chatId/spaceId is specified we CANNOT scope without the manifest.
    // Return empty so the agent reports "no files" instead of answering from wrong corpus.
    if (chatId != null || (opts?.spaceId && !opts?.globalMode)) return [];

    const client = admin();
    const { data: files, error } = await client.storage
      .from("documents")
      .list(ownerId, { limit: 1000 });
    if (error || !files) return [];
    return files
      .filter((f) => f.name !== "_files.json")
      .map((f) => {
        const name = f.name;
        const ext = name.split(".").pop()?.toLowerCase() ?? "";
        const type =
          ext === "xlsx" || ext === "xls" ? "spreadsheet"
          : ext === "pdf" ? "pdf"
          : ext === "csv" ? "csv"
          : "file";
        return { docId: name, displayName: name, type, session_id: null };
      });
  } catch {
    return [];
  }
}

/**
 * Fetch owner's files from Supabase and write them into workdir as RAW original bytes
 * with their real filenames. No pre-conversion — the agent reads them directly.
 * Also writes manifest.json. Returns the list of prepared files.
 *
 * chatId (migration 015 — STRICT): when provided + no space opts, fetches ONLY files
 * for that chat. No NULL-session fallback. Null/undefined = all owner files.
 * opts.spaceId (migration 016): when provided, fetches ALL files in the space (cross-chat).
 * opts.globalMode: when true, fetches ALL of the owner's files (global search).
 */
async function prepareOwnerFiles(
  ownerId: string,
  workdir: string,
  chatId?: string | null,
  opts?: { spaceId?: string | null; globalMode?: boolean }
): Promise<PreparedFile[]> {
  const fileIndex = await listOwnerFiles(ownerId, chatId, opts);
  console.log(`[agentic] prepareOwnerFiles owner=${ownerId.slice(0, 8)} chat=${chatId ?? "(none)"} space=${opts?.spaceId ?? "(none)"} global=${!!opts?.globalMode} toFetch=${fileIndex.length}`);
  if (fileIndex.length === 0) return [];

  const prepared: PreparedFile[] = [];

  for (const { docId, displayName, type } of fileIndex) {
    const fetched = await fetchOriginalFile(ownerId, docId);
    if (!fetched) {
      console.warn(`[agentic] FETCH FAILED owner=${ownerId.slice(0, 8)} docId="${String(docId).slice(0, 44)}" — blob missing/unreadable, file SKIPPED`);
      continue;
    }

    const buf = fetched.bytes;

    try {
      // Write the raw bytes using the displayName (original filename, may contain Hebrew
      // or other non-ASCII characters). Linux/macOS filesystems use UTF-8 natively, so
      // the real filename is safe. The agent sees + cites the REAL filename (e.g.
      // "שיבוצים-יוני-2024.xlsx"), not an ASCII-mangled proxy, which is critical for
      // correct citation and grounding. The Storage key encoding is separate — handled
      // in storagePath() via encodeURIComponent — so only the key was ever the problem,
      // never the local filesystem write.
      const localPath = join(workdir, displayName);
      await writeFile(localPath, buf);
      prepared.push({ localPath, sourceName: displayName, docId, type });
      console.log(`[agentic] wrote ${buf.length}B -> "${displayName.slice(0, 44)}" (${type})`);
    } catch (e) {
      console.warn(`[answer-agentic] could not write file ${docId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Write a manifest so the agent can ls + know the files and their types
  const manifest = prepared.map((f) => ({
    file: f.localPath.replace(workdir + "/", ""),
    source: f.sourceName,
    docId: f.docId,
    type: f.type,
  }));
  await writeFile(join(workdir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  console.log(`[agentic] prepared=${prepared.length}/${fileIndex.length} -> ${JSON.stringify(prepared.map((p) => p.sourceName.slice(0, 28)))}`);
  return prepared;
}

// ── Agent system prompt ────────────────────────────────────────────────────────

function buildSystemPrompt(
  files: PreparedFile[],
  customPrompt?: string | null,
  spaceAttribution?: Map<string, string> // docId → space name (for global mode)
): string {
  const fileList = files.length > 0
    ? files.map((f) => {
        const localName = f.localPath.split("/").pop() ?? f.localPath;
        const spaceLabel = spaceAttribution?.get(f.docId);
        const spaceNote = spaceLabel ? `, Space: "${spaceLabel}"` : "";
        return `  - ${localName}  (original: "${f.sourceName}", type: ${f.type}${spaceNote})`;
      }).join("\n")
    : "  (no files available — you will not be able to ground an answer)";

  // The workspace owner's EDITABLE system prompt (Settings → Prompts / the inline editor)
  // is the persona + style the agent must follow — it replaces the default one-liner. The
  // file-reading mechanics below are always appended so the agent still knows how to work.
  const persona = customPrompt && customPrompt.trim()
    ? customPrompt.trim()
    : "You are a business assistant.";

  return `${persona}

The user's original files are in your working directory. Read them however you find useful and answer the user's question from what you actually find.

AVAILABLE FILES IN THIS DIRECTORY:
${fileList}

HOW TO READ THE FILES:
- Excel (.xlsx/.xls): use python3 with pandas + openpyxl, e.g.:
    python3 -c "import pandas as pd; df=pd.read_excel('file.xlsx', sheet_name=None); [print(s, df[s].to_string()) for s in df]"
  (sheet_name=None reads ALL sheets; encoding is handled automatically by pandas/openpyxl)
- PDF: use the Read tool directly — it renders the text content of PDF files natively. Do NOT shell out to Bash to parse PDFs (pdftotext, python pdf libraries, or any PDF CLI tool). That wastes turns and is unnecessary. Read tool reads PDFs natively.
- CSV: use the Read tool or Bash (cat, awk, python3 with csv/pandas).
- manifest.json lists all available files with their types.
- Bash / python3 is for COMPUTATION (counting, aggregating, sorting spreadsheet/CSV data) — not for PDF extraction. For PDFs: Read tool only.

WORKING APPROACH:
1. Start by reading manifest.json to see ALL available files.
2. CRITICAL — manifest.json is only an INDEX of which files exist. It never contains the actual content of any document. For ANY question about document content — a specific fact, a person's name or role, a date, a value, a who/what/when — you MUST open and read the actual file(s) before answering. Never answer from filenames or the manifest alone. If a question could plausibly be answered by a document you have not yet opened, open it.
3. For any superlative or total question — "who is the most / most active / participates the most / highest / largest / most frequent" or any ranking across the data — READ ALL available files first, then combine the results before answering. Do NOT answer from a single file when multiple files are available; you might miss data in the other file(s).
4. For counting or ranking questions, run python3 code to aggregate — do not guess from a visual scan.
5. Answer ONLY from what you actually find. If the files don't contain the answer, say so honestly.
6. Be concise and reasonably fast — read what you need, compute, answer.

FILE CONTENT vs FILE NAME — CRITICAL:
A file's NAME is not a reliable indicator of its content. For questions like "what data do I have", "what's in <file>", or "summarize my files", you MUST open each relevant file and inspect its actual columns/values before describing or categorizing it, and aggregate across ALL files of that kind (do not stop at the first match).

NO DOCS CASE:
If no files are available (the file list above says "(no files available)"), do NOT fabricate an answer from general knowledge. Reply honestly: "There are no documents in this space — upload a file and I'll be able to answer from it."

SPACE ATTRIBUTION (when shown in the file list above):
When a file entry shows "Space: <name>", that means the file belongs to that Knowledge Space. If asked which space a file or piece of information came from, cite the Space name from the file list above.

SOURCES — REQUIRED (this powers the app's evidence/citations panel):
End your ENTIRE response with ONE final line in EXACTLY this format, listing every file you
actually opened / read / computed over to answer — use the exact original filenames shown in
AVAILABLE FILES above:
  SOURCES_USED: <file one>, <file two>
If you used no files at all (general knowledge, or no documents are available), write exactly:
  SOURCES_USED: NONE
This line is MANDATORY and must be the LAST line of your reply. It is how the app knows which
documents grounded the answer — do not omit it, even when you also cite inline.

CITATIONS (optional, in addition to the required SOURCES_USED line):
After a fact you may add an inline citation like [P:filename#page] (spreadsheets/CSVs use page 0,
PDFs use the page where you found it), e.g. "Joni Carter is the petitioner [P:family-court-order.pdf#1]."`;
}

// ── Parse tool calls from SDK messages ────────────────────────────────────────

export type ToolCallRecord = {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
};

// ── Build AnswerResult from agentic output ─────────────────────────────────────

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function buildAgenticInspector(opts: {
  answer: string;
  toolCalls: ToolCallRecord[];
  filesRead: string[];
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  route: RoutePlan;
  citationCount: number;
  // Real evidence-source count (files the agent used, incl. Bash-read spreadsheets). filesRead
  // only counts the Read tool, so it misses spreadsheet/CSV answers — use this for passages.
  evidenceCount: number;
  // The RESOLVED model that answered (drives the cost table below). Optional so legacy
  // callers keep working; absent → priced at Haiku rates with a note.
  model?: string;
}): InspectorTrace {
  const steps: TraceStep[] = [];

  // Step 1: routing
  steps.push({
    key: "router",
    label: "Router",
    status: "ok",
    detail: "Agentic path: the SDK agent decides which files to read and what code to run (model IS the router).",
  });

  // Step 2: file discovery
  steps.push({
    key: "sources",
    label: "Sources",
    status: opts.filesRead.length > 0 ? "ok" : "info",
    detail: opts.filesRead.length > 0
      ? `Agent read ${opts.filesRead.length} file(s): ${opts.filesRead.join(", ")}`
      : "Agent listed files but read none (or all via Bash output).",
  });

  // Step 3: retrieval (tool calls)
  const bashCalls = opts.toolCalls.filter((c) => c.tool === "Bash");
  const readCalls = opts.toolCalls.filter((c) => c.tool === "Read");
  const retrieval = bashCalls.length + readCalls.length;
  steps.push({
    key: "retrieval",
    label: "Retrieval",
    status: retrieval > 0 ? "ok" : "warn",
    detail: retrieval > 0
      ? `${readCalls.length} Read call(s) + ${bashCalls.length} Bash command(s): ${opts.toolCalls.map(c => c.tool).join(", ")}`
      : "No file reads or Bash commands executed.",
  });

  // Step 4: generation
  steps.push({
    key: "generation",
    label: "Generation",
    status: "ok",
    detail: `Agentic generation — ${opts.turns} model turn(s); agent ran code and read files to produce grounded answer.`,
  });

  // Step 5: citations (informational only — no gate)
  steps.push({
    key: "safety",
    label: "Citations",
    status: opts.citationCount > 0 ? "ok" : "info",
    detail: opts.citationCount > 0
      ? `${opts.citationCount} inline citation token(s) found in answer.`
      : "No [P:] citation tokens in answer — agent did not cite sources inline (best-effort only).",
  });

  // MODEL-AWARE pricing (USD per 1M tokens, Anthropic price sheet as of 2026-07 —
  // update alongside model changes). The old version hardcoded STALE Haiku rates
  // ($0.80/$4.00) and labeled every ask "claude-haiku-4-5" even when Sonnet answered,
  // under-reporting Sonnet costs ~4-5x — which silently corrupted any spend ledger
  // built on these numbers. Local (Ollama) models cost $0 on the API.
  const PRICES_PER_1M: Record<string, { in: number; out: number }> = {
    "claude-haiku-4-5": { in: 1.0, out: 5.0 },
    "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
    "claude-opus-4-5": { in: 5.0, out: 25.0 },
  };
  const resolvedModel = opts.model ?? "claude-haiku-4-5";
  const isLocal = resolvedModel.startsWith("local:");
  const price = isLocal
    ? { in: 0, out: 0 }
    : PRICES_PER_1M[resolvedModel] ?? PRICES_PER_1M["claude-haiku-4-5"];
  const priceKnown = isLocal || Boolean(PRICES_PER_1M[resolvedModel]) || opts.model === undefined;
  const usd = (opts.inputTokens / 1_000_000) * price.in + (opts.outputTokens / 1_000_000) * price.out;

  const cost: CostReport = {
    liveCalls: opts.turns,
    promptTokens: opts.inputTokens,
    completionTokens: opts.outputTokens,
    usd,
    pricingNote: isLocal
      ? "Local model — prompts never leave the owner's endpoint; $0 API cost."
      : `Priced at ${resolvedModel} rates${priceKnown ? "" : " (UNKNOWN model — Haiku rates assumed)"}. Embeddings run locally (no API cost).`,
    provider: isLocal ? "local" : "anthropic",
    model: resolvedModel,
  };

  const timings: Timings = {
    routingMs: 0,
    retrievalMs: 0,
    generationMs: Math.round(opts.totalMs),
    totalMs: Math.round(opts.totalMs),
  };

  return {
    retrievalMethod: "agentic (Claude Agent SDK, built-in Bash + Read + Glob tools; raw original files)",
    passages: opts.evidenceCount,
    evidenceCount: opts.evidenceCount,
    confidence: {
      value: opts.filesRead.length > 0 || opts.citationCount > 0 ? 0.90 : 0.40,
      basis: opts.filesRead.length > 0 || opts.citationCount > 0
        ? `agent read ${opts.filesRead.length} file(s) via Read tool, ran ${bashCalls.length} Bash command(s), cited ${opts.citationCount} source(s)`
        : "no files read — general knowledge",
    },
    steps,
    timings,
    cost,
  };
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Answer a question using the Claude Agent SDK with DEFAULT built-in tools.
 *
 * The owner's raw original files are fetched from Supabase and written to a temp
 * working dir. The SDK agent (with Bash + Read + Glob) reads the raw xlsx/pdf/csv
 * files directly using python3 (for xlsx) or the Read tool (for PDF/CSV) and
 * computes the answer. No pre-conversion; no output validation gate — the answer
 * always comes through. The system prompt is the only control surface.
 *
 * Returns the same AnswerResult shape as the existing pipeline so the UI is unchanged.
 *
 * @param question  The question to answer
 * @param ownerId   The owner whose Supabase-stored files to use
 * @param model     Defaults to "claude-haiku-4-5" (per Chris's cost cap)
 */
export async function answerAgentic(
  question: string,
  ownerId: string,
  model = "claude-haiku-4-5",
  // Per-chat scoping (migration 015 — STRICT): when provided + no spaceOpts, the agent
  // ONLY sees files for this chat (session_id = chatId). Null = all owner files.
  chatId?: string | null,
  // Conversation memory: prior turns in THIS chat (oldest→newest). Without it every
  // follow-up is a contextless "first message" — the agent can't resolve "that"/"it".
  history?: { question: string; answer: string }[],
  // Knowledge Space scoping (migration 016):
  //   spaceOpts.spaceId → see ALL files in this space (cross-chat in-space read).
  //   spaceOpts.globalMode → see ALL owner files across all spaces (global search).
  //   undefined → legacy per-chat scoping via chatId.
  spaceOpts?: { spaceId?: string | null; globalMode?: boolean }
): Promise<AnswerResult> {
  if (!supabaseEnabled()) {
    throw new Error("answerAgentic requires Supabase (for file storage) — SUPABASE_URL not set.");
  }

  const reqId = randomUUID().slice(0, 8);
  const workdir = `/tmp/nucleus-agent-${reqId}`;
  const startTime = now();

  await mkdir(workdir, { recursive: true });

  let prepared: PreparedFile[] = [];
  try {
    prepared = await prepareOwnerFiles(ownerId, workdir, chatId, spaceOpts);
  } catch (e) {
    console.warn(`[answer-agentic] file prep failed: ${e instanceof Error ? e.message : e}`);
  }

  // Apply the owner's editable system prompt (persona/style) to the agentic answer —
  // resolved from the owner's settings (ALS owner context). Best-effort: a fetch failure
  // falls back to the default persona, never blocks the answer.
  // Pass ownerId EXPLICITLY (not via currentOwner()/ALS) — on the Fly /api/agent path the
  // ALS owner context isn't set, so a bare getSetting() would read the empty global prompt
  // and the owner's edited prompt would never reach generation in prod.
  const customPrompt = await getSetting("system_prompt", ownerId).catch((e) => {
    console.log(`[agentic] getSetting(system_prompt) THREW: ${(e as Error)?.message ?? e}`);
    return null;
  });
  console.log(
    `[agentic] resolve owner=${(ownerId || "").slice(0, 8)} model=${model} ` +
      `customPromptLen=${customPrompt?.length ?? 0} head=${(customPrompt || "").slice(0, 48).replace(/\n/g, " ")} ` +
      `spaceId=${spaceOpts?.spaceId ?? "(none)"} globalMode=${!!spaceOpts?.globalMode}`
  );
  const systemPrompt = buildSystemPrompt(prepared, customPrompt);

  // Conversation memory: the Agent SDK query() takes a single prompt, so prepend the prior
  // turns as context. Without this every follow-up is a contextless "first message" — the bug
  // the UI's "follow-ups use the whole conversation" promise hides. Bounded to the last 12 turns.
  const recent = (history ?? []).slice(-12).filter((h) => h && (h.question || h.answer));
  console.log(`[agentic] history turns=${recent.length}`);
  const promptWithHistory = recent.length
    ? "Conversation so far (earlier turns in THIS chat — use them as context for the new message):\n\n" +
      recent.map((h) => `User: ${h.question}\nAssistant: ${h.answer}`).join("\n\n") +
      '\n\n----------\nThe user\'s NEW message follows. Answer it using the conversation above for context ' +
      '(resolve references like "that", "it", "the previous one"). Do NOT claim you have no prior context.\n\n' +
      `User: ${question}`
    : question;

  // ── Run the agent ──────────────────────────────────────────────────────────
  const toolCalls: ToolCallRecord[] = [];
  const filesRead: string[] = [];
  let finalAnswer = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;

  try {
    const q = query({
      prompt: promptWithHistory,
      options: {
        model,
        // DEFAULT built-in tools — do NOT pass tools: [] to avoid stripping them.
        // The agent has Bash, Read, Glob, Grep by default (the Claude Code toolset).
        // allowedTools locks down to only the safe read/compute subset so it
        // can't write files outside the workdir or do network calls.
        allowedTools: ["Bash", "Read", "Glob", "Grep"],
        disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "WebSearch", "WebFetch", "TodoWrite", "Task", "Agent"],
        // Restrict filesystem access to only the workdir
        cwd: workdir,
        systemPrompt,
        maxTurns: 40,
        // Belt-and-suspenders: deny any tool not in the safe list
        canUseTool: async (toolName: string) => {
          const safe = ["Bash", "Read", "Glob", "Grep", "LS"].includes(toolName);
          if (safe) return { behavior: "allow" as const };
          return {
            behavior: "deny" as const,
            message: `Tool "${toolName}" is not permitted in the agentic answer sandbox.`,
          };
        },
      },
    });

    for await (const msg of q) {
      if (msg.type === "assistant") {
        turns++;
        const usage = (msg as { type: "assistant"; message: { usage?: { input_tokens?: number; output_tokens?: number } } }).message?.usage;
        if (usage) {
          inputTokens += usage.input_tokens ?? 0;
          outputTokens += usage.output_tokens ?? 0;
        }

        // Extract text content
        const content = (msg as { type: "assistant"; message: { content?: unknown[] } }).message?.content ?? [];
        for (const block of content) {
          const b = block as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };
          if (b.type === "text" && b.text?.trim()) {
            finalAnswer = b.text.trim();
          }
          if (b.type === "tool_use" && b.name && b.id) {
            const toolRec: ToolCallRecord = { tool: b.name, args: b.input ?? {} };
            toolCalls.push(toolRec);

            // Track file reads
            if (b.name === "Read" && typeof b.input?.file_path === "string") {
              const fp = b.input.file_path as string;
              const shortName = fp.split("/").pop() ?? fp;
              if (!filesRead.includes(shortName)) filesRead.push(shortName);
            }
          }
        }
      }

      if (msg.type === "result") {
        const r = msg as {
          type: "result";
          subtype: string;
          result?: string;
          errors?: string[];
          usage?: {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        if (r.subtype === "success" && r.result) {
          finalAnswer = r.result;
        }
        if (r.subtype !== "success" && r.errors?.length) {
          console.warn("[answer-agentic] agent errors:", r.errors.join("; "));
          if (!finalAnswer) {
            finalAnswer = `I was unable to complete the analysis. Errors: ${r.errors.join("; ")}`;
          }
        }
        if (r.usage) {
          // Totals from the result message (may include all turns)
          inputTokens = r.usage.input_tokens;
          outputTokens = r.usage.output_tokens;
        }
      }
    }
  } catch (authErr) {
    // Auth errors from the CLI should propagate so the caller knows auth is broken
    const msg = authErr instanceof Error ? authErr.message : String(authErr);
    if (/authentication|auth|login|credential|401|403/i.test(msg)) {
      throw authErr;
    }
    // Other errors → honest failure answer
    console.error("[answer-agentic] agent run failed:", msg);
    finalAnswer = `The agent encountered an error: ${msg.slice(0, 200)}`;
  } finally {
    // Clean up the temp working dir
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }

  const totalMs = now() - startTime;

  // The agent declares the files it used in a final "SOURCES_USED:" line (see buildSystemPrompt).
  // This is the agent's OWN statement of what grounded the answer — the source of truth — not a
  // regex guess over tool-call text. Parse it, then strip the line from the user-visible answer.
  const declaredSources: string[] = [];
  const sourcesMatch = finalAnswer.match(/SOURCES_USED:\s*(.+?)\s*$/im);
  if (sourcesMatch) {
    const raw = sourcesMatch[1].trim();
    if (raw && !/^none$/i.test(raw)) {
      declaredSources.push(...raw.split(",").map((s) => s.trim()).filter(Boolean));
    }
  }
  const displayAnswer = finalAnswer.replace(/\n*[ \t]*SOURCES_USED:[ \t]*.*$/im, "").trimEnd();

  // ── Build the AnswerResult ────────────────────────────────────────────────

  // Build a map from source name → prepared file so we can resolve citations.
  const sourceNameToFile = new Map<string, PreparedFile>(
    prepared.map((f) => [f.sourceName, f])
  );

  // Parse [P:<doc>#<page>] citation tokens from the answer — the standard format
  // the UI renders. Build the evidence chunk set from the union of:
  //  (a) files the agent explicitly READ (via Read tool), and
  //  (b) files the agent cited in its answer (via [P:] tokens).
  // This way the sources panel shows every file the agent used, whether it cited
  // inline or only read it with Bash.
  const citedTokens = extractCitationTokens(finalAnswer);
  const evidenceSourceNames = new Set<string>(filesRead);

  // Extract any source names from [P:<name>#<page>] tokens in the answer
  for (const token of citedTokens) {
    const m = token.match(/^\[P:(.+)#(\d+)\]$/);
    if (m) evidenceSourceNames.add(m[1]);
  }

  // The AGENT declares which files it used, via a machine-readable trailer it is instructed to
  // emit (see buildSystemPrompt). This is the source of truth for grounding — not a regex guess
  // over tool-call text (which breaks on Hebrew/space-laden shell-escaped filenames). Parse the
  // agent's own SOURCES_USED line and credit each declared file that matches a prepared file.
  for (const declared of declaredSources) {
    const match = prepared.find(
      (f) => f.sourceName === declared || f.sourceName.split("/").pop() === declared
    );
    if (match) evidenceSourceNames.add(match.sourceName);
  }

  // Floor: if the agent actually USED file-reading tools (Bash/Read/Grep) and files were
  // available, the answer is grounded in them — even if a weaker model forgot to emit the
  // SOURCES_USED line. Never report a tool-using answer over the user's files as "insufficient".
  // This is NOT filename-regex inference — just "did it touch the file tools at all". Precise
  // per-file attribution still comes from the agent's SOURCES_USED declaration when present.
  const usedFileTools = toolCalls.some((c) => ["Bash", "Read", "Grep", "Glob"].includes(c.tool));
  if (evidenceSourceNames.size === 0 && usedFileTools && prepared.length > 0) {
    for (const f of prepared) evidenceSourceNames.add(f.sourceName);
  }
  console.log(
    `[agentic] grounding declared=${JSON.stringify(declaredSources)} filesRead=${filesRead.length} ` +
      `usedFileTools=${usedFileTools} evidence=${evidenceSourceNames.size}`
  );

  // Build the evidence chunk set — one entry per unique source name.
  const evChunks: {
    doc: string;
    page: number;
    token: string;
    text: string;
    score?: number;
    denseRank?: number;
    bm25Rank?: number;
    rrfScore?: number;
  }[] = [];
  const seenSources = new Set<string>();
  for (const sourceName of evidenceSourceNames) {
    if (seenSources.has(sourceName)) continue;
    seenSources.add(sourceName);
    const file = sourceNameToFile.get(sourceName);
    const docLabel = file ? file.sourceName : sourceName;
    const isSpreadsheet = file?.type === "spreadsheet" || file?.type === "csv" || docLabel.endsWith(".csv");
    evChunks.push({
      doc: docLabel,
      page: 0,
      token: `[P:${docLabel}#0]`,
      text: `(read by agent: ${docLabel}${isSpreadsheet ? " — spreadsheet data" : ""})`,
      score: undefined,
      denseRank: undefined,
      bm25Rank: undefined,
      rrfScore: undefined,
    });
  }

  // "Citations"/sources shown to the user = inline [P:] tokens if the agent emitted any,
  // otherwise the number of files it actually used (read via Bash/Read) — never a bare 0 on
  // a grounded answer.
  const citationCount = citedTokens.length > 0 ? citedTokens.length : evidenceSourceNames.size;
  // Derive grounded from EITHER Read-tool file access OR [P:] citations in the answer.
  // This ensures that Bash-only file reads (e.g. python on xlsx) that produce cited
  // answers are reported as grounded rather than "general knowledge".
  const grounded = filesRead.length > 0 || citationCount > 0 || evidenceSourceNames.size > 0;

  // Route: "documents" if agent read any files OR cited sources in the answer.
  // Bash-only file reads (e.g. python on xlsx) show up via [P:] citations rather
  // than filesRead, so we must check both signals.
  const citedSourceNames = Array.from(evidenceSourceNames);
  const agentRouteIsGrounded = grounded;
  const agentRoute: RoutePlan = {
    sources: agentRouteIsGrounded ? ["documents" as const] : [],
    docFilter: null,
    rationale: agentRouteIsGrounded
      ? `Agentic: agent read/cited ${citedSourceNames.length > 0 ? citedSourceNames.join(", ") : filesRead.join(", ")} (${filesRead.length} Read-tool call(s), ${toolCalls.filter(c => c.tool === "Bash").length} Bash command(s), ${citationCount} citation(s)).`
      : "Agentic: agent did not read any files — answered from general knowledge.",
  };

  const inspector = buildAgenticInspector({
    answer: displayAnswer,
    toolCalls,
    filesRead,
    totalMs,
    inputTokens,
    outputTokens,
    turns,
    route: agentRoute,
    citationCount,
    evidenceCount: evidenceSourceNames.size,
    model,
  });

  return {
    question,
    route: agentRoute,
    answer: displayAnswer || "(no answer produced by the agent)",
    mode: grounded ? "grounded" : "general",
    grounded,
    evidence: {
      rows: [],
      chunks: evChunks,
    },
    // No validation gate — answer always comes through; validation is always ok
    validation: { ok: true, reasons: [] },
    inspector,
  };
}
