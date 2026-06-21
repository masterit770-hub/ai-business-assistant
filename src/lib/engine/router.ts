// The ROUTER — a REAL LLM call that decides which source(s) are relevant: the
// structured store (text-to-SQL over the live table catalog), the documents (RAG),
// or BOTH for a hybrid question. It REPORTS its decision (the differentiator the
// client asked for: a routing decision over heterogeneous sources, not "embed
// everything and search").
//
// GENERALIZED: the router sees the LIVE introspected table catalog (any ingested
// table, bundled or uploaded) — NOT a fixed list of named query intents. Picking the
// table(s) and writing the SQL is the text-to-SQL lane's job; the router only decides
// structured-vs-documents-vs-both. No table/column/domain is hardcoded.
import { chat } from "./llm.ts";
import { DOCUMENTS, type DocSpec } from "./documents.ts";
import { listUploadedDocs } from "./doc-store.ts";
import { introspectSchema } from "./structured-store.ts";
import type { TableSchema } from "./sql-guard.ts";
import { buildConversationContext, type Turn } from "./conversation.ts";

export type RoutePlan = {
  sources: ("structured" | "documents")[];
  docFilter: string | null; // restrict RAG to one doc id, or null = all docs
  rationale: string;
};

// Build the system prompt PER-CALL: both the document catalog AND the structured
// table catalog are dynamic (uploads change them), so the router always reasons over
// the CURRENT set of sources.
function buildSystem(uploaded: DocSpec[], tables: TableSchema[]): string {
  const allDocs = [...DOCUMENTS, ...uploaded];
  const docCatalog = allDocs.length
    ? allDocs.map((d) => `- ${d.doc}: ${d.label}`).join("\n")
    : "- (no documents loaded)";
  const tableCatalog = tables.length
    ? tables
        .map((t) => `- ${t.table} (columns: ${t.columns.map((c) => c.name).join(", ")})`)
        .join("\n")
    : "- (no structured tables loaded)";

  return `You are the query ROUTER for a knowledge assistant. You decide which data source(s) can answer a question. You DO NOT answer the question and you DO NOT write SQL.

Sources:
1. "structured" — a read-only SQLite database. Use it for questions answerable by querying/aggregating ROWS (counts, totals, averages, top-N, filtering, lookups by value). Available tables and their columns:
${tableCatalog}
2. "documents" — text documents (RAG over passages). Use for narrative/qualitative/legal questions answered from prose.
Documents:
${docCatalog}

Rules:
- Choose "structured" when the question maps to columns in a table above (e.g. a total/count/average/top-N or a lookup over those columns). Choose "documents" for a question answered from document prose. Choose BOTH only when the question genuinely spans them (e.g. summarize a document AND report a figure from a table).
- Do NOT route a question to a source that has no relevant table/document. If neither source is relevant, return an empty sources list.
- If documents are relevant to ONE specific document, set docFilter to its id; otherwise null.

Respond with ONLY JSON: {"sources": [...], "docFilter": null, "rationale": "one short sentence"}.`;
}

export async function routeQuestion(
  question: string,
  ctx: { ownerId?: string; history?: Turn[] } = {}
): Promise<RoutePlan> {
  const uploaded = await listUploadedDocs(ctx.ownerId);
  let tables: TableSchema[] = [];
  try {
    tables = introspectSchema().catalog;
  } catch {
    // Structured store not built (dev) — route over documents only.
    tables = [];
  }
  // MULTI-TURN: if this is a follow-up, put the recent conversation BEFORE the
  // question so the router understands a reference like "what about Q2?" — it routes
  // the RESOLVED intent, not the bare fragment. No history → empty string → the user
  // message is byte-identical to the single-shot path (backward-compatible).
  const convo = buildConversationContext(ctx.history);
  const userContent = convo
    ? `${convo}\n\n— — —\n\nNEW QUESTION (route THIS, using the conversation above only to understand what it refers to): ${question}`
    : question;
  const raw = await chat(
    [
      { role: "system", content: buildSystem(uploaded, tables) },
      { role: "user", content: userContent },
    ],
    { json: true, temperature: 0 }
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Safe degradation: if the router output is unparseable, query both and let
    // retrieval/relevance decide.
    return {
      sources: ["structured", "documents"],
      docFilter: null,
      rationale: "router output unparseable — querying all sources and letting relevance decide",
    };
  }
  return normalizePlan(parsed);
}

export function normalizePlan(parsed: unknown): RoutePlan {
  const p = (parsed ?? {}) as Record<string, unknown>;
  const rawSources = Array.isArray(p.sources) ? (p.sources as unknown[]) : null;
  const valid = (rawSources ?? []).filter(
    (s): s is "structured" | "documents" => s === "structured" || s === "documents"
  );
  // Decide source selection, distinguishing a DELIBERATE "no source needed" from a
  // MALFORMED response. The router prompt instructs the model to return an EMPTY
  // sources array when neither source is relevant (a greeting / pure-general
  // question) — that is a real decision and we must HONOR it (skip retrieval, answer
  // from general knowledge), NOT silently override it to query both. Only fall back
  // to querying BOTH when the response is genuinely unusable: no sources field at
  // all, or a non-empty array that contained no valid source name.
  const BOTH: ("structured" | "documents")[] = ["structured", "documents"];
  const finalSources: ("structured" | "documents")[] =
    rawSources === null
      ? BOTH // no usable sources field → malformed → query everything
      : rawSources.length === 0
        ? [] // deliberate "no source needed" → honor it (no retrieval)
        : valid.length
          ? valid // model picked valid source(s)
          : BOTH; // non-empty but all-garbage → malformed → query everything
  return {
    sources: finalSources,
    docFilter: typeof p.docFilter === "string" ? (p.docFilter as string) : null,
    rationale: typeof p.rationale === "string" ? (p.rationale as string) : "",
  };
}
