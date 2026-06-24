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
import { classifyOccurrenceIntent, isGridShaped } from "./cell-tally.ts";

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
- SUMMARY / OVERVIEW / "WHAT IS / WHAT DOES X INCLUDE / TELL ME ABOUT / DESCRIBE X" questions: the subject "X" the user names (a track, a program, a process, a topic) may live in EITHER the documents OR the structured TABLES (a multi-sheet program is often a set of TABLES, not a document). The table NAMES below are terse and may not spell out the subject, but a sheet whose name shares a word with the subject — or a set of related sheets — can BE the thing to summarize. So for a summary/overview/"what does X include" question, when BOTH documents AND tables are listed, route to BOTH (let retrieval judge which holds the subject) rather than guessing documents-only. If ONLY tables are listed, route to "structured"; if ONLY documents are listed, route to "documents". NEVER answer a summary of the user's OWN named subject with an empty route when their tables/documents are listed — that strands their own data and forces a wrong general-knowledge answer.
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
  // TEST-ONLY: force the router LLM to "return empty" so a test can prove the deterministic guards
  // rescue a stranded grid-cell/summary question (the LLM is non-deterministic at temp 0 and
  // intermittently returns sources:[] for her cryptic Hebrew sheets — we must not depend on its mood
  // to verify the guard). Never set in production; gated behind an explicit test env flag.
  const raw =
    process.env.__ROUTER_FORCE_EMPTY === "1"
      ? '{"sources": [], "docFilter": null, "rationale": "forced-empty (test)"}'
      : await chat(
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
  // DETERMINISTIC SUMMARY-OVER-OWN-DATA GUARD (the summary-routing fix). A modest router LLM
  // intermittently routes a SUMMARY/OVERVIEW of the user's OWN named subject ("summarize the
  // Danieli track", "what does X include") to documents-ONLY (or empty), stranding the user's
  // structured SHEETS — which is where a multi-sheet program actually lives — and forcing a wrong
  // general-knowledge answer that DENIES their data holds it (the live RED). When the question is a
  // summary/overview AND the caller HAS structured tables, we deterministically ADD "structured" so
  // their sheets get retrieved; documents stays too (retrieval judges which holds the subject). This
  // is keyed only off the question SHAPE (a summary cue) + "the caller has tables", never a table
  // name or subject — a non-summary question is untouched.
  const planned = guardEmptyCatalogs(normalizePlan(parsed), hasAccessibleDocs, hasAccessibleTables);
  const withSummary = guardSummaryOverOwnData(planned, question, hasAccessibleTables);
  // GRID-CELL ROUTING GUARD: a grid occurrence-ranking/count/filter question over the caller's OWN
  // grid sheets must route to "structured" even when the router LLM punted it to empty/documents — the
  // cell-tally lane (which the planner can't express in plain SQL) is the only thing that answers it.
  // This used to gate on a regex cue-list; it now gates on the SAME phrasing-independent intent flag
  // the structured lane uses (the model decides intent, no maintained phrase list). The extra intent
  // call only runs in the RESCUE path: the router didn't already route structured AND the caller has a
  // grid-shaped table. When the router already chose structured (the common case) it's a no-op.
  return guardGridCellOverOwnData(withSummary, question, tables);
}

// A SUMMARY / OVERVIEW / "what is / what does X include / tell me about / describe X" cue (EN + HE).
// Conservative: a real "summarize/overview/describe/what does … include/tell me about" phrasing, not
// a plain fact lookup. Pure + exported so the guard is unit-tested without an LLM.
export function isSummaryQuestion(question: string): boolean {
  const q = question.normalize("NFC").toLowerCase();
  return (
    /\b(summari[sz]e|summary|overview|tell me about|describe|walk me through|what (is|are|does|do)\b.*\b(include|cover|consist|contain|about))\b/.test(q) ||
    /\b(what does .* include|give me .* (overview|summary))\b/.test(q) ||
    /(סכם|תסכם|סיכום|תקציר|סקירה|מה כולל|מה כוללת|ספר לי על|תאר|מה זה|על מה|מה יש ב)/.test(question)
  );
}

// DETERMINISTIC: for a SUMMARY question over a caller WITH structured tables, ensure "structured"
// is in the route (so their own sheets are retrieved) without removing "documents". A non-summary
// question, or a caller with no tables, is returned unchanged. Pure + exported.
export function guardSummaryOverOwnData(
  plan: RoutePlan,
  question: string,
  hasAccessibleTables: boolean
): RoutePlan {
  if (!hasAccessibleTables) return plan;
  if (!isSummaryQuestion(question)) return plan;
  if (plan.sources.includes("structured")) return plan;
  return {
    sources: [...plan.sources, "structured"],
    docFilter: plan.docFilter,
    rationale: `${plan.rationale || "summary"}; also routing to the caller's structured sheets (a summary of their own subject may live in their tables, not only documents)`,
  };
}

// For a GRID OCCURRENCE question (ranking / specific-value count / filter-by-count over a header-less
// grid sheet) the caller owns, ensure "structured" is in the route so the cell-tally lane gets to run
// — without removing "documents". The router LLM intermittently strands these questions (sources:[] or
// documents-only) over her cryptic Hebrew sheet names. The trigger is the SAME phrasing-independent
// intent flag the structured lane uses (the model decides intent; no regex cue-list), so this guard
// and the lane agree. The extra intent LLM call runs ONLY in the rescue path: the router did NOT
// already route structured AND the caller has a grid-shaped table. When structured is already routed,
// or the caller has no grid sheet, it is a no-op with no extra call. `tables` is the SAME owner-scoped
// catalog the prompt was built from, so this only ever adds the caller's OWN structured source.
export async function guardGridCellOverOwnData(
  plan: RoutePlan,
  question: string,
  tables: TableSchema[]
): Promise<RoutePlan> {
  if (plan.sources.includes("structured")) return plan;
  const gridTables = tables.filter((t) => isGridShaped(t));
  if (gridTables.length === 0) return plan;
  const intent = await classifyOccurrenceIntent(question, gridTables);
  if (intent.kind === "none") return plan;
  return {
    sources: [...plan.sources, "structured"],
    docFilter: plan.docFilter,
    rationale: `${plan.rationale || "grid occurrence question"}; also routing to the caller's structured sheets (an occurrence-${intent.kind} over their schedule grid is answered by the cell-tally lane, not plain SQL)`,
  };
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
