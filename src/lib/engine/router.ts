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
import { DOCUMENTS } from "./documents.ts";
import { listUploadedDocs } from "./doc-store.ts";
import { listUploadedDocs as listUploadedDocsDurable } from "./pgvector-store.ts";
import { introspectSchema, hydrateUploadedTables, type CatalogScope } from "./structured-store.ts";
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
// `includeBundled` gates whether the BUNDLED sample DOCUMENTS catalog (the Carter demo
// corpus) is shown to the router. A real (non-demo) client user must NOT see it — if it
// did, the router would route their unrelated question to "documents" against a corpus
// they cannot access (the recorded RED #3 hallucination). So a non-demo caller sees ONLY
// their own uploaded docs; with none, the catalog reads "(no documents loaded)" and the
// router has nothing to route a document question TO.
function buildSystem(
  uploaded: { doc: string; label: string }[],
  tables: TableSchema[],
  includeBundled: boolean
): string {
  const allDocs = includeBundled ? [...DOCUMENTS, ...uploaded] : [...uploaded];
  const hasDocs = allDocs.length > 0;
  const hasTables = tables.length > 0;
  const docCatalog = hasDocs
    ? allDocs.map((d) => `- ${d.doc}: ${d.label}`).join("\n")
    : "- (no documents loaded)";
  const tableCatalog = hasTables
    ? tables
        .map((t) => `- ${t.table} (columns: ${t.columns.map((c) => c.name).join(", ")})`)
        .join("\n")
    : "- (no structured tables loaded)";

  return `You are the query ROUTER for a knowledge assistant. You decide which data source(s) can answer a question. You DO NOT answer the question and you DO NOT write SQL.

WHAT A SOURCE BEING "AVAILABLE" MEANS: a source is available ONLY if its catalog below actually LISTS something. If the documents catalog says "(no documents loaded)", the "documents" source does NOT exist — you may NOT route to it. If the tables catalog says "(no structured tables loaded)", the "structured" source does NOT exist. You can only route to a source that has real entries listed.

HOW TO CHOOSE WHEN A SOURCE IS AVAILABLE: the document LABELS below are short and DO NOT reveal everything a document contains — a document labelled "Services Statement", "Contract", "Memo", "Report", or "Case File" can hold supplier names, fees, parties, figures, dates, terms, and more. So you must NOT require the label to mention the thing the question asks about. DEFAULT TO ROUTING when content exists: if ANY documents are listed and the question is anything other than a greeting/small-talk/pure-general-knowledge question, route to "documents" — assume a listed document MIGHT contain the answer and let retrieval judge. Likewise route to "structured" when tables are listed and the question counts/totals/averages/looks up/filters rows. Choose BOTH when the question could span a listed document AND a listed table. It is much worse to wrongly return empty (and fail to search the user's own uploaded file) than to route to documents that turn out not to match — retrieval handles a non-match gracefully.

WHEN TO RETURN EMPTY (no source): return an EMPTY sources list ONLY when (a) the relevant catalog is empty — nothing of that type is loaded (so that source does not exist) — OR (b) the question is a greeting, small talk, or a pure general-knowledge question (e.g. "what is the capital of France?", "explain photosynthesis") that plainly needs none of the user's uploaded content. NEVER invent a source that the catalog does not list, but when documents/tables ARE listed and the question is about content/data, do NOT withhold the route.

WORKED COUNTER-EXAMPLE (the empty case): the catalog lists only a "vendors" table (columns: vendor, amount) and the documents catalog says "(no documents loaded)". The question is "what does the 14th-century castle restoration report say about the moat?". There is NO documents source at all and the vendors table is unrelated → {"sources": [], "docFilter": null, "rationale": "no documents are loaded and no listed table is about a castle report"}. Do NOT answer ["documents"] — there are no documents loaded.

Sources:
1. "structured" — a read-only SQLite database. Use it for questions answerable by querying/aggregating ROWS (counts, totals, averages, top-N, filtering, lookups by value). Available tables and their columns:
${tableCatalog}
2. "documents" — text documents (RAG over passages). Use for narrative/qualitative/factual questions answered from prose the user uploaded.
Documents:
${docCatalog}

Rules:
- If documents ARE listed and the question is a content/factual/narrative/lookup question, choose "documents" (the labels are terse — let retrieval judge; do not require the label to spell out the answer).
- If tables ARE listed and the question counts/totals/averages/looks up/filters rows, choose "structured".
- Choose BOTH only when the question genuinely spans a listed document AND a listed table.
- Return [] for a greeting/small-talk/general-knowledge question, or when the needed catalog is empty (that source is unavailable).
- If documents are relevant to ONE specific listed document, set docFilter to its id; otherwise null.

Respond with ONLY JSON: {"sources": [...], "docFilter": null, "rationale": "one short sentence"}.`;
}

export async function routeQuestion(
  question: string,
  // `isAdmin` lets the structured catalog be OWNER-SCOPED: an admin (isAdmin=true, ownerId
  // typically undefined) sees every owner's uploaded tables; a member (a concrete ownerId)
  // sees ONLY their own; a legacy caller with neither keeps the all-tables default. The
  // doc-catalog scoping already keys off ownerId; this adds the same isolation to the
  // structured table catalog so a spreadsheet question is routed (and only routed) on the
  // caller's own tables.
  ctx: { ownerId?: string; history?: Turn[]; isDemo?: boolean; isAdmin?: boolean } = {}
): Promise<RoutePlan> {
  // The uploaded-document catalog MUST be durable: a Vercel serverless cold start wipes
  // the in-memory runtime store, so a router that only knew the in-memory catalog saw
  // "(no documents loaded)" after a cold start and answered "no documents" for REAL
  // uploads (PDF/Word/spreadsheet). We rebuild it from the durable pgvector store
  // (doc_chunks, owner-scoped) and UNION it with the in-memory store so dev/offline (no
  // Supabase) still works. Durable is fail-open ([] on any error) — never breaks routing.
  const [mem, durable] = await Promise.all([
    listUploadedDocs(ctx.ownerId),
    listUploadedDocsDurable(ctx.ownerId).catch(() => []),
  ]);
  const byDoc = new Map<string, { doc: string; label: string }>();
  for (const d of [...durable, ...mem]) byDoc.set(d.doc, { doc: d.doc, label: d.label });
  const uploaded = [...byDoc.values()];
  // OWNER-SCOPED structured catalog. Build the scope from the caller: an admin sees all
  // uploaded tables; a member only their own; a legacy caller (no ownerId, not admin)
  // keeps the all-tables default. Undefined scope = the legacy default (preserves the
  // existing router unit tests, which call introspectSchema with no scope).
  const scope: CatalogScope | undefined =
    ctx.isAdmin || ctx.ownerId !== undefined
      ? { ownerId: ctx.ownerId, isAdmin: !!ctx.isAdmin }
      : undefined;
  // DURABLE COLD-START FIX (structured lane): rehydrate the caller's uploaded rows from
  // Supabase into the runtime store BEFORE the synchronous introspect, so after a cold
  // start the router still sees their spreadsheet tables and routes the question to
  // "structured" (rather than "(no structured tables loaded)" → wrongly answering none).
  // Owner-scoped + fail-open; no-op when Supabase is off or there are no durable rows.
  if (scope) await hydrateUploadedTables(scope.ownerId, !!scope.isAdmin);
  let tables: TableSchema[] = [];
  try {
    // A non-demo caller never sees the bundled sample tables in the routing catalog,
    // so it won't route a question to data it can't access.
    tables = introspectSchema(3, ctx.isDemo !== false, scope).catalog;
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
  const includeBundled = ctx.isDemo !== false;
  // The DETERMINISTIC catalog the guard below enforces against, computed the SAME way the
  // prompt's catalog is built. A document source is only accessible if there is at least
  // one document the caller can actually see (their own uploads, plus the bundled corpus
  // ONLY for a demo caller). A structured source is only accessible if a table is listed.
  const hasAccessibleDocs = (includeBundled ? DOCUMENTS.length : 0) + uploaded.length > 0;
  const hasAccessibleTables = tables.length > 0;
  const raw = await chat(
    [
      { role: "system", content: buildSystem(uploaded, tables, includeBundled) },
      { role: "user", content: userContent },
    ],
    { json: true, temperature: 0 }
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Safe degradation: if the router output is unparseable, query both and let
    // retrieval/relevance decide — but still bounded by the empty-catalog guard, so a
    // caller with no documents/tables never gets a hallucinated source even here.
    return guardEmptyCatalogs(
      {
        sources: ["structured", "documents"],
        docFilter: null,
        rationale: "router output unparseable — querying all available sources and letting relevance decide",
      },
      hasAccessibleDocs,
      hasAccessibleTables
    );
  }
  // DETERMINISTIC EMPTY-CATALOG GUARD (RED #3). Independent of what the LLM returned: drop
  // "documents" when the caller has NO accessible documents and "structured" when there are
  // NO tables. This makes the no-hallucinated-source property hold even if a modest model
  // ignores the prompt and guesses a source the catalog doesn't contain.
  return guardEmptyCatalogs(normalizePlan(parsed), hasAccessibleDocs, hasAccessibleTables);
}

// Deterministic post-routing guard: a source the caller cannot access (empty catalog)
// is removed regardless of the model's choice, so the router can NEVER hallucinate a
// "documents"/"structured" route for content the caller does not have. Pure + exported
// so the guard is unit-tested directly without an LLM.
export function guardEmptyCatalogs(
  plan: RoutePlan,
  hasAccessibleDocs: boolean,
  hasAccessibleTables: boolean
): RoutePlan {
  const before = plan.sources;
  const filtered = before.filter(
    (s) => (s === "documents" ? hasAccessibleDocs : true) && (s === "structured" ? hasAccessibleTables : true)
  );
  if (filtered.length === before.length) return plan;
  const dropped = before.filter((s) => !filtered.includes(s));
  return {
    sources: filtered,
    docFilter: filtered.includes("documents") ? plan.docFilter : null,
    rationale: filtered.length
      ? plan.rationale
      : `no accessible ${dropped.join("/")} source for this question — answering without retrieval`,
  };
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
