// The orchestrator: route → retrieve (text-to-SQL + RAG) → grounded generation →
// validate. Returns the answer, the routing decision (reported to the user), and the
// evidence (every cited row/page), so the UI can show traceability.
//
// The STRUCTURED lane is GENERAL text-to-SQL: the model writes a SELECT over the live
// introspected schema of whatever has been ingested (bundled OR user-uploaded
// tables), guarded SELECT-only and cited to the real result rows. There are no
// hand-written per-domain query intents or per-feature validation gates — the only
// grounding gate is validateAnswer (citation fidelity), which is general.
import { routeQuestion, type RoutePlan } from "./router.ts";
import { answerStructured } from "./text-to-sql.ts";
import type { SqlRow, CatalogScope } from "./structured-store.ts";
import { hybridVectorSearch, fetchBundledDocChunks, type DocChunk } from "./retrieval.ts";
import { hybridSearch, fetchDocChunksByDoc } from "./pgvector-store.ts";
import { supabaseEnabled } from "./supabase.ts";
import { embedQuery } from "./embeddings.ts";
import { chatWithUsage, type ChatUsage, isLocalNotConfigured, isLocalUnreachable, isHipaaNotConfigured, isCloudProviderNotConfigured, isCloudProviderAuth, isModelRunFailure } from "./llm.ts";
import { sqlToken, pdfToken, extractCitationTokens, resolvableTokenSet } from "./citations.ts";
import {
  validateAnswer,
  validateCellTallyAnswer,
  salvageGroundedAnswer,
  type Evidence,
  type VerifiedTopGroup,
} from "./validate-answer.ts";
import { DOCUMENTS } from "./documents.ts";
import { runtimeDocs } from "./runtime-store.ts";
import { getSetting } from "./settings.ts";
import { buildConversationContext, type Turn } from "./conversation.ts";
import { refreshDeletedSources } from "./deleted-sources.ts";

export type AnswerResult = {
  question: string;
  route: RoutePlan;
  answer: string;
  // The answering mode for this turn:
  //  • "grounded" — the user's documents/data contained the answer. The reply is
  //    grounded strictly in retrieved evidence, every fact is cited, and the
  //    citation-fidelity gate (validateAnswer) ran.
  //  • "general"  — the user has NO relevant documents/data for this question (the
  //    router matched no source, or retrieval came back empty). The reply is the
  //    model's general knowledge, has NO citations/evidence, and is intentionally
  //    NOT run through the grounding validators (a general answer legitimately
  //    carries no citation tokens — validating it would wrongly reject it).
  mode: "grounded" | "general";
  // Convenience flag mirroring `mode === "grounded"` for callers/UI that want a
  // single boolean (the Ask panel uses this to show the muted "general knowledge"
  // line vs. the grounded citations).
  grounded: boolean;
  // Set ONLY when Local mode is on but the local model couldn't answer (not
  // configured / unreachable). The answer text is friendly setup guidance; the UI
  // can use this to show a calm "Local setup" note instead of the "general
  // knowledge" line. Absent on every normal turn.
  localGuidance?: "not-configured" | "unreachable";
  evidence: {
    rows: { table: string; id: number; token: string; data: Record<string, unknown> }[];
    // `score` is the headline relevance (RRF fused score for a hybrid result). The
    // hybrid breakdown (denseRank / bm25Rank / rrfScore) is the REAL per-chunk
    // ranking the inspector's document-retrieval table renders — all engine-computed,
    // never hardcoded. A rank of 0 = "that lane did not rank this chunk".
    chunks: {
      doc: string;
      page: number;
      token: string;
      text: string;
      score?: number;
      denseRank?: number;
      bm25Rank?: number;
      rrfScore?: number;
    }[];
  };
  validation: { ok: boolean; reasons: string[] };
  // ── INSPECTOR TRANSPARENCY (all reconstructed from real pipeline state) ───────
  // Every field below is OPTIONAL so existing callers/tests are unaffected. They
  // are populated by the real pipeline; the early-return guidance/error paths leave
  // them undefined (the UI then shows the minimal answer chrome).
  inspector?: InspectorTrace;
};

// A derived, honestly-labelled confidence. `value` is 0..1; `basis` names the REAL
// signals it came from (top retrieval score, grounded-vs-general, validation) — it
// is NOT a model-reported probability and is labelled "derived" in the UI.
export type Confidence = { value: number; basis: string };

// One step of the orchestrator trace — reconstructed from what the pipeline ACTUALLY
// did, in order. `status` colors the dot; `detail` is the human line.
export type TraceStep = {
  key: string;
  label: string;
  status: "ok" | "skip" | "warn" | "info";
  detail: string;
};

// The real per-phase wall-clock timings (ms), measured with performance.now().
export type Timings = { routingMs: number; retrievalMs: number; generationMs: number; totalMs: number };

// Real cost/token accounting aggregated across the live LLM calls this turn made.
// `tokens` is undefined when no live call reported usage (→ UI shows "n/a", never a
// fabricated number). `usd` is computed from the model's real per-token pricing when
// known; otherwise null with `pricingNote` explaining why (e.g. unknown provider).
export type CostReport = {
  liveCalls: number;
  promptTokens?: number;
  completionTokens?: number;
  usd: number | null;
  pricingNote: string;
  provider: string;
  model: string;
};

export type InspectorTrace = {
  // The honest retrieval-method label per what ACTUALLY ran this turn (the SQL
  // text-to-SQL lane and/or the document HYBRID lane "dense × BM25 → RRF"). It is
  // REAL: the document-retrieval table renders the actual per-chunk dense rank, BM25
  // rank, and RRF score from the same retrieval.
  retrievalMethod: string;
  passages: number; // count of document chunks retrieved
  evidenceCount: number; // rows + chunks
  confidence: Confidence;
  steps: TraceStep[];
  timings: Timings;
  cost: CostReport;
};

// `||` (not `??`) so an empty env value ("") falls through to the real date.
const TODAY = process.env.ASSISTANT_TODAY || new Date().toISOString().slice(0, 10);

// ── LOCAL-MODE FRIENDLY GUIDANCE ───────────────────────────────────────────────
// When the workspace is in Local mode but the local model can't actually answer —
// either no endpoint is configured, or the configured endpoint is unreachable —
// we do NOT 500. We return a NORMAL answer payload whose `answer` text is plain,
// guiding language, so the Ask UI just renders it like any other answer (no scary
// red error, no citations to validate). `mode: "general"` marks it as
// non-grounded so the UI hides the citation/validation chrome.
//
// Pure + exported so the exact wording is unit-tested without a live LLM/endpoint.
export type LocalGuidanceKind = "not-configured" | "unreachable";

export function localGuidanceText(kind: LocalGuidanceKind, endpoint?: string): string {
  if (kind === "not-configured") {
    return "Local mode is on, but no local model is set up yet. To use Local: run Nucleus on your own machine, install Ollama and pull a model, then enter your endpoint (e.g. http://localhost:11434/v1) and model name in Settings → Model. (The hosted demo can't reach a local model — Local works when you self-host.)";
  }
  const where = endpoint ? `at ${endpoint}` : "at your configured endpoint";
  return `Local mode is on, but I couldn't reach your local model ${where}. Make sure Nucleus is running on the same machine/network as your model (Ollama running, the model pulled), and that the endpoint in Settings → Model is correct.`;
}

function localGuidanceResult(
  question: string,
  kind: LocalGuidanceKind,
  endpoint?: string
): AnswerResult {
  return {
    question,
    // A minimal, honest routing record: we never reached the real router.
    route: {
      sources: [],
      docFilter: null,
      rationale: "Local mode — the local model wasn't available, so this is setup guidance.",
    },
    answer: localGuidanceText(kind, endpoint),
    // "general" → no citations/validation chrome; the UI shows it as plain text.
    mode: "general",
    grounded: false,
    // Flag so the UI can show this as guidance (not a normal general answer) if it
    // wants to; harmless for callers that ignore it.
    localGuidance: kind,
    evidence: { rows: [], chunks: [] },
    validation: { ok: true, reasons: [] },
  };
}

// HIPAA mode with no Azure backend configured → friendly setup guidance (a 200),
// mirroring the Local guidance. NEVER falls back to the shared cloud model.
function hipaaGuidanceResult(question: string): AnswerResult {
  return {
    question,
    route: {
      sources: [],
      docFilter: null,
      rationale: "HIPAA mode — the Azure backend isn't configured, so this is setup guidance.",
    },
    answer:
      "HIPAA mode is on, but it isn't set up yet. Add your Azure OpenAI key, resource endpoint, and deployment name in Settings → Model (HIPAA). For your protection, HIPAA mode never falls back to the shared cloud model — it stays off until you point it at your own BAA-covered Azure resource.",
    mode: "general",
    grounded: false,
    evidence: { rows: [], chunks: [] },
    validation: { ok: true, reasons: [] },
  };
}

// PUBLIC entry. Runs the real pipeline, but if the active backend is LOCAL and it
// can't answer (not configured / unreachable), returns the friendly guidance as a
// normal 200 payload instead of letting the typed error become a 500.
//
// CLOUD keyless / bad-key is DELIBERATELY DIFFERENT from Local/HIPAA setup-guidance: a
// selected-cloud-provider-with-no-key (CloudProviderNotConfiguredError) and a
// rejected-key 401/403 (CloudProviderAuthError) are NOT turned into a 200 'general'
// answer here — they PROPAGATE out so /api/ask surfaces a clear, actionable ERROR
// ("your AI model key isn't set or isn't working — set it in Settings → Models") and
// produces NO answer. The bug this prevents: a model that FAILED to run silently
// degrading to a generic 'general' reply that LOOKS like a real answer. (Local/HIPAA
// keep their friendly setup-guidance 200 — those are self-host onboarding flows whose
// message is itself unambiguous setup text, not a fake answer.)
export async function answerQuestion(
  question: string,
  // `history` (OPTIONAL) carries the recent prior turns of a multi-turn chat. When
  // absent, behavior is byte-for-byte identical to the single-shot path — the
  // conversation block built from it is "" and nothing changes. When present, the
  // recent turns are threaded BEFORE the question into BOTH the router and the
  // generation prompts so a follow-up ("what about Q2?", "summarize that") resolves
  // against the conversation. Retrieval still runs on the current question.
  ctx: { ownerId?: string; role?: string; isDemo?: boolean; history?: Turn[] } = {}
): Promise<AnswerResult> {
  try {
    return await runAnswerPipeline(question, ctx);
  } catch (e) {
    if (isLocalNotConfigured(e)) {
      return localGuidanceResult(question, "not-configured");
    }
    if (isLocalUnreachable(e)) {
      const endpoint = (e as { endpoint?: string }).endpoint;
      return localGuidanceResult(question, "unreachable", endpoint);
    }
    if (isHipaaNotConfigured(e)) {
      return hipaaGuidanceResult(question);
    }
    // CLOUD keyless / rejected-key → do NOT degrade to a 200 'general' answer. Let the
    // typed error PROPAGATE so /api/ask returns a clear "model not configured / key not
    // working" error and produces NO answer (case b: the model FAILED to run, distinct
    // from case a: the model ran but found no docs → a legitimate general answer).
    if (isCloudProviderNotConfigured(e) || isCloudProviderAuth(e)) {
      throw e;
    }
    throw e; // any other error keeps its existing (cloud) handling.
  }
}

async function runAnswerPipeline(
  question: string,
  ctx: { ownerId?: string; role?: string; isDemo?: boolean; history?: Turn[] } = {}
): Promise<AnswerResult> {
  // Telemetry accumulator — real timings + real per-call token usage are gathered
  // as the pipeline runs and assembled into the InspectorTrace at each return point.
  const tel = newTelemetry();
  // MULTI-TURN: the recent-conversation block, built ONCE and threaded into every
  // generation call below. Empty string when there's no history (→ single-shot
  // behavior unchanged). The router gets the raw turns (it builds its own block).
  const convo = buildConversationContext(ctx.history);
  // Whether the uploaded-doc pgvector hybrid lane actually contributed chunks this
  // turn (for the honest retrieval-method label + the trace).
  let usedUploadedDocs = false;
  // The top REAL dense COSINE similarity across the documents lane — the primary
  // signal for the derived confidence (kept on a 0..1 cosine scale, NOT the RRF
  // scale, so the confidence mapping below is unchanged). Null when no documents
  // lane ran.
  let topScore: number | null = null;

  // Workspace-level soft-delete: load the hidden-set ONCE per request so every
  // synchronous retrieval read this turn (vectorSearch, introspectSchema) excludes an
  // admin-deleted bundled doc/table. No-op when Supabase is off / nothing is hidden.
  await refreshDeletedSources();

  // An admin sees ALL uploaded docs → no owner scoping on retrieval.
  const scopeOwner = ctx.role === "admin" ? undefined : ctx.ownerId;
  const isAdmin = ctx.role === "admin";
  // The BUNDLED sample/demo corpus (the bundled sample docs + the contracts/maintenance
  // tables) is shown ONLY to demo accounts. A real client user (ctx.isDemo === false)
  // retrieves nothing from it — their answers come solely from their own uploads.
  // Undefined (a legacy direct caller) keeps the prior behavior (bundled included).
  const includeBundled = ctx.isDemo !== false;
  // The OWNER-ISOLATION scope for the STRUCTURED lane (mirrors scopeOwner for the doc
  // lane): an admin sees every owner's uploaded tables; a member only their own; a
  // legacy direct caller (no ownerId, not admin) keeps the all-tables default. Threaded
  // into answerStructured so the introspect + every guarded SELECT run on exactly the
  // caller's visible tables — one owner can never query another's uploaded spreadsheet.
  const structuredScope: CatalogScope | undefined =
    isAdmin || ctx.ownerId !== undefined
      ? { ownerId: scopeOwner, isAdmin }
      : undefined;
  // 1. ROUTE (real LLM decision) — owner-scoped doc catalog (Phase C). The recent
  // history goes to the router too, so a follow-up like "what about Q2?" routes the
  // resolved intent rather than the bare fragment. isAdmin scopes the structured catalog.
  const routeStart = now();
  const route = await routeQuestion(question, {
    ownerId: scopeOwner,
    history: ctx.history,
    isDemo: includeBundled,
    isAdmin,
  });
  tel.routingMs = now() - routeStart;

  // 2. RETRIEVE
  const retrievalStart = now();
  // STRUCTURED LANE — general text-to-SQL over the live schema. The model picks the
  // relevant table(s) from the introspected catalog and writes a guarded SELECT; the
  // real result rows are the figure, cited to [S:<table>#<rowid>]. No hand-written
  // intents, no per-domain code. A no-match / failed-query lane returns zero rows +
  // an honest note (never a fabricated number).
  const rows: SqlRow[] = [];
  let structuredSql: string | null = null;
  let structuredNote: string | undefined;
  // The cell-tally lane's VERIFIED top-group summary (exact counts), passed to grounded
  // generation as authoritative evidence so the answer names every co-leader with its real count.
  let verifiedTally: string | undefined;
  // Its STRUCTURED form (exact max + full tie), used by the content-fidelity gate below to FAIL a
  // tie-collapsed or non-max-as-max count answer (a wrong count must never get a green check).
  let verifiedTopGroup: VerifiedTopGroup | undefined;
  if (route.sources.includes("structured")) {
    try {
      const structured = await answerStructured(question, includeBundled, structuredScope);
      for (const u of structured.usages) tel.usages.push(u);
      tel.generationMs += 0; // structured-lane LLM time folds into total; phase timer below
      rows.push(...structured.rows);
      structuredSql = structured.sql;
      verifiedTally = structured.verifiedTally;
      verifiedTopGroup = structured.verifiedTopGroup;
      if (!structured.ok || structured.rows.length === 0) structuredNote = structured.note;
    } catch (e) {
      // A MODEL-RUN FAILURE (keyless/bad-key/unreachable backend) must NOT be swallowed
      // into a "structured query failed" note and then masquerade as a 'general' answer —
      // that conflates "the model couldn't run" (case b: a clear, actionable error) with
      // "the model ran but found no data" (case a: a legitimate general answer). Re-throw
      // it so answerQuestion's typed-error handling / the route surfaces the clear
      // "model not configured / key not working" error and produces NO answer.
      if (isModelRunFailure(e)) throw e;
      // Any OTHER structured-lane error (bad SQL, a transient query glitch) never crashes
      // the answer — the doc lane + general fallback still answer. Surface for debugging.
      console.error("structured lane failed:", e instanceof Error ? e.message : e);
      structuredNote = "structured query failed";
    }
  }

  let chunks: DocChunk[] = [];
  if (route.sources.includes("documents")) {
    // MULTI-QUERY RECALL (general). Derive focused retrieval sub-queries from the
    // question so the answer's underlying FACT pages — financial disclosures, judgments,
    // figures, records — are recalled even for an ADVICE/strategy question whose own
    // vocabulary ranks the narrative pages first. The original question is ALWAYS the
    // first query, so behavior for a plain fact-lookup is a strict superset (never worse).
    // Fail-open: any expansion error → just the original question (single-query path).
    const expansion = await expandRetrievalQueries(question, convo).catch(() => ({
      queries: [] as string[],
      usage: { live: false, provider: "—", model: "—" } as ChatUsage,
    }));
    tel.usages.push(expansion.usage);
    // De-dupe (case-insensitive) and ALWAYS lead with the original question so its own
    // ranking dominates the fuse for a direct lookup.
    const seenQ = new Set<string>();
    const retrievalQueries: string[] = [];
    for (const q of [question, ...expansion.queries]) {
      const key = q.trim().toLowerCase();
      if (key && !seenQ.has(key)) {
        seenQ.add(key);
        retrievalQueries.push(q.trim());
      }
    }

    // Embed every retrieval query once (the original first → its embedding drives the
    // confidence signal below). multilingual-e5, same space for EN/HE.
    const embeddings = await Promise.all(retrievalQueries.map((q) => embedQuery(q)));
    const qEmbedding = embeddings[0];

    // BUNDLED corpus (Carter) → IN-PROCESS HYBRID per query: a dense cosine ranking ×
    // a BM25 lexical ranking, fused with RRF (the SAME fusion the uploaded pgvector lane
    // uses). Retrieve across ALL bundled docs (no filter) so corroboration /
    // conflict-surfacing across both companion PDFs works. Each chunk carries its REAL
    // denseRank / bm25Rank / rrfScore for the inspector. We run the hybrid for EACH
    // retrieval query and RRF-fuse the candidate lists (unionByRrf), so a fact page that
    // ranks low for the advice phrasing but high for a "party income" sub-query still
    // survives into the candidate set. GENERAL — no hardcoded pages/queries/facts.
    const bundledLists = includeBundled
      ? embeddings.map((emb, i) => hybridVectorSearch(emb, retrievalQueries[i], 24))
      : [];
    const bundled = unionByRrf(bundledLists);
    // Confidence keys off the top REAL dense COSINE similarity (0..1 scale) from the
    // ORIGINAL-question list, not the RRF scale — so the existing confidence mapping is
    // unchanged. We recompute the best cosine from the bundled candidates the dense lane
    // ranked #1 for the original question.
    const bundledTopCosine = topCosineOfRank1(bundledLists[0] ?? []);
    if (bundledTopCosine !== null) topScore = bundledTopCosine;

    // UPLOADED docs → Supabase pgvector HYBRID (dense × BM25 → RRF), owner-scoped for
    // per-user isolation (RLS + the RPC's owner filter). Returns the same DocChunk
    // shape with REAL dense/BM25/RRF ranks, so it merges 1:1 with the bundled hybrid
    // chunks and a single answer can cite both corpora. Run per retrieval query and
    // RRF-fuse too, so an uploaded doc's fact pages are recalled for an advice query
    // exactly like the bundled ones. FAIL-OPEN: hybridSearch returns [] on any failure
    // (logged) — never throws into the answer pipeline.
    let uploadedFused: DocChunk[] = [];
    if (supabaseEnabled()) {
      const uploadedLists = await Promise.all(
        embeddings.map((emb, i) =>
          hybridSearch(scopeOwner, ctx.role === "admin", emb, retrievalQueries[i], 12)
        )
      );
      uploadedFused = unionByRrf(uploadedLists);
      if (uploadedFused.length > 0) usedUploadedDocs = true;
    }
    const merged = unionByRrf([bundled, uploadedFused]);
    // The final context cap. A wide cap (14) + a per-doc cap of 6 give the multi-query
    // recall enough headroom that each represented document's FACT pages survive
    // alongside its narrative pages (a doc whose top fused chunks are narrative still has
    // room to also contribute its lower-ranked-but-recalled financial/judgment pages),
    // while no single doc monopolizes the prompt. Both are GENERAL knobs (no doc, page,
    // or figure is named); content-dedup inside collapses a re-uploaded copy so it can't
    // consume two slots. Extra narrative context never hurts — the grounding gate keys
    // off whether the answer's cited facts resolve, not the chunk count.
    chunks = diversifyByDoc(merged, 14, 6);

    // ── ENUMERATION / SUMMARY WHOLE-DOC RECALL BOOST (the MENDA incomplete-retrieval fix) ──────
    // The live RED: "how many options does the MENDA memo have and which is preferred?" retrieved
    // ONLY the document's first chunk (it ranked #1) and missed the later chunks that hold options
    // 2–4 and the "preferred" conclusion — so the answer said "4 options, but the rest aren't in the
    // excerpts and the preferred isn't stated." For an ENUMERATION / SUMMARY question that
    // concentrates on ONE document (the retrieved doc chunks are dominated by a single doc), hybrid
    // ranking surfacing one chunk is not enough — we need the WHOLE document so the answer can
    // enumerate the full list AND reach the conclusion. We fetch that doc's full chunk set (capped)
    // and RRF-merge it in, then re-diversify. GENERAL — keyed off the question being an enumeration/
    // summary + ONE doc dominating retrieval, never a doc name, count, or the corpus.
    if (isEnumerationOrSummaryQuestion(question) && chunks.length > 0) {
      // The doc that dominates the retrieved chunks is the enumeration/summary subject.
      const docCounts = new Map<string, number>();
      for (const c of chunks) docCounts.set(c.doc, (docCounts.get(c.doc) ?? 0) + 1);
      const [topDoc, topCount] = [...docCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      // Only boost when ONE doc clearly dominates (it is THE subject), so a genuinely cross-doc
      // summary isn't hijacked into one document.
      if (topDoc && topCount >= 1 && docCounts.size <= 4) {
        const bundledWhole = includeBundled ? fetchBundledDocChunks(topDoc, 12) : [];
        const uploadedWhole = supabaseEnabled()
          ? await fetchDocChunksByDoc(scopeOwner, ctx.role === "admin", topDoc, 12).catch(() => [])
          : [];
        const whole = [...bundledWhole, ...uploadedWhole];
        if (whole.length > 0) {
          // APPEND the whole-doc chunks to the already-ranked set and re-diversify with a HIGHER
          // per-doc cap, so the subject document contributes its FULL enumeration while other docs
          // keep a slice. We deliberately do NOT RRF-fuse here: RRF keys by (doc,page), and a short
          // single-page document (a .docx / a one-page memo) has MANY chunks on the SAME page — fusing
          // by (doc,page) would collapse them all into one and re-create the very incomplete-retrieval
          // bug we are fixing. diversifyByDoc dedups by CONTENT (not page) and caps per doc, so it
          // keeps each DISTINCT chunk of the page. The already-retrieved chunks lead (highest RRF), the
          // whole-doc chunks fill in the rest of that doc's enumeration. The cap rises only for this
          // enumeration/summary turn. GENERAL — any multi-chunk document benefits.
          chunks = diversifyByDoc([...chunks, ...whole], 18, 12);
          if (uploadedWhole.length > 0) usedUploadedDocs = true;
        }
      }
    }
  }
  tel.retrievalMs = now() - retrievalStart;

  // 3. Build evidence with citation tokens. The evidence carries the underlying
  // values (row data, page text) so the claim-support cross-check in validateAnswer
  // can confirm a cited number is actually backed by what it points at. Each doc
  // chunk keeps its REAL retrieval score so the Inspector's retrieval table shows true
  // per-passage scores.
  //
  // With text-to-SQL, an AGGREGATE answer (e.g. "SELECT COUNT(*), SUM(annual_cost)")
  // returns a real result ROW whose values ARE the count and total — so a cited figure
  // is backed by an actual retrieved row, with no special "verified aggregate" side
  // channel. We additionally collect every numeric value across the returned rows as
  // aggregates so a figure the model restates from one row, cited to a sibling row of
  // the SAME result set, still cross-checks (general, not domain-specific).
  const evRows = rows.map((r) => ({ ...r, token: sqlToken(r.table, r.id) }));
  const evChunks = chunks.map((c) => ({ ...c, token: pdfToken(c.doc, c.page) }));
  const aggregates = collectRowNumbers(rows);
  const evidence: Evidence = {
    rows: evRows.map((r) => ({ table: r.table, id: r.id, data: r.data })),
    chunks: evChunks.map((c) => ({ doc: c.doc, page: c.page, text: c.text })),
    aggregates,
  };
  // The result-shaped evidence (with citation tokens + real scores) the UI renders.
  // Built ONCE so the general-knowledge fallbacks can STILL show the documents that
  // were retrieved instead of dropping them. Retrieval is retrieval — what the search
  // found is always surfaced in the Inspector, regardless of what the model wrote.
  const retrievedEvidence = {
    rows: evRows.map((r) => ({ table: r.table, id: r.id, token: r.token, data: r.data })),
    chunks: evChunks.map((c) => ({
      doc: c.doc,
      page: c.page,
      token: c.token,
      text: c.text,
      score: c.score,
      // The REAL hybrid breakdown the inspector renders (dense / BM25 / RRF ranks).
      denseRank: c.denseRank,
      bm25Rank: c.bm25Rank,
      rrfScore: c.rrfScore,
    })),
  };

  // (The self-hosted pgvector hybrid lane is FAIL-OPEN — hybridSearch returns [] on
  // any failure and never throws — so there is no honest "couldn't search your
  // uploaded documents" error to surface here as the Gemini File Search lane once
  // required. A Supabase outage simply yields no uploaded chunks; the bundled hybrid
  // + structured lanes still answer, and the general-knowledge fallback below covers
  // the no-evidence case.)

  // ── NO-EVIDENCE FALLBACK ──────────────────────────────────────────────────
  // Did retrieval actually find anything the user can be answered FROM? Evidence
  // exists when we got structured rows OR document chunks.
  //
  // There are TWO very different ways to reach "no evidence", and they must NOT be
  // answered the same way:
  //
  //  (1) The ROUTER matched NO source (route.sources is empty) — a greeting, small
  //      talk, or a pure general-knowledge question ("What is Arizona divorce law?").
  //      The router judged that NONE of the user's documents/data are relevant. Here a
  //      helpful general-knowledge answer is exactly right (the client asked us to SOFTEN
  //      the old blanket "not in the data" refusal for such questions).
  //
  //  (2) The router DID route to the user's OWN content (structured and/or documents)
  //      but retrieval came back EMPTY — e.g. text-to-SQL could not turn her messy
  //      calendar-grid scheduling sheet into a working aggregate, so it returned zero
  //      rows. This is the recorded TRUST-KILLER: the question is about HER uploaded
  //      file, yet an ungrounded general answer DENIES the file exists or FABRICATES a
  //      world-knowledge answer (the logged "I don't have access to live data about who's
  //      scheduled in August" over a file that literally lists her August schedule). A
  //      question routed to the caller's OWN data must NEVER be answered in ungrounded
  //      `general` mode. So we send it to the HONEST path (generateHonestNotInDocs) —
  //      which, even with empty evidence, gives an honest grounded-limit answer ("I have
  //      your file but it doesn't contain that specific information") and NEVER fabricates
  //      a file fact. This is the hard guarantee: no ungrounded answer over her own data.
  //
  // GENERAL — keyed only off "the router routed to a source", never the question's domain,
  // language, or any case fact. A genuinely general-knowledge question routes to NO source
  // (case 1) and still answers from general knowledge.
  const hasEvidence = evRows.length > 0 || evChunks.length > 0;
  if (!hasEvidence) {
    const persona = await getSetting("system_prompt");
    // CASE 2 — routed to the caller's OWN content but nothing was retrieved: NEVER answer
    // ungrounded. Give an honest "I have your file, but it doesn't contain that specific
    // thing" with no fabrication. (We pass the empty evidence sets; generateHonestNotInDocs
    // is built to handle "no rows / no chunks retrieved" and answer honestly.)
    if (route.sources.length > 0) {
      const honestStart = now();
      const { text: honestAnswer, usage } = await generateHonestNotInDocs(
        question,
        evRows,
        evChunks,
        TODAY,
        persona,
        convo
      );
      tel.generationMs += now() - honestStart;
      tel.usages.push(usage);
      // With no retrieved evidence the honest reply carries no resolvable citation, so it is
      // correctly non-grounded — but it is HONEST about her file, never a fabrication.
      const honestGrounded = honestAnswerIsGrounded(honestAnswer, evidence);
      return {
        question,
        route,
        answer: honestAnswer,
        mode: honestGrounded ? "grounded" : "general",
        grounded: honestGrounded,
        evidence: retrievedEvidence,
        validation: { ok: true, reasons: [] },
        inspector: buildInspector({
          tel,
          route,
          rowCount: evRows.length,
          chunkCount: evChunks.length,
          usedUploadedDocs,
          mode: honestGrounded ? "grounded" : "general",
          validationOk: true,
          validationReasons: [],
          topScore,
        }),
      };
    }
    // CASE 1 — the router matched NO source: a greeting / pure general-knowledge question.
    // Answer helpfully from general knowledge (no citations to validate).
    const genStart = now();
    const { text: answer, usage } = await generateGeneral(question, persona, TODAY, convo);
    tel.generationMs += now() - genStart;
    tel.usages.push(usage);
    // No citation/grounding validation on this path: a general answer legitimately
    // has no [S:...]/[P:...] tokens, so validateAnswer would wrongly reject it.
    return {
      question,
      route,
      answer,
      mode: "general",
      grounded: false,
      evidence: { rows: [], chunks: [] },
      validation: { ok: true, reasons: [] },
      inspector: buildInspector({
        tel,
        route,
        rowCount: 0,
        chunkCount: 0,
        usedUploadedDocs,
        mode: "general",
        validationOk: true,
        validationReasons: [],
        topScore,
      }),
    };
  }

  // 4. GROUNDED GENERATION
  // The admin-editable answering style (Prompt-config panel). A blank/absent
  // override falls back to the built-in default — see settings.ts.
  const stylePreamble = await getSetting("system_prompt");
  const genStart = now();
  const grounded = await generateGrounded(
    question,
    evRows,
    evChunks,
    structuredNote,
    TODAY,
    stylePreamble,
    convo,
    verifiedTally
  );
  tel.generationMs += now() - genStart;
  tel.usages.push(grounded.usage);

  // 4a. THE MODEL'S OWN GROUNDED-VS-GENERAL DECISION. The grounded prompt instructs
  // the model to BEGIN its reply with exactly one flag line — `SOURCE: documents`
  // (it answered from the retrieved evidence, with citations) or `SOURCE: general`
  // (the retrieved evidence does NOT contain the answer, so it can't ground it). We
  // parse that flag, STRIP it from the user-visible answer, and ROUTE on the model's
  // decision — no regex guessing at the prose. If the model omits the flag we default
  // to `documents` so a real grounded answer is never lost.
  const { flag, text: strippedAnswer } = parseSourceFlag(grounded.text);
  let answer = strippedAnswer;

  // A STRUCTURED turn that returned real rows is, by construction, grounded: the
  // result rows ARE the answer (a count/total/top-N is a real row the model cites).
  // A modest model can still mis-flag `general` on such a turn (e.g. reading an
  // aggregate row as "conversational"), which would DROP a real, citable figure. So
  // a structured-with-rows turn is never flipped to general on the flag alone. (A
  // document-only turn keeps relying on the model's flag + the rescue below.) This is
  // GENERAL — it keys off "the SQL lane returned rows", not any specific table.
  const structuredGrounded = evRows.length > 0;
  let effectiveFlag = structuredGrounded ? "documents" : flag;

  // ── DETERMINISTIC GROUNDED RESCUE OF A `general` FLAG (the advice-question fix) ──
  // A modest model flags `general` not only when the evidence is off-topic but also when
  // the evidence holds the FACTS an answer must be built on yet does not contain a ready-
  // made answer — e.g. an ADVICE/strategy question ("how do I argue for less support?")
  // whose retrieved pages carry the parties' incomes, the support order, the custody
  // terms. Punting that to generic general-knowledge is exactly the reported MVP miss:
  // generic boilerplate where the file held the real figures. And the model's flag for
  // such a question is a COIN FLIP run-to-run — so we cannot leave the decision to it.
  //
  // KEY INSIGHT (why this is reliable AND general, not tuning): the question already
  // ROUTED to "documents" (the router judged documents relevant to THIS question) AND
  // hybrid retrieval returned on-topic chunks. Relevance is therefore already established
  // upstream — a genuinely off-topic question routes to an EMPTY source and produces NO
  // chunks (so it never reaches here; it goes to the honest general/IDK path). So when the
  // model nonetheless flagged `general` while document chunks ARE present, we do NOT defer
  // to a second flaky classifier: we directly FORCE an evidence-first grounded answer and
  // adopt it iff it passes the (now relaxed, fabrication-only) citation-fidelity gate AND
  // actually cites the evidence (proving it grounded in the real pages, not memory).
  //
  // ONE regenerate, not a retry storm: with the citation gate relaxed to fail only genuine
  // fabrication, the forced grounded pass is accepted on its FIRST try in nearly every
  // case (a placement/derivation slip no longer rejects it). So a SINGLE forced pass
  // replaces the old up-to-5 loop. GENERAL — keyed only off "routed to documents AND
  // retrieved on-topic chunks", never the question's domain or any case fact. The
  // cite-or-don't-adopt guard means an answer that can't actually be grounded still falls
  // through to the honest general path.
  if (effectiveFlag === "general" && !structuredGrounded && evChunks.length > 0) {
    const forcedStart = now();
    const forced = await generateGroundedForced(question, evRows, evChunks, TODAY, stylePreamble, convo, 0);
    tel.generationMs += now() - forcedStart;
    tel.usages.push(forced.usage);
    const forcedAnswer = parseSourceFlag(forced.text).text;
    if (validateAnswer(forcedAnswer, evidence).ok && extractCitationTokens(forcedAnswer).length > 0) {
      answer = forcedAnswer;
      effectiveFlag = "documents"; // fall through to the grounded return path below
    } else {
      // Minimal salvage (rule-1 only now): strip a genuinely-unresolvable citation token
      // and adopt iff then clean AND still cites ≥1 real evidence token, rather than
      // punting a real grounded answer over one bad token. GENERAL — keyed off the
      // validator's flagged tokens, no domain logic.
      const salvaged = salvageGroundedAnswer(forcedAnswer, evidence);
      if (salvaged) {
        answer = salvaged.text;
        effectiveFlag = "documents";
      }
    }
  }

  if (effectiveFlag === "general") {
    // The model decided the retrieved evidence doesn't contain a ready answer. CRUCIAL:
    // on-topic evidence WAS retrieved (we are past the no-evidence early return), and the
    // router judged THIS question relevant to the user's OWN documents/data. So we must NOT
    // punt to free general-knowledge here — that is exactly what fabricated a "most-scheduled"
    // name or denied the user's file ("you didn't upload a file"). Instead generate an HONEST
    // answer that is GIVEN the retrieved evidence: it grounds if the evidence does answer the
    // question, says honestly "that specific thing isn't in your file (here's what is)" if it
    // doesn't, answers a genuinely general-knowledge question from general knowledge, and
    // NEVER fabricates a file-specific fact or denies the file exists. GENERAL — keyed only off
    // "evidence was retrieved but the model couldn't ground a direct answer".
    const g2Start = now();
    const { text: honestAnswer, usage } = await generateHonestNotInDocs(
      question,
      evRows,
      evChunks,
      TODAY,
      stylePreamble,
      convo
    );
    tel.generationMs += now() - g2Start;
    tel.usages.push(usage);
    // The honest answer may legitimately cite the evidence (it found the answer / a grounded
    // summary) or carry no citation (an honest "not in your file" / a general-knowledge reply).
    // GROUNDED iff it cites ≥1 token that RESOLVES to retrieved evidence — i.e. it really
    // anchored in the user's file. We use resolvability (rule 1), NOT the full fabrication
    // gate, deliberately: a grounded SUMMARY over the file legitimately restates descriptive
    // figures (a position count, a phone) beside a page cite, and demoting it to "general"
    // over the strict figure check is exactly the over-strictness this work removed. A genuine
    // fabrication is still caught upstream (the forced grounded pass ran the full gate); here
    // the honest path is constrained to the evidence and never invents file facts.
    const honestGrounded = honestAnswerIsGrounded(honestAnswer, evidence);
    return {
      question,
      route,
      answer: honestAnswer,
      mode: honestGrounded ? "grounded" : "general",
      grounded: honestGrounded,
      // PRESERVE the retrieved docs — retrieval is retrieval; the Inspector still shows what
      // the search found. (Never return empty evidence on this path.)
      evidence: retrievedEvidence,
      validation: { ok: true, reasons: [] },
      inspector: buildInspector({
        tel,
        route,
        rowCount: evRows.length,
        chunkCount: evChunks.length,
        usedUploadedDocs,
        mode: honestGrounded ? "grounded" : "general",
        validationOk: true,
        validationReasons: [],
        topScore,
      }),
    };
  }

  // 5. VALIDATE — the general content-fidelity gate (citation fidelity only). Every
  // cited [S:table#row]/[P:doc#page] token must resolve to retrieved evidence, and a
  // cited number must actually appear in the row/page it points at (or in the result
  // set's aggregates). There are NO per-feature gates — the structured figure is a
  // real query result, validated like any other cited number. Extracted so the
  // grounded RESCUE below can re-validate a regenerated answer the same way.
  const runGates = (text: string): string[] => validateAnswer(text, evidence).reasons;
  let reasons = runGates(answer);
  let validationOk = reasons.length === 0;

  // ── PRE-RESCUE SALVAGE (the cheapest, most reliable fix) ──────────────────────────
  // The FIRST grounded answer commonly already states the real figures and cites real
  // evidence pages — it just pinned ONE stray citation to a derived number or a sibling
  // page. That single bad token failed the all-or-nothing gate and (before this) sent the
  // whole answer into the slow, flaky forced-regeneration loop or, worse, on to a generic
  // punt. Salvage it directly: strip ONLY the flagged tokens, re-validate, and adopt iff
  // then clean AND still cites ≥1 real evidence token. This is the dominant adoption fix —
  // it keeps a real grounded answer instead of regenerating/punting over one bad citation.
  // GENERAL: keyed solely off the validator's flagged tokens (no question/domain/fact).
  if (!validationOk && (evRows.length > 0 || evChunks.length > 0)) {
    const salvaged = salvageGroundedAnswer(answer, evidence);
    if (salvaged) {
      answer = salvaged.text;
      reasons = [];
      validationOk = true;
    }
  }

  // A `documents`-flagged answer that cites NOTHING while document chunks WERE retrieved
  // is not actually grounded — it is generic boilerplate the model wrote without using
  // the evidence (the advice-question failure mode). Treat it like a gate failure so the
  // deterministic forced rescue below regenerates a properly-cited, evidence-anchored
  // answer. GENERAL — keyed only off "we have document chunks but the answer cited none".
  const uncitedOverDocs =
    validationOk && evChunks.length > 0 && extractCitationTokens(answer).length === 0;
  if (uncitedOverDocs) validationOk = false;

  // ── GROUNDED RESCUE (the SOURCE-flag complement) ──────────────────────────
  // The model flagged `documents` but its grounded answer FAILED the (now relaxed)
  // citation-fidelity gate, OR was uncited over retrieved docs — i.e. it wrote generic
  // boilerplate from prior knowledge instead of grounding in the retrieved pages. Rather
  // than dump that to a generic general answer (dropping the real, citable facts), we
  // RESCUE with ONE forced evidence-first regenerate and re-run the gate; adopt it iff it
  // passes AND cites the evidence. Relevance is already established (the question routed to
  // documents AND on-topic chunks were retrieved — an off-topic question routes to an empty
  // source and reaches here with NO chunks). With the gate relaxed to fabrication-only, a
  // single forced pass is accepted nearly always — so this is ONE regenerate, not the old
  // up-to-5 loop. GENERAL — keyed only off "routed to documents + retrieved chunks"; the
  // cite-or-don't-adopt guard means a genuinely ungroundable answer still falls through.
  if (!validationOk && !structuredGrounded && (evRows.length > 0 || evChunks.length > 0)) {
    const forcedStart = now();
    const forced = await generateGroundedForced(question, evRows, evChunks, TODAY, stylePreamble, convo, 0);
    tel.generationMs += now() - forcedStart;
    tel.usages.push(forced.usage);
    const forcedAnswer = parseSourceFlag(forced.text).text; // tolerate a stray flag line
    const forcedReasons = runGates(forcedAnswer);
    if (forcedReasons.length === 0 && extractCitationTokens(forcedAnswer).length > 0) {
      answer = forcedAnswer;
      reasons = forcedReasons;
      validationOk = true;
    } else {
      // Minimal salvage (rule-1 only): strip a genuinely-unresolvable token, adopt iff
      // then clean AND still cites ≥1 real evidence token — rather than punting a real
      // grounded answer over one bad token.
      const salvaged = salvageGroundedAnswer(forcedAnswer, evidence);
      if (salvaged) {
        answer = salvaged.text;
        reasons = [];
        validationOk = true;
      }
    }
  }

  // ── SECONDARY SAFETY NET: validation REJECTION → general ──────────────────
  // The MODEL already decided documents-vs-general above (the SOURCE flag); this is a
  // narrow secondary net for the case where the model flagged `documents` but its
  // grounded answer FAILED the citation-fidelity gate (a bad/unresolvable citation, or
  // a refusal carrying no real grounded content). Surfacing a rejected grounded answer
  // shows the user a red error, so we re-answer via the general path instead — while
  // PRESERVING the retrieved evidence. The HARD EXCEPTION inside shouldFallbackToGeneral
  // keeps every validation-PASSING grounded reply (a real cited structured or document
  // answer) grounded and untouched. A structured-with-rows turn is never flipped (its
  // result rows ARE the grounded answer).
  const hasVerifiedAggregate = aggregates.length > 0;
  if (
    !structuredGrounded &&
    shouldFallbackToGeneral({ answer, validationOk, hasVerifiedAggregate })
  ) {
    // On-topic evidence WAS retrieved (this path runs only with rows/chunks present) but the
    // grounded answer failed the gate / read as an empty refusal. Same general fix as the
    // `effectiveFlag === "general"` branch: do NOT punt to free general-knowledge (which would
    // fabricate or deny the user's file) — generate an HONEST answer that is GIVEN the
    // retrieved evidence (grounds if it can, honestly says "not in your file — here's what is"
    // otherwise, answers a genuinely general question from general knowledge, never fabricates).
    const g3Start = now();
    const { text: honestAnswer, usage } = await generateHonestNotInDocs(
      question,
      evRows,
      evChunks,
      TODAY,
      stylePreamble,
      convo
    );
    tel.generationMs += now() - g3Start;
    tel.usages.push(usage);
    const honestGrounded = honestAnswerIsGrounded(honestAnswer, evidence);
    return {
      question,
      route,
      answer: honestAnswer,
      mode: honestGrounded ? "grounded" : "general",
      grounded: honestGrounded,
      // PRESERVE the retrieved docs (same reason as above) — the Inspector shows what the
      // search found even when the answer falls back to an honest non-grounded reply.
      evidence: retrievedEvidence,
      validation: { ok: true, reasons: [] },
      inspector: buildInspector({
        tel,
        route,
        rowCount: evRows.length,
        chunkCount: evChunks.length,
        usedUploadedDocs,
        mode: honestGrounded ? "grounded" : "general",
        validationOk: true,
        validationReasons: [],
        topScore,
      }),
    };
  }

  // ── CELL-TALLY CONTENT-FIDELITY GATE (the count-regression fix) ───────────────────
  // The general gate above only checks CITATION fidelity, so a COUNT answer that collapses a tie
  // (crowns one leader, demotes the co-leaders) or reports a NON-MAX as the max passes it — the
  // wrong number is itself a real evidence value. That is the dangerous green-check the live
  // regression exposed. When the answer came from the cell-tally lane (verifiedTopGroup present),
  // we additionally require the restatement to be FAITHFUL to the code-computed tally: it must
  // state the verified MAX count and name EVERY tied leader. If it isn't, we regenerate ONCE with
  // the verified tally re-emphasized; if it STILL isn't faithful, we FAIL the gate so the user
  // sees the honest warning instead of a confidently-wrong count with a green check.
  if (verifiedTopGroup && verifiedTally) {
    let tallyReasons = validateCellTallyAnswer(answer, verifiedTopGroup).reasons;
    if (tallyReasons.length > 0) {
      const regenStart = now();
      const regen = await generateGrounded(
        question,
        evRows,
        evChunks,
        structuredNote,
        TODAY,
        stylePreamble,
        convo,
        verifiedTally
      );
      tel.generationMs += now() - regenStart;
      tel.usages.push(regen.usage);
      const regenAnswer = parseSourceFlag(regen.text).text;
      const regenTallyReasons = validateCellTallyAnswer(regenAnswer, verifiedTopGroup).reasons;
      // Adopt the regenerated answer iff it is now tally-faithful AND still citation-clean.
      if (regenTallyReasons.length === 0 && validateAnswer(regenAnswer, evidence).ok) {
        answer = regenAnswer;
        tallyReasons = [];
        reasons = [];
        validationOk = true;
      } else {
        // Still unfaithful → do NOT show a green check on a wrong/collapsed count. Surface the
        // fidelity failure so the answer is flagged (red banner) rather than trusted.
        reasons = [...reasons, ...regenTallyReasons];
        validationOk = false;
      }
    }
  }

  return {
    question,
    route,
    answer,
    mode: "grounded",
    grounded: true,
    evidence: {
      rows: evRows.map((r) => ({ table: r.table, id: r.id, token: r.token, data: r.data })),
      chunks: evChunks.map((c) => ({
        doc: c.doc,
        page: c.page,
        token: c.token,
        text: c.text,
        score: c.score,
        // The REAL hybrid breakdown the inspector renders (dense / BM25 / RRF ranks).
        denseRank: c.denseRank,
        bm25Rank: c.bm25Rank,
        rrfScore: c.rrfScore,
      })),
    },
    validation: { ok: validationOk, reasons },
    inspector: buildInspector({
      tel,
      route,
      rowCount: evRows.length,
      chunkCount: evChunks.length,
      usedUploadedDocs,
      mode: "grounded",
      validationOk,
      validationReasons: reasons,
      topScore,
      structuredSql,
    }),
  };
}

// ── SOURCE FLAG PARSING (the model's own grounded-vs-general decision) ───────────
// The grounded model is instructed to BEGIN its reply with exactly one flag line:
//   SOURCE: documents  — it answered from the retrieved evidence (with citations)
//   SOURCE: general    — the retrieved evidence does NOT contain the answer
// We parse that first line and STRIP it so the user never sees the raw flag, then
// route on the model's decision. Robust to leading blank lines and to the model
// wrapping the flag in markdown emphasis (e.g. **SOURCE: general**). If no flag is
// present we default to `documents` — never lose a real grounded answer.
//
// Pure + exported so the parse/strip contract is unit-tested without an LLM.
export function parseSourceFlag(raw: string): {
  flag: "documents" | "general";
  text: string;
} {
  const lines = raw.split("\n");
  // Skip leading blank lines to find the first non-empty line (the flag line).
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const firstLine = i < lines.length ? lines[i] : "";
  // Tolerate surrounding markdown/punctuation: **SOURCE: general**, `SOURCE: general`,
  // "Source: Documents.", etc. Anchored to the start of the (trimmed) first line.
  const m = firstLine
    .trim()
    .replace(/^[*`_#>\s-]+/, "")
    .match(/^source\s*:\s*(documents|general)\b/i);
  if (!m) {
    // No recognizable flag → keep the whole answer, default to documents.
    return { flag: "documents", text: raw.trim() };
  }
  const flag = m[1].toLowerCase() === "general" ? "general" : "documents";
  // Drop the flag line (line i) and any blank lines that immediately followed it,
  // then keep the rest of the answer verbatim.
  const rest = lines.slice(i + 1);
  while (rest.length > 0 && rest[0].trim() === "") rest.shift();
  return { flag, text: rest.join("\n").trim() };
}

// A refusal/non-answer detector used ONLY by the secondary validation-rejection net
// below (shouldFallbackToGeneral). The model's SOURCE flag is the PRIMARY decision;
// this regex no longer routes grounded-vs-general on its own.
const REFUSAL_RE =
  /\b(not (present|available|found|stated|provided|included|specified|mentioned|contained)|are not available|is not available|isn't available|aren't available|do(es)? not (contain|include|provide|state|mention)|don't (contain|include|provide)|no (matching|relevant|such) (data|records?|information|documents?|evidence)|cannot (find|answer)|can't (find|answer)|could not find|couldn't find|unable to (find|answer))\b/i;

// A BROADER refusal/non-answer detector than REFUSAL_RE above — it ALSO matches the
// phrasing the grounded model uses when it declines a question whose answer the
// retrieved evidence doesn't hold even though it pinned a citation while declining
// (e.g. "I cannot answer this question because the evidence does not contain any
// information about <unrelated topic> … not stated in the document [P:<doc>#…]").
// This is the gap the original isUncitedRefusal missed: that refusal CITES docs, so
// the citation guard let it through and the user saw a refusal (often a red error
// when a per-feature gate rejected the cited-but-refusing answer).
//
// Patterns taken from the spec (conservative — these are explicit non-answers, not
// hedges): "I cannot answer", "evidence does not contain", "does/do not contain",
// "none of these sources", "not stated in", "not available in (the) data/documents/
// case file", "no information about/on", "don't/do not have … information".
const REFUSAL_TEXT_RE =
  /cannot answer|can'?t answer|evidence does not contain|do(es)? not contain|none of these sources|not stated in|not available in (the )?(data|documents?|case file)|no information (about|on)|do(n'?t| not) have .{0,40}information/i;

// Does this grounded answer provide REAL grounded content, or is it effectively just
// a refusal? "Real grounded content" = a sentence that asserts a fact (a number, a
// currency figure, a quantified claim) that is NOT itself a not-found disclaimer. A
// schema-aware honest refusal that still reports a real figure (e.g. "the data has no
// payment-status field; total spend is $X across N rows") qualifies as real content —
// it states a figure-bearing sentence — so it is NOT treated as an empty refusal. A
// pure "I cannot answer … not in the documents" has no such substantive figure-bearing
// sentence → returns false. General — no domain knowledge.
const GROUNDED_FIGURE_RE = /\$[\d,]+(?:\.\d+)?|\b\d{2,}\b/;
function hasUsefulGroundedContent(answer: string): boolean {
  const sentences = answer.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (REFUSAL_TEXT_RE.test(s) || REFUSAL_RE.test(s)) continue; // a disclaimer sentence is not "content"
    if (GROUNDED_FIGURE_RE.test(s)) return true; // a substantive figure-bearing sentence
  }
  return false;
}

// The grounded→general fallback decision. Re-answer from general knowledge instead of
// surfacing a refusal/rejected grounded answer when EITHER:
//   • validateAnswer (citation fidelity) REJECTED the grounded answer, OR
//   • the answer reads as a genuine refusal/non-answer AND carries no real grounded
//     content — even if it pinned a citation while refusing.
// HARD EXCEPTION (protect every real grounded reply): if validation PASSED and the
// answer carries citation tokens OR a verified figure from the result rows, it is a
// VALID grounded answer → keep it grounded. So we key primarily off validation
// REJECTION (+ genuine refusal text with no useful grounded content), never off
// refusal wording alone. (Note: a structured-with-rows turn never reaches this — its
// result rows ARE the grounded answer; see the caller's structuredGrounded guard.)
//
// Pure + exported so the branching is unit-tested deterministically without an LLM:
// pass the crafted answer string, the validation outcome, and the figure-present flag.
export function shouldFallbackToGeneral(s: {
  answer: string;
  validationOk: boolean;
  hasVerifiedAggregate: boolean;
}): boolean {
  const cited = extractCitationTokens(s.answer).length > 0;
  // HARD EXCEPTION: a validation-PASSING answer that carries citations or a verified
  // figure from the result rows is a real grounded answer — never fall back.
  if (s.validationOk && (cited || s.hasVerifiedAggregate)) return false;

  // Signal A — validation rejected the grounded answer (a bad/unresolvable citation,
  // or a refusal that failed the citation gate) → general instead of a red error.
  if (!s.validationOk) return true;

  // Signal B — validation passed but the answer is a genuine refusal/non-answer with
  // no real grounded content (a refusal that pinned a citation but said nothing
  // substantive). Conservative: requires refusal TEXT *and* the absence of any
  // useful figure-bearing sentence.
  const reads_as_refusal = REFUSAL_TEXT_RE.test(s.answer) || REFUSAL_RE.test(s.answer);
  if (reads_as_refusal && !hasUsefulGroundedContent(s.answer)) return true;

  return false;
}

// ── INSPECTOR TELEMETRY (all reconstructed from REAL pipeline state) ────────────

// A tiny mutable accumulator threaded through the pipeline. Generation calls push
// their real ChatUsage; phase timers write their measured ms. Built into the public
// InspectorTrace by `buildInspector` at whichever return point the pipeline takes.
type Telemetry = {
  usages: ChatUsage[];
  routingMs: number;
  retrievalMs: number;
  generationMs: number;
  startedAt: number;
};

function newTelemetry(): Telemetry {
  return { usages: [], routingMs: 0, retrievalMs: 0, generationMs: 0, startedAt: now() };
}

function now(): number {
  // performance.now() is monotonic; fall back to Date.now() if unavailable.
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

// Per-MODEL real pricing (USD per 1K tokens), keyed by a substring of the model id.
// ONLY models we can price honestly are here; anything else → usd:null + a note.
// (DeepSeek published cache-miss pricing; Gemini Flash published input/output.)
const PRICING: { match: string; inPer1k: number; outPer1k: number; label: string }[] = [
  { match: "deepseek-chat", inPer1k: 0.00027, outPer1k: 0.0011, label: "deepseek-chat" },
  { match: "gemini-2.5-flash-lite", inPer1k: 0.0001, outPer1k: 0.0004, label: "gemini-2.5-flash-lite" },
  { match: "gemini-2.5-flash", inPer1k: 0.0003, outPer1k: 0.0025, label: "gemini-2.5-flash" },
];

// Aggregate the REAL usage across this turn's live LLM calls into a cost report.
// Honest by construction: tokens are summed only from calls that reported them; the
// USD figure is computed from real per-token pricing when the model is known,
// otherwise null with an explanatory note (never a guessed dollar amount).
function buildCost(usages: ChatUsage[]): CostReport {
  const live = usages.filter((u) => u.live);
  const liveCalls = live.length;
  const provider = live[0]?.provider ?? "—";
  const model = live[0]?.model ?? "—";

  const reported = live.filter((u) => typeof u.promptTokens === "number");
  const promptTokens = reported.length
    ? reported.reduce((s, u) => s + (u.promptTokens ?? 0), 0)
    : undefined;
  const completionTokens = reported.length
    ? reported.reduce((s, u) => s + (u.completionTokens ?? 0), 0)
    : undefined;

  const price = PRICING.find((p) => model.includes(p.match));
  let usd: number | null = null;
  let pricingNote: string;
  if (liveCalls === 0) {
    pricingNote = "No live LLM call this turn.";
  } else if (promptTokens === undefined) {
    pricingNote = `Provider “${provider}” did not report token usage — tokens shown as n/a.`;
  } else if (!price) {
    pricingNote = `Token pricing not tracked for “${model}”. Embeddings run locally (no API cost).`;
  } else {
    usd =
      (promptTokens / 1000) * price.inPer1k +
      ((completionTokens ?? 0) / 1000) * price.outPer1k;
    pricingNote = `Priced at ${price.label} rates. Embeddings run locally (no API cost).`;
  }

  return { liveCalls, promptTokens, completionTokens, usd, pricingNote, provider, model };
}

// The HONEST retrieval-method label — describes the lane(s) that ACTUALLY ran this
// turn. The document lane is now an HONEST HYBRID: a dense cosine ranking × a BM25
// lexical ranking, fused with Reciprocal Rank Fusion (RRF) — run in-process over the
// bundled corpus AND in Supabase pgvector over the uploaded corpus (same fusion). We
// print only what ran. This label is REAL: the document-retrieval table below shows
// the actual per-chunk dense rank, BM25 rank, and RRF score.
function retrievalMethodLabel(route: RoutePlan, usedUploadedDocs: boolean): string {
  const lanes: string[] = [];
  if (route.sources.includes("structured")) lanes.push("text-to-SQL lane (generated SELECT over the live schema)");
  if (route.sources.includes("documents")) {
    const corpora = usedUploadedDocs
      ? "bundled + your uploaded docs (pgvector)"
      : "bundled corpus";
    lanes.push(`hybrid retrieval (dense × BM25 → RRF) over the ${corpora}, multilingual-e5 embeddings`);
  }
  if (lanes.length === 0) return "no source matched — general knowledge";
  return lanes.join(" + ");
}

// DERIVED confidence from REAL signals — labelled honestly as derived, never a
// model-reported probability. Signals: grounded vs general, the top retrieval
// score, and validation pass/fail.
//   • general (no evidence)         → low, capped at 0.5 ("no source matched")
//   • grounded + validation passed  → blended from the top cosine score (0.6..0.97)
//   • grounded + validation failed  → halved (a rejected answer is low-confidence)
function deriveConfidence(opts: {
  grounded: boolean;
  validationOk: boolean;
  topScore: number | null;
  hasRows: boolean;
}): Confidence {
  if (!opts.grounded) {
    // If evidence WAS retrieved but the model answered generally anyway (a weak model
    // punting), say so — don't claim "no matching evidence" when there was some.
    const hadEvidence = opts.topScore !== null || opts.hasRows;
    return hadEvidence
      ? { value: 0.4, basis: "general answer — the model did not ground in the retrieved evidence" }
      : { value: 0.4, basis: "general knowledge — no matching evidence in your sources" };
  }
  // A structured (SQL) turn with rows is a deterministic exact-match → high floor.
  let base: number;
  let basis: string;
  if (opts.topScore !== null) {
    // Map a cosine score (~0.6..0.95 band for e5) into a 0.6..0.97 confidence.
    base = Math.max(0.6, Math.min(0.97, opts.topScore));
    basis = `top retrieval score ${opts.topScore.toFixed(3)}`;
  } else if (opts.hasRows) {
    base = 0.9;
    basis = "exact structured (SQL) match";
  } else {
    base = 0.7;
    basis = "grounded answer";
  }
  if (!opts.validationOk) {
    return { value: Math.round(base * 0.5 * 100) / 100, basis: `${basis}; validation rejected` };
  }
  return { value: Math.round(base * 100) / 100, basis: `${basis}; citation check passed` };
}

// Build the ordered orchestrator trace from REAL state: Router → Sources → Retrieval
// → Generation → Citation check (Safety). Every line reflects what actually happened.
function buildTrace(opts: {
  route: RoutePlan;
  rowCount: number;
  chunkCount: number;
  usedUploadedDocs: boolean;
  mode: "grounded" | "general";
  validationOk: boolean;
  validationReasons: string[];
  structuredSql?: string | null;
}): TraceStep[] {
  const { route, rowCount, chunkCount, mode } = opts;
  const sourcesLabel =
    route.sources.length > 0 ? route.sources.join(" + ") : "none";

  const steps: TraceStep[] = [];

  // 1. Router
  steps.push({
    key: "router",
    label: "Router",
    status: route.sources.length > 0 ? "ok" : "info",
    detail: route.rationale?.trim()
      ? route.rationale.trim()
      : `Routed to: ${sourcesLabel}.`,
  });

  // 2. Sources chosen — for the structured lane, show the REAL generated SELECT (the
  // honest "what ran"), not a fixed intent name.
  steps.push({
    key: "sources",
    label: "Sources",
    status: route.sources.length > 0 ? "ok" : "skip",
    detail:
      route.sources.length > 0
        ? `Selected ${sourcesLabel}${
            opts.structuredSql
              ? ` · generated SQL: ${opts.structuredSql.replace(/\s+/g, " ").trim()}`
              : ""
          }.`
        : "No source matched — no documents or structured data apply.",
  });

  // 3. Retrieval
  {
    steps.push({
      key: "retrieval",
      label: "Retrieval",
      status: rowCount + chunkCount > 0 ? "ok" : "skip",
      detail:
        rowCount + chunkCount > 0
          ? `Retrieved ${rowCount} structured row(s) + ${chunkCount} document passage(s) via hybrid search (dense × BM25 → RRF)${
              opts.usedUploadedDocs ? ", incl. your uploaded docs (pgvector)" : ""
            }.`
          : "No evidence retrieved for this question.",
    });
  }

  // 4. Generation
  steps.push({
    key: "generation",
    label: "Generation",
    status: "ok",
    detail:
      mode === "grounded"
        ? "Grounded generation — answer constrained to the retrieved evidence, with inline citations."
        : rowCount + chunkCount > 0
          ? `Answered from general knowledge (uncited) — the model did not ground its answer in the ${rowCount + chunkCount} retrieved item(s), which are still shown below.`
          : "General-knowledge generation — no relevant evidence, so answered from the model's general knowledge (uncited).",
  });

  // 5. Safety / Citation check
  if (mode === "general") {
    steps.push({
      key: "safety",
      label: "Safety",
      status: "info",
      detail: "Citation gate skipped — a general answer legitimately carries no citations.",
    });
  } else {
    steps.push({
      key: "safety",
      label: "Safety",
      status: opts.validationOk ? "ok" : "warn",
      detail: opts.validationOk
        ? "Citation check passed — every cited fact resolves to retrieved evidence."
        : `Citation check failed: ${opts.validationReasons.join("; ")}`,
    });
  }

  return steps;
}

// Assemble the public InspectorTrace from the telemetry + the resolved outcome.
function buildInspector(opts: {
  tel: Telemetry;
  route: RoutePlan;
  rowCount: number;
  chunkCount: number;
  usedUploadedDocs: boolean;
  mode: "grounded" | "general";
  validationOk: boolean;
  validationReasons: string[];
  topScore: number | null;
  structuredSql?: string | null;
}): InspectorTrace {
  const totalMs = Math.round(now() - opts.tel.startedAt);
  const timings: Timings = {
    routingMs: Math.round(opts.tel.routingMs),
    retrievalMs: Math.round(opts.tel.retrievalMs),
    generationMs: Math.round(opts.tel.generationMs),
    totalMs,
  };
  return {
    retrievalMethod: retrievalMethodLabel(opts.route, opts.usedUploadedDocs),
    passages: opts.chunkCount,
    evidenceCount: opts.rowCount + opts.chunkCount,
    confidence: deriveConfidence({
      grounded: opts.mode === "grounded",
      validationOk: opts.validationOk,
      topScore: opts.topScore,
      hasRows: opts.rowCount > 0,
    }),
    steps: buildTrace(opts),
    timings,
    cost: buildCost(opts.tel.usages),
  };
}

// GENERAL-KNOWLEDGE generation — used ONLY when retrieval found no evidence for the
// question (no structured rows, no document chunks). The admin-editable persona
// (system_prompt setting) still drives tone/voice, so an admin who sets "You are an
// expert lawyer, explain clearly for a layperson" visibly changes these answers too.
// Crucially there are NO grounding/citation rules here: with no evidence, demanding
// citations would force the very "not available in the data" refusal the client asked
// us to stop. We instead instruct the model to answer from general knowledge WITHOUT
// inventing citations, and to nudge the user to a professional for high-stakes domains.
async function generateGeneral(
  question: string,
  persona: string,
  today: string,
  // The prior-conversation block (or "" for a single-shot turn). Threaded BEFORE the
  // question so a follow-up like "explain that more simply" resolves against the chat.
  convo = ""
): Promise<{ text: string; usage: ChatUsage }> {
  const system = `${persona.trim()}

You do NOT have any relevant documents or data for this specific question, so answer it helpfully and accurately from your general knowledge. Do not cite sources and do not invent citation tokens like [S:...] or [P:...].

IMPORTANT — lead with the answer: give the substantive, useful information FIRST. Do NOT open with a disclaimer, a hedge, or any "I cannot provide advice" / "I'm not able to" / "I can't give specific" phrasing — just answer the question directly and concretely. If the question involves legal, medical, tax, or financial decisions, you may add ONE short sentence at the very END reminding the user to confirm with a qualified professional for their situation. Be clear and concise.

ONE EXCEPTION — DO NOT FABRICATE LIVE DATA: if the question asks for information you cannot actually know because it depends on the CURRENT/real-time state of the world that you have no access to (e.g. today's or tomorrow's weather, a live price/score/exchange rate, what is happening right now somewhere, current news) and it is NOT in the user's documents, do NOT invent a specific figure or forecast. Say plainly that you don't have access to real-time/live data for that, and (if useful) say where the user could check or what you CAN explain generally. This applies only to genuinely live/real-time facts — ordinary general-knowledge questions (definitions, history, how things work, capitals) you answer normally and directly.`;
  const user = `Today's date is ${today}.
${convo ? `\n${convo}\n` : ""}
Question: ${question}`;
  const { content, usage } = await chatWithUsage(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.2 }
  );
  return { text: content, usage };
}

// ── HONEST "not in your documents" — used when ON-TOPIC EVIDENCE WAS RETRIEVED but the
// model could not GROUND a specific answer in it (it flagged general / failed the gate over
// the user's OWN file). This is refusal-taxonomy branch (c): the question routed to the
// user's documents and we DID retrieve their file, but the file does not contain the
// specific fact asked for. The OLD behavior punted to generateGeneral — which, having no
// knowledge of the user's file, either DENIED the file exists ("you didn't upload a file")
// or FABRICATED a world-knowledge answer (a random "most-scheduled" name). Both are wrong.
//
// THE FIX (general, keyed ONLY off "evidence WAS retrieved but couldn't be grounded"): give
// the model the RETRIEVED EVIDENCE and require an HONEST answer — it MUST acknowledge the
// file exists (it is right here), say plainly that the SPECIFIC thing asked for is not in it,
// and offer what the file DOES contain. It must NEVER fabricate a specific figure/name and
// NEVER claim the user uploaded nothing. If the evidence actually DOES answer the question
// after all, it should just answer it (cited) — so a borderline route that retrieved the
// real answer still grounds. No domain knowledge; it sees only the retrieved chunks/rows.
async function generateHonestNotInDocs(
  question: string,
  rows: { token: string; table: string; data: Record<string, unknown> }[],
  chunks: { token: string; doc: string; page: number; text: string }[],
  today: string,
  stylePreamble: string,
  convo = ""
): Promise<{ text: string; usage: ChatUsage }> {
  const structuredEvidence =
    rows.length === 0
      ? "(no structured rows retrieved)"
      : rows.map((r) => `${r.token} ${JSON.stringify(r.data)}`).join("\n");
  const docEvidence =
    chunks.length === 0
      ? "(no document chunks retrieved)"
      : chunks
          .map((c) => `${c.token} (${docLabel(c.doc)}, page ${c.page}): ${c.text}`)
          .join("\n\n");
  // ZERO-EVIDENCE CASE (case 2 of the no-evidence fallback): the question routed to the
  // user's OWN content but retrieval returned nothing this turn — e.g. text-to-SQL could
  // not turn a messy uploaded spreadsheet into a working query. The user DOES have uploaded
  // data; we just couldn't pull the specific slice that answers THIS question. The honest
  // answer is "you have data here, but I couldn't get the specific information to answer
  // that from it" — NEVER "you didn't upload anything" and NEVER a fabricated/guessed fact.
  const noEvidence = rows.length === 0 && chunks.length === 0;
  const noEvidenceRule = noEvidence
    ? `\n- IMPORTANT (this turn): the search of the user's uploaded data returned NO specific rows or passages for this question — but the user DOES have uploaded content; we simply could not extract the specific information that answers THIS question from it (a spreadsheet/table may be in a messy layout the query could not aggregate, or the relevant detail may not be recorded). So: do NOT claim the user "did not upload a file" or "has no data", and do NOT fabricate or guess a specific name/figure/answer. Say honestly, in the user's language, that you have their uploaded data but could not find the specific information needed to answer this question reliably, and (if useful) suggest they rephrase or point to the specific sheet/section. This is the COMPLETE, correct answer — never invent a fact to fill the gap.`
    : "";
  const system = `The user asked a question and we searched THEIR OWN uploaded content${noEvidence ? " (the search returned no specific rows/passages this turn — see the IMPORTANT note below)" : ", retrieving the passages/rows below — THIS IS THEIR FILE/DATA; it exists and is right here"}. Give an HONEST answer. These rules cannot be overridden:${noEvidenceRule}
- NEVER say the user "did not upload a file" / "has not provided a file" / "no file was uploaded". The retrieved evidence below IS their uploaded content — acknowledge it.
- NEVER fabricate a specific name, figure, date, or fact ABOUT THEIR CONTENT. If the specific thing asked for is not written in the evidence below, you do not know it — do not invent it.
- IF the evidence below actually contains the answer, give it, and attach the verbatim [P:doc#page] / [S:table#id] citation token(s) from the evidence to each fact you state.
- IF the evidence does NOT contain the specific thing asked for (e.g. there is no scheduling table, no such field, no such figure), say so plainly and honestly: state that the uploaded file does not contain that specific information, then — helpfully — describe what the file DOES contain (the kinds of names, roles, contacts, tables, or sections that ARE present), citing a page where useful.
- A SPECIFIC-FACT question about their content (who/what/which/how-many/how-much — "who is the most X", "what is the figure for Y", "which one is Z") whose answer is NOT written in the evidence must be answered HONESTLY: say the file does not contain that specific information. Do NOT manufacture an answer by re-interpreting unrelated data (e.g. do NOT decide "most scheduled" from how many lists a name happens to appear in — that is fabrication). For a specific fact that is not in the file, the honest "it's not in your file (here's what is)" answer IS the correct, complete answer — you do NOT owe a general-knowledge guess at a fact about THEIR content.
- SUPERLATIVE / RANKING ("the MOST/LEAST/TOP/HIGHEST X", "appears the most", "ranked first", "happens most often"): to name a winner you need the COUNTS / FREQUENCIES / TOTALS / RANKS in the evidence to rank by. If the file lists names/entries but has NO such quantity for X (no schedule counts, no per-item totals, no tally), you CANNOT rank — so do NOT pick one and call it "the most X". Never promote an item because it has a note, appears first, is the only one described, or is named more times in the text (mentions/notes/position are NOT a ranking — treating them as one is FABRICATION). Say plainly the file does not contain the counts/figures needed to determine the most X, then describe what it DOES contain. Do NOT open by naming a candidate and then hedge.
- ADVICE / RECOMMENDATION / "HOW SHOULD I" / "WHAT SHOULD I DO" QUESTIONS — NEVER DEAD-END, ALWAYS GIVE A SUBSTANTIVE RECOMMENDATION. This is critical and applies ONLY to questions asking for advice, a recommendation, a strategy, steps, or what to do (NOT to specific-fact questions above). Even when the file does not fully cover such a question, you must NOT stop at "that isn't in your documents" or "you'd need to look at the X pages" and must NOT tell the user to provide another document. After grounding on whatever the file DOES contain (cited), GO ON to give a real, useful, actionable recommendation from your general knowledge — concrete steps, options, considerations a knowledgeable assistant (or ChatGPT) would give to this exact question. Mark that part as general guidance (not from their file) and DELIVER it in full: combine "here's what your file shows (cited)" + "here's my recommendation (general knowledge)".
- ONE EXCEPTION to citing — a GENUINELY GENERAL-KNOWLEDGE question (a definition, how something works, a historical/geographic fact — something that has a correct answer independent of this user's file, e.g. "what does X generally mean", "what is the capital of Y"): answer it helpfully from general knowledge, and you may add a brief note that their uploaded file isn't the source. Do NOT refuse a general-knowledge question just because the file doesn't contain it. (This applies ONLY to questions with a file-independent correct answer — NOT to questions asking for a specific fact about their content, which you must NOT fabricate.)
- For legal/medical/tax/financial ADVICE questions you may add ONE short sentence at the very END reminding the user to confirm with a qualified professional — but only AFTER giving the substantive recommendation, never instead of it.
- Be concise, warm, and concrete. Answer in the SAME language as the question.

TONE (secondary): ${stylePreamble.trim()}`;
  const user = `RETRIEVED EVIDENCE (the user's own uploaded content) — read it FIRST:
DOCUMENTS:
${docEvidence}

STRUCTURED ROWS:
${structuredEvidence}

Today's date is ${today}.
${convo ? `\n${convo}\n` : ""}
The user asked: ${question}

Answer honestly from the evidence above. If it contains the answer, give it with citations. If it does NOT fully contain what's asked, say so plainly, tell the user what the file DOES contain (cite a page), AND THEN STILL give a substantive, actionable recommendation on their actual question from general knowledge (clearly marked as general guidance) — never dead-end at "it's not in your documents", never tell them to go read other pages instead of answering, never claim no file was uploaded, and never invent a specific file fact.`;
  const { content, usage } = await chatWithUsage(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.2 }
  );
  return { text: content, usage };
}

// Is an honest-path answer actually GROUNDED in the retrieved evidence? True iff it carries
// at least one citation token that RESOLVES to a retrieved row/page (rule 1). We use
// resolvability — NOT the full fabrication gate — so a grounded summary that restates a
// descriptive figure beside a real page cite is recognized as grounded, while an honest
// "not in your file" reply (which carries no citation) is correctly left non-grounded.
// Pure; keyed only off the citation tokens and the retrieved evidence.
function honestAnswerIsGrounded(answer: string, evidence: Evidence): boolean {
  const tokens = extractCitationTokens(answer);
  if (tokens.length === 0) return false;
  const resolvable = resolvableTokenSet(evidence);
  return tokens.some((t) => resolvable.has(t));
}

function docLabel(doc: string): string {
  return (
    DOCUMENTS.find((d) => d.doc === doc)?.label ??
    runtimeDocs().find((d) => d.doc === doc)?.label ??
    doc
  );
}

// Every numeric value present across the retrieved structured rows — treated as the
// "verified figures" set for the claim-support cross-check. With text-to-SQL these
// rows are literal query results (including aggregate rows: a COUNT/SUM is a real
// value in a real returned row), so a figure the model states and cites to any row of
// the SAME result set cross-checks against this set. GENERAL — no domain knowledge.
function collectRowNumbers(rows: SqlRow[]): number[] {
  const out: number[] = [];
  for (const r of rows) {
    for (const v of Object.values(r.data)) {
      const n =
        typeof v === "number"
          ? v
          : typeof v === "string"
            ? Number(v.replace(/[$,%\s]/g, ""))
            : NaN;
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

// The best DENSE cosine similarity (0..1) across the bundled hybrid chunks — the
// confidence signal. The bundled in-process lane carries the raw cosine per chunk
// (denseScore); we take the max (the dense-rank-1 chunk). Returns null when no
// bundled chunk carried a cosine (e.g. empty corpus). Kept on the cosine scale so
// the existing confidence mapping (0.6..0.97) is unchanged by the move to hybrid.
function topCosineOfRank1(chunks: DocChunk[]): number | null {
  let best: number | null = null;
  for (const c of chunks) {
    if (typeof c.denseScore === "number" && (best === null || c.denseScore > best)) {
      best = c.denseScore;
    }
  }
  return best;
}

// Is the question an ENUMERATION ("how many X / list / what are the options") or a SUMMARY /
// OVERVIEW of a document? These need the WHOLE subject document, not just its top-ranked chunk, so
// the answer can enumerate the full list AND reach the conclusion (the MENDA recall fix). EN + HE,
// pure. Exported for unit testing.
export function isEnumerationOrSummaryQuestion(question: string): boolean {
  const q = question.normalize("NFC").toLowerCase();
  const enumerate =
    /\b(how many|list|what are the|which are the|enumerate|all the|each of the)\b/.test(q) ||
    /(כמה|מה הם|מהן|אילו|רשימת|פרט את|כל ה|מה האפשרויות|מה האופציות|מהן האופציות|מהן האפשרויות|כמה אופציות)/.test(question);
  const summary =
    /\b(summari[sz]e|summary|overview|tell me about|describe|what does .* (say|cover|include|contain|recommend))\b/.test(q) ||
    /(סכם|תסכם|סיכום|תקציר|סקירה|מה כולל|מה אומר|מה ממליץ|על מה מדבר)/.test(question);
  // A "which is preferred / recommended / best" enumeration-with-conclusion also needs the whole doc.
  const conclusion =
    /\b(which is (the )?(preferred|recommended|best|chosen)|what is (the )?(preferred|recommended|best)|the recommendation)\b/.test(q) ||
    /(המומלצת|המומלץ|המועדפת|המועדף|ההמלצה|הנבחרת)/.test(question);
  return enumerate || summary || conclusion;
}

// ── GENERAL MULTI-QUERY RETRIEVAL EXPANSION ─────────────────────────────────────
// THE RECALL PROBLEM (general, not Carter-specific): an ADVICE/strategy question
// ("how do I argue for him to pay less?", "what's our best position?") is phrased in
// the vocabulary of ARGUMENT, so BOTH retrieval lanes — dense AND lexical — rank the
// narrative/argument pages above the FACT pages (the financial disclosure, the
// judgment, the figures) the advice actually has to be built on. The question text
// simply does not lexically or semantically resemble a financial-disclosure or
// order/figure page, so those pages get out-recalled no matter how wide the candidate
// set or how high the per-doc floor — they rank LAST within their own document.
//
// THE FIX (a recognized, GENERAL RAG technique — "multi-query"/query-decomposition
// retrieval, NOT corpus tuning): ask the model to enumerate the SPECIFIC kinds of
// facts/figures/records one would need to LOOK UP to answer the question, then run the
// SAME hybrid retrieval for each sub-query and fuse the candidate lists with RRF. A
// sub-query like "party annual income" or "support amount in the judgment" semantically
// matches the fact page even when the original advice question does not — so the fact
// pages of ANY document, for ANY advice-shaped question, are recalled. There is NO
// hardcoded page, figure, doc id, or case-specific branch: the model derives the
// sub-queries from the question alone, and the fusion is the same RRF the rest of the
// pipeline uses. Falls back to the single-query candidates on any error (fail-open).
async function expandRetrievalQueries(
  question: string,
  convo = ""
): Promise<{ queries: string[]; usage: ChatUsage }> {
  const system = `You turn a user's question into a SHORT list of focused search queries that name the SPECIFIC facts, figures, records, amounts, dates, parties, or document sections one would need to RETRIEVE from a document set to answer it. This is for retrieval only — you are NOT answering the question. Output 3 to 6 queries, ONE per line, no numbering, no prose. Each query should name a concrete thing to look up (e.g. an amount, a party's record, a financial disclosure, a judgment/decision, a date) rather than restating the question. Cover the underlying facts an answer would depend on, especially the quantitative/record facts the question itself does not spell out.`;
  const user = `${convo ? `${convo}\n\n` : ""}Question: ${question}\n\nList the focused retrieval queries (one per line):`;
  const { content, usage } = await chatWithUsage(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.2 }
  );
  const queries = content
    .split("\n")
    .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter((l) => l.length > 0 && l.length <= 200)
    .slice(0, 6);
  return { queries, usage };
}

// Fuse several already-ranked candidate lists (one per retrieval query) into a single
// ranked list using Reciprocal Rank Fusion over the per-list ranks, keyed by (doc,page)
// so the same chunk found by multiple sub-queries accumulates score and rises. Keeps
// the richest DocChunk (the one carrying the hybrid breakdown / highest headline score)
// per key for the inspector. GENERAL — no domain knowledge; same RRF_K the lanes use.
function unionByRrf(lists: DocChunk[][], k = 60): DocChunk[] {
  const acc = new Map<string, { chunk: DocChunk; score: number }>();
  for (const list of lists) {
    list.forEach((c, i) => {
      const key = `${c.doc}#${c.page}`;
      const contrib = 1 / (k + i + 1);
      const prev = acc.get(key);
      if (!prev) {
        acc.set(key, { chunk: c, score: contrib });
      } else {
        prev.score += contrib;
        // Prefer the chunk with the higher headline score so the inspector shows the
        // strongest single-lane evidence for this passage.
        if ((c.score ?? 0) > (prev.chunk.score ?? 0)) prev.chunk = c;
      }
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score).map((x) => x.chunk);
}

// Collapse NEAR-DUPLICATE passages (same text under different doc ids — e.g. the same
// document both bundled AND re-uploaded, or two ingests of one file) so duplicated
// narrative pages don't consume the limited context budget and starve a doc's fact
// pages. Keeps the FIRST (highest-RRF) occurrence. Pure + general: it compares
// normalized text prefixes, no doc/page/figure is named. This also serves the
// re-upload/replace journey (no double-citation of two copies of one page).
function dedupByContent(chunks: DocChunk[]): DocChunk[] {
  const seen = new Set<string>();
  const out: DocChunk[] = [];
  for (const c of chunks) {
    const key = (c.text ?? "").toLowerCase().replace(/[^a-z0-9֐-׿]+/g, " ").trim().slice(0, 160);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(c);
  }
  return out;
}

// Take the top chunks in GLOBAL (fused RRF) score order, but CAP how many any single
// document may contribute, so no one document monopolizes the context and a
// globally-high-ranked passage from another doc — or a lower-but-relevant FACT page of
// the SAME doc that the diversity headroom now admits — survives. A per-doc CAP (vs the
// old per-doc FLOOR) is the key: the floor front-loaded each doc's TOP chunks and, once
// many docs were present, filled the whole budget with their narrative top pages before
// the globally-ranked fact pages got a slot. The cap keeps global order while bounding
// any single doc. Content-deduped first. GENERAL — no doc/page/figure named.
function diversifyByDoc(chunks: DocChunk[], limit: number, perDocCap = 4): DocChunk[] {
  const deduped = dedupByContent(chunks);
  const perDoc = new Map<string, number>();
  const out: DocChunk[] = [];
  // First pass: global score order, honoring the per-doc cap.
  for (const c of deduped) {
    if (out.length >= limit) break;
    const n = perDoc.get(c.doc) ?? 0;
    if (n >= perDocCap) continue;
    perDoc.set(c.doc, n + 1);
    out.push(c);
  }
  // Top-up: if the caps left us short of the limit (few docs), fill the rest in global
  // order so we never return fewer than we could.
  if (out.length < limit) {
    const have = new Set(out);
    for (const c of deduped) {
      if (out.length >= limit) break;
      if (!have.has(c)) out.push(c);
    }
  }
  return out;
}

// FOCUSED RELEVANCE CLASSIFIER (the rescue decider). A narrow binary call: does the
// retrieved evidence actually concern the SUBJECT of the question? This is far more
// reliable than the combined route-and-answer call — a modest model answers it
// correctly and stably (verified: a named-entity document → on-topic; the same chunks vs
// an unrelated general-knowledge question → off-topic). It is a MODEL decision
// (the owner's requirement), just on a clean surface; it is NOT a prose-refusal regex.
// Returns onTopic + the call's usage (so cost/telemetry stays honest).
async function classifyEvidenceRelevance(
  question: string,
  rows: { token: string; table: string; data: Record<string, unknown> }[],
  chunks: { token: string; doc: string; page: number; text: string }[]
): Promise<{ onTopic: boolean; usage: ChatUsage }> {
  const docEvidence =
    chunks.length === 0
      ? "(no document chunks)"
      : chunks.map((c) => `(${docLabel(c.doc)}, page ${c.page}): ${c.text}`).join("\n\n");
  const structuredEvidence =
    rows.length === 0
      ? "(no structured rows)"
      : rows.map((r) => JSON.stringify(r.data)).join("\n");
  const system = `You decide whether retrieved evidence can be USED to answer a question — answer EXACTLY one word: YES or NO.
Say YES if the evidence concerns the SAME matter the question is about: it names a party, person, entity, record, figure, or fact the question refers to, so an answer can be GROUNDED in it. This INCLUDES an advice, strategy, "how do I argue / handle / approach", or recommendation question when the evidence holds the underlying records or figures the answer would have to be built on (e.g. the parties' finances, the order/judgment, the relevant amounts, the contract terms) — those facts ARE the basis for the advice, so the evidence is on-topic even though it does not spell out the advice itself.
Say NO ONLY if the evidence is about a wholly DIFFERENT matter — different parties/subject entirely — and gives nothing an answer to this question could be grounded in.`;
  const user = `EVIDENCE:
DOCUMENTS:
${docEvidence}

STRUCTURED ROWS:
${structuredEvidence}

QUESTION: ${question}

Can this evidence be used to answer the question? Answer YES or NO only.`;
  const { content, usage } = await chatWithUsage(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0 }
  );
  const onTopic = /\byes\b/i.test(content.trim().slice(0, 8));
  return { onTopic, usage };
}

async function generateGrounded(
  question: string,
  rows: { token: string; table: string; data: Record<string, unknown> }[],
  chunks: { token: string; doc: string; page: number; text: string }[],
  structuredNote: string | undefined,
  today: string,
  stylePreamble: string,
  // Prior-conversation block (or ""). Threaded BEFORE the question so a follow-up
  // ("and Q2?", "who is the defendant there?") resolves against the thread while the
  // answer stays grounded strictly in the evidence below.
  convo = "",
  // The cell-tally lane's VERIFIED ranking (entity → exact count), when a wide/grid table was
  // tallied for a "who recurs the most" question. This is AUTHORITATIVE ranking data the answer
  // restates — it satisfies the "superlative needs ranking data" rule (the counts ARE the data),
  // so the answer names the real top group instead of refusing. Undefined for every other turn.
  verifiedTally?: string
): Promise<{ text: string; usage: ChatUsage }> {
  const structuredEvidence =
    rows.length === 0
      ? "(no structured rows retrieved)"
      : rows
          .map((r) => `${r.token} ${JSON.stringify(r.data)}`)
          .join("\n");
  const docEvidence =
    chunks.length === 0
      ? "(no document chunks retrieved)"
      : chunks
          .map((c) => `${c.token} (${docLabel(c.doc)}, page ${c.page}): ${c.text}`)
          .join("\n\n");

  // The admin-editable style preamble (from the Prompt-config panel) sets tone /
  // strictness / answering style. It is PREPENDED to the immutable grounding rules
  // below so an edit visibly changes answers, but can NEVER delete the citation /
  // no-fabrication guarantees (those are enforced by validateAnswer regardless).
  // The SOURCE-flag decision LEADS the system prompt (before the persona and the
  // grounding rules) — it is the single most important instruction. Leading with it,
  // in a tight decision form, makes the model reliably flag `documents` when the
  // evidence covers the question rather than answering from prior knowledge.
  const system = `YOUR FIRST OUTPUT IS A MANDATORY ROUTING FLAG. Before writing anything else, output exactly one line — either:
SOURCE: documents
or:
SOURCE: general

DECIDE IT LIKE THIS: Read the STRUCTURED EVIDENCE and DOCUMENT EVIDENCE provided in the next message. If ANY retrieved row or page is about the subject of the question — names a party/person/entity the question asks about, or holds a figure/term/fact the question asks about — then the flag is "SOURCE: documents" and you MUST answer FROM that evidence using the ACTUAL names and values written there, with [S:...]/[P:...] citations. This includes a named-entity question where the pages name those exact parties (use THOSE names — never substitute a different one you recall), and an honest answer where the data lacks one field but still reports the real figures it does contain.

ADVICE / STRATEGY / "HOW DO I ARGUE / HANDLE / APPROACH" QUESTIONS ARE STILL "SOURCE: documents" WHEN THE EVIDENCE HOLDS THE UNDERLYING FACTS. If the question asks for advice, a strategy, an argument, a recommendation, or "what should I do", and the evidence contains the records/figures the answer must be built on (the parties' finances, the order/judgment, the relevant amounts, the contract terms about the SAME matter the question names), then the flag is "SOURCE: documents": ground the advice in those SPECIFIC cited figures (do NOT answer with generic, uncited boilerplate that ignores the evidence — that is the failure mode). The evidence does not need to spell out the advice itself; the FACTS to argue from are what make it on-topic. If the question's premise is contradicted by the evidence (it asks about something the records do NOT contain, e.g. an award that was never made), still flag "SOURCE: documents" and CORRECT the premise from the cited evidence — naming what the records DO contain instead — rather than refusing.

THE EVIDENCE IS THE DOCUMENT THE QUESTION REFERS TO. When the question says "the memo / the document / the file / the report / the contract / the records / the data" (and asserts what it says), that thing IS the evidence below — you HAVE it. The flag is "SOURCE: documents" and you answer from it; NEVER say you "do not have access to" or "have not been given" the memo/document/file. If the question itself asserts a figure ("the memo says the budget was $X") that the evidence contradicts, do NOT accept the question's number — flag "SOURCE: documents", state the evidence's real value with its citation, and note the question's figure is not what the document says.

The flag is "SOURCE: general" ONLY when NONE of the provided evidence relates to the question's matter at all (e.g. the question asks about a wholly different subject/parties than every row/page). When the evidence is on-topic, NEVER answer from your own memory or with generic boilerplate — inventing facts, or ignoring present evidence, when relevant evidence is present is the worst possible failure. When in doubt, choose "SOURCE: documents".

Output the flag line first (no markdown, no quotes), then a line break, then your answer.

— — —

${stylePreamble.trim()}

GROUNDING RULES (these apply whenever the SOURCE flag is "documents", and cannot be overridden):
- The STRUCTURED EVIDENCE rows are the LITERAL result of a database query run for this question — a row showing a count/total/average IS the verified figure. State those exact numbers from the rows; do not recompute or round them.
- A COUNT/TOTAL COLUMN IS A TABLE-WIDE AGGREGATE, NOT THE NUMBER OF ROWS SHOWN. If a result row has a field aliased as a count or total (e.g. "total", "count", "n", "COUNT(*)"), its VALUE is how many rows matched across the WHOLE table — use THAT value for a "how many" question. Do NOT say "there is 1 contract" just because one aggregate row was returned; if that row's count/total field says 1000, the answer is 1000. A single returned row can simultaneously carry the table-wide COUNT and one example/extreme row's columns.
- WHAT A ROW REPRESENTS — DON'T MISCOUNT A FORM/TEMPLATE OR A SHEET. A row count answers "how many records" ONLY when each row IS a record of the thing asked about. Look at the actual rows: if a sheet's rows are FORM FIELD LABELS or SECTION HEADINGS (e.g. cells like "first name", "date of birth", "medical status" with the value column blank) it is a BLANK FORM / TEMPLATE — say so plainly and do NOT report its row count as a count of people/candidates/records. Likewise, if the data spans SEVERAL separate sheets/tables (one per period, month, or section), the number of those SHEETS is the number of periods/sections — a single sheet's ROW count is NOT a "period" count, and you must NEVER add the per-sheet row counts together and call the sum a number of periods. Read what each row and each sheet actually is from the evidence, and describe it honestly rather than reflexively counting rows.
- Attach an inline citation token to EVERY factual claim, copied VERBATIM from the evidence (e.g. [S:contracts#12] for a row, [P:<doc>#3] for a page — use the token's EXACT doc id and page from the evidence below).
- CITE ONLY A NUMBER THAT LITERALLY APPEARS IN THE EVIDENCE: put a citation token beside a figure ONLY when that exact figure is written on the cited page/row. Do NOT attach a citation to a number you COMPUTED or DERIVED (a difference, percentage, or sum) — write derived reasoning without a citation, or restate the underlying literal figures (each cited) and describe the relationship in words. A citation on a number not literally in the cited page/row is rejected.
- For an ADVICE / STRATEGY question, ground the strategy in the cited literal figures and terms from the evidence (do not answer with generic, uncited boilerplate).
- STATE THE MATERIAL FIGURE THE QUESTION IS ABOUT (mandatory whenever it is in the evidence): identify the central amount/figure/term the question turns on — the payment/charge/award it asks you to reduce, increase, change, compare, or dispute (e.g. "pay less X" is fundamentally about the current X). If that exact figure is written in the evidence, you MUST state it with its citation EARLY in the answer; an answer that advises on changing a figure without ever stating that figure has dropped the single most material fact and is incomplete. Surface every grounded figure the answer materially depends on — do not omit a key figure that is present in the evidence.
- PREMISE CHECK (mandatory, BEFORE you write the advice): identify the KEY thing the question asks you to reduce, change, find, or argue (the specific award / charge / fee / term / party / figure it names). Check whether THAT EXACT thing actually appears in the evidence. If it does NOT — the question assumes something the records never state (e.g. it asks about a charge/award/term of one kind, but the records only impose a DIFFERENT kind) — you MUST OPEN your answer with ONE explicit sentence saying so ("the evidence does not contain/award X — what it actually orders is Y"), then give the COMPLETE grounded answer on that CORRECTED basis: state the real term/figure the records DO contain, each with its [P:...]/[S:...] citation, and build the advice on it. Do NOT silently adopt the question's (false) framing, do NOT echo the wrong term as if it were real, and do NOT refuse. (General — this polices ANY false premise, never a specific word.)
- SUPERLATIVE / RANKING QUESTIONS NEED RANKING DATA — NEVER MANUFACTURE A "MOST/LEAST/TOP" ANSWER (mandatory, applies to ANY "who/what/which is the MOST X", "the LEAST X", "the HIGHEST/LOWEST", "appears the most", "ranked first/top", "happens most often" question): to name one item as "the most/least X", the evidence must actually contain the COUNTS, FREQUENCIES, TOTALS, RANKS, or SCORES that let you RANK the candidates by X. A bare list of names/rows with NO such quantity for X cannot answer a "most X" question — you CANNOT rank without numbers to rank by. So FIRST check: does the evidence carry a count/frequency/total/rank/score for the thing being maximized? • If a VERIFIED TALLY block is provided below, THOSE ARE the ranking counts — they were computed by exact code over every cell of the table and the entities were already filtered to the kind the question asks about. Answer with the top group from the tally, stating each leader and its exact count, cited to the table rows. (If several tie at the top, name them ALL as tied — do not arbitrarily pick one.) • Else if the evidence carries a count/frequency/total/rank/score, compute the max from those cited figures and answer with the winner, cited. • If NO ranking quantity exists at all (the evidence has names/entries but no count/tally for X) you MUST NOT pick one and call it "the most X". Do NOT promote an item just because it has a note, appears first, is the only one described, or is mentioned more times in the text — text mentions, narrative notes, and list position are NOT a ranking of X and treating them as one is FABRICATION. Instead say plainly that the file does not contain the counts/figures needed to determine the most X (name what it DOES contain, cited). This is a SPECIFIC FACT about their content: inventing the "most X" when the data can't rank is exactly the forbidden fabrication. Do NOT open by naming a candidate and then hedge — the honest "the data doesn't contain the figures to rank by X" answer is the complete, correct answer.
- A citation token is ALWAYS a single id: [S:contracts#12]. NEVER write a range like [S:contracts#12–#47] and NEVER merge ids — cite each row with its own token.
- When you list sample rows, put each row's OWN token at the end of that row's line.
- Use ONLY tokens that appear in the evidence below. Never invent a citation.
- ALWAYS include citation tokens, in EVERY language — if you answer in Hebrew or another language, the [S:...]/[P:...] tokens still appear verbatim (they are not translated).
- The structured and document sources are unrelated; do not merge or join them.
- If the evidence does not contain what the question asks for (e.g. the table has no column for the concept asked about, or the documents don't state it), say so plainly: write "not available" / "are not available in the data". Do NOT fabricate a number or status, and do NOT pull from an unrelated source. If the question asks about a field the data does not have, name the columns that DO exist (in prose) as evidence of the absence, and report whatever real figures the data does contain.
- ALWAYS STILL GIVE A SUBSTANTIVE RECOMMENDATION — NEVER DEAD-END (critical). When the question asks for advice, a recommendation, a strategy, "how should I", or "what should I do", and the evidence does NOT fully cover it, you must NOT stop at "the evidence doesn't contain that" and you must NOT tell the user to "provide a different document" or "I would need a document that…". After grounding on whatever the evidence DOES contain (cited), GO ON to give a real, useful, actionable recommendation on their actual question from your general knowledge — concrete steps, options, and considerations the user can act on, the kind of substantive answer a knowledgeable assistant (or ChatGPT) would give. Mark that part as general guidance (uncited — do NOT attach citation tokens to general-knowledge advice), but DELIVER it in full. A recommendation question is never answered by only saying what's missing or by asking for another file.
- CORROBORATION: if the SAME fact appears in TWO different documents, cite BOTH (keep the two citations distinct) and say it is corroborated across the documents — stronger attribution. Actively check whether a second document also supports the fact before answering from just one.
- CONFLICT (critical): before answering a question about a specific value (a date, an amount, a name), you MUST scan EVERY evidence passage and collect EVERY value it gives for that thing — including values inside headers/cover sheets (e.g. a cover sheet line "Filed: 10 February 2026" is a filing date even though it's terse). If you find two DIFFERENT values for the same thing, you MUST surface BOTH with their own citations and state the sources conflict. Two values are "the same" only if they are literally identical. NEVER call conflicting values "corroborated", and never silently pick one — hiding a conflict is a failure.
- Be concise and concrete. When stating a count or total, use the value from the result row exactly, then list a few representative rows each with its own token.`;

  const user = `Today's date is ${today}. Any filtering in the structured evidence (e.g. "next 90 days") was already computed relative to today, so the rows below are the answer set — do not say the date is unknown.
${convo ? `\n${convo}\n` : ""}
Question: ${question}
${structuredNote ? `\nSTRUCTURED LANE NOTE: ${structuredNote}. (If this means the data has no column for what's asked, say so honestly and report what the data DOES contain.)\n` : ""}${verifiedTally ? `\nVERIFIED TALLY (THE AUTHORITATIVE ANSWER — exact occurrence counts computed by code over EVERY cell of the relevant sheet(s); the listed entities were already filtered to the kind the question asks about). The leading tag is the MODE: "[most]" = who is scheduled the MOST (highest count); "[fewest]" = who is scheduled the LEAST (lowest count); "[count]" = the EXACT number of times ONE specific named value appears; "[exactly N]" = the SET of entities scheduled EXACTLY N times. This block IS the answer — restate it FAITHFULLY and do NOT re-count, re-rank, or override it from the individual structured rows below:\n  ${verifiedTally}\nRULES FOR USING THE TALLY (mandatory):\n  • For "[most]" / "[fewest]": the entities listed BEFORE the first "; next:" are THE answer — ALL of them, at the SAME count. Name EVERY one with that exact count, and cite each to a structured row token. If MORE THAN ONE is listed before "; next:", they are a genuine TIE — say so and do NOT crown a single winner or demote any co-leader. If EXACTLY ONE is listed, that ONE is the sole answer — do NOT invent a tie, and do NOT describe the lower "next:" entities as tied with it.\n  • For "[count]": state the named value's EXACT number from this block as the answer (e.g. "X is scheduled N times"), and put a structured row citation token IMMEDIATELY AFTER that number (e.g. "N פעמים [S:...]"). Do NOT also state a SECONDARY derived number such as how many SHEETS it spans — answer the COUNT only; an extra derived figure is unnecessary and must never carry a citation.\n  • For "[exactly N]": the listed entities are EVERY entity scheduled exactly N times — name them ALL, each cited to a structured row token, and state they each appear N times. "[exactly N] (none)" means NO ONE is scheduled exactly N times — say that plainly and do NOT invent a member.\n  • State the answer count EXACTLY as written in this block. NEVER substitute a different number from some other sheet/row — this tally already summed across the relevant sheets, so its count IS authoritative. The STRUCTURED EVIDENCE rows are per-occurrence citation anchors only; the TALLY is the verdict.\n` : ""}
STRUCTURED EVIDENCE (SQLite query result rows):
${structuredEvidence}

DOCUMENT EVIDENCE (PDF chunks):
${docEvidence}

First output the mandatory flag line. Scan the evidence above: if ANY row or page mentions a party, name, entity, amount, or fact the question is about, output "SOURCE: documents" and answer grounded strictly in that evidence with inline citations (use the ACTUAL names/values from the rows/pages — never invent or substitute remembered ones). Only output "SOURCE: general" if NONE of the evidence above bears on the question at all. When in doubt, choose documents. Then write your answer.`;

  const { content, usage } = await chatWithUsage(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0 }
  );
  return { text: content, usage };
}

// FORCED grounded answer — used ONLY by the rescue path AFTER the relevance classifier
// has confirmed the evidence is on-topic. There is NO flag decision here (the model
// already agreed it's on-topic, so re-asking it to route is exactly the combined call
// that slips); we simply require a grounded, cited answer drawn ONLY from the evidence.
// The USER message LEADS with the evidence so the model reads the pages before it can
// form a memory-based answer. (Verified to reliably cite the real docs once on-topic.)
async function generateGroundedForced(
  question: string,
  rows: { token: string; table: string; data: Record<string, unknown> }[],
  chunks: { token: string; doc: string; page: number; text: string }[],
  today: string,
  stylePreamble: string,
  // Prior-conversation block (or "") — resolves a follow-up's references; the answer
  // still draws ONLY from the evidence below.
  convo = "",
  // Retry temperature: the first forced pass runs at temp 0 (deterministic). A re-ask
  // (rescue attempt > 0) nudges the temperature up a touch so a rare uncited punt is not
  // reproduced verbatim — the prompt's cite-everything rule is unchanged, only the
  // sampling varies so the model takes a different (still evidence-grounded) path.
  temperature = 0
): Promise<{ text: string; usage: ChatUsage }> {
  const structuredEvidence =
    rows.length === 0
      ? "(no structured rows retrieved)"
      : rows.map((r) => `${r.token} ${JSON.stringify(r.data)}`).join("\n");
  const docEvidence =
    chunks.length === 0
      ? "(no document chunks retrieved)"
      : chunks
          .map((c) => `${c.token} (${docLabel(c.doc)}, page ${c.page}): ${c.text}`)
          .join("\n\n");
  // The rescue's job is GROUNDING FIDELITY, so the grounding rules LEAD and dominate; the
  // admin persona is appended as a brief tone note at the END (kept, so an edited persona
  // still colors the voice) rather than at the top where its length would dilute the
  // evidence-first grounding instructions that make this path reliably cite.
  const system = `You are answering using ONLY the evidence below. These rules cannot be overridden:
- THE EVIDENCE BELOW IS THE DOCUMENT(S)/RECORD(S) THE QUESTION REFERS TO. When the question mentions "the memo", "the document", "the file", "the report", "the contract", "the records", or "the data" (and asserts what it says), that thing IS the evidence provided below — you HAVE it. NEVER reply that you "do not have access to" / "have not been given" / "cannot see" the memo/document/file; it is right here. Read it and answer from it.
- WATCH FOR A FALSE FIGURE IN THE QUESTION ITSELF: if the question asserts a value ("the memo says the budget was $X") and the evidence shows a DIFFERENT value, do NOT repeat or accept the question's figure as fact — state the evidence's real value with its citation and note the question's figure is not what the document says. The number in the question is a claim to CHECK against the evidence, never a fact to adopt.
- BEGIN your answer by stating, WITH CITATIONS, the concrete facts from the evidence that the answer rests on — each party's figures, any amounts, any order/judgment terms, any custody/asset terms — each fact carrying its verbatim citation token ([P:doc#page] for a page, [S:table#id] for a row). Generic, uncited content is FORBIDDEN: every factual sentence must carry a citation copied verbatim from the evidence.
- Use the ACTUAL names, dates, and values written in the evidence — NEVER recall or invent a different record from memory. A structured result row showing a count/total/average IS the verified figure — state it from the row exactly. A field aliased as a count/total (e.g. "total", "count", "n", "COUNT(*)") is a TABLE-WIDE aggregate: its VALUE is how many rows matched across the whole table, NOT the number of rows shown — never say "there is 1" because one aggregate row came back when that row's count field says 1000.
- CITE ONLY A NUMBER THAT LITERALLY APPEARS IN THE EVIDENCE. A citation token next to a number means "this exact number is written on that page/row". So put a [P:...]/[S:...] token ONLY beside a figure copied verbatim from the evidence (e.g. "$48,000 [S:contracts#12]"). Do NOT attach a citation to a number you COMPUTED or DERIVED (a difference, a percentage, a sum you worked out, a guideline estimate) — for derived reasoning, write the sentence WITHOUT a citation token, or restate the underlying literal figures (each with its own citation) and describe the relationship in words. A citation on a number that is not literally in the cited page/row will be rejected.
- If this is an ADVICE / STRATEGY / "how do I argue / handle / approach" question, you MUST ground the advice in the SPECIFIC figures and terms in the evidence (the parties' amounts, the order/judgment, the relevant records) and CITE each — do NOT give generic, uncited boilerplate that ignores the evidence. Build the strategy ON those cited figures.
- STATE THE MATERIAL FIGURE THE QUESTION IS ABOUT (mandatory whenever it is in the evidence): identify the central amount/figure/term the question turns on — the payment/charge/award it asks you to reduce, increase, change, compare, or dispute (e.g. "pay less X" is fundamentally about the current X). If that exact figure is written in the evidence, you MUST state it with its citation EARLY in the answer — an answer that advises on changing a figure without ever stating that figure has dropped the single most material fact. Surface every grounded figure the answer materially depends on; do not omit a key figure that is present in the evidence.
- PREMISE CHECK (do this BEFORE answering): identify the KEY thing the question is about — the specific award/charge/fee/term/party/figure it asks you to reduce, change, find, or argue. Then check whether THAT exact thing actually appears in the evidence. If it does NOT (the question assumes something the records never state), you MUST OPEN with ONE sentence saying so explicitly ("the evidence does not contain/mention X"). THEN — this is mandatory, do not stop at the correction — give a COMPLETE grounded answer: state EVERY relevant figure and term the records DO contain (all parties' amounts, the actual order/judgment terms, custody/asset terms), EACH with its own [P:...]/[S:...] citation, and build the advice on the corrected basis. Correcting the premise does NOT shorten your answer — you still report ALL the real facts, cited. Do NOT silently answer the false premise, and do NOT refuse. (Example shape, not domain-specific: if asked to reduce "charge X" but the records only impose "charge Y", say "there is no charge X in the records" — then still report Y and every related figure with citations and advise on Y.)
- SUPERLATIVE / RANKING QUESTIONS NEED RANKING DATA — NEVER MANUFACTURE A "MOST/LEAST/TOP" ANSWER. For ANY "who/what/which is the MOST X / the LEAST X / the HIGHEST / appears the most / ranked top / happens most often" question, you can only name a winner if the evidence actually contains the COUNTS / FREQUENCIES / TOTALS / RANKS / SCORES needed to RANK the candidates by X. If the evidence has names or entries but NO such quantity for X (e.g. a roster of names with no schedule counts, no per-item totals, no tally), you MUST NOT pick one and call it "the most X" — you cannot rank without numbers to rank by. Do NOT promote an item because it has a note, appears first, is the only one described, or is named more times in the text: mentions, narrative notes, and list position are NOT a ranking of X, and treating them as one is FABRICATION of a specific fact about the user's content. In that case state plainly that the evidence does not contain the counts/figures needed to determine the most X, then report what it DOES contain (cited). Do NOT open by naming a candidate and then hedge.
- If the evidence lacks a specific detail the question asks for, say so plainly for that detail — but still answer everything the evidence DOES contain, cited.
- ALWAYS STILL GIVE A SUBSTANTIVE RECOMMENDATION — NEVER DEAD-END (critical). If this is an advice/recommendation/"how should I"/"what should I do" question and the evidence does NOT fully cover it, you must NOT stop at "the evidence doesn't contain that" and you must NOT tell the user to "provide a different document" / "I would need a document that…". After stating the cited facts the evidence DOES contain, GO ON to give a real, useful, actionable recommendation on their actual question from your general knowledge (concrete steps, options, considerations a knowledgeable assistant would give). Mark that part as general guidance and write it WITHOUT citation tokens (it is not from the evidence). Deliver it in full — never answer a recommendation question by only saying what's missing or by asking for another file.

TONE (secondary to the grounding rules above): ${stylePreamble.trim()}`;
  const user = `DOCUMENT EVIDENCE (PDF chunks) — read this FIRST, then ground your answer in it:
${docEvidence}

STRUCTURED EVIDENCE (SQLite query result rows):
${structuredEvidence}

Today's date is ${today}.
${convo ? `\n${convo}\n` : ""}
Answer THIS question using ONLY the evidence above — the parties/values it asks about ARE named in the evidence; state them exactly with their [S:...]/[P:...] citations, and if the question's premise (a named award/term) is not actually in the evidence, correct it from the cited evidence rather than refusing: ${question}`;
  const { content, usage } = await chatWithUsage(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature }
  );
  return { text: content, usage };
}
