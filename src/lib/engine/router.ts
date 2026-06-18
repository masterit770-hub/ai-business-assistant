// The ROUTER — a REAL DeepSeek call that decides which source(s) are relevant and
// (for structured) which named intents to run, and REPORTS its decision. This is
// the differentiator the client asked for: not "embed everything and search", but
// a routing decision over heterogeneous sources.
import { chat } from "./llm.ts";
import { INTENTS } from "./intents.ts";
import { DOCUMENTS, type DocSpec } from "./documents.ts";
import { listUploadedDocs } from "./doc-store.ts";

export type RoutePlan = {
  sources: ("structured" | "documents")[];
  intents: { name: string; params: Record<string, any> }[];
  docFilter: string | null; // restrict RAG to one doc id, or null = all docs
  rationale: string;
};

const intentCatalog = INTENTS.map(
  (i) => `- ${i.name} (feature: ${i.feature}): ${i.description}`
).join("\n");

// The system prompt is built PER-CALL because the document catalog is dynamic:
// docs uploaded at runtime are appended, and the "the only documents are Carter"
// guard is relaxed once a user has uploaded their own document (so a question
// about THAT doc is correctly routed to "documents"). `uploaded` comes from the
// persistent store (Supabase) or the in-memory fallback, owner-scoped in Phase C.
function buildSystem(uploaded: DocSpec[]): string {
  const allDocs = [...DOCUMENTS, ...uploaded];
  const docCatalog = allDocs.map((d) => `- ${d.doc}: ${d.label}`).join("\n");
  const uploadedList = uploaded.map((d) => `- ${d.doc}: ${d.label}`).join("\n");

  // With no uploads, keep the strict Carter-only guard (prevents a business
  // question from leaking into the divorce-case PDFs). With uploads present, the
  // corpus is no longer Carter-only, so the guard becomes: route to documents
  // when the question matches an uploaded document's subject.
  const docGuard = uploaded.length
    ? `- The documents now include USER-UPLOADED files (listed below). If a question is about the subject of an uploaded document, route to "documents". The bundled Carter case file + story are about a DIVORCE CASE; do not answer a business-operations question (payments, invoices, overdue, vendors) from the Carter PDFs — but an uploaded document may legitimately be about anything its label describes.\nUSER-UPLOADED documents:\n${uploadedList}`
    : `- The ONLY documents are the Carter family-court case file + story. They are about a DIVORCE CASE — NOT business agreements, contracts, invoices, payments, or service terms. NEVER route a business/operations question (payments, invoices, overdue, vendors, contracts, service agreements, suspension terms) to the documents — there is no business agreement document in this system.`;

  return `You are the query ROUTER for a business knowledge assistant. You decide which data source(s) can answer a question and, for the structured store, which named query intents to run. You DO NOT answer the question.

Sources:
1. "structured" — a read-only SQLite database of school/business operations. Answer structured questions by selecting INTENTS (you cannot write SQL):
${intentCatalog}
2. "documents" — PDF case files (RAG over text chunks). Use for narrative/legal/qualitative questions:
${docCatalog}

Rules:
- The structured (school operations) and document domains are UNRELATED. Never assume a join between them.
${docGuard}
- A question about overdue payments, who owes us, unpaid/paid invoices, customers in arrears, or service-suspension terms is a BUSINESS-OPERATIONS question about the maintenance/invoice data → route to "structured" with the "maintenance_spend" intent (which will honestly explain the data has no such field). Do NOT route it to the bundled Carter documents looking for an "agreement".
- Pick "structured", "documents", or BOTH when a question genuinely spans them (e.g. list business data AND summarize a document). A pure business question is "structured" only; a pure document question is "documents" only.
- For each structured intent, supply params it needs (e.g. {"days": 90}, {"vendor": "Acme"}, {"year": 2026}, {"department": "Sales"}). Omit params you don't have.
- If documents are relevant to one specific case file, set docFilter to its id; otherwise null.

Respond with ONLY JSON: {"sources": [...], "intents": [{"name": "...", "params": {...}}], "docFilter": null, "rationale": "one short sentence"}.`;
}

export async function routeQuestion(
  question: string,
  ctx: { ownerId?: string } = {}
): Promise<RoutePlan> {
  const uploaded = await listUploadedDocs(ctx.ownerId);
  const raw = await chat(
    [
      { role: "system", content: buildSystem(uploaded) },
      { role: "user", content: question },
    ],
    { json: true, temperature: 0 }
  );
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Safe deg: if the router output is unparseable, fall back to querying both.
    return {
      sources: ["structured", "documents"],
      intents: [],
      docFilter: null,
      rationale: "router output unparseable — querying all sources and letting relevance decide",
    };
  }
  return normalizePlan(parsed);
}

export function normalizePlan(parsed: any): RoutePlan {
  const validIntents = new Set(INTENTS.map((i) => i.name));
  let sources: string[] = Array.isArray(parsed.sources)
    ? parsed.sources.filter((s: string) => s === "structured" || s === "documents")
    : [];
  const intents = Array.isArray(parsed.intents)
    ? parsed.intents
        .filter((i: any) => i && validIntents.has(i.name))
        .map((i: any) => ({ name: i.name, params: i.params ?? {} }))
    : [];
  // Coherence: if structured intents were chosen, ensure "structured" is in sources.
  if (intents.length && !sources.includes("structured")) sources.push("structured");

  // CROSS-DOMAIN-LEAK GUARD (contract-intelligence J1/G2): the contract data has
  // no companion documents in this corpus — the only PDFs are the unrelated Carter
  // case file. A contract question must NEVER retrieve documents, so a penalty/
  // termination ask can't be "answered" with divorce-case text. If a contract
  // intent was selected, force SQL-only — there is no Carter chunk in evidence to
  // leak. This is the strongest form of the leak gate (prevent, don't post-filter).
  const isContractTurn = intents.some((i: { name: string }) => i.name.startsWith("contracts_"));
  let leakGuarded = false;
  if (isContractTurn && sources.includes("documents")) {
    sources = sources.filter((s: string) => s !== "documents");
    leakGuarded = true;
  }

  const rationale =
    (typeof parsed.rationale === "string" ? parsed.rationale : "") +
    (leakGuarded
      ? " (contract questions are answered from structured data only; no contract documents exist in this corpus, so penalty terms are reported as unavailable rather than sourced from an unrelated document)"
      : "");

  const finalSources = (sources.length ? sources : ["structured", "documents"]) as (
    | "structured"
    | "documents"
  )[];
  return {
    sources: finalSources,
    intents,
    docFilter: typeof parsed.docFilter === "string" && !isContractTurn ? parsed.docFilter : null,
    rationale,
  };
}
