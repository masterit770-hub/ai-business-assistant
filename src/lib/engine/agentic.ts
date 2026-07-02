// AGENTIC BASELINE — Claude Agent SDK query() with EXACTLY TWO owner-scoped MCP tools.
//
// answerAgentic(question, scope) lets the AGENT pick which files to read and answer
// purely from what it reads. NO SQL, no tally, no RAG, no grep. This is the raw
// baseline: agent sees only its own files and decides which to read.
//
// TWO TOOLS (no others):
//   list_files()          → [{docId, name, type}] scoped to the owner
//   read_file({docId})    → parsed content (xlsx → full grid text; pdf → extracted text;
//                           csv → all rows as text); bytes from fetchOriginalFile()
//
// LOCKDOWN:
//   tools: []             — all built-in tools removed
//   allowedTools: [...]   — only the two MCP tools
//   canUseTool: deny-all  — belt-and-suspenders filesystem/bash deny
//   System prompt         — minimal: "list and read files, answer only from what you read"

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { fetchOriginalFile } from "./doc-files.ts";
import { admin, supabaseEnabled } from "./supabase.ts";

const ROOT = process.cwd();

// ── Types ──────────────────────────────────────────────────────────────────────

export type AgenticFileInfo = { docId: string; name: string; type: string };

export type AgenticResult = {
  answer: string;
  filesListed: AgenticFileInfo[];
  filesRead: string[];          // docIds the agent chose to read
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  toolCalls: { tool: string; args: unknown }[];
};

// ── Helper: list an owner's raw stored files from Supabase Storage ─────────────

async function listOwnerStoredFiles(ownerId: string): Promise<AgenticFileInfo[]> {
  if (!supabaseEnabled()) return [];
  try {
    // Try to read the _files.json metadata index first (human-readable names + types)
    const index = await fetchOriginalFile(ownerId, "_files.json");
    if (index) {
      const text = new TextDecoder("utf-8").decode(index.bytes);
      const parsed = JSON.parse(text) as Array<{ docId: string; displayName: string; type: string }>;
      return parsed.map((f) => ({ docId: f.docId, name: f.displayName, type: f.type }));
    }
    // Fallback: list storage objects directly
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
        const type = ext === "xlsx" ? "spreadsheet" : ext === "pdf" ? "pdf" : ext === "csv" ? "csv" : "file";
        return { docId: name, name, type };
      });
  } catch {
    return [];
  }
}

// ── Helper: parse raw bytes to readable text ───────────────────────────────────

async function parseToText(buf: Uint8Array, name: string): Promise<string> {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "xlsx") {
    // Reuse Nucleus xlsx convert: full grid as text rows
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "array" });
    const parts: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      parts.push(`=== Sheet: ${sheetName} ===\n${csv}`);
    }
    return parts.join("\n\n");
  }
  if (ext === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return pages
      .map((p, i) => `--- Page ${i + 1} ---\n${(p ?? "").replace(/​/g, "").trim()}`)
      .join("\n\n");
  }
  if (ext === "csv") {
    // Return all rows as text (the task: "for the enrollment CSV return all rows")
    return new TextDecoder("utf-8").decode(buf);
  }
  // Fallback: try UTF-8 text
  try {
    return new TextDecoder("utf-8").decode(buf);
  } catch {
    return "[binary file — cannot display]";
  }
}

// ── Main: answerAgentic ────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You can list and read the user's files. Pick the relevant file(s), read them, " +
  "and answer ONLY from what you read. Always cite the file name in your answer. " +
  "Do not guess or use prior knowledge — read the file first.";

/**
 * Answer a question using the Agent SDK with ONLY list_files + read_file tools.
 * The agent picks which file(s) to read; no SQL, tally, RAG, or decomposition.
 *
 * @param question  The question to answer
 * @param ownerId   The owner whose files are in Supabase Storage
 * @param model     Defaults to "claude-haiku-4-5"
 */
export async function answerAgentic(
  question: string,
  ownerId: string,
  model = "claude-haiku-4-5"
): Promise<AgenticResult> {
  const filesRead: string[] = [];
  const toolCalls: { tool: string; args: unknown }[] = [];
  let filesListed: AgenticFileInfo[] = [];

  // Build the two owner-scoped MCP tools
  const listFilesTool = tool(
    "list_files",
    "List the user's available files (docId, name, type). Always call this first to discover which files exist.",
    {},
    async (_args: Record<string, never>) => {
      const files = await listOwnerStoredFiles(ownerId);
      filesListed = files;
      toolCalls.push({ tool: "list_files", args: {} });
      return {
        content: [
          {
            type: "text" as const,
            text: files.length
              ? JSON.stringify(files, null, 2)
              : "[]  (no files stored for this user)",
          },
        ],
      };
    }
  );

  const readFileTool = tool(
    "read_file",
    "Read a file by docId and return its full content as text. For spreadsheets returns all rows; for PDFs returns extracted text; for CSVs returns all rows.",
    { docId: z.string().describe("The docId from list_files to read") },
    async (args: { docId: string }) => {
      toolCalls.push({ tool: "read_file", args });
      const fetched = await fetchOriginalFile(ownerId, args.docId);
      if (!fetched) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${args.docId}` }],
        };
      }
      if (!filesRead.includes(args.docId)) filesRead.push(args.docId);
      const text = await parseToText(fetched.bytes, args.docId);
      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );

  const mcpServer = createSdkMcpServer({
    name: "nucleus",
    version: "1.0.0",
    instructions: "Provides access to the user's uploaded files via list_files and read_file.",
    tools: [listFilesTool, readFileTool],
    alwaysLoad: true,
  });

  // Run the query
  let answer = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let turns = 0;

  const q = query({
    prompt: question,
    options: {
      model,
      // LOCKDOWN: remove all built-in tools
      tools: [],
      // Only these two MCP tools are allowed
      allowedTools: ["mcp__nucleus__list_files", "mcp__nucleus__read_file"],
      // Belt-and-suspenders: deny anything that tries to escape the sandbox
      canUseTool: async (toolName: string) => {
        const allowed =
          toolName === "mcp__nucleus__list_files" ||
          toolName === "mcp__nucleus__read_file";
        if (allowed) return { behavior: "allow" as const };
        return { behavior: "deny" as const, message: `Tool ${toolName} is not permitted in the agentic baseline sandbox.` };
      },
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { nucleus: mcpServer },
      maxTurns: 10,
    },
  });

  for await (const msg of q) {
    if (msg.type === "assistant") {
      turns++;
      if (msg.message?.usage) {
        inputTokens += msg.message.usage.input_tokens ?? 0;
        outputTokens += msg.message.usage.output_tokens ?? 0;
        cacheReadTokens += (msg.message.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
        cacheWriteTokens += (msg.message.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
      }
      // Extract text from content blocks
      const textBlocks = (msg.message?.content ?? [])
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { type: string; text?: string }) => (b as { type: string; text: string }).text ?? "")
        .join("\n");
      if (textBlocks.trim()) answer = textBlocks.trim();
    }
    if (msg.type === "result") {
      // SDKResultSuccess has a `result` string field; SDKResultError has `errors`.
      const r = msg as { type: "result"; subtype: string; result?: string; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
      if (r.subtype === "success" && r.result) {
        answer = r.result;
      }
      if (r.usage) {
        // Accumulate final totals from the result message (may supersede per-turn)
        inputTokens = r.usage.input_tokens;
        outputTokens = r.usage.output_tokens;
        cacheReadTokens = r.usage.cache_read_input_tokens ?? 0;
        cacheWriteTokens = r.usage.cache_creation_input_tokens ?? 0;
      }
    }
  }

  return {
    answer,
    filesListed,
    filesRead,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    turns,
    toolCalls,
  };
}
