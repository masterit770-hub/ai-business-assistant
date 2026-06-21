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
import type { SqlRow } from "./structured-store.ts";
import { vectorSearch as vectorSearchLocal, type DocChunk } from "./retrieval.ts";
import { fileSearchEnabled, queryFileSearch } from "./file-search.ts";
import { embedQuery } from "./embeddings.ts";
import { chatWithUsage, type ChatUsage, isLocalNotConfigured, isLocalUnreachable, isHipaaNotConfigured, isCloudProviderNotConfigured } from "./llm.ts";
import { sqlToken, pdfToken, extractCitationTokens } from "./citations.ts";
import { validateAnswer, type Evidence } from "./validate-answer.ts";
import { DOCUMENTS } from "./documents.ts";
import { runtimeDocs } from "./runtime-store.ts";
import { getSetting } from "./settings.ts";

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
    chunks: { doc: string; page: number; token: string; text: string; score?: number }[];
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
  // The honest retrieval-method label per what ACTUALLY ran this turn (e.g. the SQL
  // lane, the local cosine dense lane, Gemini File Search) — never a copied false
  // "dense × BM25 → RRF → rerank".
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

/**
 * Decide whether to surface the HONEST "couldn't search your uploaded documents"
 * error instead of answering. Pure, so it's unit-testable without the LLM/index.
 *
 * Fires when File Search (the uploaded-doc lane) failed AND there's no legitimate
 * substitute evidence: no structured rows, and either no doc chunks at all OR the
 * question targeted a specific uploaded doc (so the always-returned bundled Carter
 * chunks must NOT be used to answer it). A genuine bundled question still answers.
 */
export function shouldSurfaceDocLaneError(s: {
  fileSearchError: string | null;
  rowCount: number;
  chunkCount: number;
  targetedUploadedDoc: boolean;
}): boolean {
  if (!s.fileSearchError) return false;
  if (s.rowCount > 0) return false; // a structured-backed turn still answers
  return s.chunkCount === 0 || s.targetedUploadedDoc;
}

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

// A cloud provider was explicitly selected but has no saved key → friendly guidance
// (a 200) instead of a silent fallback to the env default. NEVER uses another
// provider's key.
function cloudProviderGuidanceResult(question: string, provider: string): AnswerResult {
  return {
    question,
    route: {
      sources: [],
      docFilter: null,
      rationale: `Cloud provider "${provider}" is selected but has no saved API key.`,
    },
    answer:
      `You've selected the "${provider}" cloud provider, but no API key is saved for it. Add your ${provider} key in Settings → Model, or switch the provider back to "Default" to use the built-in model. (It will not silently use a different provider's key.)`,
    mode: "general",
    grounded: false,
    evidence: { rows: [], chunks: [] },
    validation: { ok: true, reasons: [] },
  };
}

// PUBLIC entry. Runs the real pipeline, but if the active backend is LOCAL and it
// can't answer (not configured / unreachable), returns the friendly guidance as a
// normal 200 payload instead of letting the typed error become a 500.
export async function answerQuestion(
  question: string,
  ctx: { ownerId?: string; role?: string } = {}
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
    if (isCloudProviderNotConfigured(e)) {
      return cloudProviderGuidanceResult(question, (e as { provider?: string }).provider ?? "the selected");
    }
    throw e; // any other error keeps its existing (cloud) handling.
  }
}

async function runAnswerPipeline(
  question: string,
  ctx: { ownerId?: string; role?: string } = {}
): Promise<AnswerResult> {
  // Telemetry accumulator — real timings + real per-call token usage are gathered
  // as the pipeline runs and assembled into the InspectorTrace at each return point.
  const tel = newTelemetry();
  // Whether the Gemini File Search lane actually contributed chunks this turn (for
  // the honest retrieval-method label + the trace).
  let usedFileSearch = false;
  // The top REAL retrieval (cosine) score across the bundled dense lane — the
  // primary signal for the derived confidence. Null when no dense lane ran.
  let topScore: number | null = null;

  // An admin sees ALL uploaded docs → no owner scoping on retrieval.
  const scopeOwner = ctx.role === "admin" ? undefined : ctx.ownerId;
  // 1. ROUTE (real LLM decision) — owner-scoped doc catalog (Phase C)
  const routeStart = now();
  const route = await routeQuestion(question, { ownerId: scopeOwner });
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
  if (route.sources.includes("structured")) {
    try {
      const structured = await answerStructured(question);
      for (const u of structured.usages) tel.usages.push(u);
      tel.generationMs += 0; // structured-lane LLM time folds into total; phase timer below
      rows.push(...structured.rows);
      structuredSql = structured.sql;
      if (!structured.ok || structured.rows.length === 0) structuredNote = structured.note;
    } catch (e) {
      // The structured lane never crashes the answer; surface for debugging.
      console.error("structured lane failed:", e instanceof Error ? e.message : e);
      structuredNote = "structured query failed";
    }
  }

  let chunks: DocChunk[] = [];
  let fileSearchError: string | null = null;
  // Did the router target a specific UPLOADED doc (a docFilter that isn't one of the
  // bundled Carter ids)? The local vector index ALWAYS returns its top-k Carter chunks
  // even for an uploaded-doc question, so we can't tell from the chunks alone whether
  // the bundled text actually answers the question. The route's docFilter is the
  // reliable signal: if it names a non-bundled doc, the UPLOADED-doc lane (File Search)
  // was the intended source — and if that lane failed, we must surface the honest
  // error, not silently answer from the Carter corpus. (A flat cosine threshold was
  // tried and is NOT separable — multilingual-e5 puts Carter and uploaded-doc
  // questions in the same high score band; verified empirically.)
  const BUNDLED_DOC_IDS = new Set(DOCUMENTS.map((d) => d.doc));
  const targetedUploadedDoc = !!route.docFilter && !BUNDLED_DOC_IDS.has(route.docFilter);
  if (route.sources.includes("documents")) {
    // BUNDLED corpus (Carter) → the verified LOCAL vector path. Retrieve across ALL
    // bundled docs (no filter) so corroboration / conflict-surfacing across both
    // companion PDFs works.
    const qEmbedding = await embedQuery(question);
    const localRaw = vectorSearchLocal(qEmbedding, 12);
    // The best REAL cosine score this turn — the primary confidence signal.
    if (localRaw.length > 0) {
      topScore = Math.max(...localRaw.map((c) => c.score));
    }
    let merged = localRaw;

    // UPLOADED docs → Gemini File Search (managed, durable). One generateContent
    // call returns grounding chunks we map to the engine's [P:doc#page] shape and
    // merge with the bundled chunks, so a single answer can cite both corpora. A
    // quota 429 is captured (not swallowed) and surfaced honestly downstream.
    if (fileSearchEnabled()) {
      try {
        const fs = await queryFileSearch(question, scopeOwner);
        if (fs.chunks.length > 0) usedFileSearch = true;
        merged = [
          ...merged,
          ...fs.chunks.map((c) => ({ doc: c.doc, page: c.page, text: c.text, score: 0.99 })),
        ];
      } catch (e) {
        // File Search is an ENRICHMENT of the answer (the caller's UPLOADED docs).
        // It must never be fatal to a bundled/structured answer: a quota block OR a
        // transient transport blip ("terminated"/"fetch failed") to Gemini is
        // captured here and surfaced honestly downstream — the local bundled chunks
        // and any structured rows still answer. (Previously a non-quota error
        // re-threw and took down a bundled-PDF answer that didn't even need Gemini.)
        fileSearchError = e instanceof Error ? e.message : String(e);
      }
    }
    chunks = diversifyByDoc(merged, 8);
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
    })),
  };

  // HONEST DOC-LANE SHORT-CIRCUIT: when File Search (the UPLOADED-doc lane) failed,
  // do NOT silently answer from the wrong corpus. Surface the honest "couldn't search
  // your uploaded documents" message when there's no legitimate substitute evidence:
  //   • no structured rows (a structured-backed turn still answers), AND
  //   • EITHER no doc chunks came back at all, OR the question targeted a specific
  //     UPLOADED doc (route.docFilter names a non-bundled doc) — in which case the
  //     always-returned bundled chunks are NOT a valid answer and must not be used.
  // A genuine bundled-document question — no uploaded-doc docFilter — still answers
  // from its chunks despite a File Search blip (the earlier not-fatal fix).
  if (
    shouldSurfaceDocLaneError({
      fileSearchError,
      rowCount: evRows.length,
      chunkCount: evChunks.length,
      targetedUploadedDoc,
    })
  ) {
    return {
      question,
      route,
      answer:
        "I couldn't search your uploaded documents right now: " +
        fileSearchError +
        " (Bundled data and structured questions are unaffected.)",
      mode: "grounded",
      grounded: true,
      evidence: { rows: [], chunks: [] },
      validation: { ok: false, reasons: ["file-search-unavailable"] },
      inspector: buildInspector({
        tel,
        route,
        rowCount: evRows.length,
        chunkCount: evChunks.length,
        usedFileSearch,
        fileSearchError,
        mode: "grounded",
        validationOk: false,
        validationReasons: ["file-search-unavailable"],
        topScore,
      }),
    };
  }

  // ── GENERAL-KNOWLEDGE FALLBACK ────────────────────────────────────────────
  // Did retrieval actually find anything the user can be answered FROM? Evidence
  // exists when we got structured rows OR document chunks. (The router matching no
  // source at all also lands here — it produces neither rows nor chunks.)
  //
  // When there is NO evidence, the OLD behavior was to still run grounded
  // generation, whose immutable rules forced an "are not available in the data"
  // refusal for a general question like "What is Arizona divorce law?". The client
  // asked us to SOFTEN that: with no evidence, answer helpfully from the model's
  // general knowledge instead of refusing — while the grounded, cited path below is
  // untouched whenever the user's documents/data DO contain the answer.
  const hasEvidence = evRows.length > 0 || evChunks.length > 0;
  if (!hasEvidence) {
    const persona = await getSetting("system_prompt");
    const genStart = now();
    const { text: answer, usage } = await generateGeneral(question, persona, TODAY);
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
        usedFileSearch,
        fileSearchError,
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
    stylePreamble
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
  const effectiveFlag = structuredGrounded ? "documents" : flag;

  if (effectiveFlag === "general") {
    // The MODEL decided the retrieved evidence doesn't actually contain the answer →
    // answer from general knowledge instead of surfacing a forced "not in the docs".
    const g2Start = now();
    const { text: generalAnswer, usage } = await generateGeneral(question, stylePreamble, TODAY);
    tel.generationMs += now() - g2Start;
    tel.usages.push(usage);
    return {
      question,
      route,
      answer: generalAnswer,
      mode: "general",
      grounded: false,
      // PRESERVE the retrieved docs — retrieval is retrieval; the Inspector still
      // shows what the search found even when the model answered from general
      // knowledge. (Never return empty evidence on this path.)
      evidence: retrievedEvidence,
      validation: { ok: true, reasons: [] },
      inspector: buildInspector({
        tel,
        route,
        rowCount: evRows.length,
        chunkCount: evChunks.length,
        usedFileSearch,
        fileSearchError,
        mode: "general",
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

  // ── GROUNDED RESCUE (the SOURCE-flag complement) ──────────────────────────
  // The model flagged `documents` but its grounded answer FAILED the citation-fidelity
  // gate — the dominant real cause (observed live) is a NAMED-entity question where a
  // modest model writes from prior knowledge instead of the retrieved pages. Rather
  // than dump that to a generic general answer (dropping the real, citable facts), we
  // RESCUE: ask the model the NARROW, reliable "is this evidence on-topic?" question;
  // if YES, regenerate with the forced evidence-first grounded prompt (no flag
  // re-decision — it reliably cites the real docs) and re-run the gate. If the
  // regenerated answer now passes, keep it grounded. This is a MODEL decision on a
  // clean surface, and it CANNOT rescue a genuinely off-topic question (it classifies
  // off-topic → no rescue → stays general).
  if (!validationOk && !structuredGrounded && (evRows.length > 0 || evChunks.length > 0)) {
    const relStart = now();
    const rel = await classifyEvidenceRelevance(question, evRows, evChunks);
    tel.generationMs += now() - relStart;
    tel.usages.push(rel.usage);
    if (rel.onTopic) {
      const forcedStart = now();
      const forced = await generateGroundedForced(
        question,
        evRows,
        evChunks,
        TODAY,
        stylePreamble
      );
      tel.generationMs += now() - forcedStart;
      tel.usages.push(forced.usage);
      const forcedAnswer = parseSourceFlag(forced.text).text; // tolerate a stray flag line
      const forcedReasons = runGates(forcedAnswer);
      // Adopt the rescued answer only if it now PASSES the gate and actually cites the
      // evidence — proving it grounded in the real docs, not memory.
      if (forcedReasons.length === 0 && extractCitationTokens(forcedAnswer).length > 0) {
        answer = forcedAnswer;
        reasons = forcedReasons;
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
    // `stylePreamble` (the persona) is already fetched above — reuse it.
    const g3Start = now();
    const { text: generalAnswer, usage } = await generateGeneral(question, stylePreamble, TODAY);
    tel.generationMs += now() - g3Start;
    tel.usages.push(usage);
    return {
      question,
      route,
      answer: generalAnswer,
      mode: "general",
      grounded: false,
      // PRESERVE the retrieved docs (same reason as above) — the Inspector shows what
      // the search found even when the answer falls back to general knowledge.
      evidence: retrievedEvidence,
      validation: { ok: true, reasons: [] },
      inspector: buildInspector({
        tel,
        route,
        rowCount: evRows.length,
        chunkCount: evChunks.length,
        usedFileSearch,
        fileSearchError,
        mode: "general",
        validationOk: true,
        validationReasons: [],
        topScore,
      }),
    };
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
      })),
    },
    validation: { ok: validationOk, reasons },
    inspector: buildInspector({
      tel,
      route,
      rowCount: evRows.length,
      chunkCount: evChunks.length,
      usedFileSearch,
      fileSearchError,
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
// information about Arizona divorce law … not stated in the case file [P:carter#…]").
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
// turn. Deliberately NOT a copied "dense × BM25 → RRF → rerank": the engine uses a
// text-to-SQL lane for structured data + local cosine-similarity dense embeddings
// (multilingual-e5, bundled) + Gemini File Search for uploaded docs. We print only
// what ran.
function retrievalMethodLabel(route: RoutePlan, usedFileSearch: boolean): string {
  const lanes: string[] = [];
  if (route.sources.includes("structured")) lanes.push("text-to-SQL lane (generated SELECT over the live schema)");
  if (route.sources.includes("documents")) {
    lanes.push("dense cosine similarity (multilingual-e5, local)");
    if (usedFileSearch) lanes.push("Gemini File Search (uploaded docs)");
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
  usedFileSearch: boolean;
  fileSearchError: string | null;
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
  if (opts.fileSearchError) {
    steps.push({
      key: "retrieval",
      label: "Retrieval",
      status: "warn",
      detail: `Retrieved ${rowCount} row(s) + ${chunkCount} passage(s). File Search unavailable: ${opts.fileSearchError}`,
    });
  } else {
    steps.push({
      key: "retrieval",
      label: "Retrieval",
      status: rowCount + chunkCount > 0 ? "ok" : "skip",
      detail:
        rowCount + chunkCount > 0
          ? `Retrieved ${rowCount} structured row(s) + ${chunkCount} document passage(s)${
              opts.usedFileSearch ? " (incl. Gemini File Search)" : ""
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
  usedFileSearch: boolean;
  fileSearchError: string | null;
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
    retrievalMethod: retrievalMethodLabel(opts.route, opts.usedFileSearch),
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
  today: string
): Promise<{ text: string; usage: ChatUsage }> {
  const system = `${persona.trim()}

You do NOT have any relevant documents or data for this specific question, so answer it helpfully and accurately from your general knowledge. Do not cite sources and do not invent citation tokens like [S:...] or [P:...].

IMPORTANT — lead with the answer: give the substantive, useful information FIRST. Do NOT open with a disclaimer, a hedge, or any "I cannot provide advice" / "I'm not able to" / "I can't give specific" phrasing — just answer the question directly and concretely. If the question involves legal, medical, tax, or financial decisions, you may add ONE short sentence at the very END reminding the user to confirm with a qualified professional for their situation. Be clear and concise.`;
  const user = `Today's date is ${today}.

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

// Keep the top chunks but guarantee each represented document gets at least a
// couple of slots, so a corroborating/conflicting passage in a lower-ranked doc
// isn't crowded out by a higher-ranked one. Preserves overall score order.
function diversifyByDoc(chunks: DocChunk[], limit: number): DocChunk[] {
  const perDocFloor = 2;
  const byDoc = new Map<string, DocChunk[]>();
  for (const c of chunks) {
    if (!byDoc.has(c.doc)) byDoc.set(c.doc, []);
    byDoc.get(c.doc)!.push(c);
  }
  const picked = new Set<DocChunk>();
  // First pass: each doc's top `perDocFloor`.
  for (const list of byDoc.values()) for (const c of list.slice(0, perDocFloor)) picked.add(c);
  // Then fill remaining slots in global score order.
  for (const c of chunks) {
    if (picked.size >= limit) break;
    picked.add(c);
  }
  return chunks.filter((c) => picked.has(c)).slice(0, limit);
}

// FOCUSED RELEVANCE CLASSIFIER (the rescue decider). A narrow binary call: does the
// retrieved evidence actually concern the SUBJECT of the question? This is far more
// reliable than the combined route-and-answer call — a modest model answers it
// correctly and stably (verified: a named-case file → on-topic; the bundled chunks vs
// "capital of Australia" or "AZ alimony strategy" → off-topic). It is a MODEL decision
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
  const system = `You decide whether retrieved evidence is ON-TOPIC for a question. Answer with EXACTLY one word: YES or NO. YES = the evidence contains the specific subject the question asks about (the named parties/entities/figures/records), so the question can be answered from it — even if some specific detail is missing. NO = the evidence is about a wholly unrelated topic and does not bear on the question.`;
  const user = `EVIDENCE:
DOCUMENTS:
${docEvidence}

STRUCTURED ROWS:
${structuredEvidence}

QUESTION: ${question}

Is this evidence on-topic for the question? Answer YES or NO only.`;
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
  stylePreamble: string
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

The flag is "SOURCE: general" ONLY when NONE of the provided evidence relates to the question at all (e.g. the question asks for an unrelated topic but every row/page is about something else). When the evidence is on-topic, NEVER answer from your own memory — inventing facts when relevant evidence is present is the worst possible failure. When in doubt, choose "SOURCE: documents".

Output the flag line first (no markdown, no quotes), then a line break, then your answer.

— — —

${stylePreamble.trim()}

GROUNDING RULES (these apply whenever the SOURCE flag is "documents", and cannot be overridden):
- The STRUCTURED EVIDENCE rows are the LITERAL result of a database query run for this question — a row showing a count/total/average IS the verified figure. State those exact numbers from the rows; do not recompute or round them.
- Attach an inline citation token to EVERY factual claim, copied VERBATIM from the evidence (e.g. [S:contracts#12] for a row, [P:family-court#14] for a page).
- A citation token is ALWAYS a single id: [S:contracts#12]. NEVER write a range like [S:contracts#12–#47] and NEVER merge ids — cite each row with its own token.
- When you list sample rows, put each row's OWN token at the end of that row's line.
- Use ONLY tokens that appear in the evidence below. Never invent a citation.
- ALWAYS include citation tokens, in EVERY language — if you answer in Hebrew or another language, the [S:...]/[P:...] tokens still appear verbatim (they are not translated).
- The structured and document sources are unrelated; do not merge or join them.
- If the evidence does not contain what the question asks for (e.g. the table has no column for the concept asked about, or the documents don't state it), say so plainly: write "not available" / "are not available in the data". Do NOT fabricate a number or status, and do NOT pull from an unrelated source. If the question asks about a field the data does not have, name the columns that DO exist (in prose) as evidence of the absence, and report whatever real figures the data does contain.
- CORROBORATION: if the SAME fact appears in TWO different documents, cite BOTH (keep the two citations distinct) and say it is corroborated across the documents — stronger attribution. Actively check whether a second document also supports the fact before answering from just one.
- CONFLICT (critical): before answering a question about a specific value (a date, an amount, a name), you MUST scan EVERY evidence passage and collect EVERY value it gives for that thing — including values inside headers/cover sheets (e.g. a cover sheet line "Filed: 10 February 2026" is a filing date even though it's terse). If you find two DIFFERENT values for the same thing, you MUST surface BOTH with their own citations and state the sources conflict. Two values are "the same" only if they are literally identical. NEVER call conflicting values "corroborated", and never silently pick one — hiding a conflict is a failure.
- Be concise and concrete. When stating a count or total, use the value from the result row exactly, then list a few representative rows each with its own token.`;

  const user = `Today's date is ${today}. Any filtering in the structured evidence (e.g. "next 90 days") was already computed relative to today, so the rows below are the answer set — do not say the date is unknown.

Question: ${question}
${structuredNote ? `\nSTRUCTURED LANE NOTE: ${structuredNote}. (If this means the data has no column for what's asked, say so honestly and report what the data DOES contain.)\n` : ""}
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
  stylePreamble: string
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
  const system = `${stylePreamble.trim()}

You are answering a question that HAS matching evidence below. Answer using ONLY that evidence. Rules (cannot be overridden):
- Use the ACTUAL names, dates, and values written in the evidence — NEVER recall or invent a different record from memory.
- Attach an inline citation token to EVERY factual claim, copied VERBATIM from the evidence ([S:table#id] for a row, [P:doc#page] for a page).
- A structured result row showing a count/total/average IS the verified figure — state it from the row exactly.
- If the evidence lacks a specific detail the question asks for, say so plainly for that detail — but still answer everything the evidence DOES contain, cited.`;
  const user = `DOCUMENT EVIDENCE (PDF chunks) — read this FIRST:
${docEvidence}

STRUCTURED EVIDENCE (SQLite query result rows):
${structuredEvidence}

Today's date is ${today}.

Answer THIS question using ONLY the evidence above — the parties/values it asks about ARE named in the evidence; use them exactly, with their [S:...]/[P:...] citations, and do not recall a different record: ${question}`;
  const { content, usage } = await chatWithUsage(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0 }
  );
  return { text: content, usage };
}
